"""Meeting-Monster text-model API with server-owned model configuration."""

from __future__ import annotations

import asyncio
import json
import os
import threading
from dataclasses import replace
from collections.abc import Callable
from pathlib import Path
from typing import Any, Mapping

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from server.settings.model_profiles import (
    DEFAULT_PROFILE_STORE_PATH,
    ModelConfigurationError,
    ResolvedModelProfile,
    resolve_active_profile,
)
from server.settings.profile_store import ProfileStore, SecretCipher
from server.llm_providers import LLMProvider, create_provider
from server.model_api import create_router as create_model_router


PROMPT_FILE = Path(__file__).resolve().parents[1] / "cache" / "prompt.txt"


class UserMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1)
    profile_id: str | None = Field(default=None, min_length=1)
    max_tokens: int | None = Field(default=None, gt=0)
    temperature: float | None = Field(default=None, ge=0, le=2)


class ModelTestRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile_id: str = Field(min_length=1)
    api_key: str | None = None
    max_tokens: int | None = Field(default=None, gt=0)
    temperature: float | None = Field(default=None, ge=0, le=2)


class PromptMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str


ProfileResolver = Callable[[], ResolvedModelProfile]
ProviderFactory = Callable[[ResolvedModelProfile], LLMProvider]


def create_runtime_profile_store(environ: Mapping[str, str] | None = None) -> ProfileStore:
    """Build the encrypted profile store used by the local API process."""

    environment = os.environ if environ is None else environ
    store_path = Path(
        environment.get("MODEL_PROFILE_STORE_PATH", "").strip() or DEFAULT_PROFILE_STORE_PATH
    )
    master_key = environment.get("MODEL_CONFIG_MASTER_KEY", "").strip()
    return ProfileStore(store_path, SecretCipher(master_key) if master_key else None)


def create_app(
    profile_resolver: ProfileResolver | None = None,
    provider_factory: ProviderFactory = create_provider,
    profile_store: ProfileStore | None = None,
    admin_token: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> FastAPI:
    environment = os.environ if environ is None else environ
    runtime_store = profile_store or create_runtime_profile_store(environment)
    if profile_resolver is None:
        profile_resolver = lambda: runtime_store.resolve_active_profile(environment)
    if admin_token is None:
        admin_token = environment.get("APP_ADMIN_TOKEN", "")

    app = FastAPI(title="Meeting-Monster LLM API")
    app.state.conversation_history = []

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def resolve_profile(
        profile_id: str | None = None,
        api_key: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> ResolvedModelProfile:
        try:
            profile = (
                runtime_store.resolve_active_profile(environment, profile_id, api_key_override=api_key)
                if profile_id
                else profile_resolver()
            )
        except ModelConfigurationError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        if max_tokens is not None or temperature is not None:
            profile = replace(
                profile,
                **{
                    **({"max_tokens": max_tokens} if max_tokens is not None else {}),
                    **({"temperature": temperature} if temperature is not None else {}),
                },
            )
        return profile

    def require_local_client(request: Request) -> None:
        client_host = request.client.host if request.client else ""
        if client_host not in {"127.0.0.1", "::1", "localhost", "testclient"}:
            raise HTTPException(status_code=403, detail="Local model selection is required")

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
        profile = resolve_profile(
            user_message.profile_id,
            None,
            user_message.max_tokens,
            user_message.temperature,
        )
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

    @app.get("/model-options/")
    async def get_model_options(request: Request):
        require_local_client(request)
        try:
            profiles = runtime_store.list_profiles()
        except ModelConfigurationError as exc:
            raise HTTPException(status_code=503, detail="Model options are unavailable") from exc
        active_profile = next(profile.id for profile in profiles if profile.active)
        return {
            "active_profile": active_profile,
            "profiles": [profile.model_dump(exclude={"base_url"}) for profile in profiles],
        }

    @app.post("/model-test/")
    async def test_model(http_request: Request, request: ModelTestRequest):
        require_local_client(http_request)
        profile = resolve_profile(request.profile_id, request.api_key, request.max_tokens, request.temperature)
        short_profile = replace(profile, max_tokens=min(profile.max_tokens, 8))
        started = asyncio.get_running_loop().time()
        received_text = False
        try:
            stream = provider_factory(short_profile).stream_text(
                [{"role": "user", "content": "Reply with OK."}]
            )
            for text in stream:
                if text:
                    received_text = True
                    break
        except Exception as exc:
            raise HTTPException(status_code=422, detail="Model connectivity test failed") from exc
        if not received_text:
            raise HTTPException(status_code=422, detail="Model connectivity test failed")
        return {
            "ok": True,
            "latency_ms": int((asyncio.get_running_loop().time() - started) * 1000),
            "model": short_profile.model,
        }

    @app.get("/health/")
    async def health_check():
        return {"status": "ok"}

    app.include_router(
        create_model_router(
            profile_store=runtime_store,
            admin_token=admin_token,
            provider_factory=provider_factory,
            environ=environment,
        )
    )

    return app


app = create_app()
