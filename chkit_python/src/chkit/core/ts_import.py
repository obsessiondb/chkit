"""Load a user config or schema module from an absolute file path.

Mirrors `@chkit/core/ts-import.ts`. In TypeScript that helper has to
choose between Bun's native loader and `jiti` (for Node) because `.ts`
files need transpilation. Python has no such split — `importlib.util`
loads `.py` directly — but exporting a named helper keeps the public
API surface parallel and lets us centralise the synthetic module
naming convention so two schema files with the same stem can coexist
in `sys.modules`.
"""

from __future__ import annotations

import itertools
import sys
from pathlib import Path
from types import ModuleType


class ModuleLoadError(RuntimeError):
    """Raised when the module file cannot be read or compiled."""


_load_counter = itertools.count()


def _synthetic_module_name(path: Path) -> str:
    """Generate a unique synthetic name per call.

    A monotonic counter (rather than a hash of the path) is used so that
    re-loading the same path twice produces two distinct modules. This
    is required because Python's importlib caches bytecode keyed by
    mtime, and on Windows NTFS mtime granularity (~10ms) can mask
    back-to-back rewrites of the same source — a real issue when tests
    or watch-mode dev loops mutate a schema file in quick succession.
    """
    serial = next(_load_counter)
    return f"chkit_user_module_{path.stem}_{serial:08x}"


def import_module_file(path: Path | str) -> ModuleType:
    """Import a Python module from a file path, always reading fresh source.

    The file is read via ``read_text``, compiled with the builtin
    ``compile()``, and executed against a fresh ``ModuleType``. This
    intentionally bypasses ``importlib``'s mtime-keyed cache so that
    successive calls always reflect the latest on-disk content.
    """
    file_path = Path(path)
    if not file_path.is_absolute():
        file_path = file_path.resolve()

    try:
        source = file_path.read_text(encoding="utf-8")
    except OSError as error:
        msg = f"Unable to load module from {file_path}: {error}"
        raise ModuleLoadError(msg) from error

    module_name = _synthetic_module_name(file_path)
    module = ModuleType(module_name)
    module.__file__ = str(file_path)
    sys.modules[module_name] = module

    code = compile(source, str(file_path), "exec")
    exec(code, module.__dict__)
    return module
