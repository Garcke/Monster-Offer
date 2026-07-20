import json
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from server.settings.model_profiles import ModelConfigurationError, ResolvedModelProfile


def test_profile() -> ResolvedModelProfile:
    return ResolvedModelProfile(
        profile_id="test-profile",
        label="Test Provider",
        protocol="openai",
        base_url="https://secret-endpoint.example/v1",
        model="test-model",
        api_key="top-secret",
        max_tokens=1024,
        temperature=0.2,
        top_p=None,
    )


class FakeProvider:
    def __init__(self, chunks=None, error=None) -> None:
        self.chunks = chunks or []
        self.error = error
        self.messages = None

    def stream_text(self, messages):
        self.messages = list(messages)
        if self.error:
            raise self.error
        yield from self.chunks


class LLMAPITests(unittest.TestCase):
    def create_client(self, provider: FakeProvider, resolver=None):
        from server.llm_api import create_app

        app = create_app(
            profile_resolver=resolver or (lambda: test_profile()),
            provider_factory=lambda profile: provider,
        )
        return TestClient(app)

    def test_content_only_request_streams_chunks_and_saves_assistant_history(self):
        provider = FakeProvider(["first", " second"])
        with self.create_client(provider) as client:
            self.assertEqual(
                client.post("/set_prompt/", json={"prompt": "System prompt"}).status_code,
                200,
            )
            response = client.post("/chat/", json={"content": "Question"})

            self.assertEqual(response.status_code, 200)
            self.assertIn('event: chunk\ndata: {"response": "first"}', response.text)
            self.assertIn('event: chunk\ndata: {"response": " second"}', response.text)
            self.assertIn("event: done", response.text)
            self.assertEqual(
                provider.messages,
                [
                    {"role": "system", "content": "System prompt"},
                    {"role": "user", "content": "Question"},
                ],
            )
            self.assertEqual(
                client.get("/history/").json()["history"][-1],
                {"role": "assistant", "content": "first second"},
            )

    def test_request_rejects_browser_supplied_model_credentials(self):
        with self.create_client(FakeProvider(["answer"])) as client:
            response = client.post(
                "/chat/",
                json={"content": "Question", "api_key": "browser-secret"},
            )

        self.assertEqual(response.status_code, 422)

    def test_public_model_config_omits_endpoint_key_and_environment_name(self):
        with self.create_client(FakeProvider()) as client:
            response = client.get("/model-config/")

        self.assertEqual(
            response.json(),
            {
                "active_profile": "test-profile",
                "label": "Test Provider",
                "protocol": "openai",
                "model": "test-model",
            },
        )
        rendered = json.dumps(response.json())
        self.assertNotIn("top-secret", rendered)
        self.assertNotIn("secret-endpoint", rendered)
        self.assertNotIn("api_key_env", rendered)

    def test_model_options_are_safe_and_chat_profile_selection_does_not_change_active_profile(self):
        from server.llm_api import create_app
        from server.settings.profile_store import ModelProfileInput, ProfileStore, SecretCipher

        with tempfile.TemporaryDirectory() as directory:
            store = ProfileStore(Path(directory) / "profiles.json", SecretCipher(Fernet.generate_key()))
            store.create_profile(
                ModelProfileInput(
                    id="alternate",
                    label="Alternate",
                    protocol="openai",
                    base_url="https://alternate.example/v1",
                    model="alternate-model",
                    api_key_required=False,
                    max_tokens=32,
                    temperature=0.2,
                )
            )
            provider = FakeProvider(["answer"])
            seen_profiles = []

            def provider_factory(profile):
                seen_profiles.append(profile)
                return provider

            with TestClient(create_app(profile_store=store, provider_factory=provider_factory)) as client:
                options = client.get("/model-options/")
                test_result = client.post("/model-test/", json={"profile_id": "alternate"})
                response = client.post("/chat/", json={"content": "Question", "profile_id": "alternate"})
                active = client.get("/model-config/")

        self.assertEqual(options.status_code, 200)
        self.assertEqual(test_result.status_code, 200)
        self.assertEqual(test_result.json()["model"], "alternate-model")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen_profiles[-1].profile_id, "alternate")
        self.assertEqual(active.json()["active_profile"], "generic_openai")
        self.assertEqual(options.json()["active_profile"], "generic_openai")
        self.assertTrue(all("base_url" not in profile for profile in options.json()["profiles"]))
        self.assertTrue(all("api_key" not in profile for profile in options.json()["profiles"]))
        self.assertTrue(all("api_key_env" not in profile for profile in options.json()["profiles"]))

    def test_provider_failure_emits_error_and_done_events_without_hanging(self):
        provider = FakeProvider(error=RuntimeError("provider unavailable"))
        with self.create_client(provider) as client:
            response = client.post("/chat/", json={"content": "Question"})

        self.assertEqual(response.status_code, 200)
        self.assertIn("event: error", response.text)
        self.assertIn("provider unavailable", response.text)
        self.assertIn("event: done", response.text)

    def test_invalid_server_configuration_returns_service_unavailable(self):
        def broken_resolver():
            raise ModelConfigurationError("missing MODEL_API_KEY")

        with self.create_client(FakeProvider(), resolver=broken_resolver) as client:
            response = client.post("/chat/", json={"content": "Question"})

        self.assertEqual(response.status_code, 503)
        self.assertIn("MODEL_API_KEY", response.json()["detail"])

    def test_chat_uses_the_profile_newly_activated_in_the_injected_store(self):
        from server.llm_api import create_app
        from server.settings.profile_store import ModelProfileInput, ProfileStore, SecretCipher

        with tempfile.TemporaryDirectory() as directory:
            store = ProfileStore(Path(directory) / "profiles.json", SecretCipher(Fernet.generate_key()))
            store.create_profile(
                ModelProfileInput(
                    id="alternate",
                    label="Alternate",
                    protocol="openai",
                    base_url="https://alternate.example/v1",
                    model="alternate-model",
                    api_key_required=False,
                    max_tokens=32,
                    temperature=0.2,
                )
            )
            provider = FakeProvider(["answer"])
            seen_profiles = []

            def provider_factory(profile):
                seen_profiles.append(profile)
                return provider

            with TestClient(
                create_app(
                    profile_store=store,
                    admin_token="admin-token",
                    provider_factory=provider_factory,
                )
            ) as client:
                activated = client.post(
                    "/models/alternate/activate",
                    headers={"Authorization": "Bearer admin-token"},
                )
                response = client.post("/chat/", json={"content": "Question"})
                configuration = client.get("/model-config/")

        self.assertEqual(activated.status_code, 200)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen_profiles[-1].profile_id, "alternate")
        self.assertEqual(configuration.json()["active_profile"], "alternate")


if __name__ == "__main__":
    unittest.main()
