import json
import tempfile
import unittest
from pathlib import Path

from cryptography.fernet import Fernet


class ModelProfileTests(unittest.TestCase):
    def write_settings(self, payload: dict) -> Path:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        path = Path(temp_dir.name) / "model_settings.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def base_payload(self) -> dict:
        return {
            "active_profile": "primary",
            "profiles": {
                "primary": {
                    "label": "Primary",
                    "protocol": "openai",
                    "base_url": "https://example.com/v1",
                    "model": "model-a",
                    "api_key_env": "PRIMARY_API_KEY",
                    "api_key_required": True,
                    "max_tokens": 2048,
                    "temperature": 0.2,
                },
                "backup": {
                    "label": "Backup",
                    "protocol": "anthropic",
                    "base_url": "https://example.net",
                    "model": "model-b",
                    "api_key_env": "BACKUP_API_KEY",
                    "api_key_required": True,
                    "max_tokens": 4096,
                    "temperature": 0.3,
                },
            },
        }

    def test_resolves_active_profile_and_key_from_named_environment_variable(self):
        from server.settings.model_profiles import resolve_active_profile

        resolved = resolve_active_profile(
            self.write_settings(self.base_payload()),
            environ={"PRIMARY_API_KEY": "secret-value"},
        )

        self.assertEqual(resolved.profile_id, "primary")
        self.assertEqual(resolved.protocol, "openai")
        self.assertEqual(resolved.api_key, "secret-value")
        self.assertEqual(resolved.model, "model-a")

    def test_environment_override_selects_another_profile(self):
        from server.settings.model_profiles import resolve_active_profile

        resolved = resolve_active_profile(
            self.write_settings(self.base_payload()),
            environ={
                "LLM_ACTIVE_PROFILE": "backup",
                "BACKUP_API_KEY": "backup-secret",
            },
        )

        self.assertEqual(resolved.profile_id, "backup")
        self.assertEqual(resolved.protocol, "anthropic")

    def test_missing_required_key_names_the_environment_variable(self):
        from server.settings.model_profiles import ModelConfigurationError, resolve_active_profile

        with self.assertRaisesRegex(ModelConfigurationError, "PRIMARY_API_KEY"):
            resolve_active_profile(self.write_settings(self.base_payload()), environ={})

    def test_keyless_local_profile_uses_non_secret_sdk_placeholder(self):
        from server.settings.model_profiles import resolve_active_profile

        payload = self.base_payload()
        payload["profiles"]["primary"].update(
            {
                "base_url": "http://127.0.0.1:8000/v1",
                "api_key_required": False,
            }
        )

        resolved = resolve_active_profile(self.write_settings(payload), environ={})

        self.assertEqual(resolved.api_key, "not-needed")

    def test_rejects_unknown_protocol_and_missing_active_profile(self):
        from server.settings.model_profiles import ModelConfigurationError, load_model_settings, resolve_active_profile

        invalid_protocol = self.base_payload()
        invalid_protocol["profiles"]["primary"]["protocol"] = "responses"
        with self.assertRaises(ModelConfigurationError):
            load_model_settings(self.write_settings(invalid_protocol))

        missing_profile = self.base_payload()
        missing_profile["active_profile"] = "does-not-exist"
        with self.assertRaisesRegex(ModelConfigurationError, "does-not-exist"):
            resolve_active_profile(self.write_settings(missing_profile), environ={})

    def test_public_summary_never_exposes_endpoint_or_credentials(self):
        from server.settings.model_profiles import resolve_active_profile

        resolved = resolve_active_profile(
            self.write_settings(self.base_payload()),
            environ={"PRIMARY_API_KEY": "secret-value"},
        )

        self.assertEqual(
            resolved.public_summary(),
            {
                "active_profile": "primary",
                "label": "Primary",
                "protocol": "openai",
                "model": "model-a",
            },
        )
        rendered = json.dumps(resolved.public_summary())
        self.assertNotIn("secret-value", rendered)
        self.assertNotIn("base_url", rendered)
        self.assertNotIn("api_key_env", rendered)

    def test_project_defaults_use_generic_openai_and_remove_dashscope_profiles(self):
        from server.settings.model_profiles import load_model_settings

        settings = load_model_settings()

        self.assertEqual(settings.active_profile, "generic_openai")
        self.assertIn("generic_openai", settings.profiles)
        self.assertIn("generic_anthropic", settings.profiles)
        self.assertFalse(any("dashscope" in name.lower() for name in settings.profiles))
        self.assertFalse(
            any("dashscope" in profile.base_url.lower() for profile in settings.profiles.values())
        )

    def test_both_generic_project_profiles_are_keyless_and_use_explicit_protocols(self):
        from server.settings.model_profiles import resolve_active_profile

        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        master_key = Fernet.generate_key().decode("ascii")
        environ = {
            "MODEL_CONFIG_MASTER_KEY": master_key,
            "MODEL_PROFILE_STORE_PATH": str(Path(temp_dir.name) / "profiles.json"),
        }

        openai_profile = resolve_active_profile(
            environ={**environ, "LLM_ACTIVE_PROFILE": "generic_openai"}
        )
        anthropic_profile = resolve_active_profile(
            environ={**environ, "LLM_ACTIVE_PROFILE": "generic_anthropic"}
        )

        self.assertEqual(openai_profile.protocol, "openai")
        self.assertEqual(openai_profile.api_key, "not-needed")
        self.assertEqual(anthropic_profile.protocol, "anthropic")
        self.assertEqual(anthropic_profile.api_key, "not-needed")

    def test_runtime_store_prefers_encrypted_key_over_legacy_environment_fallback(self):
        from server.settings.model_profiles import resolve_active_profile
        from server.settings.profile_store import ModelProfileInput, ProfileStore, SecretCipher

        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        path = Path(temp_dir.name) / "profiles.json"
        master_key = Fernet.generate_key().decode("ascii")
        store = ProfileStore(path, SecretCipher(master_key))
        store.create_profile(
            ModelProfileInput(
                id="primary",
                label="Primary",
                protocol="openai",
                base_url="https://example.com/v1",
                model="model-a",
                api_key="stored-secret",
                api_key_env="PRIMARY_API_KEY",
                api_key_required=True,
                max_tokens=2048,
                temperature=0.2,
            )
        )
        store.activate_profile("primary")

        resolved = resolve_active_profile(
            environ={
                "MODEL_CONFIG_MASTER_KEY": master_key,
                "MODEL_PROFILE_STORE_PATH": str(path),
                "PRIMARY_API_KEY": "environment-secret",
            }
        )

        self.assertEqual(resolved.api_key, "stored-secret")

    def test_runtime_store_resolves_default_profile_from_legacy_environment_without_master_key(self):
        from server.settings.model_profiles import resolve_active_profile

        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        path = Path(temp_dir.name) / "profiles.json"

        resolved = resolve_active_profile(
            environ={
                "MODEL_PROFILE_STORE_PATH": str(path),
                "LLM_ACTIVE_PROFILE": "openrouter",
                "OPENROUTER_API_KEY": "legacy-secret",
            }
        )

        self.assertTrue(path.is_file())
        self.assertEqual(resolved.profile_id, "openrouter")
        self.assertEqual(resolved.api_key, "legacy-secret")

    def test_runtime_store_rejects_encrypted_key_without_master_key_instead_of_fallback(self):
        from server.settings.model_profiles import ModelConfigurationError, resolve_active_profile

        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        path = Path(temp_dir.name) / "profiles.json"
        encrypted_key = Fernet(Fernet.generate_key()).encrypt(b"stored-secret").decode("ascii")
        payload = self.base_payload()
        payload["version"] = 1
        payload["profiles"]["primary"]["encrypted_api_key"] = encrypted_key
        path.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaisesRegex(ModelConfigurationError, "MODEL_CONFIG_MASTER_KEY.*encrypted"):
            resolve_active_profile(
                environ={
                    "MODEL_PROFILE_STORE_PATH": str(path),
                    "PRIMARY_API_KEY": "legacy-secret",
                }
            )

    def test_operator_and_runtime_files_do_not_reference_dashscope(self):
        project_root = Path(__file__).resolve().parents[2]
        files = [
            project_root / "server" / "config" / "default_model_profiles.json",
            project_root / ".env.example",
            project_root / "README.md",
            project_root / "server" / "llm_api.py",
            project_root / "server" / "llm_providers.py",
            project_root / "web" / "scripts.js",
        ]
        combined = "\n".join(path.read_text(encoding="utf-8") for path in files).lower()

        self.assertNotIn("dashscope_api_key", combined)
        self.assertNotIn("dashscope_qwen", combined)
        self.assertNotIn("dashscope.aliyuncs.com", combined)
        self.assertNotIn("dashscope-intl.aliyuncs.com", combined)
        self.assertIn("openai_compatible_api_key", combined)
        self.assertIn("anthropic_compatible_api_key", combined)


if __name__ == "__main__":
    unittest.main()
