# Hands-On Guide

This file is **Part 1** of the hands-on lab: File Management foundation.

For **Part 2 (Report / Power BI App Owned Data)**, continue in `HANDS_ON_REPORT.md`.

## 1. Prerequisites

- Azure subscription with Azure Static Web Apps and Key Vault access
- Microsoft Fabric workspace and lakehouse
- Two Microsoft Entra test users (example: `user01@contoso.com`, `user02@contoso.com`)
- Two service principals with OneLake folder-level permissions
- Python 3.10+
- Node.js 18+
- Azure Functions Core Tools v4
- SWA CLI

Install SWA CLI:

```bash
npm install -g @azure/static-web-apps-cli
```

### Minimum App Registration Checklist (Web Login)

Before local or cloud sign-in tests, prepare one Microsoft Entra app registration for Azure Static Web Apps authentication:

1. Create an app registration (single-tenant recommended for internal demo).
2. Add platform type: **Single-page application (SPA)**.
3. Configure redirect URIs:
  - `http://localhost:4280` (recommended local URI when accessing through SWA CLI)
  - `http://localhost:5173` (optional, only when testing Vite directly)
  - `https://<your-static-web-app-domain>` (production)
4. Grant delegated permissions: `openid`, `profile`, `email` (and `User.Read` if required by tenant policy).
5. Configure this app registration in Azure Static Web Apps Authentication provider settings.

Note: This project uses SWA authentication and backend token generation. Frontend MSAL configuration is not required.

## 2. Prepare Service Principals

Create two service principals in Microsoft Entra ID. You will use their client IDs and secrets for OneLake access.

### Steps

1. Open Azure CLI or Azure Portal, then create the first service principal:

```bash
az ad sp create-for-rbac --name "sp-onelake-user01" --skip-assignment
```

For this demo, do not grant Azure subscription RBAC roles (such as Contributor). OneLake folder permissions are configured in Fabric UI. The output will show:
- `appId` (this is the client ID)
- `password` (this is the client secret)
- `tenant` (this is the tenant ID)

Save these values securely.

2. Create the second service principal:

```bash
az ad sp create-for-rbac --name "sp-onelake-user02" --skip-assignment
```

3. Note down the credentials for both SPs:
   - SP01: appId, password, tenant
   - SP02: appId, password, tenant

4. (Optional) If you need to reset the password for an existing SP:

```bash
az ad sp credential reset --id <appId> --append
```

5. Verify the service principal was created:

```bash
az ad sp show --id <appId>
```

## 3. Prepare OneLake Folders and Permissions

Create folders in your Fabric lakehouse and configure folder-level permissions for each service principal.

### Steps

