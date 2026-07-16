"""Single-process web, LLM API, and local streaming ASR server."""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any, Callable

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles


LOGGER = logging.getLogger("meeting-monster")
PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_DIR = PROJECT_ROOT / "static"


def load_local_asr_engine() -> Any:
    """Import the native ASR dependency only when the unified app starts."""
    from local_asr import LocalASREngine

    return LocalASREngine()


class LazyLLMApp:
    """Delay importing the OpenAI SDK until an /api request is received."""

    def __init__(self) -> None:
        self._app = None
        self._lock = asyncio.Lock()

    async def __call__(self, scope, receive, send) -> None:
        if self._app is None:
            async with self._lock:
                if self._app is None:
                    self._app = importlib.import_module("llm_api").app
        await self._app(scope, receive, send)


class AudioServer:
    """Adapts LocalASREngine sessions to FastAPI WebSocket connections."""

    def __init__(self, engine: Any) -> None:
        self.engine = engine
        # Native inference is shared, so serialize decoding across connections.
        self.decode_lock = asyncio.Lock()

    async def handle_client(self, websocket: WebSocket) -> None:
        await websocket.accept()
        session = self.engine.create_session()
        stopped_by_client = False
        LOGGER.info("ASR client connected: %s", websocket.client)

        try:
            while True:
                data = await websocket.receive()
                message_type = data.get("type")
                if message_type == "websocket.disconnect":
                    break

                audio = data.get("bytes")
                if audio is not None:
                    async with self.decode_lock:
                        messages = await asyncio.to_thread(session.accept_pcm, audio)
                    await self._send_messages(websocket, messages)
                    continue

                text = data.get("text")
                if text == "stop":
                    stopped_by_client = True
                    break
                if text is not None:
                    self._handle_control_message(session, text)
        except WebSocketDisconnect:
            LOGGER.info("ASR client disconnected: %s", websocket.client)
        except (TypeError, ValueError) as exc:
            LOGGER.warning("Invalid ASR client data: %s", exc)
            await self._send_error(websocket, str(exc))
        except Exception:
            LOGGER.exception("ASR connection failed")
            await self._send_error(websocket, "Local speech recognition failed")

        if not stopped_by_client:
            return

        try:
            async with self.decode_lock:
                final_messages = await asyncio.to_thread(session.finish)
            await self._send_messages(websocket, final_messages)
            await websocket.send_text("asr stopped")
            LOGGER.info("ASR recognition stopped: %s", websocket.client)
        except WebSocketDisconnect:
            LOGGER.info("ASR client disconnected while flushing")
        except Exception:
            LOGGER.exception("Failed to flush final ASR result")
            await self._send_error(websocket, "Failed to finish speech recognition")

    @staticmethod
    def _handle_control_message(session: Any, message: str) -> None:
        try:
            payload = json.loads(message)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Unknown control message: {message}") from exc

        if payload.get("type") != "audio_config":
            raise ValueError("Unknown control message type")
        session.set_input_sample_rate(int(payload.get("sample_rate", 16000)))

    @staticmethod
    async def _send_messages(websocket: WebSocket, messages: list[Any]) -> None:
        for message in messages:
            await websocket.send_json(
                {"text": message.text, "is_end": message.is_end},
                mode="text",
            )

    @staticmethod
    async def _send_error(websocket: WebSocket, message: str) -> None:
        with suppress(RuntimeError, WebSocketDisconnect):
            await websocket.send_json({"event": "error", "message": message})


def create_app(
    engine_factory: Callable[[], Any] = load_local_asr_engine,
    llm_app: Any | None = None,
) -> FastAPI:
    """Build the unified application; dependencies are injectable for tests."""

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        LOGGER.info("Loading local Paraformer model...")
        engine = await asyncio.to_thread(engine_factory)
        application.state.audio_server = AudioServer(engine)
        model_dir = getattr(engine, "model_dir", None)
        if model_dir:
            LOGGER.info("Local ASR model loaded from %s", model_dir)
        else:
            LOGGER.info("Local ASR engine loaded")
        yield

    application = FastAPI(
        title="Meeting-Monster",
        lifespan=lifespan,
    )

    @application.websocket("/ws/asr")
    async def asr_websocket(websocket: WebSocket) -> None:
        await application.state.audio_server.handle_client(websocket)

    # API and WebSocket routes must be registered before the catch-all static mount.
    application.mount("/api", llm_app or LazyLLMApp(), name="api")
    application.mount(
        "/",
        StaticFiles(directory=STATIC_DIR, html=True),
        name="static",
    )
    return application


app = create_app()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    host = os.getenv("APP_HOST", "127.0.0.1")
    port = int(os.getenv("APP_PORT", "9000"))
    LOGGER.info("Starting Meeting-Monster at http://%s:%s", host, port)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        LOGGER.info("Server stopped")
    except (FileNotFoundError, ValueError, ModuleNotFoundError) as exc:
        LOGGER.error("%s", exc)
        raise SystemExit(1) from exc
