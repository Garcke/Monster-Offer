"""Streaming adapters for the two supported LLM wire protocols."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Any, Protocol

from server.settings.model_profiles import ResolvedModelProfile


ChatMessage = dict[str, str]


class LLMProvider(Protocol):
    def stream_text(self, messages: Sequence[ChatMessage]) -> Iterator[str]: ...


class OpenAIProvider:
    def __init__(self, profile: ResolvedModelProfile, client: Any | None = None) -> None:
        self.profile = profile
        if client is None:
            from openai import OpenAI

            client = OpenAI(
                api_key=profile.api_key,
                base_url=profile.base_url,
                default_headers=profile.extra_headers or None,
            )
        self.client = client

    def stream_text(self, messages: Sequence[ChatMessage]) -> Iterator[str]:
        request: dict[str, Any] = {
            "model": self.profile.model,
            "messages": list(messages),
            "stream": True,
            "max_tokens": self.profile.max_tokens,
        }
        if self.profile.temperature is not None:
            request["temperature"] = self.profile.temperature
        if self.profile.top_p is not None:
            request["top_p"] = self.profile.top_p
        if self.profile.extra_headers:
            request["extra_headers"] = self.profile.extra_headers
        if self.profile.extra_body:
            request["extra_body"] = self.profile.extra_body

        for chunk in self.client.chat.completions.create(**request):
            try:
                content = chunk.choices[0].delta.content
            except (AttributeError, IndexError, KeyError, TypeError):
                content = None
            if content:
                yield content


class AnthropicProvider:
    def __init__(self, profile: ResolvedModelProfile, client: Any | None = None) -> None:
        self.profile = profile
        if client is None:
            from anthropic import Anthropic

            client = Anthropic(
                api_key=profile.api_key,
                base_url=profile.base_url,
                default_headers=profile.extra_headers or None,
            )
        self.client = client

    def stream_text(self, messages: Sequence[ChatMessage]) -> Iterator[str]:
        system_parts = [
            message["content"]
            for message in messages
            if message.get("role") == "system" and message.get("content")
        ]
        conversation = [
            {"role": message["role"], "content": message["content"]}
            for message in messages
            if message.get("role") in {"user", "assistant"}
            and message.get("content")
        ]
        request: dict[str, Any] = {
            "model": self.profile.model,
            "messages": conversation,
            "max_tokens": self.profile.max_tokens,
        }
        if system_parts:
            request["system"] = "\n\n".join(system_parts)
        if self.profile.temperature is not None:
            request["temperature"] = self.profile.temperature
        if self.profile.top_p is not None:
            request["top_p"] = self.profile.top_p
        if self.profile.extra_headers:
            request["extra_headers"] = self.profile.extra_headers

        with self.client.messages.stream(**request) as stream:
            yield from stream.text_stream


def create_provider(
    profile: ResolvedModelProfile,
    client: Any | None = None,
) -> LLMProvider:
    if profile.protocol == "openai":
        return OpenAIProvider(profile, client=client)
    if profile.protocol == "anthropic":
        return AnthropicProvider(profile, client=client)
    raise ValueError(f"不支持的模型协议: {profile.protocol}")
