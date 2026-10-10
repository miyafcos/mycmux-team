"""Dummy login fixtures; only the opt-in Rust driver may create their targets."""

import base64
import json
import os
from pathlib import Path
import re
import time
from typing import Any, Dict


def staging_dir(env_key: str) -> Path:
    if os.environ.get("MYCMUX_E2E_FAKE_CLI") != "1":
        raise RuntimeError("fake CLI requires MYCMUX_E2E_FAKE_CLI=1")
    directory = Path(os.environ[env_key])
    if (
        not directory.is_dir()
        or directory.parent.name != "cli_login_staging"
        or re.fullmatch(r"[0-9a-f]{32}", directory.name) is None
        or (directory / ".fake-cli-test").read_text() != "mycmux dummy credentials only\n"
    ):
        raise RuntimeError("fake CLI refuses a directory outside its test fixture")
    return directory


def write_json(path: Path, value: Dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(value, output)
    temporary.replace(path)


def fake_jwt(claims: Dict[str, Any]) -> str:
    def encode(value: Dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return encode({"alg": "none", "typ": "JWT"}) + "." + encode(claims) + ".dummy"


def await_credentials_permission(directory: Path) -> None:
    deadline = time.monotonic() + 10
    while not (directory / ".allow-credentials").is_file():
        if time.monotonic() >= deadline:
            raise RuntimeError("Rust driver did not release the credential writer")
        time.sleep(0.025)
    time.sleep(0.1)
