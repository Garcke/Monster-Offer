"""Local streaming speech recognition powered by sherpa-onnx."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    import sherpa_onnx


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_DIR = (
    PROJECT_ROOT
    / "models"
    / "sherpa-onnx-streaming-paraformer-bilingual-zh-en"
)


@dataclass(frozen=True)
class RecognitionMessage:
    text: str
    is_end: bool


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc


class LocalASREngine:
    """Load the model once and create an independent stream per connection."""

    def __init__(self, model_dir: str | Path | None = None) -> None:
        try:
            import sherpa_onnx
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError(
                "sherpa-onnx is required for local speech recognition. "
                "Run `python -m pip install -r server/requirements.txt`."
            ) from exc

        configured_dir = model_dir or os.getenv("LOCAL_ASR_MODEL_DIR")
        self.model_dir = Path(configured_dir or DEFAULT_MODEL_DIR).expanduser().resolve()
        self.tokens = self.model_dir / "tokens.txt"
        self.encoder = self.model_dir / "encoder.int8.onnx"
        self.decoder = self.model_dir / "decoder.int8.onnx"
        self._validate_model_files()

        self.sample_rate = 16000
        self.recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(self.tokens),
            encoder=str(self.encoder),
            decoder=str(self.decoder),
            num_threads=_env_int("LOCAL_ASR_NUM_THREADS", 2),
            sample_rate=self.sample_rate,
            feature_dim=80,
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=_env_float(
                "LOCAL_ASR_RULE1_MIN_TRAILING_SILENCE", 2.4
            ),
            rule2_min_trailing_silence=_env_float(
                "LOCAL_ASR_RULE2_MIN_TRAILING_SILENCE", 0.8
            ),
            rule3_min_utterance_length=_env_float(
                "LOCAL_ASR_RULE3_MIN_UTTERANCE_LENGTH", 20.0
            ),
            decoding_method="greedy_search",
            provider="cpu",
        )

    def _validate_model_files(self) -> None:
        missing = [
            str(path)
            for path in (self.tokens, self.encoder, self.decoder)
            if not path.is_file()
        ]
        if not missing:
            return

        missing_lines = "\n".join(f"  - {path}" for path in missing)
        raise FileNotFoundError(
            "Local ASR model is incomplete. Missing files:\n"
            f"{missing_lines}\n"
            "Run `python -m server.scripts.download_asr_model` from the project directory."
        )

    def create_session(self, input_sample_rate: int = 16000) -> "LocalASRSession":
        return LocalASRSession(
            recognizer=self.recognizer,
            input_sample_rate=input_sample_rate,
            model_sample_rate=self.sample_rate,
        )


class LocalASRSession:
    """State for one microphone/WebSocket connection."""

    def __init__(
        self,
        recognizer: Any,
        input_sample_rate: int,
        model_sample_rate: int,
    ) -> None:
        self.recognizer = recognizer
        self.stream = recognizer.create_stream()
        self.input_sample_rate = input_sample_rate
        self.model_sample_rate = model_sample_rate
        self.last_partial = ""
        self.finished = False

    def set_input_sample_rate(self, sample_rate: int) -> None:
        if sample_rate < 8000 or sample_rate > 192000:
            raise ValueError(f"Unsupported input sample rate: {sample_rate}")
        self.input_sample_rate = sample_rate

    def accept_pcm(self, pcm_bytes: bytes) -> list[RecognitionMessage]:
        if self.finished:
            return []
        if not pcm_bytes:
            return []
        if len(pcm_bytes) % 2:
            raise ValueError("PCM payload length must be an even number of bytes")

        samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32)
        samples /= 32768.0
        self.stream.accept_waveform(self.input_sample_rate, samples)
        return self._decode_ready_frames()

    def finish(self) -> list[RecognitionMessage]:
        """Flush the final partial sentence after the browser stops recording."""
        if self.finished:
            return []
        self.finished = True

        # Paraformer needs a short silence tail to flush the final chunk.
        tail = np.zeros(int(0.66 * self.model_sample_rate), dtype=np.float32)
        self.stream.accept_waveform(self.model_sample_rate, tail)
        try:
            self.stream.set_option("is_final", "1")
        except RuntimeError:
            # Older compatible runtimes do not expose this option; input_finished
            # plus the silence tail still performs the flush.
            pass
        self.stream.input_finished()

        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)

        text = self.recognizer.get_result(self.stream).strip()
        if not text:
            return []
        return [RecognitionMessage(text=text, is_end=True)]

    def _decode_ready_frames(self) -> list[RecognitionMessage]:
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)

        text = self.recognizer.get_result(self.stream).strip()
        is_endpoint = self.recognizer.is_endpoint(self.stream)

        if is_endpoint:
            messages = [RecognitionMessage(text=text, is_end=True)] if text else []
            self.recognizer.reset(self.stream)
            self.last_partial = ""
            return messages

        if text and text != self.last_partial:
            self.last_partial = text
            return [RecognitionMessage(text=text, is_end=False)]
        return []
