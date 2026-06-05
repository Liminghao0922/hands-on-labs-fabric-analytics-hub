from dataclasses import dataclass
from typing import Optional

import requests
from azure.identity import ClientSecretCredential

from .keyvault import ServicePrincipalConfig


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

    def list_reports(self) -> list[PowerBIReport]:
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

        allow_list = {report_id.strip() for report_id in self._sp_config.powerbi_report_ids if report_id.strip()}
        if allow_list:
            reports = [report for report in reports if report.id in allow_list]

        reports.sort(key=lambda report: report.name.lower())
        return reports

    def generate_embed_token(self, report_id: str) -> dict:
        report_id = report_id.strip()
        if not report_id:
            raise ValueError("Missing report id.")

        reports = self.list_reports()
        target = next((report for report in reports if report.id == report_id), None)
        if not target:
            raise ValueError("Requested report is not available for this user.")

        workspace_id = self._workspace_id()
        generate_token_url = f"{self.API_BASE}/groups/{workspace_id}/reports/{report_id}/GenerateToken"
        token_response = requests.post(
            generate_token_url,
            headers=self._headers(),
            json={"accessLevel": "View", "allowSaveAs": False},
            timeout=30,
        )
        token_response.raise_for_status()

        token_payload = token_response.json()
        return {
            "reportId": target.id,
            "reportName": target.name,
            "embedUrl": target.embed_url,
            "token": token_payload["token"],
            "expiration": token_payload.get("expiration"),
            "tokenType": "Embed",
        }
