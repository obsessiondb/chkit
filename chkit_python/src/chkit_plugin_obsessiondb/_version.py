"""Single source of truth for ``chkit_plugin_obsessiondb.__version__``.

Lives in its own module so the User-Agent constant in
:mod:`chkit_plugin_obsessiondb.api_client` can import the version without
creating a circular import with the package's ``__init__`` (which
re-exports api_client symbols).
"""

from __future__ import annotations

__version__ = "0.1.0"
