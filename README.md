# Meeting-Monster

Meeting-Monster provides live interview assistance with a Python service, a same-origin Web client, and a separate Electron desktop client.

## Python service

The Python service hosts the Web client plus `/api/chat/`, `/api/models/`, and `/ws/asr`. It owns the local ASR model and operator-managed model configuration.

Set up the service and download its ASR model:

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -r server\requirements.txt
.\.venv\Scripts\python.exe -m server.scripts.download_asr_model
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m server.app
```

The Web client opens at the Python service origin and sends microphone PCM to that same service over `/ws/asr`.

## Text-model configuration

Non-secret provider defaults live in [`server/config/default_model_profiles.json`](server/config/default_model_profiles.json). Its `active_profile` selects the default profile; set `LLM_ACTIVE_PROFILE` in `.env` to override that selection without editing the file.

Each provider profile declares an `api_key_env` name. Put the active provider key in `.env` under that named variable. The Web client has no model settings UI. Desktop settings can manage remote profiles through the protected model-management API using `APP_ADMIN_TOKEN`.

## Electron desktop client

The Electron client contains no Python runtime or ASR model. Configure the Python service URL and the model-management admin token in the overlay settings; Electron Main connects to that configured service and sends microphone PCM to it. See [desktop/README.md](desktop/README.md) for local desktop development.

## Remote deployment and security

Public deployments must use HTTPS and WSS behind a protected network boundary or reverse proxy. `APP_ADMIN_TOKEN` protects model-management endpoints only; the MVP `/api/chat/` and `/ws/asr` endpoints do not use it. Restrict access to those public endpoints at the network or reverse-proxy layer as appropriate for the deployment.

PCM leaves the Electron client for the configured Python service during ASR. `BrowserWindow.setContentProtection` is best-effort protection for the application window and does not protect network audio.

## Testing

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests/server -p "test_*.py" -v
Set-Location desktop
npm ci
npm run desktop-test
```
