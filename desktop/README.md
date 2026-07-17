# Meeting-Monster Desktop

This folder contains the pure Electron desktop shell for Meeting-Monster.

## Development

From the repository root:

```powershell
cd desktop
npm install
npm start
```

Electron first probes `http://127.0.0.1:9000/`. If no service is already running, it starts `python -m server.app` with the project `.venv` Python executable and loads the dedicated `renderer/overlay.html` renderer. The shell is a single always-on-top transparent, frameless window with a compact capsule and directly connected expanded panel; drag the header to move it.

Set `MONSTER_OFFER_PROJECT_ROOT` when the Python project is outside the desktop folder. Set `MONSTER_OFFER_PYTHON` to use a specific Python executable.

## Privacy behavior

- Electron content protection is enabled for Meeting-Monster windows by default through `BrowserWindow.setContentProtection(true)`.
- Press `Ctrl+Shift+P` or click the capsule protection button to toggle `setContentProtection(true/false)`.
- The capsule button and expanded status badge report whether window protection is enabled, disabled, unsupported, or failed.
- The taskbar icon remains visible. Minimize-to-tray, if added later, is a normal usability feature and is not a capture-protection mechanism.

Window protection is best-effort OS capture protection. It is not process hiding or anti-monitoring behavior. Phone cameras, hardware capture, privileged tools, and capture paths that ignore the operating-system affinity policy cannot be guaranteed against. During a sensitive meeting, share only the intended window instead of the entire desktop.

The Python service continues to provide local sherpa-onnx ASR at `/ws/asr` and OpenAI Compatible / Anthropic streaming answers at `/api/chat/`.
