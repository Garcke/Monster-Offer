import json
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient


class RecordingProvider:
    def __init__(self, chunks=None, error=None):
        self.chunks = ["connected"] if chunks is None else chunks
        self.error = error
        self.messages = []

    def stream_text(self, messages):
        self.messages.append(list(messages))
        if self.error:
            raise self.error
        yield from self.chunks


class ModelAPITests(unittest.TestCase):
    admin_token = "admin-test-token"
    auth = {"Authorization": "Bearer admin-test-token"}

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        from server.settings.profile_store import ProfileStore, SecretCipher

        self.store = ProfileStore(
            Path(self.temp_dir.name) / "profiles.json",
            SecretCipher(Fernet.generate_key()),
        )
        self.provider = RecordingProvider()
        self.provider_profiles = []

    def create_client(self, *, admin_token=admin_token, provider=None):
        from server.llm_api import create_app

        def provider_factory(profile):
            self.provider_profiles.append(profile)
            return provider or self.provider

        return TestClient(
            create_app(
                profile_store=self.store,
                admin_token=admin_token,
                provider_factory=provider_factory,
            )
        )

    def profile_payload(self, **overrides):
        payload = {
            "id": "demo",
            "label": "Demo",
            "protocol": "openai",
            "base_url": "https://example.com/v1",
            "model": "demo-model",
            "api_key": "provider-secret",
            "api_key_env": "DEMO_API_KEY",
            "api_key_required": True,
            "max_tokens": 2048,
            "temperature": 0.2,
        }
        payload.update(overrides)
        return payload

    def test_management_routes_require_a_configured_correct_bearer_token(self):
        with self.create_client() as client:
            self.assertEqual(client.get("/models/").status_code, 401)
            self.assertEqual(
                client.get("/models/", headers={"Authorization": "Basic bad"}).status_code,
                403,
            )
            self.assertEqual(
                client.get("/models/", headers={"Authorization": "Bearer wrong"}).status_code,
                403,
            )
            self.assertEqual(client.get("/models/", headers=self.auth).status_code, 200)

        with self.create_client(admin_token="") as client:
            response = client.get("/models/")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(self.admin_token, response.text)

    def test_complete_crud_activation_and_delete_conflicts_never_disclose_secrets(self):
        with self.create_client() as client:
            created = client.post("/models/", headers=self.auth, json=self.profile_payload())
            self.assertEqual(created.status_code, 201)
            self.assertTrue(created.json()["has_api_key"])
            self.assertNotIn("api_key", created.json())
            self.assertNotIn("provider-secret", created.text)
            self.assertNotIn("DEMO_API_KEY", created.text)

            listed = client.get("/models/", headers=self.auth)
            self.assertEqual(listed.status_code, 200)
            self.assertIn("active_profile", listed.json())
            self.assertEqual(
                {profile["id"] for profile in listed.json()["profiles"]},
                {"demo", *[profile.id for profile in self.store.list_profiles()]},
            )

            duplicate = client.post("/models/", headers=self.auth, json=self.profile_payload())
            self.assertEqual(duplicate.status_code, 409)
            invalid = client.post(
                "/models/",
                headers=self.auth,
                json=self.profile_payload(id="invalid", base_url="not-a-url"),
            )
            self.assertEqual(invalid.status_code, 422)
            malformed = client.post("/models/", headers=self.auth, json=["provider-secret"])
            self.assertEqual(malformed.status_code, 422)
            self.assertNotIn("provider-secret", malformed.text)

            updated = client.put(
                "/models/demo",
                headers=self.auth,
                json=self.profile_payload(label="Renamed", api_key="replacement-secret"),
            )
            self.assertEqual(updated.status_code, 200)
            self.assertEqual(updated.json()["label"], "Renamed")
            self.assertNotIn("replacement-secret", updated.text)

            activated = client.post("/models/demo/activate", headers=self.auth)
            self.assertEqual(activated.status_code, 200)
            self.assertEqual(activated.json()["active_profile"], "demo")
            self.assertEqual(activated.json()["profile"]["id"], "demo")

            active_delete = client.delete("/models/demo", headers=self.auth)
            self.assertEqual(active_delete.status_code, 409)
            self.assertIn("active", active_delete.json()["detail"].lower())

            for profile in list(self.store.list_profiles()):
                if profile.id != "demo":
                    self.assertEqual(
                        client.delete(f"/models/{profile.id}", headers=self.auth).status_code,
                        204,
                    )
            last_delete = client.delete("/models/demo", headers=self.auth)
            self.assertEqual(last_delete.status_code, 409)
            self.assertIn("last", last_delete.json()["detail"].lower())

        rendered_store = self.store.path.read_text(encoding="utf-8")
        self.assertNotIn("provider-secret", rendered_store)
        self.assertNotIn("replacement-secret", rendered_store)

    def test_connectivity_test_uses_temporary_candidate_without_mutating_store(self):
        before = self.store.path.read_bytes() if self.store.path.exists() else None
        candidate = self.profile_payload(id="temporary", max_tokens=99, api_key="temporary-secret")

        with self.create_client() as client:
            response = client.post("/models/test", headers=self.auth, json=candidate)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], True)
        self.assertEqual(response.json()["model"], "demo-model")
        self.assertIsInstance(response.json()["latency_ms"], int)
        self.assertEqual(self.provider.messages, [[{"role": "user", "content": "Reply with OK."}]])
        self.assertEqual(self.provider_profiles[-1].max_tokens, 8)
        self.assertEqual(self.store.path.read_bytes() if self.store.path.exists() else None, before)
        self.assertTrue(any(profile.active for profile in self.store.list_profiles()))

    def test_connectivity_test_redacts_failure_and_does_not_mutate_active_profile(self):
        failing_provider = RecordingProvider(error=RuntimeError("temporary-secret rejected"))
        self.store.list_profiles()
        before = self.store.path.read_bytes()
        active_before = next(profile.id for profile in self.store.list_profiles() if profile.active)

        with self.create_client(provider=failing_provider) as client:
            response = client.post(
                "/models/test",
                headers=self.auth,
                json=self.profile_payload(id="temporary", api_key="temporary-secret"),
            )

        self.assertEqual(response.status_code, 422)
        self.assertNotIn("temporary-secret", response.text)
        self.assertNotIn("rejected", response.text)
        self.assertEqual(self.store.path.read_bytes(), before)
        active_after = next(profile.id for profile in self.store.list_profiles() if profile.active)
        self.assertEqual(active_after, active_before)

    def test_connectivity_test_rejects_an_empty_stream_without_mutating_the_store(self):
        empty_provider = RecordingProvider(chunks=[])
        self.store.list_profiles()
        before = self.store.path.read_bytes()
        active_before = next(profile.id for profile in self.store.list_profiles() if profile.active)

        with self.create_client(provider=empty_provider) as client:
            response = client.post(
                "/models/test",
                headers=self.auth,
                json=self.profile_payload(id="temporary", api_key="temporary-secret"),
            )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "Model connectivity test failed")
        self.assertNotIn("temporary-secret", response.text)
        self.assertEqual(self.store.path.read_bytes(), before)
        active_after = next(profile.id for profile in self.store.list_profiles() if profile.active)
        self.assertEqual(active_after, active_before)

    def test_connectivity_test_accepts_a_stored_profile_with_a_temporary_key_replacement(self):
        from server.settings.profile_store import ModelProfileInput

        self.store.create_profile(ModelProfileInput(**self.profile_payload(api_key=None, max_tokens=99)))
        before = self.store.path.read_bytes()

        with self.create_client() as client:
            response = client.post(
                "/models/test",
                headers=self.auth,
                json={"profile_id": "demo", "api_key": "temporary-secret"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.provider_profiles[-1].max_tokens, 8)
        self.assertEqual(self.store.path.read_bytes(), before)
        self.assertNotIn("temporary-secret", json.dumps(response.json()))


if __name__ == "__main__":
    unittest.main()
