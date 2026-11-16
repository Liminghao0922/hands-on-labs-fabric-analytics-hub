"""HTTP endpoints and API guard for concurrent session control.

Endpoints (all behind SWA authentication):
- POST /api/session/acquire    body: {"browserId": "..."}
- POST /api/session/heartbeat  body: {"browserId": "...", "slotId": "slot-0001"}
- POST /api/session/release    body: {"browserId": "...", "slotId": "slot-0001"}
- GET  /api/session/status     current settings and number of active sessions

Other APIs can be protected with the ``require_session`` decorator. Guarded
calls validate without writing unless SESSION_API_EXTEND is enabled.
"""

import functools
import json
import logging
import os
import uuid
from http import HTTPStatus
from typing import Optional

import azure.functions as func

from shared.auth import get_user_upn
from shared.session_store import (
    InvalidSessionRequest,
    SessionConfig,
    SessionGrant,
    SessionLimitReached,
    SLOT_ID_PATTERN,
    get_session_store,
    load_session_config,
    make_session_key,
)

bp = func.Blueprint()
logger = logging.getLogger(__name__)

HEADER_BROWSER_ID = "x-session-browser"
HEADER_SLOT_ID = "x-session-slot"
HEADER_EXPIRES_AT = "X-Session-Expires-At"
HEADER_HEARTBEAT_INTERVAL = "X-Session-Heartbeat-Interval"
HEADER_EXTENDED = "X-Session-Extended"


def _json(payload: dict, status_code: int = HTTPStatus.OK) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
        headers={"Cache-Control": "no-store"},
    )


def _read_body(req: func.HttpRequest) -> dict:
    try:
        body = req.get_json()
        return body if isinstance(body, dict) else {}
    except ValueError:
        return {}


def _service_error(req: func.HttpRequest, exc: Exception, route: str) -> func.HttpResponse:
    error_id = req.headers.get("x-ms-client-request-id") or str(uuid.uuid4())
    logger.exception("Session store error route=%s errorId=%s", route, error_id)
    payload = {
        "error": "Session service is temporarily unavailable.",
        "code": "SESSION_SERVICE_UNAVAILABLE",
        "errorId": error_id,
    }
    if os.getenv("SHOW_DETAILED_ERRORS", "false").lower() == "true":
        payload["details"] = str(exc)
    return _json(payload, HTTPStatus.SERVICE_UNAVAILABLE)


def _expired(message: str = "Session expired or was assigned to another user. Please acquire a new session.",
             code: str = "SESSION_EXPIRED") -> func.HttpResponse:
    return _json({"error": message, "code": code}, HTTPStatus.GONE)


def _grant_payload(config: SessionConfig, grant: SessionGrant) -> dict:
    return {"slotId": grant.slot_id, "expiresAt": grant.expires_at, **config.to_client_dict()}


def _log_degraded(req: func.HttpRequest, route: str) -> str:
    error_id = req.headers.get("x-ms-client-request-id") or str(uuid.uuid4())
    logger.warning("Session store fail-open route=%s errorId=%s", route, error_id, exc_info=True)
    return error_id


def _store_error(req: func.HttpRequest, exc: Exception, route: str, config: SessionConfig) -> func.HttpResponse:
    if config.fail_open:
        error_id = _log_degraded(req, route)
        return _json({**config.to_client_dict(), "degraded": True, "errorId": error_id})
    return _service_error(req, exc, route)


def _valid_slot_id(slot_id) -> bool:
    return isinstance(slot_id, str) and SLOT_ID_PATTERN.fullmatch(slot_id) is not None


def _load_config(req: func.HttpRequest, route: str):
    try:
        return load_session_config(), None
    except ValueError as exc:
        return None, _service_error(req, exc, route)


# ---------------------------------------------------------------------------
# Session endpoints
# ---------------------------------------------------------------------------


@bp.route(route="session/acquire", methods=["POST"])
def session_acquire(req: func.HttpRequest) -> func.HttpResponse:
    config, error = _load_config(req, "session_acquire")
    if error:
        return error
    if not config.enabled:
        return _json({"enabled": False})

    user_upn = get_user_upn(req)
    if not user_upn:
        return func.HttpResponse("Unauthorized", status_code=HTTPStatus.UNAUTHORIZED)

    body = _read_body(req)
    try:
        session_key = make_session_key(config, user_upn, body.get("browserId"))
        grant = get_session_store(config).acquire(session_key, user_upn)
    except InvalidSessionRequest as exc:
        return _json({"error": str(exc), "code": "INVALID_SESSION_REQUEST"}, HTTPStatus.BAD_REQUEST)
    except SessionLimitReached as exc:
        return _json(
            {"error": str(exc), "code": "SESSION_LIMIT_REACHED", "maxSessions": config.max_sessions},
            HTTPStatus.CONFLICT,
        )
    except Exception as exc:
        return _store_error(req, exc, "session_acquire", config)

    return _json(_grant_payload(config, grant))


