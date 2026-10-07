# Goal subscriptions: schema base and consumer handoff

This base adds exactly `goal_subscriptions`. It adds no collector, notification
runtime, Goal repair, or Dashboard behavior. Numeric observations remain solely
in `metrics` / `metric_points`; run output and failures remain in `widget_runs`.

## Inspected consumers (base 7b08086728)

| Responsibility                   | Existing entry point                                                                                                                   | Observed behavior / boundary                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal measured acceptance         | `apps/server/src/services/goal/index.ts`, `evaluateMetricCriteria`                                                                     | Reads `MetricModel.findByKeys('goal', goal.id, keys)` then latest points. Later change must resolve a clause through the subscription to the Widget metric, never copy points to a Goal series. |
| Goal planning / final acceptance | `apps/server/src/services/goal/manager.ts`, `setAcceptanceCriteria` in Goal service                                                    | Final acceptance still uses title lookup and failed takeover only permits escalation. Repair lifecycle is a later PR.                                                                           |
| Goal durable waiting             | `apps/server/src/services/goal/wait.ts`, `scheduler/impls/{local,qstash}.ts`, `router-hono/workflows/goal/handlers/{advance,sweep}.ts` | Existing wait/wake coordination and scheduled advance, distinct from Widget collection schedule.                                                                                                |
| Widget authoring/versioning      | `apps/server/src/services/widget/index.ts`, `WidgetService.saveDraft/dryRun/publish/rollback/refresh`                                  | Immutable version/contentHash, preview runs, published version pinned to manual runs.                                                                                                           |
| Collection scheduling            | `apps/server/src/services/widget/scheduler.ts`, `WidgetModel.claimDueRun/renewRunLease`                                                | Due slot CAS reserves a run and advances nextRunAt transactionally; expired reservations resume.                                                                                                |
| Queue dispatch                   | `apps/server/src/router-hono/workflows/widget/handlers/{tick,runWidget}.ts`, `scripts/serverLauncher/startServer.js`                   | QStash tick, slot and lease dedupe; `widget:tick` permits local real-server dispatch.                                                                                                           |
| Execution                        | `apps/server/src/services/widget/executeRun.ts`, `sandbox/{index,cloudflareWorker}.ts`, `credentials.ts`                               | Credentials, allowlisted network and remote sandbox; invalid/timeout/partial statuses persisted. Missing sandbox configuration fails a run.                                                     |
| Result persistence               | `packages/database/src/models/widget.ts`, `finishRun/isCurrentRun`                                                                     | Only running-to-final transition, preview exclusion, published version/start ordering gate. Latest card output can be partial.                                                                  |
| Metric persistence               | `apps/server/src/services/widget/metrics.ts`, `recordWidgetMetrics`; `packages/database/src/models/metric.ts`                          | Complete successful folded runs only; `actorId = runId`, actorType system/sourceType probe. Stat: finish time; series: source timestamps, serialized appendNewerPoints.                         |
| Dashboard data                   | `apps/server/src/services/dashboard/index.ts`, `packages/database/src/models/dashboard.ts`, `listItems`                                | Placements join the same widgets; readable widgets and matching workspace checked. A board does not own collection history.                                                                     |
| UI gap                           | `src/features/Projects/Workspace/ProjectDashboard.tsx`                                                                                 | Project overview surface exists; no general persisted Widget board/result renderer found in this base. Do not equate data/router availability with a verified shared display.                   |

Cloud source inspected read-only at freshly fetched `lobehub-cloud` origin/main
`ee0c6c544923e5498b62d0495e596b7ecaea4d3a`: no Goal/Widget/Dashboard service
or feature overrides found in its tracked `src/apps/packages` paths (the unrelated
HomeUsageWidget is a billing component). OSS remains the inspected runtime owner.
Cloud `scripts/migrateMainDatabase/{index,run,migrations}.ts` consumes the OSS
migration history and filters retired pg_search migrations; `build-migrate-db`
already migrates both databases. This is a remote-default source inspection, not proof of
deployment configuration, scheduler registration,
sandbox availability, credentials, or successful live collection. Those remain
unverified. No private production database was accessed.

## Identity, ownership and deletion

One subscription per `(goalId, widgetId, metricId)`; a separate partial unique
index makes NULL metricId one result-only subscription per Goal/Widget. Several
metrics from one Widget can be consumed independently. Result-only subscriptions
can wake planning but cannot satisfy a numeric clause. Threshold/change policies
require a metric; every numeric clause maps to exactly one subscription via
`binding.criterionKey` (service validation must reject ambiguous mappings).

