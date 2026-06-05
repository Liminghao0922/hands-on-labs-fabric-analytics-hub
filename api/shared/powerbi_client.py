import logging
from dataclasses import dataclass
from typing import Optional

import requests
from azure.identity import ClientSecretCredential

from .keyvault import ServicePrincipalConfig


logger = logging.getLogger(__name__)


@dataclass
class PowerBIReport:
    id: str
    name: str
    embed_url: str
    dataset_id: Optional[str]


class PowerBIClient:
    API_BASE = "https://api.powerbi.com/v1.0/myorg"

    def __init__(self, sp_config: ServicePrincipalConfig):
        self._sp_config = sp_config
        self._credential = ClientSecretCredential(
            tenant_id=sp_config.tenant_id,
            client_id=sp_config.client_id,
            client_secret=sp_config.client_secret,
        )

    def _workspace_id(self) -> str:
        if not self._sp_config.powerbi_workspace_id:
            raise ValueError("Missing 'powerbi_workspace_id' in Key Vault service principal config.")
        return self._sp_config.powerbi_workspace_id

    def _headers(self) -> dict:
        token = self._credential.get_token("https://analysis.windows.net/powerbi/api/.default").token
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    def _configured_report_ids(self) -> list[str]:
        return [report_id.strip() for report_id in self._sp_config.powerbi_report_ids if report_id and report_id.strip()]

    def _default_embed_url(self, report_id: str) -> str:
        workspace_id = self._workspace_id()
        return f"https://app.powerbi.com/reportEmbed?reportId={report_id}&groupId={workspace_id}"

    def _get_report_in_workspace(self, workspace_id: str, report_id: str) -> PowerBIReport:
        report_url = f"{self.API_BASE}/groups/{workspace_id}/reports/{report_id}"
        response = requests.get(report_url, headers=self._headers(), timeout=30)
        response.raise_for_status()

        payload = response.json()
        return PowerBIReport(
            id=payload["id"],
            name=payload.get("name", payload["id"]),
            embed_url=payload.get("embedUrl", self._default_embed_url(report_id)),
            dataset_id=payload.get("datasetId"),
        )

    def _generate_v2_embed_token(self, report_id: str, workspace_id: str, dataset_id: Optional[str]) -> dict:
        request_body = {
            "reports": [{"id": report_id}],
            "targetWorkspaces": [{"id": workspace_id}],
        }
        if dataset_id:
            request_body["datasets"] = [{"id": dataset_id}]

        embed_token_url = f"{self.API_BASE}/GenerateToken"
        response = requests.post(embed_token_url, json=request_body, headers=self._headers(), timeout=30)
        response.raise_for_status()
        return response.json()

    def _generate_rdl_embed_token(self, workspace_id: str, report_id: str) -> dict:
        generate_token_url = f"{self.API_BASE}/groups/{workspace_id}/reports/{report_id}/GenerateToken"
        response = requests.post(
            generate_token_url,
            json={"accessLevel": "View"},
            headers=self._headers(),
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    def list_reports(self) -> list[PowerBIReport]:
        configured_ids = self._configured_report_ids()
        try:
            workspace_id = self._workspace_id()
            url = f"{self.API_BASE}/groups/{workspace_id}/reports"
            response = requests.get(url, headers=self._headers(), timeout=30)
            response.raise_for_status()

            payload = response.json()
            reports = [
                PowerBIReport(
                    id=item["id"],
                    name=item.get("name", item["id"]),
                    embed_url=item["embedUrl"],
                    dataset_id=item.get("datasetId"),
                )
                for item in payload.get("value", [])
            ]

            allow_list = set(configured_ids)
            if allow_list:
                reports = [report for report in reports if report.id in allow_list]

            reports.sort(key=lambda report: report.name.lower())
            return reports
        except Exception as exc:
            logger.warning("Failed to list reports from Power BI API, fallback to configured report IDs: %s", exc)
            return [
                PowerBIReport(
                    id=report_id,
                    name=report_id,
                    embed_url=self._default_embed_url(report_id),
                    dataset_id=None,
                )
                for report_id in configured_ids
            ]

    def generate_embed_token(self, report_id: str) -> dict:
        report_id = report_id.strip()
        if not report_id:
            raise ValueError("Missing report id.")

        allow_list = set(self._configured_report_ids())
        if allow_list and report_id not in allow_list:
            raise ValueError("Requested report is not available for this user.")

        workspace_id = self._workspace_id()
        report = self._get_report_in_workspace(workspace_id, report_id)

        if report.dataset_id:
            token_payload = self._generate_v2_embed_token(report.id, workspace_id, report.dataset_id)
        else:
            token_payload = self._generate_rdl_embed_token(workspace_id, report.id)

        return {
            "reportId": report.id,
            "reportName": report.name,
            "embedUrl": report.embed_url,
            "token": token_payload["token"],
            "expiration": token_payload.get("expiration"),
            "tokenType": "Embed",
        }
