"""Protected single-user model profile management routes."""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import replace
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from server.llm_providers import LLMProvider
from server.settings.model_profiles import ModelConfigurationError, ResolvedModelProfile
from server.settings.profile_store import ModelProfileInput, ProfileStore, PublicModelProfile


ProviderFactory = Callable[[ResolvedModelProfile], LLMProvider]
CONNECTIVITY_PROMPT = "Reply with OK."


class StoredProfileTestRequest(BaseModel):
    """Select a stored profile, optionally replacing its key for one test."""

    model_config = ConfigDict(extra="forbid")

    profile_id: str = Field(min_length=1)
    api_key: str | None = None

    @field_validator("profile_id", "api_key", mode="before")
    @classmethod
    def strip_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


def create_router(
    *,
    profile_store: ProfileStore,
    admin_token: str | None,
    provider_factory: ProviderFactory,
    environ: Mapping[str, str],
) -> APIRouter:
    """Build management endpoints with explicit dependencies for local use and tests."""

    router = APIRouter(prefix="/models", tags=["models"])

    def storage_error() -> HTTPException:
        return HTTPException(status_code=503, detail="Model profile storage is unavailable")

    def profiles() -> list[PublicModelProfile]:
        try:
            return profile_store.list_profiles()
        except ModelConfigurationError as exc:
            raise storage_error() from exc

    def public(profile: PublicModelProfile) -> dict[str, Any]:
        return profile.model_dump()

    def parse_profile(payload: dict[str, Any]) -> ModelProfileInput:
        try:
            return ModelProfileInput.model_validate(payload)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="Invalid model profile") from exc

    async def request_payload(request: Request) -> dict[str, Any]:
        try:
            payload = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=422, detail="Invalid model request") from exc
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="Invalid model request")
        return payload

    def find_profile(profile_id: str) -> PublicModelProfile:
        for profile in profiles():
            if profile.id == profile_id:
                return profile
        raise HTTPException(status_code=404, detail="Model profile was not found")

    async def require_admin(
        authorization: str | None = Header(default=None, alias="Authorization"),
    ) -> None:
        if not admin_token:
            raise HTTPException(status_code=503, detail="Model management is not configured")
        if authorization is None:
            raise HTTPException(status_code=401, detail="Authorization is required")
        scheme, _, supplied_token = authorization.partition(" ")
        if scheme != "Bearer" or not supplied_token or not secrets.compare_digest(
            supplied_token, admin_token
        ):
            raise HTTPException(status_code=403, detail="Authorization is invalid")

    @router.get("/", dependencies=[Depends(require_admin)])
    async def list_models() -> dict[str, Any]:
        current_profiles = profiles()
        active = next(profile.id for profile in current_profiles if profile.active)
        return {"active_profile": active, "profiles": [public(profile) for profile in current_profiles]}

    @router.post("/", dependencies=[Depends(require_admin)])
    async def create_model(request: Request) -> JSONResponse:
        payload = await request_payload(request)
        profile_input = parse_profile(payload)
        if any(profile.id == profile_input.id for profile in profiles()):
            raise HTTPException(status_code=409, detail="Model profile already exists")
        try:
            created = profile_store.create_profile(profile_input)
        except (ModelConfigurationError, ValidationError) as exc:
            raise HTTPException(status_code=422, detail="Unable to create model profile") from exc
        return JSONResponse(status_code=201, content=public(created))

    @router.put("/{profile_id}", dependencies=[Depends(require_admin)])
    async def update_model(profile_id: str, request: Request) -> dict[str, Any]:
        payload = await request_payload(request)
        profile_input = parse_profile(payload)
        find_profile(profile_id)
        if profile_input.id != profile_id:
            raise HTTPException(status_code=422, detail="Model profile id cannot be changed")
        try:
            return public(profile_store.update_profile(profile_id, profile_input))
        except (ModelConfigurationError, ValidationError) as exc:
            raise HTTPException(status_code=422, detail="Unable to update model profile") from exc

    @router.delete("/{profile_id}", dependencies=[Depends(require_admin)], status_code=204)
    async def delete_model(profile_id: str) -> Response:
        current_profiles = profiles()
        profile = next((item for item in current_profiles if item.id == profile_id), None)
        if profile is None:
            raise HTTPException(status_code=404, detail="Model profile was not found")
        if len(current_profiles) == 1:
            raise HTTPException(status_code=409, detail="Cannot delete the last model profile")
        if profile.active:
            raise HTTPException(status_code=409, detail="Cannot delete the active model profile")
        try:
            profile_store.delete_profile(profile_id)
        except ModelConfigurationError as exc:
            raise storage_error() from exc
        return Response(status_code=204)

    @router.post("/{profile_id}/activate", dependencies=[Depends(require_admin)])
    async def activate_model(profile_id: str) -> dict[str, Any]:
        find_profile(profile_id)
        try:
            activated = profile_store.activate_profile(profile_id)
        except ModelConfigurationError as exc:
            raise storage_error() from exc
        return {"active_profile": activated.id, "profile": public(activated)}

    def resolve_candidate_profile(payload: dict[str, Any]) -> ResolvedModelProfile:
        candidate_payload = payload.get("profile", payload)
        if not isinstance(candidate_payload, dict):
            raise HTTPException(status_code=422, detail="Invalid model test request")
        candidate = parse_profile(candidate_payload)
        if candidate.api_key_required and not candidate.api_key:
            raise HTTPException(status_code=422, detail="A temporary API key is required for this test")
        return ResolvedModelProfile(
            profile_id=candidate.id,
            label=candidate.label,
            protocol=candidate.protocol,
            base_url=candidate.base_url,
            model=candidate.model,
            api_key=candidate.api_key or "not-needed",
            max_tokens=candidate.max_tokens,
            temperature=candidate.temperature,
            top_p=candidate.top_p,
            extra_headers=dict(candidate.extra_headers),
            extra_body=dict(candidate.extra_body),
        )

    def resolve_stored_profile(payload: dict[str, Any]) -> ResolvedModelProfile:
        try:
            request = StoredProfileTestRequest.model_validate(payload)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="Invalid model test request") from exc
        find_profile(request.profile_id)
        try:
            profile = profile_store.resolve_active_profile(
                environ,
                request.profile_id,
                api_key_override=request.api_key,
            )
        except ModelConfigurationError as exc:
            raise HTTPException(status_code=422, detail="Unable to resolve model profile for testing") from exc
        return profile

    @router.post("/test", dependencies=[Depends(require_admin)])
    async def test_model(request: Request) -> dict[str, Any]:
        payload = await request_payload(request)
        profile = (
            resolve_stored_profile(payload)
            if "profile_id" in payload
            else resolve_candidate_profile(payload)
        )
        short_profile = replace(profile, max_tokens=min(profile.max_tokens, 8))
        started = time.perf_counter()
        received_text = False
        try:
            stream = provider_factory(short_profile).stream_text(
                [{"role": "user", "content": CONNECTIVITY_PROMPT}]
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
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "model": short_profile.model,
        }

    return router
