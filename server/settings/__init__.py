"""Configuration and helper functions for the optional remote LLM.

Speech recognition runs locally and does not require an API key.
"""

from .model_profiles import (
    ModelConfigurationError,
    ResolvedModelProfile,
    load_model_settings,
    resolve_active_profile,
)

__all__ = [
    "ModelConfigurationError",
    "ResolvedModelProfile",
    "load_model_settings",
    "resolve_active_profile",
]
