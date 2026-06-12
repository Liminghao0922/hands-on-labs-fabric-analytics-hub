import json
import logging
import os
import uuid
from http import HTTPStatus
from typing import Optional, Tuple, Union

import azure.functions as func

from shared.auth import get_user_upn
from shared.keyvault import KeyVaultConfigError, load_service_principal_config
from shared.mapping import MappingNotFoundError, load_user_mapping
from shared.onelake_client import OneLakeClient
from shared.powerbi_client import PowerBIClient

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)
logger = logging.getLogger(__name__)
SHOW_DETAILED_ERRORS = os.getenv("SHOW_DETAILED_ERRORS", "false").lower() == "true"


def _json_response(payload: dict, status_code: int = HTTPStatus.OK) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
    )


def _error_id(req: func.HttpRequest) -> str:
    return req.headers.get("x-ms-client-request-id") or str(uuid.uuid4())


def _internal_error(
    req: func.HttpRequest,
    *,
    route: str,
    message: str,
    exc: Exception,
    user_upn: Optional[str] = None,
) -> func.HttpResponse:
    error_id = _error_id(req)
    logger.exception(
        "Unhandled error route=%s method=%s user=%s errorId=%s",
        route,
        req.method,
        user_upn or "unknown",
        error_id,
    )

    payload = {
        "error": message,
        "errorId": error_id,
    }
    if SHOW_DETAILED_ERRORS:
        payload["details"] = str(exc)

    return _json_response(payload, status_code=HTTPStatus.INTERNAL_SERVER_ERROR)


def _build_client(req: func.HttpRequest) -> Union[Tuple[str, OneLakeClient], Tuple[None, func.HttpResponse]]:
    user_upn = get_user_upn(req)
    if not user_upn:
        return None, func.HttpResponse("Unauthorized", status_code=HTTPStatus.UNAUTHORIZED)

    try:
        mapping = load_user_mapping(user_upn.lower())
        sp_config = load_service_principal_config(mapping.service_principal_secret_name)
    except MappingNotFoundError as exc:
        return None, _json_response({"error": str(exc)}, status_code=HTTPStatus.FORBIDDEN)
    except KeyVaultConfigError as exc:
        return None, _internal_error(
            req,
            route="client_init",
            message="Key Vault configuration error while loading user/SP mapping.",
            exc=exc,
            user_upn=user_upn,
        )
    except Exception as exc:
        return None, _internal_error(
            req,
            route="client_init",
            message="Failed to load user/SP configuration.",
            exc=exc,
            user_upn=user_upn,
        )

    client = OneLakeClient(sp_config=sp_config)
    return user_upn, client


def _resolve_user_sp_config(req: func.HttpRequest):
    user_upn = get_user_upn(req)
    if not user_upn:
        return None, None, func.HttpResponse("Unauthorized", status_code=HTTPStatus.UNAUTHORIZED)

    try:
        mapping = load_user_mapping(user_upn.lower())
        sp_config = load_service_principal_config(mapping.service_principal_secret_name)
    except MappingNotFoundError as exc:
        return None, None, _json_response({"error": str(exc)}, status_code=HTTPStatus.FORBIDDEN)
    except KeyVaultConfigError as exc:
        return None, None, _internal_error(
            req,
            route="sp_config_init",
            message="Key Vault configuration error while loading Power BI profile.",
            exc=exc,
            user_upn=user_upn,
        )
    except Exception as exc:
        return None, None, _internal_error(
            req,
            route="sp_config_init",
            message="Failed to load user/SP configuration.",
            exc=exc,
            user_upn=user_upn,
        )

    return user_upn, sp_config, None


@app.route(route="profile", methods=["GET"])
def profile(req: func.HttpRequest) -> func.HttpResponse:
    user_upn, client_or_response = _build_client(req)
    if not user_upn:
        return client_or_response

    return _json_response({"user": user_upn})


@app.route(route="folders", methods=["GET"])
def folders(req: func.HttpRequest) -> func.HttpResponse:
    user_upn, client_or_response = _build_client(req)
    if not user_upn:
        return client_or_response

    try:
        # Dynamically list folders accessible to the service principal
        available_folders = client_or_response.list_accessible_folders()
    except Exception as exc:
        return _internal_error(
            req,
            route="folders",
            message="Failed to retrieve accessible folders.",
            exc=exc,
            user_upn=user_upn,
        )

    return _json_response({"folders": available_folders})


@app.route(route="files", methods=["GET"])
def files(req: func.HttpRequest) -> func.HttpResponse:
    user_upn, client_or_response = _build_client(req)
    if not user_upn:
        return client_or_response

    folder = req.params.get("folder")
    if not folder:
        return _json_response({"error": "Missing 'folder' parameter."}, status_code=HTTPStatus.BAD_REQUEST)

    try:
        file_entries = client_or_response.list_files(folder_name=folder)
    except Exception as exc:
        return _internal_error(
            req,
            route="files",
            message="Failed to list files.",
            exc=exc,
            user_upn=user_upn,
        )

    payload = {
        "folder": folder,
        "files": [
            {
                "name": f.name,
                "path": f.path,
                "modifiedTime": f.modified_time,
                "type": f.file_type,
                "size": f.size,
            }
            for f in file_entries
        ],
    }

    return _json_response(payload)


