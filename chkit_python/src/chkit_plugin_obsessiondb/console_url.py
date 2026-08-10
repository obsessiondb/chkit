"""Console deep-link helpers.

Port of ``packages/plugin-obsessiondb/src/backfill/console-url.ts``.
"""

from __future__ import annotations

import re
from urllib.parse import quote, urlsplit, urlunsplit


def console_web_base_url(api_base_url: str) -> str:
    """Derive the web-console base URL from the stored API base URL.

    Credentials store the API host (e.g. ``https://console-api.obsessiondb.com``);
    the web console lives at the sibling host (``console.obsessiondb.com``). We
    map a leading ``console-api.`` to ``console.``, fall back to stripping an
    ``-api`` segment, and finally return the origin unchanged when no mapping
    applies.
    """
    try:
        split = urlsplit(api_base_url)
        if not split.scheme or split.hostname is None:
            raise ValueError(api_base_url)
        hostname = split.hostname
        if hostname.startswith("console-api."):
            hostname = f"console.{hostname[len('console-api.'):]}"
        elif "-api." in hostname:
            hostname = hostname.replace("-api.", ".", 1)
        if ":" in hostname:  # IPv6 literal — restore brackets
            hostname = f"[{hostname}]"
        netloc = hostname
        # WHATWG `origin` (which TS builds from) omits scheme-default ports.
        default_port = {"https": 443, "http": 80}.get(split.scheme)
        if split.port is not None and split.port != default_port:
            netloc = f"{hostname}:{split.port}"
        return urlunsplit((split.scheme, netloc, "", "", ""))
    except ValueError:
        return re.sub(r"/+$", "", api_base_url)


def build_job_console_url(api_base_url: str, service_slug: str, job_id: str) -> str:
    """Build the deep-link to a job's progress page in the ObsessionDB console.

    Shape: ``<console>/<serviceSlug>/jobs/<jobId>``.
    """
    return (
        f"{console_web_base_url(api_base_url)}/"
        f"{quote(service_slug, safe='')}/jobs/{quote(job_id, safe='')}"
    )


__all__ = ["build_job_console_url", "console_web_base_url"]
