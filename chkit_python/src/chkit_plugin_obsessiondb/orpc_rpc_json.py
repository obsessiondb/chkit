"""How ``@orpc/client`` 1.15.4 decodes the JSON body of an RPC response.

A port of ``StandardRPCSerializer.deserialize`` and
``StandardRPCJsonSerializer.deserialize`` for a parsed JSON body
``{"json": value, "meta": [[type, ...path], ...]}``: each ``meta`` item turns
the value at ``path`` into a ``bigint``, ``Date``, ``NaN``, ``undefined``,
``URL``, ``RegExp``, ``Set`` or ``Map``. TS's ``RPCLink`` reports any failure
of that as ``Invalid RPC response format.``, so this module only has to say
whether the body decodes, and which JS type each value ends up with: the
decoded value tells an oRPC error body from a malformed one. Converted values
are opaque :class:`JsValue` objects; JS ``undefined`` is :data:`UNDEFINED` and
``NaN`` is ``float("nan")``.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Iterator
from typing import Any

# JS ``undefined``.
UNDEFINED: Any = object()


class InvalidRpcFormatError(Exception):
    """The body is not a valid serialized RPC value (TS: ``Invalid RPC response format.``)."""


class JsValue:
    """A value ``meta`` converted into a JS type that JSON has no form for."""

    def __init__(self, js_type: str) -> None:
        self.js_type = js_type


_BIGINT, _DATE, _NAN, _UNDEFINED_TYPE, _URL, _REGEXP, _SET, _MAP = range(8)

# ``StrWhiteSpaceChar``: JS WhiteSpace and LineTerminator.
_LINE_TERMINATORS = "\n\r" + chr(0x2028) + chr(0x2029)
_JS_SPACE = re.escape(
    "\t\v\f "
    + _LINE_TERMINATORS
    + "".join(
        chr(c)
        for c in (0xA0, 0x1680, *range(0x2000, 0x200B), 0x202F, 0x205F, 0x3000, 0xFEFF)
    )
)
_BIGINT_STRING = re.compile(
    rf"[{_JS_SPACE}]*(?:[+-]?[0-9]+|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)?[{_JS_SPACE}]*"
)
# ``SERIALIZED_REGEXP_FORMAT`` (``/^\/(.*)\/([a-z]*)$/``): JS ``.`` stops at line terminators.
_SERIALIZED_REGEXP = re.compile(f"/([^{re.escape(_LINE_TERMINATORS)}]*)/([a-z]*)")
_REGEXP_FLAGS = re.compile("[dgimsuvy]*")
_URL_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*:")
_SPECIAL_SCHEMES = frozenset({"http", "https", "ws", "wss", "ftp"})
_FORBIDDEN_HOST_CHARS = frozenset(" #%/:<>?@[\\]^|")
_CANONICAL_INDEX = re.compile("0|[1-9][0-9]*")


def deserialize_rpc_body(body: Any) -> Any:
    """The value ``RPCLink`` decodes from the parsed JSON ``body`` of a response.

    Raises :class:`InvalidRpcFormatError` where TS does.
    """
    if body is None:
        # ``data.json`` on ``null`` throws.
        raise InvalidRpcFormatError
    if not isinstance(body, dict):
        # A list or primitive has no ``json`` or ``meta``.
        return UNDEFINED
    root: dict[str, Any] = {"data": copy.deepcopy(body["json"]) if "json" in body else UNDEFINED}
    meta = body.get("meta")
    if meta is None:
        items: list[Any] = []
    elif isinstance(meta, list):
        items = meta
    elif isinstance(meta, str):
        # ``for (const item of meta)`` iterates a string's characters.
        items = list(meta)
    else:
        raise InvalidRpcFormatError
    for item in items:
        _apply_meta_item(root, item)
    return root["data"]


def _apply_meta_item(root: dict[str, Any], item: Any) -> None:
    if item is None:
        raise InvalidRpcFormatError
    if isinstance(item, list):
        meta_type = item[0] if item else UNDEFINED
        segments: Iterator[Any] = iter(item[1:])
    elif isinstance(item, dict):
        meta_type = item.get("0", UNDEFINED)
        segments = _object_segments(item)
    else:
        # A string's first character, or a number's or boolean's missing ``[0]``:
        # never a built-in type.
        return
    if (
        not isinstance(meta_type, int | float)
        or isinstance(meta_type, bool)
        or meta_type not in range(8)
    ):
        return

    container: Any = root
    key: Any = "data"
    for segment in segments:
        container = _get(container, key)
        key = _property_key(segment)
        if not _has_own(container, key):
            raise InvalidRpcFormatError
    _set(container, key, _convert(int(meta_type), _get(container, key)))


def _object_segments(item: dict[str, Any]) -> Iterator[Any]:
    """``item[i]`` for ``i`` from 1 while ``i < item.length``, for an object item."""
    length = item.get("length", UNDEFINED)
    if isinstance(length, bool):
        length = int(length)
    if not isinstance(length, int | float):
        return
    i = 1
    while i < length:
        yield item.get(str(i), UNDEFINED)
        i += 1


def _has_own(container: Any, key: str) -> bool:
    """``Object.hasOwn``, where a ``True`` the transform then fails on counts as ``False``.

    An array's ``length`` and a string's characters are own properties, but a
    meta item can neither convert nor go through them.
    """
    if isinstance(container, dict):
        return key in container
    if isinstance(container, list):
        return _CANONICAL_INDEX.fullmatch(key) is not None and int(key) < len(container)
    return False


def _get(container: Any, key: str) -> Any:
    return container[int(key)] if isinstance(container, list) else container[key]


def _set(container: Any, key: str, value: Any) -> None:
    if isinstance(container, list):
        container[int(key)] = value
    else:
        container[key] = value


def _property_key(segment: Any) -> str:  # noqa: PLR0911
    """``ToPropertyKey`` of a JSON value."""
    if isinstance(segment, str):
        return segment
    if segment is UNDEFINED:
        return "undefined"
    if segment is None:
        return "null"
    if isinstance(segment, bool):
        return "true" if segment else "false"
    if isinstance(segment, int):
        return str(segment)
    if isinstance(segment, float):
        if segment.is_integer() and abs(segment) < 1e21:  # noqa: PLR2004
            return str(int(segment))
        return repr(segment)
    if isinstance(segment, list):
        return ",".join("" if s is None else _property_key(s) for s in segment)
    return "[object Object]"


def _convert(meta_type: int, value: Any) -> Any:  # noqa: PLR0911
    if meta_type == _BIGINT and isinstance(value, str) and _BIGINT_STRING.fullmatch(value):
        return JsValue("bigint")
    if meta_type == _DATE and (value is None or isinstance(value, str)):
        return JsValue("Date")
    if meta_type == _NAN and value is None:
        return float("nan")
    if meta_type == _UNDEFINED_TYPE and value is None:
        return UNDEFINED
    if meta_type == _URL and isinstance(value, str) and _is_valid_url(value):
        return JsValue("URL")
    if meta_type == _REGEXP and isinstance(value, str) and _is_serialized_regexp(value):
        return JsValue("RegExp")
    if meta_type == _SET and isinstance(value, list):
        return JsValue("Set")
    # ``new Map`` takes only object entries.
    if (
        meta_type == _MAP
        and isinstance(value, list)
        and all(isinstance(entry, list | dict) for entry in value)
    ):
        return JsValue("Map")
    raise InvalidRpcFormatError


def _is_serialized_regexp(value: str) -> bool:
    match = _SERIALIZED_REGEXP.fullmatch(value)
    if match is None:
        return False
    flags = match.group(2)
    return (
        _REGEXP_FLAGS.fullmatch(flags) is not None
        and len(set(flags)) == len(flags)
        and not ("u" in flags and "v" in flags)
    )


def _is_valid_url(value: str) -> bool:
    """Whether ``new URL(value)`` parses, for the common cases.

    An approximation of the WHATWG URL parser: an absolute URL with a scheme,
    and for a special scheme other than ``file`` a host and a numeric port.
    """
    text = value.strip("".join(chr(c) for c in range(0x21))).translate(
        {ord("\t"): None, ord("\n"): None, ord("\r"): None}
    )
    scheme_match = _URL_SCHEME.match(text)
    if scheme_match is None:
        return False
    scheme = scheme_match.group()[:-1].lower()
    if scheme not in _SPECIAL_SCHEMES:
        return True
    rest = text[scheme_match.end() :].lstrip("/\\")
    authority = re.split(r"[/?#\\]", rest, maxsplit=1)[0]
    host_port = authority.rsplit("@", 1)[-1]
    if host_port.startswith("["):
        host, port = host_port, ""
    else:
        host, _, port = host_port.partition(":")
    if port and (not port.isascii() or not port.isdigit() or int(port) > 65535):  # noqa: PLR2004
        return False
    return bool(host) and not (set(host) & _FORBIDDEN_HOST_CHARS)
