# Deployment Checklist (SWA + Linked Functions)

## 1. Azure Resources

- Azure DevOps project and Azure Repos repository are created.
- Azure Static Web App is created.
- Azure Function App is created (Python, v4 runtime).
- Azure Key Vault is created.
- Static Web App is linked to the Function App under APIs.

## 2. Required Azure DevOps Variables

Set these variables in the pipeline or variable group for [azure-pipelines.yml](azure-pipelines.yml).

### Main pipeline

- `AZURE_SERVICE_CONNECTION`
- `AZURE_STATIC_WEB_APPS_API_TOKEN`
- `FUNCTION_APP_NAME`
- `NODE_VERSION` (optional override)
- `PYTHON_VERSION` (optional override)

### Legacy split pipelines

If you still use the single-target pipeline files, keep these variables available.

#### For `azure-pipelines-swa.yml`

- `AZURE_STATIC_WEB_APPS_API_TOKEN`

#### For `azure-pipelines-functions.yml`

- `AZURE_SERVICE_CONNECTION`
- `FUNCTION_APP_NAME`

## 3. Function App Configuration

Add these application settings to the Function App.

- `KEY_VAULT_URL=https://<your-kv-name>.vault.azure.net/`
- `USER_SP_MAPPING_SECRET_NAME=user-sp-mapping`
- `USER_SP_MAPPING_ALLOW_FILE_FALLBACK=false`
- `USER_SP_MAPPING_FILE=config/user_sp_mapping.json` (optional fallback)

## 4. Key Vault Secrets

### 4.1 User mapping secret

Secret name: `user-sp-mapping`

Sample value:

```json
{
  "users": {
    "user01@contoso.com": "sp-user01-onelake",
    "user02@contoso.com": "sp-user02-onelake"
  }
}
```

### 4.2 Service principal profile secrets

Create one secret per profile (for example `sp-user01-onelake`) using:

- `api/config/service_principal_secret.sample.json`

## 5. Access Setup

- Function App managed identity has `get` and `list` permissions on Key Vault secrets.
- Each service principal has OneLake folder permissions in Fabric.
- Each service principal has access to target Power BI workspace and reports.
- Power BI tenant allows service principals for API access.

## 6. Validation After Deployment

- Azure DevOps pipeline completes successfully on `main`.
- Function App is deployed before the Static Web App.
- Function App deployment uses zipDeploy, not `func azure functionapp publish --build remote`, when shared key access is disabled on the storage account.
- Sign-in succeeds through SWA auth.
- `/api/profile` returns current user.
- File list/upload/download/delete work according to folder permissions.
- `/api/reports` returns allowed reports.
- `/api/reports/embed` returns token and report embeds successfully.

## 7. Rollback Hint

If new release fails, redeploy last successful frontend artifact and last successful Function App package, then verify Key Vault settings were not changed.
