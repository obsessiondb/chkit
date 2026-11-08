"""The server's MergeTree ``index_granularity`` default (#466).

Mirrors ``packages/clickhouse/src/index-granularity.ts``.
"""

from __future__ import annotations

import logging
from typing import Any

_LOG = logging.getLogger("chkit.config")


class IndexGranularityMismatchError(Exception):
    """A server whose ``<merge_tree><index_granularity>`` differs from the value
    chkit assumes (``clickhouse.indexGranularity``, 8192 by default). Tables
    created without the setting store the server's value, so chkit would report
    drift, plan their recreation, or strand a cutover."""

    code = "index_granularity_mismatch"

    def __init__(self, server_value: int, configured_value: int) -> None:
        super().__init__(
            f"This server's MergeTree index_granularity default is {server_value}, but chkit "
            f"assumes {configured_value} for tables that do not declare index_granularity. "
            f"Set clickhouse.indexGranularity: {server_value} in the config."
        )
        self.server_value = server_value
        self.configured_value = configured_value


def assert_server_index_granularity(client: Any, configured: int) -> None:
    """Raise ``IndexGranularityMismatchError`` when the server's MergeTree
    ``index_granularity`` default is not ``configured``. When the server cannot
    be asked (no grant on system.merge_tree_settings, an executor that cannot
    run the query), nothing is checked and the command goes on; ``--debug``
    logs why."""
    try:
        rows = client.query(
            "SELECT value FROM system.merge_tree_settings WHERE name = 'index_granularity'"
        ).rows
    except Exception as error:  # any failure only skips the check
        _LOG.debug("index_granularity default not checked: %s", error)
        return
    value = rows[0].get("value") if rows else None
    try:
        server = int(str(value))
    except ValueError:
        server = 0
    if server <= 0:
        _LOG.debug("index_granularity default not checked: unexpected value %r", value)
        return
    if server != configured:
        raise IndexGranularityMismatchError(server, configured)
