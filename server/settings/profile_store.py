"""Encrypted local persistence for server-side model profiles."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Mapping

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .model_profiles import (
    DEFAULT_SETTINGS_PATH,
    ModelConfigurationError,
    ModelProfile,
    ModelSettings,
    ResolvedModelProfile,
)


class ModelProfileInput(BaseModel):
    """Profile fields accepted from local profile management callers."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    protocol: Literal["openai", "anthropic"]
    base_url: str = Field(min_length=1)
    model: str = Field(min_length=1)
    api_key: str | None = None
    api_key_env: str = ""
    api_key_required: bool = True
    max_tokens: int = Field(default=4096, gt=0)
    temperature: float | None = Field(default=0.3, ge=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    extra_headers: dict[str, str] = Field(default_factory=dict)
    extra_body: dict[str, Any] = Field(default_factory=dict)

    @field_validator("id", "label", "model", "api_key_env", "api_key", mode="before")
    @classmethod
    def strip_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class PublicModelProfile(BaseModel):
    """Non-secret profile representation suitable for local UI consumers."""

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    protocol: Literal["openai", "anthropic"]
    base_url: str
    model: str
    api_key_required: bool
    has_api_key: bool
    max_tokens: int
    temperature: float | None
    active: bool


class SecretCipher:
    """Fernet wrapper that validates the explicitly supplied master key."""

    def __init__(self, key: str | bytes) -> None:
        try:
            self._fernet = Fernet(key)
        except (TypeError, ValueError) as exc:
            raise ModelConfigurationError("MODEL_CONFIG_MASTER_KEY must be a Fernet key") from exc

    @classmethod
    def from_environment(cls, environ: Mapping[str, str]) -> "SecretCipher":
        key = environ.get("MODEL_CONFIG_MASTER_KEY", "").strip()
        if not key:
            raise ModelConfigurationError("MODEL_CONFIG_MASTER_KEY is required")
        return cls(key)

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt(self, ciphertext: str) -> str:
        try:
            return self._fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError) as exc:
            raise ModelConfigurationError("Stored model API key cannot be decrypted") from exc


