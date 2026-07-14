"""Project settings loaded from environment variables."""

import os
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).resolve().parents[1] / ".env")

# Speech recognition is fully local. This key is used only by the optional
# default Qwen text model when the browser provides no other LLM config.
DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "").strip()

config = {
    "DASHSCOPE_API_KEY": DASHSCOPE_API_KEY,
}
