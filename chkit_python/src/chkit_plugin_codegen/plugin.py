"""``codegen()`` plugin factory + plugin runtime wiring.

Mirrors ``packages/plugin-codegen/src/plugin.ts``:

- ``codegen({...})`` returns a ``ChxPlugin`` with one command (``codegen``)
  and an ``on_check`` hook.
- The command supports ``--check`` (compare-only) and write mode.
- File writes are atomic (write-to-temp + rename).
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from chkit.core import load_schema_definitions
from chkit.plugins import (
    ChxCheckFinding,
    ChxOnCheckContext,
    ChxOnCheckReportContext,
    ChxOnCheckResult,
    ChxPlugin,
    ChxPluginCommand,
    ChxPluginCommandContext,
    ChxPluginManifest,
)
from chkit_plugin_codegen.options import (
    CODEGEN_FLAG_MAP,
    CODEGEN_FLAGS,
    PluginConfig,
    normalize_codegen_options,
)
from chkit_plugin_codegen.type_artifacts import generate_type_artifacts


@dataclass(frozen=True, slots=True)
class _CheckArtifact:
    label: str
    out_file: Path
    expected: str
    current: str | None
    missing_code: str
    stale_code: str


def _read_text_or_none(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _write_atomic(target: Path, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    suffix = secrets.token_hex(6)
    tmp = target.parent / f".{target.name}.{suffix}.tmp"
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, target)


def _evaluate_artifact(artifact: _CheckArtifact) -> ChxCheckFinding | None:
    if artifact.current is None:
        return ChxCheckFinding(
            code=artifact.missing_code,
            message=f"{artifact.label} output file is missing: {artifact.out_file}",
            severity="error",
            metadata={"outFile": str(artifact.out_file)},
        )
    if artifact.current != artifact.expected:
        return ChxCheckFinding(
            code=artifact.stale_code,
            message=f"{artifact.label} output is stale: {artifact.out_file}",
            severity="error",
            metadata={"outFile": str(artifact.out_file)},
        )
    return None


def _options_from_context(raw: dict[str, Any]) -> Any:
    """Promote a raw options-dict (camel- or snake-case) into ``CodegenOptions``."""
    return normalize_codegen_options(raw)


def _resolve_out_path(config_path: str, out_file: str) -> Path:
    base = Path(config_path).resolve().parent
    return (base / out_file).resolve()


def _merge_plugin_options(
    plugin_options: PluginConfig, ctx_options: dict[str, Any]
) -> Any:
    """Layer command-context options over the factory-captured plugin options.

    The plugin runtime today doesn't thread factory-supplied options through
    ``ctx.options``, so we read them off the hook closure and let any ctx
    overrides (typically empty for the generate-integration case) win.
    """
    base = plugin_options.model_dump(exclude_none=True, by_alias=False)
    base.update(ctx_options or {})
    return normalize_codegen_options(base)


def _run_codegen(ctx: ChxPluginCommandContext) -> int:
    plugin_options: PluginConfig = PluginConfig()
    for entry in ctx.plugin_runtime.plugins:
        if entry.plugin.manifest.name == "codegen" and isinstance(
            getattr(entry.plugin.hooks, "options", None), PluginConfig
        ):
            plugin_options = entry.plugin.hooks.options
            break
    options = _merge_plugin_options(plugin_options, ctx.options)
    check_mode = bool(ctx.flags.get("--check"))
    out_path = _resolve_out_path(ctx.config_path, options.out_file)

    definitions = load_schema_definitions(
        list(ctx.config.schema_), cwd=Path(ctx.config_path).resolve().parent
    )
    generated = generate_type_artifacts(definitions=definitions, options=options)

    if check_mode:
        current = _read_text_or_none(out_path)
        artifact = _CheckArtifact(
            label="Codegen",
            out_file=out_path,
            expected=generated.content,
            current=current,
            missing_code="codegen_missing_output",
            stale_code="codegen_stale_output",
        )
        finding = _evaluate_artifact(artifact)
        payload: dict[str, Any] = {
            "ok": finding is None,
            "findingCodes": [finding.code] if finding else [],
            "outFile": str(out_path),
            "mode": "check",
        }
        if ctx.json_mode:
            ctx.print(payload)
        elif finding is None:
            ctx.print(f"Codegen up-to-date: {out_path}")
        else:
            ctx.print(f"Codegen check failed ({finding.code}): {out_path}")
        return 0 if finding is None else 1

    _write_atomic(out_path, generated.content)
    payload = {
        "ok": True,
        "outFile": str(out_path),
        "declarationCount": generated.declaration_count,
        "findingCodes": [f.code for f in generated.findings],
        "mode": "write",
    }
    if ctx.json_mode:
        ctx.print(payload)
    else:
        ctx.print(
            f"Codegen wrote {out_path} ({generated.declaration_count} declarations)"
        )
    return 0


@dataclass
class _CodegenHooks:
    """Hook object: ``on_check`` runs the same comparison the CLI ``--check`` does."""

    options: PluginConfig

    def on_check(self, ctx: ChxOnCheckContext) -> ChxOnCheckResult | None:
        merged: dict[str, Any] = dict(self.options.model_dump(exclude_none=True, by_alias=False))
        merged.update(ctx.options or {})
        options = normalize_codegen_options(merged)
        out_path = _resolve_out_path(ctx.config_path, options.out_file)

        definitions = load_schema_definitions(
            list(ctx.config.schema_), cwd=Path(ctx.config_path).resolve().parent
        )
        generated = generate_type_artifacts(definitions=definitions, options=options)
        current = _read_text_or_none(out_path)
        finding = _evaluate_artifact(
            _CheckArtifact(
                label="Codegen",
                out_file=out_path,
                expected=generated.content,
                current=current,
                missing_code="codegen_missing_output",
                stale_code="codegen_stale_output",
            )
        )
        return ChxOnCheckResult(
            plugin="codegen",
            evaluated=True,
            ok=finding is None,
            findings=[finding] if finding else [],
            metadata={"outFile": str(out_path)},
        )

    def on_check_report(self, ctx: ChxOnCheckReportContext) -> None:
        codes = [f.code for f in ctx.result.findings]
        if ctx.result.ok:
            ctx.print("codegen check: ok")
            return
        suffix = f" ({', '.join(codes)})" if codes else ""
        ctx.print(f"codegen check: failed{suffix}")


def create_codegen_plugin(
    options: PluginConfig | dict[str, Any] | None = None,
) -> ChxPlugin:
    """Build a ``ChxPlugin`` for the codegen plugin."""
    if isinstance(options, dict):
        plugin_options = PluginConfig.model_validate(options)
    elif options is None:
        plugin_options = PluginConfig()
    else:
        plugin_options = options
    return ChxPlugin(
        manifest=ChxPluginManifest(name="codegen", api_version=1),
        hooks=_CodegenHooks(options=plugin_options),
        commands=[
            ChxPluginCommand(
                name="codegen",
                description="Generate Pydantic models from chkit schema definitions",
                run=_run_codegen,
                flags=list(CODEGEN_FLAGS),
            ),
        ],
        options_schema=PluginConfig,
        extend_commands=[{"flag_mapping": CODEGEN_FLAG_MAP}],
    )


def codegen(
    options: PluginConfig | dict[str, Any] | None = None,
) -> ChxPlugin:
    """User-facing factory matching the TS ``codegen()`` registration helper."""
    return create_codegen_plugin(options)


__all__ = [
    "codegen",
    "create_codegen_plugin",
]
