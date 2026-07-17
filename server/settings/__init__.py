"""Configuration and helper functions for the optional remote LLM.

Speech recognition runs locally and does not require an API key.
"""

from .model_profiles import (
    DEFAULT_PROFILE_STORE_PATH,
    ModelConfigurationError,
    ResolvedModelProfile,
    load_model_settings,
    resolve_active_profile,
)
from .profile_store import ModelProfileInput, ProfileStore, PublicModelProfile, SecretCipher

__all__ = [
    "DEFAULT_PROFILE_STORE_PATH",
    "ModelConfigurationError",
    "ModelProfileInput",
    "ProfileStore",
    "PublicModelProfile",
    "ResolvedModelProfile",
    "SecretCipher",
    "load_model_settings",
    "resolve_active_profile",
]
