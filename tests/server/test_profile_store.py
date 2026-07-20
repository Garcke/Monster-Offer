import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet


class ProfileStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.path = Path(self.temp_dir.name) / "profiles.json"
        self.master_key = Fernet.generate_key().decode("ascii")

    def make_input(self, **overrides):
        from server.settings.profile_store import ModelProfileInput

        payload = {
            "id": "primary",
            "label": "Primary",
            "protocol": "openai",
            "base_url": "https://example.com/v1",
            "model": "model-a",
            "api_key": "secret-value",
            "api_key_env": "PRIMARY_API_KEY",
            "api_key_required": True,
            "max_tokens": 2048,
            "temperature": 0.2,
        }
        payload.update(overrides)
        return ModelProfileInput(**payload)

    def make_store(self):
        from server.settings.profile_store import ProfileStore, SecretCipher

        return ProfileStore(self.path, SecretCipher(self.master_key))

    def test_store_encrypts_keys_and_never_returns_them(self):
        store = self.make_store()

        created = store.create_profile(self.make_input())

        self.assertTrue(created.has_api_key)
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn("secret-value", raw)
        self.assertNotIn("api_key", created.model_dump())
        self.assertEqual(created.model_dump()["id"], "primary")

    def test_update_reencrypts_a_new_key_without_disclosing_it(self):
        store = self.make_store()
        store.create_profile(self.make_input())

        updated = store.update_profile(
            "primary",
            self.make_input(label="Renamed", api_key="replacement-secret"),
        )

        self.assertEqual(updated.label, "Renamed")
        self.assertTrue(updated.has_api_key)
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn("secret-value", raw)
        self.assertNotIn("replacement-secret", raw)

    def test_delete_removes_a_non_active_profile(self):
        store = self.make_store()
        store.create_profile(self.make_input())
        store.create_profile(self.make_input(id="backup", label="Backup"))

        store.delete_profile("backup")

        self.assertNotIn("backup", [profile.id for profile in store.list_profiles()])

    def test_activate_marks_only_the_selected_profile_active(self):
        store = self.make_store()
        store.create_profile(self.make_input())
        store.create_profile(self.make_input(id="backup", label="Backup"))

        activated = store.activate_profile("backup")
        profiles = {profile.id: profile for profile in store.list_profiles()}

        self.assertTrue(activated.active)
        self.assertFalse(profiles["primary"].active)
        self.assertTrue(profiles["backup"].active)

    def test_resolve_uses_encrypted_key_before_profile_environment_key(self):
        store = self.make_store()
        store.create_profile(self.make_input())
        store.activate_profile("primary")

        resolved = store.resolve_active_profile(environ={"PRIMARY_API_KEY": "environment-secret"})

        self.assertEqual(resolved.profile_id, "primary")
        self.assertEqual(resolved.api_key, "secret-value")

    def test_failed_atomic_replace_keeps_previous_file(self):
        store = self.make_store()
        store.create_profile(self.make_input())
        before = self.path.read_bytes()

        with patch(
            "server.settings.profile_store.os.replace",
            side_effect=OSError("disk full"),
        ):
            from server.settings.model_profiles import ModelConfigurationError

            with self.assertRaises(ModelConfigurationError):
                store.activate_profile("primary")

        self.assertEqual(self.path.read_bytes(), before)

    def test_corrupt_store_is_backed_up_and_recreated_from_non_secret_defaults(self):
        self.path.write_text("not valid json", encoding="utf-8")
        store = self.make_store()

        profiles = store.list_profiles()

        backups = list(self.path.parent.glob("profiles.json.corrupt-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(encoding="utf-8"), "not valid json")
        self.assertIn("generic_openai", [profile.id for profile in profiles])
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertTrue(
            all(
                profile["encrypted_api_key"] is None
                for profile in payload["profiles"].values()
            )
        )

    def test_first_run_copies_checked_in_defaults_into_versioned_store(self):
        store = self.make_store()

        profiles = store.list_profiles()

        payload = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["active_profile"], "generic_openai")
        self.assertIn("generic_openai", payload["profiles"])
        self.assertIsNone(payload["profiles"]["generic_openai"]["encrypted_api_key"])
        self.assertIn("generic_openai", [profile.id for profile in profiles])

    def test_existing_store_is_migrated_with_missing_builtin_profiles(self):
        self.path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "active_profile": "generic_openai",
                    "profiles": {
                        "generic_openai": {
                            "label": "Legacy OpenAI",
                            "protocol": "openai",
                            "base_url": "http://127.0.0.1:8000/v1",
                            "model": "legacy-model",
                            "api_key_env": "OPENAI_COMPATIBLE_API_KEY",
                            "api_key_required": False,
                            "encrypted_api_key": None,
                            "max_tokens": 2048,
                            "temperature": 0.2,
                            "top_p": None,
                            "extra_headers": {},
                            "extra_body": {},
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        store = self.make_store()

        profiles = store.list_profiles()

        profile_ids = {profile.id for profile in profiles}
        self.assertIn("openrouter", profile_ids)
        self.assertIn("anthropic", profile_ids)
        self.assertIn("opencode_zen_anthropic", profile_ids)
        self.assertEqual(next(profile for profile in profiles if profile.id == "generic_openai").label, "Legacy OpenAI")
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(payload["active_profile"], "generic_openai")

    def test_environment_cipher_requires_a_valid_explicit_fernet_key(self):
        from server.settings.model_profiles import ModelConfigurationError
        from server.settings.profile_store import SecretCipher

        with self.assertRaises(ModelConfigurationError):
            SecretCipher.from_environment({})
        with self.assertRaises(ModelConfigurationError):
            SecretCipher.from_environment({"MODEL_CONFIG_MASTER_KEY": "not-a-fernet-key"})


if __name__ == "__main__":
    unittest.main()
