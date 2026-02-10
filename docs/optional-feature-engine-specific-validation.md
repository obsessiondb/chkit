# CHX Optional Feature: Engine-Specific Validation and Migration Hints

## Status
Deferred optional feature. Not required for core MVP migration loop.

## Scope
1. Add advanced validation rules tied to specific ClickHouse engines and related options.
2. Detect risky or invalid engine-specific schema changes before SQL execution.
3. Produce targeted migration hints for safe engine-aware evolution paths.
4. Keep checks additive to core validation so base workflows remain simple.

## Why This Is Helpful
1. Catches subtle engine-level issues earlier than runtime failures.
2. Improves migration safety for advanced table designs.
3. Reduces troubleshooting time for complex engine configurations.

## Helpful Scenarios
1. Projects using more advanced engine settings beyond basic MergeTree defaults.
2. Schema changes involving TTL, indexes, or settings with engine constraints.
3. Teams migrating existing hand-managed ClickHouse infra into CHX.
4. Environments where migration rollback is expensive and prevention matters.

## Importance
1. Priority: Medium-Low for MVP, Medium-High for advanced production use.
2. Business impact: Valuable in complex deployments; limited value for simple core schemas.
3. Technical dependency: Should follow core diff/render reliability and baseline safety policies.

## Suggested Adoption Order
1. Implement a narrow rule set for the most failure-prone engine cases.
2. Ship hint-only output before hard blocking.
3. Expand rules incrementally from production feedback.
