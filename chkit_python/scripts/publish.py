"""Publish to PyPI.

Loads credentials from `.env` (TWINE_USERNAME, TWINE_PASSWORD, optional
TWINE_REPOSITORY_URL) and injects the Windows certificate store via
``truststore`` so corporate-proxied connections don't fail with SSL errors.

Usage:
    python scripts/publish.py             # uploads dist/* to PyPI
    python scripts/publish.py --test      # uses TestPyPI repository URL
"""

from __future__ import annotations

import argparse
import os
import runpy
import sys
from pathlib import Path

import truststore
from dotenv import load_dotenv


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--test",
        action="store_true",
        help="Upload to TestPyPI instead of PyPI.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    env_path = project_root / ".env"
    if not env_path.exists():
        print(f"error: {env_path} not found", file=sys.stderr)
        return 1
    load_dotenv(env_path)

    if args.test:
        os.environ["TWINE_REPOSITORY_URL"] = "https://test.pypi.org/legacy/"

    truststore.inject_into_ssl()

    dist_dir = project_root / "dist"
    artifacts = sorted(str(p) for p in dist_dir.glob("*.whl"))
    artifacts += sorted(str(p) for p in dist_dir.glob("*.tar.gz"))
    if not artifacts:
        print(f"error: no build artifacts in {dist_dir}", file=sys.stderr)
        return 1

    sys.argv = ["twine", "upload", *artifacts]
    runpy.run_module("twine", run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main())
