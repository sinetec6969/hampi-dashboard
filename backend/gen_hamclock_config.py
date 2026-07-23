"""Sync OpenHamClock's .env from config.yaml (callsign, grid).

OpenHamClock's .env parser overwrites process.env unconditionally, so .env is
the only config surface that wins — patch it in place. Run by
openhamclock.service ExecStartPre so config.yaml stays the source of truth.
"""
import re
import sys

import yaml

CONFIG_YAML = "/home/j/hampi-dashboard/config.yaml"
ENV_PATH = "/home/j/openhamclock/.env"

FIXED = {
    "PORT": "3001",
    "HOST": "0.0.0.0",
    "TIME_FORMAT": "24",
}


def patch_env(text: str, values: dict) -> str:
    for key, val in values.items():
        text, n = re.subn(rf"^{key}=.*$", f"{key}={val}", text, flags=re.M)
        if n == 0:
            text += f"\n{key}={val}\n"
    return text


def main() -> None:
    with open(CONFIG_YAML) as f:
        cfg = yaml.safe_load(f)
    values = dict(FIXED)
    values["CALLSIGN"] = cfg["station"]["callsign"]
    values["LOCATOR"] = cfg["qth"]["grid"]
    with open(ENV_PATH) as f:
        text = f.read()
    with open(ENV_PATH, "w") as f:
        f.write(patch_env(text, values))
    print(f"patched {ENV_PATH}: {values}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        out = patch_env("CALLSIGN=N0CALL\n# PORT note\nPORT=3001\n", {"CALLSIGN": "KR4BPW", "LOCATOR": "EM95of"})
        assert "CALLSIGN=KR4BPW" in out and "LOCATOR=EM95of" in out and "N0CALL" not in out, out
        print("patch_env ok")
    else:
        main()
