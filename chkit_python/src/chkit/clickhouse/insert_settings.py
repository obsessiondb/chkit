"""Migration insert settings accepted from clickhouse.url (#879)."""

import re
from urllib.parse import parse_qsl, urlsplit

_INSERT_SETTING_URL_KEYS = {
    "ch_async_insert": "async_insert",
    "clickhouse_setting_async_insert": "async_insert",
    "ch_wait_for_async_insert": "wait_for_async_insert",
    "clickhouse_setting_wait_for_async_insert": "wait_for_async_insert",
}


def insert_settings_from_url(url: str) -> dict[str, str] | None:
    """The two insert settings migrate accepts from the connection URL. The
    last assignment of a setting wins, under either prefix, as with repeated
    ``--setting`` flags. Like a WHATWG URL parser (TS ``insertSettingsFromUrl``),
    leading and trailing spaces and control characters are dropped, and so are
    tabs and newlines anywhere."""
    url = re.sub(r"[\t\n\r]", "", url).strip("".join(chr(c) for c in range(0x21)))
    try:
        parsed = urlsplit(url)
        # urlsplit validates the port only when it is read.
        _ = parsed.port
    except ValueError:
        return None
    if not parsed.scheme or not parsed.hostname:
        return None

    settings: dict[str, str] = {}
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        name = _INSERT_SETTING_URL_KEYS.get(key)
        if name is not None:
            settings[name] = value
    return settings or None
