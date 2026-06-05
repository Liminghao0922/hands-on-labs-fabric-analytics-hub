# Hands-On Guide - Part 2 (Report Module)

This file is **Part 2** of the hands-on lab: Report module (Power BI App Owned Data).

Complete `HANDS_ON.md` (Part 1) first.

## 1. Scope

Part 2 focuses on:

- Power BI report listing via backend API
- Embed token generation (App Owned Data)
- Report rendering and access control validation

## 2. Report Prerequisites (Delta from Part 1)

1. Prepare one or more reports in the target Power BI workspace. You can use the sample reports for a quick start. Refer to [https://learn.microsoft.com/en-us/power-bi/create-reports/sample-datasets](https://learn.microsoft.com/en-us/power-bi/create-reports/sample-datasets) for more details.
2. Ensure the service principal used in each user profile secret has access to:
   - the Power BI workspace
   - the reports included in `powerbi_report_ids`
3. Ensure tenant setting allows service principals to use Power BI APIs.

## 3. Confirm Key Vault Secret Fields for Report

For each profile secret (`sp-user01-onelake`, `sp-user02-onelake`, etc.), confirm these fields are present:

```json
{
  "powerbi_workspace_id": "<powerbi-workspace-id>",
  "powerbi_report_ids": [
    "<report-guid-1>",
    "<report-guid-2>"
  ]
}
```

Notes:

- `powerbi_workspace_id` is required for report APIs.
- `powerbi_report_ids` works as an allow-list.
- If `powerbi_report_ids` is omitted or empty, all reports in the workspace are returned.

## 4. Local API Validation for Report Endpoints

After starting local services in Part 1, validate report endpoints.

1. Check report list:

```bash
curl http://localhost:7071/api/reports
```

Expected:

- HTTP 200
- JSON with `reports` array

2. Generate embed config:

```bash
curl -X POST http://localhost:7071/api/reports/embed \
  -H "Content-Type: application/json" \
  -d '{"reportId":"<report-guid-1>"}'
```

Expected:

- HTTP 200
- JSON containing `token`, `embedUrl`, `reportId`, `tokenType`

## 5. Portal Validation for Report Screen

1. Open the app via SWA local URL (`http://localhost:4280`) or deployed SWA URL.
2. Navigate to `Power BI Reports` in the top menu.
3. Verify:
   - report dropdown loads
   - selecting a report embeds successfully
   - `Refresh` works
   - `Fullscreen` works

## 6. Multi-User Report Authorization Test

Run the same report test with different `DEV_USER_UPN` values (local) or different Entra users (cloud).

Validate:

1. User01 only sees reports allowed by User01's mapped secret.
2. User02 only sees reports allowed by User02's mapped secret.
3. Access to disallowed report IDs returns controlled error from `/api/reports/embed`.

## 7. Report Deployment Checklist (Production)

Before releasing report capability, recheck:

1. Function App config has `KEY_VAULT_URL` and `USER_SP_MAPPING_SECRET_NAME`.
2. Managed identity has Key Vault `get` and `list` permission.
3. Profile secrets include correct `powerbi_workspace_id` and report IDs.
4. Service principal has workspace/report access in Power BI.
5. SWA is linked to the correct Function App under `APIs`.

## 8. Report Troubleshooting

- **Empty report list**:
  - check `powerbi_workspace_id`
  - check service principal access to workspace
  - check tenant setting for service principal API usage

- **Embed API returns 400 for reportId**:
  - report ID not in `powerbi_report_ids`
  - typo in report GUID

- **Embed API returns 500**:
  - verify Key Vault secret JSON format
  - verify service principal permission in Power BI
  - check Function App logs for Power BI REST error details

- **Local `azure.keyvault` module not found when running `func start`**:
  - use a supported local Python runtime (recommended 3.11/3.12)
  - reinstall dependencies from `api/requirements.txt`
