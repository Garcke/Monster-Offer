# Meeting-Monster Desktop

This folder contains the Windows-first Electron shell for Meeting-Monster.

## Development

From the repository root:

```powershell
cd desktop
npm install
npm start
```

Electron first probes `http://127.0.0.1:9000/`. If no service is already running, it starts `server.py` with the project `.venv` Python executable and loads the existing web frontend.

Set `MONSTER_OFFER_PROJECT_ROOT` when the Python project is outside the desktop folder. Set `MONSTER_OFFER_PYTHON` to use a specific Python executable.

## Privacy behavior

- Window capture protection is enabled for Meeting-Monster windows by default.
- Press `Ctrl+Shift+P` or click `开启脱敏` to hide transcript, questions, answers, and model details behind the local privacy shield.
- The shield does not send new audio or text requests and can be dismissed locally.
- The status badge reports whether the system-level protection is protected, unsupported, or failed.
- The taskbar icon remains visible. Minimize-to-tray, if added later, is a normal usability feature and is not a capture-protection mechanism.

Window protection is best-effort. Phone cameras, hardware capture, privileged tools, and capture paths that ignore the operating-system affinity policy cannot be guaranteed against. During a sensitive meeting, share only the intended window instead of the entire desktop.

The Python service continues to provide local sherpa-onnx ASR at `/ws/asr` and OpenAI Compatible / Anthropic streaming answers at `/api/chat/`.