1. Sign in to [Fabric.microsoft.com](https://fabric.microsoft.com).

2. Open your workspace and navigate to the lakehouse.

3. In the **Files** section, create the following folders by right-clicking and selecting **New Folder**:
   - `customer01`
   - `customer02`
   - `customer03` (optional, for read-only demo)

4. For each folder, configure folder-level access:

   **For customer01 (SP01 - Read & Write):**
   - Right-click `customer01` → **Manage access**
   - Click **+ Add permissions**
   - Enter SP01's app ID (from service principal creation)
   - Select **Read** and **Write** permissions
   - Click **Save**

   **For customer02 (SP02 - Read & Write):**
   - Right-click `customer02` → **Manage access**
   - Click **+ Add permissions**
   - Enter SP02's app ID
   - Select **Read** and **Write** permissions
   - Click **Save**

   **For customer03 (Optional - Read-only demo):**
   - Right-click `customer03` → **Manage access**
   - Click **+ Add permissions**
   - Enter SP01's or SP02's app ID
   - Select **Read** only (no Write)
   - Click **Save**

5. Verify permissions are set correctly. You can see the list of users/SPs with access by clicking **Manage access** again.

6. (Optional) Add some sample files to test:
   - Upload a few test files to `customer01`, `customer02`, etc.
   - These will help verify the app is working correctly

## 4. Prepare Key Vault Secrets

Create one secret per service principal in Azure Key Vault, where the secret value is a JSON object containing OneLake and Power BI access settings.

### Steps

1. Ensure you have an Azure Key Vault. If not, create one:

```bash
az keyvault create --name "kv-onelake-demo" --resource-group "<your-resource-group>" --location <region>
```

2. Create the first Key Vault secret for SP01:

```bash
az keyvault secret set --vault-name "kv-onelake-demo" --name "sp-user01-onelake" --value '{
  "tenant_id": "<tenant-guid>",
  "client_id": "<sp01-appId>",
  "client_secret": "<sp01-password>",
  "onelake_account_name": "onelake",
  "workspace_name": "<fabric-workspace-name>",
  "lakehouse_name": "<fabric-lakehouse-name>",
  "root_path": "<fabric-lakehouse-name>.Lakehouse/Files",
  "powerbi_workspace_id": "<powerbi-workspace-id>",
  "powerbi_report_ids": [
    "<report-guid-1>",
    "<report-guid-2>"
  ]
}'
```

Replace placeholders:
- `<tenant-guid>`: Your Azure AD tenant ID (from SP creation output)
- `<sp01-appId>`: The appId from SP01 creation
- `<sp01-password>`: The password from SP01 creation
- `<fabric-workspace-name>`: Your Fabric workspace name
- `<fabric-lakehouse-name>`: Your Fabric lakehouse name
- `<powerbi-workspace-id>`: The GUID of the Power BI workspace
- `powerbi_report_ids`: Optional allow-list of report IDs visible in the portal

You can also start from `api/config/service_principal_secret.sample.json` and paste its contents into your Key Vault secret value.

3. Create the second Key Vault secret for SP02:

```bash
az keyvault secret set --vault-name "kv-onelake-demo" --name "sp-user02-onelake" --value '{
  "tenant_id": "<tenant-guid>",
  "client_id": "<sp02-appId>",
  "client_secret": "<sp02-password>",
  "onelake_account_name": "onelake",
  "workspace_name": "<fabric-workspace-name>",
  "lakehouse_name": "<fabric-lakehouse-name>",
  "root_path": "<fabric-lakehouse-name>.Lakehouse/Files",
  "powerbi_workspace_id": "<powerbi-workspace-id>",
  "powerbi_report_ids": [
    "<report-guid-1>",
    "<report-guid-2>"
  ]
}'
```

4. Verify the secrets were created:

```bash
az keyvault secret list --vault-name "kv-onelake-demo"
```

5. To retrieve a secret value for verification:

```bash
az keyvault secret show --vault-name "kv-onelake-demo" --name "sp-user01-onelake"
```

## 5. Configure User Mapping

Recommended for deployment: store mapping JSON in Key Vault and use local file as fallback for development.

1. Create a Key Vault secret for user mapping:

```bash
az keyvault secret set --vault-name "kv-onelake-demo" --name "user-sp-mapping" --value '{
  "users": {
    "user01@contoso.com": "sp-user01-onelake",
    "user02@contoso.com": "sp-user02-onelake"
  }
}'
```

2. (Optional local fallback) Edit `api/config/user_sp_mapping.json`:

Edit `api/config/user_sp_mapping.json` to map Entra ID users to Key Vault secret names:

```json
{
  "users": {
    "user01@contoso.com": "sp-user01-onelake",
    "user02@contoso.com": "sp-user02-onelake"
  }
}
```

Notes:
- The mapping is UPN -> SP secret name only.
- Folder-level permissions are already configured in Fabric OneLake UI (step 3).
- The app will enforce these OneLake permissions at runtime.
- Runtime order is: Key Vault mapping secret -> local file fallback.

## 6. Local Run

### Prerequisites

- Azure CLI installed and logged in:
  ```bash
  az login
  ```

- If using local Key Vault access, ensure your Azure CLI account has permissions to read Key Vault secrets.

### Steps

1. Copy the settings template:

```bash
copy api\local.settings.sample.json api\local.settings.json
```

2. Update `api/local.settings.json` with your Key Vault URL and configuration:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "python",
    "KEY_VAULT_URL": "https://kv-onelake-demo.vault.azure.net/",
    "USER_SP_MAPPING_SECRET_NAME": "user-sp-mapping",
    "USER_SP_MAPPING_FILE": "config/user_sp_mapping.json",
    "USER_SP_MAPPING_ALLOW_FILE_FALLBACK": "true",
    "ALLOW_LOCAL_DEV_AUTH": "true",
    "DEV_USER_UPN": "user01@contoso.com"
  }
}
```

Replace `kv-onelake-demo` with your actual Key Vault name.

**Important:** When `ALLOW_LOCAL_DEV_AUTH=true`, the app will use `DEV_USER_UPN` instead of Entra ID. This is for local development only.

3. Install Python dependencies:

```bash
cd api
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

4. Run Azure Functions API in one terminal:

```bash
cd api
func start
```

You should see output like:
```
Azure Functions Core Tools
...
Now listening on: http://0.0.0.0:7071
```

5. In a new terminal, run the SWA CLI for frontend + local proxy:

