# CHX Optional Feature: ClickHouse Compatibility Matrix

## Status
Deferred optional feature. Not required for core MVP migration loop.

## Scope
1. Define a compatibility ruleset by targeted ClickHouse versions.
2. Validate planned operations and rendered SQL against selected version constraints.
3. Surface warnings or errors when a schema feature is unsupported or behavior differs by version.
4. Keep compatibility checks configurable so teams can target their real deployment versions.

## Why This Is Helpful
1. Prevents shipping migrations that pass locally but fail on older production clusters.
2. Makes version-related risk visible during planning, not during deployment.
3. Supports mixed-environment orgs where staging and production versions differ.

## Helpful Scenarios
1. Teams running non-latest ClickHouse versions.
2. Multi-environment pipelines with version skew across clusters.
3. Migrations using newer engine/settings/TTL/index semantics.
4. Upgrade windows where temporary backward-compatibility is required.

## Importance
1. Priority: Medium.
2. Business impact: Important for mature production safety, but optional for initial core release with controlled environments.
3. Technical dependency: Most valuable once core planner output and validation surfaces are stable.

## Suggested Adoption Order
1. Start with a small set of high-impact incompatibility rules.
2. Add warning mode first, then strict blocking mode.
3. Expand coverage based on real migration failures and support incidents.