class ProfileStore:
    """Atomically persists one user's model profiles without exposing API keys."""

    def __init__(self, path: Path, cipher: SecretCipher | None) -> None:
        self.path = Path(path)
        self.cipher = cipher

    def list_profiles(self) -> list[PublicModelProfile]:
        settings = self._load_or_initialize()
        return [
            self._public_profile(profile_id, profile, settings.active_profile)
            for profile_id, profile in settings.profiles.items()
        ]

    def create_profile(self, profile_input: ModelProfileInput) -> PublicModelProfile:
        settings = self._load_or_initialize()
        if profile_input.id in settings.profiles:
            raise ModelConfigurationError(f"Model profile already exists: {profile_input.id}")

        settings.profiles[profile_input.id] = self._stored_profile(profile_input)
        self._persist(settings)
        return self._public_profile(
            profile_input.id,
            settings.profiles[profile_input.id],
            settings.active_profile,
        )

    def update_profile(self, profile_id: str, profile_input: ModelProfileInput) -> PublicModelProfile:
        settings = self._load_or_initialize()
        previous = settings.profiles.get(profile_id)
        if previous is None:
            raise ModelConfigurationError(f"Model profile does not exist: {profile_id}")
        if profile_input.id != profile_id:
            raise ModelConfigurationError("Model profile id cannot be changed")

        settings.profiles[profile_id] = self._stored_profile(
            profile_input,
            encrypted_api_key=(
                previous.encrypted_api_key
                if profile_input.api_key is None
                else None
            ),
        )
        self._persist(settings)
        return self._public_profile(profile_id, settings.profiles[profile_id], settings.active_profile)

    def delete_profile(self, profile_id: str) -> None:
        settings = self._load_or_initialize()
        if profile_id not in settings.profiles:
            raise ModelConfigurationError(f"Model profile does not exist: {profile_id}")
        if settings.active_profile == profile_id:
            raise ModelConfigurationError("Activate another model profile before deleting this one")

        del settings.profiles[profile_id]
        self._persist(settings)

    def activate_profile(self, profile_id: str) -> PublicModelProfile:
        settings = self._load_or_initialize()
        profile = settings.profiles.get(profile_id)
        if profile is None:
            raise ModelConfigurationError(f"Model profile does not exist: {profile_id}")

        settings.active_profile = profile_id
        self._persist(settings)
        return self._public_profile(profile_id, profile, settings.active_profile)

    def resolve_active_profile(
        self,
        environ: Mapping[str, str],
        profile_id: str | None = None,
        api_key_override: str | None = None,
    ) -> ResolvedModelProfile:
        settings = self._load_or_initialize()
        selected_id = profile_id or settings.active_profile
        profile = settings.profiles.get(selected_id)
        if profile is None:
            raise ModelConfigurationError(f"Active model profile does not exist: {selected_id}")

        api_key = api_key_override or ""
        if not api_key and profile.encrypted_api_key:
            if self.cipher is None:
                raise ModelConfigurationError(
                    "MODEL_CONFIG_MASTER_KEY is required to decrypt an encrypted API key"
                )
            api_key = self.cipher.decrypt(profile.encrypted_api_key)
        if not api_key and profile.api_key_env:
            api_key = environ.get(profile.api_key_env, "").strip()
        if profile.api_key_required and not api_key:
            source = profile.api_key_env or "an encrypted stored API key"
            raise ModelConfigurationError(f"Model profile {selected_id} is missing {source}")
        if not api_key:
            api_key = "not-needed"

        return ResolvedModelProfile(
            profile_id=selected_id,
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

    def _load_or_initialize(self) -> ModelSettings:
        if not self.path.exists():
            settings = self._default_settings()
            self._persist(settings)
            return settings

        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            return ModelSettings.model_validate(payload)
        except (json.JSONDecodeError, ValueError) as exc:
            self._backup_corrupt_file()
            settings = self._default_settings()
            self._persist(settings)
            return settings
        except OSError as exc:
            raise ModelConfigurationError(f"Unable to read model profile store {self.path}: {exc}") from exc

    def _default_settings(self) -> ModelSettings:
        try:
            payload = json.loads(DEFAULT_SETTINGS_PATH.read_text(encoding="utf-8"))
            return ModelSettings.model_validate(payload)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            raise ModelConfigurationError(
                f"Unable to load default model profiles {DEFAULT_SETTINGS_PATH}: {exc}"
            ) from exc

    def _stored_profile(
        self,
        profile_input: ModelProfileInput,
        encrypted_api_key: str | None = None,
    ) -> ModelProfile:
        payload = profile_input.model_dump(exclude={"id", "api_key"})
        if profile_input.api_key:
            if self.cipher is None:
                raise ModelConfigurationError(
                    "MODEL_CONFIG_MASTER_KEY is required to encrypt an API key"
                )
            encrypted_api_key = self.cipher.encrypt(profile_input.api_key)
        payload["encrypted_api_key"] = encrypted_api_key
        return ModelProfile.model_validate(payload)

    def _public_profile(
        self,
        profile_id: str,
        profile: ModelProfile,
        active_profile: str,
    ) -> PublicModelProfile:
        return PublicModelProfile(
            id=profile_id,
            label=profile.label,
            protocol=profile.protocol,
            base_url=profile.base_url,
            model=profile.model,
            api_key_required=profile.api_key_required,
            has_api_key=bool(profile.encrypted_api_key),
            max_tokens=profile.max_tokens,
            temperature=profile.temperature,
            active=profile_id == active_profile,
        )

    def _backup_corrupt_file(self) -> None:
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        backup = self.path.with_name(f"{self.path.name}.corrupt-{timestamp}")
        try:
            os.replace(self.path, backup)
        except OSError as exc:
            raise ModelConfigurationError(f"Unable to back up corrupt model profile store: {exc}") from exc

    def _persist(self, settings: ModelSettings) -> None:
        temporary_path = self.path.with_name(f"{self.path.name}.tmp")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with temporary_path.open("w", encoding="utf-8") as handle:
                json.dump(settings.model_dump(), handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.path)
        except OSError as exc:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise ModelConfigurationError(f"Unable to persist model profiles: {exc}") from exc