```bash
swa start http://localhost:5173 --api-location api --app-location frontend
```

The command will start:
- Frontend dev server on port 5173
- Local static web app (SWA) auth/proxy on port 4280

You should see output showing:
```
...
Welcome to Azure Static Web Apps CLI!
...
Local server running at http://localhost:4280
```

6. Open the URL shown (typically `http://localhost:4280`) in your browser.

7. The app will:
   - Auto-detect you're logged in as `user01@contoso.com` (due to local dev settings)
  - Show unified portal navigation
  - Let you select folders and browse files
  - Let you open embedded Power BI reports

8. To test with different users, change `DEV_USER_UPN` in `local.settings.json` and restart the Functions host.

### Troubleshooting

- **"Failed to list files"**: Check that the SP has permission in Fabric OneLake for the folder.
- **"Unauthorized"**: Ensure `ALLOW_LOCAL_DEV_AUTH=true` and `DEV_USER_UPN` is set.
- **Key Vault authentication error**: Run `az login` to ensure your CLI is authenticated.

## 7. Deploy with Azure DevOps / Azure Repos

### Steps

1. Create an Azure DevOps project and an empty Azure Repos repository.

2. Push this workspace to Azure Repos:

```bash
git remote add azure https://dev.azure.com/<org>/<project>/_git/<repo>
git push -u azure main
```

If you already have an `azure` remote, use `git remote set-url azure <url>` instead.

3. In Azure DevOps, create these resources:
  - One service connection for the Azure subscription that hosts the Function App and Static Web App
  - One variable group or secret variable set with `AZURE_SERVICE_CONNECTION`, `FUNCTION_APP_NAME`, and `AZURE_STATIC_WEB_APPS_API_TOKEN`

4. Create a pipeline from [azure-pipelines.yml](azure-pipelines.yml).

5. Ensure the Function App has these application settings:
  - `KEY_VAULT_URL`: `https://kv-onelake-demo.vault.azure.net/`
  - `USER_SP_MAPPING_SECRET_NAME`: `user-sp-mapping`
  - `USER_SP_MAPPING_ALLOW_FILE_FALLBACK`: `false`
  - Optional: `USER_SP_MAPPING_FILE`: `config/user_sp_mapping.json`

6. Enable managed identity on the Functions app and grant it access to Key Vault:

```bash
# Get the Functions app's managed identity (principal ID)
PRINCIPAL_ID=$(az functionapp identity show --name "<your-functions-app>" \
  --resource-group "<your-resource-group>" \
  --query "principalId" --output tsv)

# Grant Key Vault secret read access
az keyvault set-policy --name "kv-onelake-demo" \
  --object-id "$PRINCIPAL_ID" \
  --secret-permissions get list
```

7. In Azure Portal, go to your Static Web App → **APIs** and link the deployed Function App under **Production**.

8. In Azure Portal, configure Entra ID authentication for the Static Web App:
  - Go to **Settings** → **Authentication**
  - Click **Add** → **Entra ID**
  - Fill in app registration details or create a new one
  - Set **Restricted access** to **Require authentication**

9. Commit and push any code changes to `main`. The pipeline will:
  - Publish the Function App first
  - Build the frontend
  - Deploy the Azure Static Web App

10. After the pipeline finishes, verify the Static Web App URL in Azure Portal.

### Troubleshooting

- **403 Forbidden**: Ensure the managed identity has Secret Get/List permissions on Key Vault.
- **Unauthorized (Entra ID)**: Verify the Entra ID app registration is correctly configured in Static Web Apps.
- **"Key Vault not found"**: Ensure `KEY_VAULT_URL` is correctly set in app settings.
- **"Failed to load user mapping configuration"**: Verify `USER_SP_MAPPING_SECRET_NAME` exists and contains valid JSON.
- **API 404 from SWA**: Confirm the Functions app is linked under SWA → APIs and the backend is publicly reachable.

## 8. Validation Checklist

- User01 can access customer01, customer02, customer03 (depending on SP01 permissions in Fabric)
- User02 can access only folders where SP02 has permission (configured in Fabric)
- Upload succeeds when SP has write permission in Fabric
- Upload fails with permission error when SP lacks write permission
- Downloaded ZIP contains all selected files
- Folder-level access is fully controlled by Fabric OneLake permissions, not application logic
- Power BI report list follows `powerbi_report_ids` allow-list when provided
- Power BI reports load via backend-generated embed tokens (App Owned Data)

Next step:

- Continue with Part 2 in `HANDS_ON_REPORT.md`
