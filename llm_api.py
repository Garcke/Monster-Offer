"""Meeting-Monster text-model API with server-owned model configuration."""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from config.model_profiles import (
    ModelConfigurationError,
    ResolvedModelProfile,
    resolve_active_profile,
)
from llm_providers import LLMProvider, create_provider


PROMPT_FILE = Path(__file__).resolve().parent / "cache" / "prompt.txt"


class UserMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1)


class PromptMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str


ProfileResolver = Callable[[], ResolvedModelProfile]
ProviderFactory = Callable[[ResolvedModelProfile], LLMProvider]


def create_app(
    profile_resolver: ProfileResolver = resolve_active_profile,
    provider_factory: ProviderFactory = create_provider,
) -> FastAPI:
    app = FastAPI(title="Meeting-Monster LLM API")
    app.state.conversation_history = []

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def resolve_profile() -> ResolvedModelProfile:
        try:
            return profile_resolver()
        except ModelConfigurationError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/prompt/")
    async def get_prompt():
        try:
            prompt = PROMPT_FILE.read_text(encoding="utf-8")
        except OSError as exc:
            raise HTTPException(status_code=500, detail="无法读取系统提示词") from exc
        return {"prompt": prompt}

    @app.post("/set_prompt/")
    async def set_prompt(prompt_message: PromptMessage):
        history: list[dict[str, str]] = app.state.conversation_history
        non_system_messages = [item for item in history if item.get("role") != "system"]
        history[:] = [
            {"role": "system", "content": prompt_message.prompt},
            *non_system_messages,
        ]
        return {"message": "Prompt has been set."}

    @app.post("/chat/")
    async def chat(user_message: UserMessage):
        profile = resolve_profile()
        try:
            provider = provider_factory(profile)
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"无法初始化模型客户端: {exc}") from exc

        history: list[dict[str, str]] = app.state.conversation_history
        user_entry = {"role": "user", "content": user_message.content.strip()}
        history.append(user_entry)
        request_messages = [dict(item) for item in history]

        async def stream_response():
            yield ": stream start\n\n"
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

            def publish(kind: str, value: Any = None) -> None:
                loop.call_soon_threadsafe(queue.put_nowait, (kind, value))

            def consume_stream() -> None:
                try:
                    for text in provider.stream_text(request_messages):
                        if text:
                            publish("chunk", text)
                except Exception as exc:
                    publish("error", str(exc))
                finally:
                    publish("done")

            threading.Thread(target=consume_stream, daemon=True).start()
            assistant_message = ""
            stream_failed = False

            while True:
                kind, value = await queue.get()
                if kind == "chunk":
                    assistant_message += value
                    payload = json.dumps({"response": value}, ensure_ascii=False)
                    yield f"event: chunk\ndata: {payload}\n\n"
                elif kind == "error":
                    stream_failed = True
                    payload = json.dumps({"detail": value}, ensure_ascii=False)
                    yield f"event: error\ndata: {payload}\n\n"
                elif kind == "done":
                    break

            if assistant_message and not stream_failed:
                history.append({"role": "assistant", "content": assistant_message})
            yield "event: done\ndata: {}\n\n"

        return StreamingResponse(
            stream_response(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/history/")
    async def get_history():
        return {"history": app.state.conversation_history}

    @app.post("/reset/")
    async def reset_history():
        app.state.conversation_history = []
        return {"message": "Conversation history has been reset."}

    @app.get("/model-config/")
    async def get_model_config():
        return resolve_profile().public_summary()

    @app.get("/models/")
    async def list_models():
        summary = resolve_profile().public_summary()
        return {
            **summary,
            "default": summary["model"],
            "models": [summary["model"]],
        }

    @app.get("/health/")
    async def health_check():
        return {"status": "ok"}

    return app


app = create_app()
