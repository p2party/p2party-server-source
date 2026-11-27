import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import redirect_preflight as guard


ZONE = "1" * 32
RULESET = "2" * 32
VERSION = {"id": RULESET, "kind": "zone", "phase": guard.PHASE}
DETAIL = {**VERSION, "name": "p2party frontend redirects", "rules": [{"ref": ref} for ref in guard.REFS]}


class RedirectPreflight(unittest.TestCase):
    def test_empty_phase_needs_no_state_owner(self):
        with patch.object(guard, "phase_read", return_value=[]) as read:
            guard.verify_phase(ZONE, "test", None)
            read.assert_called_once_with(ZONE, "test", "/versions")
            with self.assertRaises(guard.PreflightError):
                guard.verify_phase(ZONE, "test", RULESET)

    def test_existing_phase_must_be_owned_and_match_latest_rules(self):
        with patch.object(guard, "phase_read", side_effect=[[VERSION], DETAIL]) as read:
            guard.verify_phase(ZONE, "test", RULESET)
            self.assertEqual(read.call_args.args[-1], "")
        for state in (None, "3" * 32):
            with patch.object(guard, "phase_read", return_value=[VERSION]), self.assertRaises(guard.PreflightError):
                guard.verify_phase(ZONE, "test", state)
        added = {**DETAIL, "rules": [*DETAIL["rules"], {"ref": "dashboard_rule"}]}
        with patch.object(guard, "phase_read", side_effect=[[VERSION], added]), self.assertRaises(guard.PreflightError):
            guard.verify_phase(ZONE, "test", RULESET)

    def test_permission_failure_and_invalid_envelopes_do_not_look_empty(self):
        with patch.object(guard.http.client, "HTTPSConnection") as connect:
            response = connect.return_value.getresponse.return_value
            response.status = 403
            with self.assertRaisesRegex(guard.PreflightError, "HTTP 403"):
                guard.verify_phase(ZONE, "dummy credential", None)
            response.status = 200
            for envelope in ({"success": False, "errors": [], "result": []},
                             {"success": True, "errors": [], "result": {}},
                             {"success": True, "errors": ["denied"], "result": []}):
                response.read.return_value = json.dumps(envelope).encode()
                with self.assertRaises(guard.PreflightError):
                    guard.verify_phase(ZONE, "test", None)

    def test_saved_plan_uses_its_own_opt_in_and_state(self):
        names = {"manage_frontend_www_redirect": True, "cloudflare_zone_id_p2party": ZONE, "cloudflare_api_token": "test"}
        variables = {key: {"value": value} for key, value in names.items()}
        ownership = {"address": guard.ADDRESS, "values": {"id": RULESET, "zone_id": ZONE}}
        plan = {"variables": variables, "prior_state": {"values": {"root_module": {"resources": [ownership]}}}}
        with patch.object(guard, "terraform_json", return_value=plan) as tf:
            self.assertEqual(guard.inputs(["apply", "-input=false", "deploy.plan"]), (ZONE, "test", RULESET))
            tf.assert_called_once_with([], ["show", "-json", "deploy.plan"])
            ownership["values"]["zone_id"] = "3" * 32
            with self.assertRaises(guard.PreflightError):
                guard.inputs(["apply", "deploy.plan"])
            variables["manage_frontend_www_redirect"]["value"] = False
            self.assertIsNone(guard.inputs(["apply", "deploy.plan"]))

    @unittest.skipUnless(shutil.which("terraform"), "Terraform CLI is required for the input-precedence test")
    def test_real_terraform_resolves_variables_and_saved_plan(self):
        with tempfile.TemporaryDirectory() as scratch, patch.dict(os.environ, {}, clear=False):
            for key in tuple(os.environ):
                if key.startswith(("TF_CLI_ARGS", "TF_VAR_")) or key in {"TF_DATA_DIR", "TF_WORKSPACE"}:
                    del os.environ[key]
            directory = Path(scratch)
            (directory / "main.tf").write_text(f'''variable "manage_frontend_www_redirect" {{ default = false }}
variable "cloudflare_zone_id_p2party" {{ default = "{ZONE}" }}
variable "cloudflare_api_token" {{
  default = "test"
  sensitive = true
}}
''')
            prefix = f"-chdir={directory}"
            self.assertIsNone(guard.inputs([prefix, "plan"]))
            (directory / "terraform.tfvars").write_text("manage_frontend_www_redirect = true\n")
            self.assertEqual(guard.inputs([prefix, "plan", "-lock-timeout=10s"]), (ZONE, "test", None))
            with patch.dict(os.environ, {"TF_CLI_ARGS_plan": "-var='manage_frontend_www_redirect=false'"}):
                self.assertIsNone(guard.inputs([prefix, "plan"]))
                self.assertEqual(guard.inputs([prefix, "plan", "-var", "manage_frontend_www_redirect=true"]), (ZONE, "test", None))
            subprocess.run(["terraform", prefix, "plan", "-out=checked.plan"], check=True, capture_output=True)
            (directory / "terraform.tfvars").write_text("manage_frontend_www_redirect = false\n")
            self.assertEqual(guard.inputs([prefix, "apply", "checked.plan"]), (ZONE, "test", None))


if __name__ == "__main__":
    unittest.main()