`userId` is the Goal owner, not necessarily the Widget creator in a workspace.
The binding service must load all parents in the authenticated scope, assert
subscription.userId = goal.userId and NULL-safe workspace equality for Goal,
Widget, version and metric. Personal bindings require all owners equal. Workspace
bindings require membership, permission to manage the Goal and current read access
to the Widget and metric; public visibility never authorizes cross-workspace use.
Version must belong to Widget; metric must be a live subjectType=widget series
with subjectId=widgetId, matching bound key/kind/unit. Worker queries recheck these
invariants, soft deletion, visibility and Goal status before reads or writes.

Simple foreign keys enforce existence, not authorization or parent coherence.
These service validations are required before any runtime enables a row. Existing
parent tables lack the composite unique scope keys needed for DB-only enforcement;
adding them is outside this base's allowed exports/schema scope. Do not claim the
DDL prevents an arbitrary privileged SQL writer from creating cross-owner links.

Hard deletion of Goal, Widget, metric, confirmed version, owner or workspace
cascades subscription deletion: a missing source cannot silently become a different
binding or a result-only subscription. Soft deletion must stop consumption in the
worker. Cursor IDs are durable values rather than FKs, so history retention does
not reset a watermark. No shared Widget is deleted/stopped when a Goal disables
consumption. Default enabled=false prevents accidental activation.

## Query indexes

- Goal list/upsert: two unique indexes beginning with goalId.
- Non-preview completion fanout: enabled partial `(widgetId, workspaceId, userId)`;
  scope and live Goal checks remain mandatory.
- Personal/workspace lists: `(userId, goalId)` for NULL workspace and
  `(workspaceId, goalId)` respectively; subscription visibility is inherited from
  its Goal, not globally public.
- Metric/version deletion and rebinding lookup: dedicated FK indexes.
- Restart reconciler: enabled partial `(updatedAt, id)` keyset pagination. Use
  cyclic full passes; this timestamp is scan ordering, not a due-time schedule.

No index is added on existing collection tables. Existing run index begins with
`(widgetId, createdAt)`; UUID is an explicit tie-break sort. Metric range index
begins with `(metricId, observedAt)`; point UUID is an explicit tie-break sort.
Measure later runtime query plans before requesting additional upstream indexes.

## Cursor protocol and correctness prerequisites

The typed JSON cursor stores positions and lastWakeAt, never sampled values.
Use PostgreSQL timestamp precision in UTC strings without JavaScript millisecond
truncation, and PostgreSQL UUID ordering. Run order is `(created_at, id)` (immutable
reservation creation), not startedAt (a resumed lease changes it) or arrival order.
Observation order is `(observed_at, id)` within the bound metric. runId is the
identity/dedupe key; notification redelivery at/below the committed run cursor has
no effect. Point provenance must match the runId; do not infer it from latestOutput
or widgets.lastRunId, which later runs can replace.

A worker locks the subscription, checks expected bindingRevision, walks runs in
order and advances only a contiguous handled prefix. Do not skip a running run
then advance beyond it: stop at that barrier and revisit after completion. Preview,
wrong-version, failed, timeout, partial and ineligible stale runs are handled as
non-achieving outcomes; failures can expose collection health but never supply a
numeric success. Read points from the bound metric with system/probe/run provenance;
check age <= maxAgeMs, future skew <= maxFutureSkewMs, complete succeeded run,
version/semantics match, and monotonically newer observation tuple. For a series,
read the whole run's point set before advancing its run cursor; older observations
must not regress accepted progress. Equality timestamps use the UUID tie-break.
Wake policy must be evaluated against authoritative metric history, not values
stored on this subscription. Validate finite thresholds and positive intervals /
age and nonnegative change/skew. Apply `toMetricScale` for comparisons.

Commit cursor advancement and the existing durable Goal wake/observation effect
atomically, or use its existing durable coordination state with a retryable CAS;
never persist a cursor first and send an unrecoverable notification afterwards.
Fence every callback with subscription id + bindingRevision and current Goal
wait/turn identity. Early notifications are hints: scan persisted runs when a wait
starts and periodically after restart, whether or not a notification arrived.

Two existing writer gaps MUST be resolved in the later subscription runtime PR:

