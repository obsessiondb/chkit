"""1:1 port of ``packages/plugin-obsessiondb/src/backfill/console-url.test.ts``."""

from __future__ import annotations

from chkit_plugin_obsessiondb.console_url import build_job_console_url, console_web_base_url

# ── console_web_base_url ─────────────────────────────────────────────────────


def test_maps_the_console_api_host_to_the_web_console_host() -> None:
    assert (
        console_web_base_url("https://console-api.obsessiondb.com")
        == "https://console.obsessiondb.com"
    )


def test_drops_any_path_on_the_api_base_url() -> None:
    assert (
        console_web_base_url("https://console-api.obsessiondb.com/rpc")
        == "https://console.obsessiondb.com"
    )


def test_strips_an_api_segment_for_non_console_hosts() -> None:
    assert console_web_base_url("https://my-api.example.com") == "https://my.example.com"


def test_returns_the_origin_unchanged_when_no_api_mapping_applies() -> None:
    assert console_web_base_url("http://localhost:3000") == "http://localhost:3000"


def test_falls_back_to_the_trimmed_string_for_an_unparseable_url() -> None:
    assert console_web_base_url("not-a-url") == "not-a-url"


# ── build_job_console_url ────────────────────────────────────────────────────


def test_builds_a_service_jobs_job_deep_link() -> None:
    assert (
        build_job_console_url("https://console-api.obsessiondb.com", "my-service", "job-123")
        == "https://console.obsessiondb.com/my-service/jobs/job-123"
    )


def test_url_encodes_the_slug_and_job_id() -> None:
    assert (
        build_job_console_url("https://console-api.obsessiondb.com", "a b", "j/1")
        == "https://console.obsessiondb.com/a%20b/jobs/j%2F1"
    )
