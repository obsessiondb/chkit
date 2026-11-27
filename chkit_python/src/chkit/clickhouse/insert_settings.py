"""Migration insert settings accepted from clickhouse.url (#879)."""

from urllib.parse import parse_qsl, urlsplit

_INSERT_SETTING_URL_KEYS = {
    "ch_async_insert": "async_insert",
    "clickhouse_setting_async_insert": "async_insert",
    "ch_wait_for_async_insert": "wait_for_async_insert",
    "clickhouse_setting_wait_for_async_insert": "wait_for_async_insert",
}


def insert_settings_from_url(url: str) -> dict[str, str] | None:
    """Read settings in URL key order using the first value of each key."""
    try:
        parsed = urlsplit(url)
        # urlsplit validates the port only when it is read.
        _ = parsed.port
    except ValueError:
        return None
    if not parsed.scheme or not parsed.hostname:
        return None

    first_values: dict[str, str] = {}
    settings: dict[str, str] = {}
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        name = _INSERT_SETTING_URL_KEYS.get(key)
        if name is not None:
            settings[name] = first_values.setdefault(key, value)
    return settings or None
