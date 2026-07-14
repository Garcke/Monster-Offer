"""Configuration and helper functions for the optional remote LLM.

Speech recognition runs locally and does not require an API key.
"""

from .settings import DASHSCOPE_API_KEY, config
from .llm_checker import check_llm_connection, get_available_models

__all__ = [
    "DASHSCOPE_API_KEY",
    "config",
    "check_llm_connection",
    "get_available_models",
]
