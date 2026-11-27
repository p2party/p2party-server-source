"""Check live redirect phase ownership before a real Terraform plan or apply."""

import http.client
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

PHASE = "http_request_dynamic_redirect"
ADDRESS = "cloudflare_ruleset.frontend_redirects[0]"
REFS = {"p2party_frontend_directory_to_https", "p2party_frontend_www_to_https_apex"}


class PreflightError(Exception):
    pass


def phase_read(zone, token, suffix):
    connection = http.client.HTTPSConnection("api.cloudflare.com", timeout=15)
    try:
        connection.request("GET", f"/client/v4/zones/{zone}/rulesets/phases/{PHASE}/entrypoint{suffix}",
                           headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        response = connection.getresponse()
        if response.status != 200:
            raise PreflightError(f"Cloudflare redirect phase read returned HTTP {response.status}. Verify Single Redirect permission on this zone.")
        body = json.load(response)
        if body.get("success") is not True or body.get("errors") != []:
            raise PreflightError("Cloudflare did not confirm a successful redirect phase read.")
        return body["result"]
    finally:
        connection.close()


def verify_phase(zone, token, state_id):
    if not re.fullmatch(r"[0-9a-f]{32}", zone) or not token:
        raise PreflightError("A valid Cloudflare zone and credential are required to check redirects.")
    versions = phase_read(zone, token, "/versions")
    if not isinstance(versions, list):
        raise PreflightError("Invalid Cloudflare redirect versions response.")
    if not versions and state_id is None:
        return
    if not state_id or not versions or any(
        item.get("id") != state_id or item.get("kind") != "zone" or item.get("phase") != PHASE for item in versions
    ):
        raise PreflightError("Reconcile the redirect entrypoint with its exact Terraform state ID before continuing.")
    # A saved plan can predate a dashboard edit. Read the rules again before applying it.
    current = phase_read(zone, token, "")
    if (current.get("id") != state_id or current.get("kind") != "zone" or current.get("phase") != PHASE
            or current.get("name") != "p2party frontend redirects" or not isinstance(current.get("rules"), list)):
        raise PreflightError("Cloudflare returned an unexpected redirect entrypoint. Reconcile its ownership.")
    refs = [rule.get("ref") for rule in current["rules"]]
    if len(refs) != len(set(refs)) or not set(refs) <= REFS:
        raise PreflightError("The live redirect entrypoint contains unmanaged rules. Review the complete rule list.")


def terraform_json(prefix, arguments, expression=None):
    # Terraform's JSON includes sensitive variables. Never relay its output or environment.
    env = {k: v for k, v in os.environ.items() if not k.startswith("TF_LOG") and k not in {"TF_CLI_ARGS", "TF_CLI_ARGS_show", "TF_CLI_ARGS_console"}}
    result = subprocess.run(["terraform", *prefix, *arguments], env=env, input=expression,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        if arguments[:2] == ["show", "-json"]:
            raise PreflightError("Terraform cannot inspect the saved plan with show -json. Reconcile incompatible state/provider schemas and create a fresh reviewable plan.")
        raise PreflightError("Terraform could not read the effective redirect inputs or state. Check initialization, workspace and variable files.")
    # The console can print a state-schema warning before the single expression result.
    output = result.stdout.strip().splitlines()[-1] if expression and result.stdout.strip() else result.stdout
    if not output.strip() and arguments == ["state", "pull"]:
        return {}  # Terraform has no state yet.
    return json.loads(output)


def inputs(argv):
    prefix = [argv.pop(0)] if argv and argv[0].startswith("-chdir=") else []
    command = argv.pop(0)
    arguments = shlex.split(os.getenv("TF_CLI_ARGS", "")) + shlex.split(os.getenv("TF_CLI_ARGS_" + command, "")) + argv
    if "-help" in arguments or "--help" in arguments:
        return None
    # Only these options take a separate, non-boolean argument in plan/apply.
    takes_value = {"-var", "-var-file", "-state", "-state-out", "-backup", "-out", "-target",
                   "-replace", "-parallelism", "-lock-timeout", "-generate-config-out", "-invoke"}
    console_args, state_args, positional = [], [], []
    items = iter(arguments)
    for arg in items:
        flag, equal, value = arg.partition("=")
        if flag in takes_value:
            if not equal:
                value = next(items, None)
                if value is None:
                    raise PreflightError(f"Missing Terraform argument for {flag}.")
            if flag in {"-var", "-var-file", "-state"}:
                console_args.append(f"{flag}={value}")
            if flag == "-state":
                state_args = [value]
        elif not arg.startswith("-"):
            positional.append(arg)
    if positional:
        if command != "apply" or len(positional) != 1:
            raise PreflightError("Unexpected positional Terraform arguments.")
        plan = terraform_json(prefix, ["show", "-json", positional[0]])
        variables = plan["variables"]
        if variables["manage_frontend_www_redirect"]["value"] is False:
            return None
        if variables["manage_frontend_www_redirect"]["value"] is not True:
            raise PreflightError("Cannot determine whether the saved plan manages redirects.")
        zone, token = [variables[k]["value"] for k in ("cloudflare_zone_id_p2party", "cloudflare_api_token")]
        state = plan.get("prior_state", {})
        resources = state.get("values", {}).get("root_module", {}).get("resources", [])
        owned = [item["values"] for item in resources if item.get("address") == ADDRESS]
    else:
        # Let Terraform resolve defaults, TF_VAR_*, tfvars and CLI overrides in their own precedence.
        expr = 'jsonencode(var.manage_frontend_www_redirect ? [var.cloudflare_zone_id_p2party, nonsensitive(var.cloudflare_api_token)] : [])\n'
        config = json.loads(terraform_json(prefix, ["console", "-no-color", *console_args], expr))
        if config == []:
            return None
        zone, token = config
        # state pull reads metadata without trying to decode unrelated legacy resources
        # against their current provider schemas (terraform show does require that).
        if state_args:
            base = Path(prefix[0].partition("=")[2]) if prefix else Path.cwd()
            path = base / state_args[0]
            state = json.loads(path.read_bytes()) if path.exists() else {}
        else:
            state = terraform_json(prefix, ["state", "pull"])
        if state and state.get("version") != 4:
            raise PreflightError("Unrecognized Terraform state format.")
        owned = [instance["attributes"] for item in state.get("resources", [])
                 if not item.get("module") and item.get("mode") == "managed"
                 and item.get("type") == "cloudflare_ruleset" and item.get("name") == "frontend_redirects"
                 for instance in item["instances"] if instance.get("index_key") == 0]
    if owned and (len(owned) != 1 or owned[0].get("zone_id") != zone or not owned[0].get("id")):
        raise PreflightError("Terraform redirect state has an unexpected owner or zone.")
    return zone, token, owned[0]["id"] if owned else None


if __name__ == "__main__":
    try:
        config = inputs(sys.argv[1:])
        if config is not None:
            verify_phase(*config)
    except PreflightError as error:
        sys.exit(f"Redirect preflight failed. {error}")
    except (OSError, http.client.HTTPException, ValueError, TypeError, KeyError, AttributeError):
        sys.exit("Redirect preflight failed. Could not verify the Terraform inputs or authenticated Cloudflare response.")
