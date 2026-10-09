"""chkit_plugin_obsessiondb — ObsessionDB integration for chkit-py.

Two consumer surfaces:

1. ``obsessiondb()`` — the plugin factory you put in your config's
   ``plugins`` list. Adds an ``on_schema_loaded`` hook that rewrites
   ``Shared*`` engines to standard equivalents when targeting a
   non-ObsessionDB host, and strips cloud-only settings.

2. ``run_onboarding(*, config_path, connect, email, code, org_name)``
   — the interactive wizard ``chkit init`` calls. When the user
   hasn't authenticated yet, prints a runbook with the commands they
   should run. When authenticated, dispatches to the appropriate
   flow (claim a free instance, log in, etc.). Phase 1 of the port
   ships the runbook path only — the full API integration lives in
   a follow-up turn.

The CLI ``chkit init`` discovers this package via ``importlib`` so it
must remain importable as the top-level name
``chkit_plugin_obsessiondb``.
"""

from __future__ import annotations

from chkit_plugin_obsessiondb._version import __version__
from chkit_plugin_obsessiondb.api_client import (
    DeviceCodeResponse,
    OtpRateLimitError,
    OtpVerifyResult,
    SessionExpiredError,
    SessionResponse,
    create_organization,
    get_session,
    poll_device_token,
    request_device_code,
    send_verification_otp,
    set_active_organization,
    verify_otp,
)
from chkit_plugin_obsessiondb.auth_login import (
    run_login,
    run_logout,
    run_whoami,
)
from chkit_plugin_obsessiondb.auth_signup import (
    SignupOptions,
    derive_org_name,
    run_signup,
    slugify_org_name,
)
from chkit_plugin_obsessiondb.backfill_handler import handle_backfill_command
from chkit_plugin_obsessiondb.credentials import (
    Credentials,
    clear_credentials,
    get_credentials_path,
    load_credentials,
    resolve_base_url,
    save_credentials,
)
from chkit_plugin_obsessiondb.engine import (
    is_obsessiondb_host,
    resolve_strip_behavior,
    rewrite_shared_engines,
    strip_cloud_settings,
    strip_shared_prefix,
)
from chkit_plugin_obsessiondb.jobs_api import (
    JobDetail,
    JobSubmitTask,
    JobSummary,
    jobs_cancel,
    jobs_get,
    jobs_list,
)
from chkit_plugin_obsessiondb.json_envelope import (
    JSON_CONTRACT_VERSION,
    ErrorEnvelope,
    ServiceListEntry,
    ServiceListEnvelope,
    WhoamiEnvelope,
    error_envelope,
    service_list_envelope,
    whoami_envelope,
)
from chkit_plugin_obsessiondb.onboarding import (
    ConnectChoice,
    EnsurePluginResult,
    OnboardingOptions,
    connect_runbook_lines,
    ensure_obsessiondb_plugin_in_source,
    run_onboarding,
)
from chkit_plugin_obsessiondb.plugin import (
    ObsessionDBPluginOptions,
    create_obsessiondb_plugin,
    obsessiondb,
)
from chkit_plugin_obsessiondb.remote_executor import (
    RemoteClickHouseClient,
    create_remote_executor,
    normalize_query_data,
    normalize_query_json_result,
)
from chkit_plugin_obsessiondb.service_api import (
    ClaimInstanceClaimed,
    ClaimInstanceResult,
    InstanceClaimStatus,
    Service,
    ServiceOrganization,
    claim_instance,
    get_service,
    instance_claim_status,
    list_service_organizations,
    list_services,
)
from chkit_plugin_obsessiondb.service_claim import run_claim
from chkit_plugin_obsessiondb.service_select import (
    ServiceChoice,
    render_service_organizations,
    select_service_interactive,
    service_choice_label,
)
from chkit_plugin_obsessiondb.storage import (
    SelectedService,
    ServiceAliases,
    load_selected_service,
    load_service_aliases,
    remove_service_alias,
    save_selected_service,
    save_service_alias,
)
from chkit_plugin_obsessiondb.workbench_api import (
    WorkbenchColumn,
    WorkbenchExecuteResult,
    workbench_query_execute,
)

__all__ = [
    "JSON_CONTRACT_VERSION",
    "ClaimInstanceClaimed",
    "ClaimInstanceResult",
    "ConnectChoice",
    "Credentials",
    "DeviceCodeResponse",
    "EnsurePluginResult",
    "ErrorEnvelope",
    "InstanceClaimStatus",
    "JobDetail",
    "JobSubmitTask",
    "JobSummary",
    "ObsessionDBPluginOptions",
    "OnboardingOptions",
    "OtpRateLimitError",
    "OtpVerifyResult",
    "RemoteClickHouseClient",
    "SelectedService",
    "Service",
    "ServiceAliases",
    "ServiceChoice",
    "ServiceListEntry",
    "ServiceListEnvelope",
    "ServiceOrganization",
    "SessionExpiredError",
    "SessionResponse",
    "SignupOptions",
    "WhoamiEnvelope",
    "WorkbenchColumn",
    "WorkbenchExecuteResult",
    "__version__",
    "claim_instance",
    "clear_credentials",
    "connect_runbook_lines",
    "create_obsessiondb_plugin",
    "create_organization",
    "create_remote_executor",
    "derive_org_name",
    "ensure_obsessiondb_plugin_in_source",
    "error_envelope",
    "get_credentials_path",
    "get_service",
    "get_session",
    "handle_backfill_command",
    "instance_claim_status",
    "is_obsessiondb_host",
    "jobs_cancel",
    "jobs_get",
    "jobs_list",
    "list_service_organizations",
    "list_services",
    "load_credentials",
    "load_selected_service",
    "load_service_aliases",
    "normalize_query_data",
    "normalize_query_json_result",
    "obsessiondb",
    "poll_device_token",
    "remove_service_alias",
    "render_service_organizations",
    "request_device_code",
    "resolve_base_url",
    "resolve_strip_behavior",
    "rewrite_shared_engines",
    "run_claim",
    "run_login",
    "run_logout",
    "run_onboarding",
    "run_signup",
    "run_whoami",
    "save_credentials",
    "save_selected_service",
    "save_service_alias",
    "select_service_interactive",
    "send_verification_otp",
    "service_choice_label",
    "service_list_envelope",
    "set_active_organization",
    "slugify_org_name",
    "strip_cloud_settings",
    "strip_shared_prefix",
    "verify_otp",
    "whoami_envelope",
    "workbench_query_execute",
]
