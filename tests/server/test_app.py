from types import SimpleNamespace
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.app import create_app


class FakeASRSession:
    def __init__(self) -> None:
        self.sample_rate = None

    def set_input_sample_rate(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate

    def accept_pcm(self, data: bytes):
        assert data == b"\x00\x00"
        return [SimpleNamespace(text="临时问题", is_end=False)]

    def finish(self):
        return [SimpleNamespace(text="最终问题", is_end=True)]


class FakeASREngine:
    def __init__(self) -> None:
        self.session = FakeASRSession()

    def create_session(self):
        return self.session


def create_fake_llm_app() -> FastAPI:
    app = FastAPI()

    @app.get("/health/")
    async def health():
        return {"status": "ok"}

    return app


class SourceLayoutTests(unittest.TestCase):
    def test_backend_python_sources_are_not_in_repository_root(self):
        root = Path(__file__).resolve().parents[2]

        self.assertFalse([path.name for path in root.glob("*.py")])
        self.assertTrue((root / "server" / "app.py").is_file())
        self.assertTrue((root / "web" / "index.html").is_file())


class UnifiedServerTests(unittest.TestCase):
    def test_unified_app_serves_frontend_and_mounted_llm_api(self):
        engine = FakeASREngine()
        app = create_app(
            engine_factory=lambda: engine,
            llm_app=create_fake_llm_app(),
        )

        with TestClient(app) as client:
            frontend = client.get("/")
            self.assertEqual(frontend.status_code, 200)
            self.assertIn("Meeting-Monster", frontend.text)
            self.assertEqual(client.get("/api/health/").json(), {"status": "ok"})

    def test_unified_asr_websocket_accepts_audio_and_flushes_final_text(self):
        engine = FakeASREngine()
        app = create_app(
            engine_factory=lambda: engine,
            llm_app=create_fake_llm_app(),
        )

        with TestClient(app) as client:
            with client.websocket_connect("/ws/asr") as websocket:
                websocket.send_json({"type": "audio_config", "sample_rate": 48000})
                websocket.send_bytes(b"\x00\x00")
                self.assertEqual(
                    websocket.receive_json(),
                    {"text": "临时问题", "is_end": False},
                )

                websocket.send_text("stop")
                self.assertEqual(
                    websocket.receive_json(),
                    {"text": "最终问题", "is_end": True},
                )
                self.assertEqual(websocket.receive_text(), "asr stopped")

        self.assertEqual(engine.session.sample_rate, 48000)


if __name__ == "__main__":
    unittest.main()
