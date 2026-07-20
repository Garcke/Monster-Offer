# Meeting-Monster Desktop

This folder contains the pure Electron desktop client. It does not probe, start, or bundle a Python service or an ASR model.

## Development

```powershell
Set-Location desktop
npm ci
npm start
```

The overlay uses the local Python service at `http://127.0.0.1:9000/` by default. Configure model profiles, provider URLs, model names, and provider keys in the Python backend (`server/config/default_model_profiles.json` and `.env`). Electron only reads a redacted model catalog, keeps the selected `profile_id` for the current request, and never asks for a separate ASR URL. The ASR WebSocket is derived automatically as `/ws/asr`; microphone PCM leaves the Electron client for that local Python service.

The model drawer keeps model type, optional API Key, maximum tokens, temperature, connection testing, and model selection. It does not create, edit, or delete backend profiles. For development, `localhost` or `127.0.0.1` targets may use HTTP/WS. A non-local production service requires HTTPS/WSS and should be wired through the application deployment configuration rather than the Electron UI.

The backend exposes `/api/model-options/` for the redacted catalog and `/api/model-test/` for a local connection test. Selecting a model sends only its `profile_id` with the chat request; it does not rewrite `active_profile` or the backend profile file.

## Privacy behavior

- Electron content protection is enabled for Meeting-Monster windows by default through `BrowserWindow.setContentProtection(true)`.
- Press `Ctrl+Shift+P` or click the capsule protection button to toggle `setContentProtection(true/false)`.
- The capsule button and expanded status badge report whether window protection is enabled, disabled, unsupported, or failed.
- The taskbar icon remains visible. Minimize-to-tray, if added later, is a normal usability feature and is not a capture-protection mechanism.

Window protection is best-effort OS capture protection. It is not process hiding or anti-monitoring behavior, and it does not protect microphone PCM sent over the network. Phone cameras, hardware capture, privileged tools, and capture paths that ignore the operating-system affinity policy cannot be guaranteed against. During a sensitive meeting, share only the intended window instead of the entire desktop.
