"""Server-side model profile loading and validation."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Mapping
from urllib.parse import urlparse

from dotenv import load_dotenv
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SETTINGS_PATH = (
    Path(__file__).resolve().parents[1] / "config" / "default_model_profiles.json"
)
DEFAULT_PROFILE_STORE_PATH = PROJECT_ROOT / "cache" / "model_profiles.json"


class ModelConfigurationError(RuntimeError):
    """Raised when the server-side model configuration cannot be used."""


class ModelProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1)
    protocol: Literal["openai", "anthropic"]
    base_url: str = Field(min_length=1)
    model: str = Field(min_length=1)
    api_key_env: str = ""
    api_key_required: bool = True
    encrypted_api_key: str | None = None
    max_tokens: int = Field(default=4096, gt=0)
    temperature: float | None = Field(default=0.3, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    extra_headers: dict[str, str] = Field(default_factory=dict)
    extra_body: dict[str, Any] = Field(default_factory=dict)

    @field_validator("label", "model", "api_key_env", mode="before")
    @classmethod
    def strip_required_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        cleaned = value.strip().rstrip("/")
        parsed = urlparse(cleaned)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        return cleaned


class ModelSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(default=1, ge=1)
    active_profile: str = Field(min_length=1)
    profiles: dict[str, ModelProfile] = Field(min_length=1)

    @field_validator("active_profile", mode="before")
    @classmethod
    def strip_active_profile(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


@dataclass(frozen=True)
class ResolvedModelProfile:
    profile_id: str
    label: str
    protocol: Literal["openai", "anthropic"]
    base_url: str
    model: str
    api_key: str
    max_tokens: int
    temperature: float | None
    top_p: float | None
    extra_headers: dict[str, str] = field(default_factory=dict)
    extra_body: dict[str, Any] = field(default_factory=dict)

    def public_summary(self) -> dict[str, str]:
        return {
            "active_profile": self.profile_id,
            "label": self.label,
            "protocol": self.protocol,
            "model": self.model,
        }


def load_model_settings(path: Path | None = None) -> ModelSettings:
    settings_path = Path(path or DEFAULT_SETTINGS_PATH)
    try:
        payload = json.loads(settings_path.read_text(encoding="utf-8"))
        return ModelSettings.model_validate(payload)
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        raise ModelConfigurationError(
            f"无法读取模型配置 {settings_path}: {exc}"
        ) from exc


def resolve_active_profile(
    path: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> ResolvedModelProfile:
    if environ is None:
        load_dotenv(PROJECT_ROOT / ".env")
        environment: Mapping[str, str] = os.environ
    else:
        environment = environ

    if path is None:
        from .profile_store import ProfileStore, SecretCipher

        store_path = Path(
            environment.get("MODEL_PROFILE_STORE_PATH", "").strip()
            or DEFAULT_PROFILE_STORE_PATH
        )
        profile_id = environment.get("LLM_ACTIVE_PROFILE", "").strip() or None
        master_key = environment.get("MODEL_CONFIG_MASTER_KEY", "").strip()
        cipher = SecretCipher(master_key) if master_key else None
        return ProfileStore(store_path, cipher).resolve_active_profile(environment, profile_id)

    settings = load_model_settings(path)
    profile_id = environment.get("LLM_ACTIVE_PROFILE", "").strip() or settings.active_profile
    profile = settings.profiles.get(profile_id)
    if profile is None:
        raise ModelConfigurationError(f"活动模型配置不存在: {profile_id}")

    api_key = environment.get(profile.api_key_env, "").strip()
    if profile.api_key_required and not api_key:
        raise ModelConfigurationError(
            f"模型配置 {profile_id} 缺少环境变量 {profile.api_key_env}"
        )
    if not api_key:
        api_key = "not-needed"

    return ResolvedModelProfile(
        profile_id=profile_id,
        label=profile.label,
        protocol=profile.protocol,
        base_url=profile.base_url,
        model=profile.model,
        api_key=api_key,
        max_tokens=profile.max_tokens,
        temperature=profile.temperature,
        top_p=profile.top_p,
        extra_headers=dict(profile.extra_headers),
        extra_body=dict(profile.extra_body),
    )
