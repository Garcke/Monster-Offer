# Meeting-Monster Desktop

This folder contains the pure Electron desktop client. It does not probe, start, or bundle a Python service or an ASR model.

## Development

```powershell
Set-Location desktop
npm ci
npm start
```

In the overlay settings, configure the Python service URL and `APP_ADMIN_TOKEN` for model-management requests. For development, `localhost` or `127.0.0.1` targets may use HTTP/WS. A non-local production service requires HTTPS/WSS. Electron Main connects to that service for chat, model management, and `/ws/asr`; microphone PCM leaves the Electron client for the configured Python service.

## Privacy behavior

- Electron content protection is enabled for Meeting-Monster windows by default through `BrowserWindow.setContentProtection(true)`.
- Press `Ctrl+Shift+P` or click the capsule protection button to toggle `setContentProtection(true/false)`.
- The capsule button and expanded status badge report whether window protection is enabled, disabled, unsupported, or failed.
- The taskbar icon remains visible. Minimize-to-tray, if added later, is a normal usability feature and is not a capture-protection mechanism.

Window protection is best-effort OS capture protection. It is not process hiding or anti-monitoring behavior, and it does not protect microphone PCM sent over the network. Phone cameras, hardware capture, privileged tools, and capture paths that ignore the operating-system affinity policy cannot be guaranteed against. During a sensitive meeting, share only the intended window instead of the entire desktop.