@app.route(route="upload", methods=["POST"])
def upload(req: func.HttpRequest) -> func.HttpResponse:
    user_upn, client_or_response = _build_client(req)
    if not user_upn:
        return client_or_response

    folder = req.params.get("folder")
    if not folder:
        return _json_response({"error": "Missing 'folder' parameter."}, status_code=HTTPStatus.BAD_REQUEST)

    try:
        files = req.files.getlist("files")
        if not files:
            return _json_response({"error": "No files were uploaded."}, status_code=HTTPStatus.BAD_REQUEST)

        client_or_response.upload_files(folder_name=folder, files=files)
        return _json_response({"message": "Upload completed."})
    except Exception as exc:
        return _internal_error(
            req,
            route="upload",
            message="Failed to upload files.",
            exc=exc,
            user_upn=user_upn,
        )


@app.route(route="download", methods=["POST"])
def download(req: func.HttpRequest) -> func.HttpResponse:
    user_upn, client_or_response = _build_client(req)
    if not user_upn:
        return client_or_response

    folder = req.params.get("folder")
    if not folder:
        return _json_response({"error": "Missing 'folder' parameter."}, status_code=HTTPStatus.BAD_REQUEST)

    try:
        body = req.get_json()
        filenames = body.get("files", [])
        if not filenames:
            return _json_response({"error": "No files selected."}, status_code=HTTPStatus.BAD_REQUEST)

        archive = client_or_response.download_as_zip(folder_name=folder, filenames=filenames)
        headers = {
            "Content-Disposition": 'attachment; filename="selected-files.zip"',
            "Content-Type": "application/zip",
        }
        return func.HttpResponse(body=archive, status_code=HTTPStatus.OK, headers=headers)
    except Exception as exc:
        return _internal_error(
            req,
            route="download",
            message="Failed to download files.",
            exc=exc,
            user_upn=user_upn,
        )


@app.route(route="delete", methods=["POST"])
def delete(req: func.HttpRequest) -> func.HttpResponse:
    user_upn, client_or_response = _build_client(req)
    if not user_upn:
        return client_or_response

    folder = req.params.get("folder")
    if not folder:
        return _json_response({"error": "Missing 'folder' parameter."}, status_code=HTTPStatus.BAD_REQUEST)

    try:
        body = req.get_json()
        filenames = body.get("files", [])
        if not filenames:
            return _json_response({"error": "No files selected."}, status_code=HTTPStatus.BAD_REQUEST)

        deleted_count = client_or_response.delete_files(folder_name=folder, filenames=filenames)
        return _json_response({"message": "Delete completed.", "deleted": deleted_count})
    except Exception as exc:
        return _internal_error(
            req,
            route="delete",
            message="Failed to delete files.",
            exc=exc,
            user_upn=user_upn,
        )


@app.route(route="reports", methods=["GET"])
def reports(req: func.HttpRequest) -> func.HttpResponse:
    user_upn, sp_config, error_response = _resolve_user_sp_config(req)
    if error_response:
        return error_response

    try:
        powerbi_client = PowerBIClient(sp_config)
        report_entries = powerbi_client.list_reports()
        payload = {
            "user": user_upn,
            "reports": [
                {
                    "id": report.id,
                    "name": report.name,
                    "embedUrl": report.embed_url,
                    "datasetId": report.dataset_id,
                }
                for report in report_entries
            ],
        }
        return _json_response(payload)
    except Exception as exc:
        return _internal_error(
            req,
            route="reports",
            message="Failed to list Power BI reports.",
            exc=exc,
            user_upn=user_upn,
        )


@app.route(route="reports/embed", methods=["POST"])
def reports_embed(req: func.HttpRequest) -> func.HttpResponse:
    user_upn, sp_config, error_response = _resolve_user_sp_config(req)
    if error_response:
        return error_response

    try:
        body = req.get_json()
        report_id = (body or {}).get("reportId", "")
        if not report_id:
            return _json_response({"error": "Missing 'reportId' in request body."}, status_code=HTTPStatus.BAD_REQUEST)

        powerbi_client = PowerBIClient(sp_config)
        embed_config = powerbi_client.generate_embed_token(report_id)
        return _json_response(embed_config)
    except ValueError as exc:
        return _json_response({"error": str(exc)}, status_code=HTTPStatus.BAD_REQUEST)
    except Exception as exc:
        return _internal_error(
            req,
            route="reports_embed",
            message="Failed to generate embed token.",
            exc=exc,
            user_upn=user_upn,
        )