@bp.route(route="session/heartbeat", methods=["POST"])
def session_heartbeat(req: func.HttpRequest) -> func.HttpResponse:
    config, error = _load_config(req, "session_heartbeat")
    if error:
        return error
    if not config.enabled:
        return _json({"enabled": False})

    user_upn = get_user_upn(req)
    if not user_upn:
        return func.HttpResponse("Unauthorized", status_code=HTTPStatus.UNAUTHORIZED)

    body = _read_body(req)
    try:
        session_key = make_session_key(config, user_upn, body.get("browserId"))
        if not _valid_slot_id(body.get("slotId")):
            return _expired()
        grant = get_session_store(config).extend(body.get("slotId"), session_key)
    except InvalidSessionRequest as exc:
        return _json({"error": str(exc), "code": "INVALID_SESSION_REQUEST"}, HTTPStatus.BAD_REQUEST)
    except SessionLimitReached as exc:
        return _json({"error": str(exc), "code": "SESSION_LIMIT_REACHED"}, HTTPStatus.CONFLICT)
    except Exception as exc:
        return _store_error(req, exc, "session_heartbeat", config)

    if grant is None:
        return _expired()
    return _json(_grant_payload(config, grant))


@bp.route(route="session/release", methods=["POST"])
def session_release(req: func.HttpRequest) -> func.HttpResponse:
    config, error = _load_config(req, "session_release")
    if error:
        return error
    if not config.enabled:
        return func.HttpResponse(status_code=HTTPStatus.NO_CONTENT)

    user_upn = get_user_upn(req)
    if not user_upn:
        return func.HttpResponse("Unauthorized", status_code=HTTPStatus.UNAUTHORIZED)

    body = _read_body(req)
    reason = body.get("reason")
    if reason not in ("logout", "idle", "close"):
        reason = "logout"
    if body.get("slotId") is not None and not _valid_slot_id(body["slotId"]):
        return _json(
            {"error": "Invalid slotId.", "code": "INVALID_SESSION_REQUEST"},
            HTTPStatus.BAD_REQUEST,
        )
    try:
        session_key = make_session_key(config, user_upn, body.get("browserId"))
        get_session_store(config).release(body.get("slotId"), session_key)
        logger.info("Session release company=%s reason=%s", config.company_id, reason)
    except InvalidSessionRequest as exc:
        return _json({"error": str(exc), "code": "INVALID_SESSION_REQUEST"}, HTTPStatus.BAD_REQUEST)
    except Exception as exc:
        return _service_error(req, exc, "session_release")

    return func.HttpResponse(status_code=HTTPStatus.NO_CONTENT)


@bp.route(route="session/status", methods=["GET"])
def session_status(req: func.HttpRequest) -> func.HttpResponse:
    # Demo endpoint. In production, restrict it to an administrator role.
    config, error = _load_config(req, "session_status")
    if error:
        return error
    if not config.enabled:
        return _json({"enabled": False})
    if not get_user_upn(req):
        return func.HttpResponse("Unauthorized", status_code=HTTPStatus.UNAUTHORIZED)

    try:
        return _json(get_session_store(config).status())
    except Exception as exc:
        return _service_error(req, exc, "session_status")


# ---------------------------------------------------------------------------
# Guard for business APIs
# ---------------------------------------------------------------------------


def _add_session_headers(response: func.HttpResponse, config: SessionConfig, grant: SessionGrant) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers[HEADER_EXPIRES_AT] = str(grant.expires_at)
    response.headers[HEADER_HEARTBEAT_INTERVAL] = str(config.heartbeat_interval_seconds)
    response.headers[HEADER_EXTENDED] = str(config.api_extends_session).lower()


def require_session(handler):
    """Reject the call unless the caller holds an active session.

    The browser sends X-Session-Browser / X-Session-Slot headers. On success the
    response carries the expiry and whether the session was actually extended.
    """

    @functools.wraps(handler)
    def wrapper(req: func.HttpRequest) -> func.HttpResponse:
        config, error = _load_config(req, handler.__name__)
        if error:
            return error
        if not config.enabled or not config.enforce_on_api:
            return handler(req)

        user_upn = get_user_upn(req)
        if not user_upn:
            return handler(req)  # the handler returns 401

        grant: Optional[SessionGrant] = None
        try:
            session_key = make_session_key(config, user_upn, req.headers.get(HEADER_BROWSER_ID))
            slot_id = req.headers.get(HEADER_SLOT_ID)
            if slot_id is not None and not _valid_slot_id(slot_id):
                return _expired("An active session is required.", code="SESSION_REQUIRED")
            store = get_session_store(config)
            if slot_id is None:
                # Degraded acquire grants have no slot. Probe availability before
                # rejecting them, so fail-open still works during a store outage.
                if config.fail_open:
                    store.status()
                return _expired("An active session is required.", code="SESSION_REQUIRED")
            check = store.extend if config.api_extends_session else store.validate
            grant = check(slot_id, session_key)
        except InvalidSessionRequest:
            return _expired("An active session is required.", code="SESSION_REQUIRED")
        except SessionLimitReached:
            return _expired()
        except Exception as exc:
            if not config.fail_open:
                return _service_error(req, exc, handler.__name__)
            error_id = _log_degraded(req, handler.__name__)
            response = handler(req)
            response.headers["Cache-Control"] = "no-store"
            response.headers[HEADER_EXTENDED] = "false"
            response.headers["X-Session-Degraded"] = "true"
            response.headers["X-Session-Error-Id"] = error_id
            return response

        if grant is None:
            return _expired()

        response = handler(req)
        _add_session_headers(response, config, grant)
        return response

    return wrapper