1. `finishRun` commits before `recordWidgetMetrics`; a succeeded run with no points
   can mean collection without numbers, metric write pending, or failed persistence.
   Do not advance a metric subscription past it merely because no point is visible.
   Make the existing run/metric writes and completion publication atomic, or record
   an explicit retryable persistence outcome in existing storage and reconcile it.
   `widget_runs.output` is recovery input, not a second authoritative metric store.
2. `WidgetModel.startRun` inserts without a parent serialization lock. A transaction
   with earlier createdAt can commit after a scanner's high-water mark. Coordinate
   reservation insertion and scan boundaries using the same Widget row lock, with
   transaction isolation/clock rules that prevent an invisible older insert being
   skipped (allocate createdAt after obtaining the lock). Alternatively prove an
   equally durable anti-gap protocol; a fixed lookback alone is not sufficient.

This base does not pretend scalar cursors alone solve these writer races. No new
event-history table is authorized. If implementation needs a persistence-state
column or replay index on existing stores, request a separately scoped schema
change in that later delivery rather than slipping it into this base.

## Semantic rebinding and cadence

confirmedVersionId plus binding.semanticsHash pins explicitly confirmed source /
account, extraction path, key, kind and unit. Freeze the associated metric meaning;
current MetricModel.ensure may update kind/unit, so the runtime must guard semantic
changes and create a new metric key when observations would become incomparable.
Even a script-only version change requires explicit confirmation in this conservative
base. A callback from another version cannot achieve the Goal.

Rebinding is one transaction: disable consumption, lock row, validate source and
permissions, increment bindingRevision, replace confirmedVersionId/binding/policies,
reset observation/run/wake cursor under an explicit replay policy, then enable only
when user-authorized and Goal active. Default to a baseline at confirmation that
excludes pre-confirmation evidence; do not silently replay old successful samples.
Old callbacks and in-flight workers must fail the revision CAS. Preserve audit
using existing Goal events and version/run history, not another observation table.

Widget schedule controls collection. observation_window intervalMs and lastWakeAt
control planning frequency, with durable scheduling for a window boundary even if
no new event arrives. Frequent sampling must not imply frequent LLM planning.
Pausing/cancelling/achieving a Goal prevents its consumption/wakes; Widget schedules,
shared boards and other Goal subscriptions continue. Freshness is evaluated again
when acceptance runs, not only when an event was originally accepted.

## Stack boundaries and later real-branch acceptance

1. **Goal repair on this base:** explicit current acceptance and rounds, retained
   failed history, corrective tasks and atomic obsolete-block removal; independent
   re-verification of changed evidence, rejection of stale/duplicate verdicts;
   bounded repeated repairs under budgets, pause and human gates. No weakening of
   original requirements or title-only identity.
2. **Widget subscriptions on repair:** scoped binding CRUD, non-preview completion
   fanout, runId dedupe, ordered cursor/restart and missed-event reconciliation,
   the two writer gaps above, validity/freshness and explicit semantic rebinding;
   separate collection/planning cadence and lifecycle isolation. Add behavioral
   regression tests that fail before the change.
3. **Dashboard on subscriptions:** existing Widget/metric data for trend, freshness
   and failures, associated Goal progress/wait/execution on existing product surfaces.
   No copied observations or additional collector.

Run later acceptance on a Cloud development checkout pinned to each actual OSS
branch with overrides accounted for, or a full isolated OSS server+SPA with that
branch. Production debug proxy is not a branch verification environment. Required:
local PostgreSQL migrations, Redis, local QStash and signed tick/advance callbacks,
S3 upload roundtrip and auth, configured Widget sandbox URL/token/network contract,
authorized external source credentials, and a model provider for Manager/verifier.
Use controlled real Widget scripts for success/partial/timeout/failure and delayed
ordering, not schema fixtures as proof of collection. Capture parent replies/cards
and Dashboard same-source display. Verify repair-to-reverification success, bounded
failure, stale verdict rejection, budgets/pause/human gates, early/duplicate/out-of-order
notifications, restart compensation, failed/partial/stale sampling, and shared
Dashboard display in those behavior PRs; publish their acceptance links.

## Acceptance decision for this base

This changes schema/types/documentation only and enables no product behavior.
No Goal repair, subscription execution or Dashboard product acceptance is claimed.
Task delivery evidence covers the schema artifacts, local migration validation,
consumer handoff and open PR; programmatic checks are separate quality gates.
The overall Goal remains incomplete after this bounded base delivery.
