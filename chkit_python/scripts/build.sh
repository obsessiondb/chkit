#!/usr/bin/env bash
# Builds the chkit-py sdist and wheel into dist/, checks their metadata, and
# smoke-tests the wheel in a clean environment. Runs in `verify` (Turbo build
# task) and in publish-chkit-py.yml, so a release builds exactly what CI built.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
uv build --quiet --out-dir dist
# twine runs in its own environment: twine 7 needs rich>=14, which chkit-py
# excludes. Keep the version in step with pypa/gh-action-pypi-publish.
uvx --from twine==7.0.0 twine check --strict dist/*

wheel=$(ls dist/*.whl)
uv run --isolated --no-project --with "$wheel" python -c \
  "import chkit, chkit_plugin_backfill, chkit_plugin_codegen, chkit_plugin_obsessiondb; print(chkit.__version__)"
uv run --isolated --no-project --with "$wheel" chkit --version
