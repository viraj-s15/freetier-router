# Design

## Context

- `registerDiscoveredModels` in `builtin-model-discovery.ts` inserts each discovered row with `enabled = 1` and `supports_tools = 1`, and adds it to `fallback_config` and every profile. This file is already a fork file.
- The router has two switches for a model. `models.enabled` decides whether the model can route at all. The dashboard's On switch writes `fallback_config.enabled` and `profile_models.enabled`. The router skips a row with `models.enabled = 0` (`router.ts:1878`), and the dashboard can set it back through `PATCH /api/models/:id`.
- `routePinnedModel`, which the dashboard's Test button uses, reads only rows with `models.enabled = 1`, so a probe for a model that is off can't use it.
- `recordRetryableFailure` in `fallback-loop.ts` handles every failed attempt on every API surface. It already calls `noteModelRetirementSignal(route, err, getRequestTrace())`, and the request trace identifies one request across its failovers. `clearModelFailure(route)` runs when an attempt succeeds.
- `isModelNotFoundError` and `isModelAccessForbiddenError` in `error-classify.ts` already define model-level permanent errors, and `isAccountSuspendedError` and `isKeyAuthError` define the account-level and key-level errors.
- Migrations are listed in `db/migrate/defaults.ts`, an upstream file that changes with each upstream migration.

## Goals / Non-Goals

**Goals:**
- Keep the edits to upstream files to single-line hooks, so syncs stay easy.
- Add no database write on the success path of a request.
- Make a new kind of probe check one new function.

**Non-Goals:**
- Changes to how upstream benches or retires catalog models.
- Changes to the dashboard client.

## Decisions

### 1. The fork turns models off with `models.enabled`, and records why in its own table

The probe and the failure rule set `models.enabled`, which hides the row from routing and leaves the operator's chain switches as they are. A new table, `discovered_model_checks`, holds one row for each discovered model:

| column | meaning |
| --- | --- |
| `model_db_id` | primary key, references `models(id)` with `ON DELETE CASCADE` |
| `state` | `pending`, `ok`, `probe_failed`, `auto_disabled` or `operator` |
| `held_off` | 1 when the fork turned the model off |
| `probe_failures` | conclusive failed probes so far |
| `tools_checked` | 1 when a tool check gave a verdict, or the operator set the flag |
| `tools_value` | the `supports_tools` value that the service last wrote |
| `failure_times` | JSON array of the times of the counted request failures |
| `last_error` | the last error, redacted |
| `updated_at` | time of the last change |

A row with `held_off = 1` whose model now has `models.enabled = 1` means that the operator turned it on. The fork then sets `state = 'operator'` and stops checking the model, so no upstream route needs a hook. "Operator" means every writer other than this service, such as `PATCH /api/models/:id` and `declarative-config.ts:445`. The service runs this check at the start of each probe step and in the failure hook, before it writes. The service writes `models.enabled`, `models.supports_tools` and its own row in one transaction, so its own writes never look like an operator change.

The same rule covers the tool flag. A column `tools_value` holds the `supports_tools` value that the service last wrote. If `models.supports_tools` differs from it, the operator changed the flag, so the service sets `tools_checked = 1` and doesn't write the flag again.

The backfill gives a model that is already off a row with `state = 'operator'`, so the probe never turns on a model that the operator turned off. The probe turns a model on only when `held_off = 1`.

States and transitions:

| from | trigger | to |
| --- | --- | --- |
| (none) | automatic pass inserts a model | `pending`, `held_off = 1` |
| (none) | backfill, model on | `pending`, `held_off = 0` |
| (none) | backfill, model off | `operator` |
| `pending` | chat probe passes | `ok`, model on, `held_off = 0` |
| `pending` | third failed probe | `probe_failed`, model off, `held_off = 1` |
| `pending` with model on, or `ok` | third counted request failure | `auto_disabled`, model off, `held_off = 1` |
| `pending`, `probe_failed` or `auto_disabled` with `held_off = 1` | another writer turns the model on | `operator` |
| `pending` with `held_off = 1` | catalog adopts the model | row deleted, model on unless the catalog entry is off |
| any other state | catalog adopts the model | row deleted, `models.enabled` unchanged |
| `pending` with `held_off = 1` | startup with checks off or discovery not `auto` | `ok`, model on, `held_off = 0` |

The failure rule and the probe apply only in `pending` and `ok`, and only while `models.source = 'discovered'`. A `pending` row with `held_off = 1` is off, so it gets no traffic and no request failures. The service handles one model in one synchronous transaction at a time, so a probe verdict and a failure verdict can't interleave.

Catalog adoption has one hook in `catalog-sync.ts`: `applyCatalog` passes its result through `afterCatalogApply`, so an adopted pending model turns on in the same sync. At the start of each probe step and at startup, the service also finds check rows whose model now has `source != 'discovered'`, applies the adoption rows of the table and deletes the check rows. It also deletes check rows whose model is gone, because the migrate CLI turns `foreign_keys` off (`db/migrate/cli.ts:195`) and the cascade then doesn't run. It rebuilds the in-memory set and the reason map after each cleanup.

The alternative was a new column on `models`. It was rejected because catalog sync and the backup restore rewrite `models` rows, and every upstream query that copies the column list would need to know about it.

### 2. The service creates its table, and no entry goes into the migration list

`discovered-model-checks.ts` runs `CREATE TABLE IF NOT EXISTS` once for each database handle, before its first query. A migration in `defaults.ts` would be the usual practice in this repo, but upstream appends to that list in most releases, so a fork entry there would conflict on most syncs. The table needs no change to existing tables, so creating it on demand is safe.

### 3. The probe runs inside the discovery pass, as a list of check functions

After a pass reads a platform's model list and registers the new models, it probes up to 10 rows of that platform in the `pending` state, oldest first. The probe step has its own `try`, so a failed `/models` call doesn't skip it. It uses the first usable key, the same key that listed the models, through `withKeyProxy`, and calls the adapter's `chatCompletion` directly. A key error counts as inconclusive. Before each probe, the runner checks the model's rpm and rpd budget on that key, and it skips the model as inconclusive when the budget is empty.

The runner keeps an in-memory `Set` of the platforms whose probe step is in progress. A second step for the same platform returns at once. The scheduled pass isn't in the `inFlight` map of `triggerBuiltinModelDiscovery`, so this set is the only guard against two probes of one row. Each check is a function that returns `pass`, `fail` or `inconclusive`:

```
const CHECKS: ProbeCheck[] = [chatCheck, toolCheck];
```

- `chatCheck` sends `ping` with `max_tokens: 16`. An answer with text counts as pass, and so does an empty answer with the finish reason `length`. A model error, as in Decision 5, any other 400 that isn't a key error, and an empty answer with another finish reason count as fail, because a model that can't answer a one-word chat request can't serve chat. Anything else counts as inconclusive. The failure rule for real requests still counts only Decision 5 errors, because a 400 there can come from the client's own request.
- `toolCheck` runs only after `chatCheck` passes. It sends one tool with one string argument, the instruction to call it, `tool_choice: 'auto'` and `max_tokens: 128`. A tool call counts as pass, and a text answer or a 400 that names tools counts as fail. On a pass or a fail it sets `supports_tools` and `tools_checked = 1`. If the result is inconclusive, the tool check runs again on the next pass, and `supports_tools` keeps its current value: 0 for a new model, and the old value for a backfill model.

A list of functions is the lightest pattern that lets a future vision or context-window check be one new function. A class hierarchy would add nothing here.

Each probe calls `recordRequest` and `recordTokens`, and it logs the request with the client `model-probe`, the same way the Test button logs `model-test`. That way the probes count toward the model's limits and show in the request log.

The existing discovered rows get a `pending` row with `held_off = 0` when the table first appears. So they stay on while their probes run.

### 4. Two hooks in `fallback-loop.ts`, with an in-memory set on the success path

- On a failed attempt, next to `noteModelRetirementSignal`: `noteDiscoveredModelFailure(route, err, getRequestTrace())`.
- On a successful attempt, next to `clearModelFailure`: `noteDiscoveredModelSuccess(route)`.

The service keeps an in-memory `Set` of the model ids whose `failure_times` isn't empty. It loads the set when the service starts and updates it on each write. So the success hook is one set lookup, and it writes to the database only for a model that has counted failures. The failure hook reads the model's `source` only when the error is a permanent model error.

Separate requests are told apart the way `model-retirement.ts` does it. The service keeps the last request trace that counted for each model, in memory, so one request's failover across keys counts once. After a restart that identity is lost, but the next failure is a new request anyway. `runFallbackLoop` always runs the attempts inside `runWithRequestTrace` (`fallback-loop.ts:1485`), so a failure always has a trace. If a future caller has no trace, the failure counts as its own request.

### 5. Which errors count

A permanent model error is `isModelNotFoundError(err) || isModelAccessForbiddenError(err)`, and only when the error is also not `isAccountSuspendedError` or `isKeyAuthError`, and not a client cancel. The probe and the failure rule both use this predicate, from one function, so the two features can't drift apart.

### 6. The reason in `/v1/models`

`proxy.ts` changes `'disabled'` to `discoveredDisableReason(m.id) ?? 'disabled'`. Here `m.id` is the listed id: the `model_id` string, or the `canonicalId` of a unify group (`model-listing.ts`), not `models.id`. So the map is keyed by the listed id. For each listed id, the service collects every row that the listing would merge into that entry. It stores a reason only when every one of those rows is off with a check reason, `auto_disabled` if any row has it and `probe_failed` if not. The service rebuilds the map on each verdict, so a `/v1/models` call makes no extra database query.

### 7. The setting

`DISCOVERED_MODEL_CHECKS` accepts `on` (the default) and `off`. Any other value counts as `on`, and the service logs a warning that names the value. With `off`, `registerDiscoveredModels` inserts rows on and tool-capable, as today. The probe and both hooks then return at once, and at startup the service turns on the rows that wait in `pending` with `held_off = 1`. The service does the same at startup when `BUILTIN_MODEL_DISCOVERY` is `manual` or `off`, because no automatic pass would ever probe those rows.

## Risks / Trade-offs

- [A model that works on a paid key can fail on the free key that the probe uses] → The probe uses the first usable key, healthy keys first, which is the key that discovery lists models with. The router can pick another key later, so a model that works only on some keys can still fail on others, and the failure rule then handles it.
- [OpenRouter accounts without credits get a small free daily limit, and probes use it] → At most 10 models for each pass, a tool check only after a chat pass, and probes run only for models with no verdict. The first run probes the 9 existing rows once, which costs about 18 requests.
- [A new model waits up to 6 hours for the next pass when the pass budget is full] → The event pass on key save also runs the probes, and the budget only delays a model, never loses one.
- [A provider that answers 403 for a short time on one key could count] → It needs 3 separate requests within 24 hours, a served request clears the count, and the operator can turn the model back on, after which the rule leaves it alone.
- [The table is created outside the migration list] → `CREATE TABLE IF NOT EXISTS` is idempotent, and the fork guard test covers the table, so a sync that breaks it fails a test.

## Migration Plan

1. Deploy with the sync script, which tests the build on a copy of the database first.
2. On the first start, the service creates the table and adds `pending` rows for the existing discovered models, which stay on.
3. The next discovery pass, or a key save, probes them.
4. To roll back the behavior, set `DISCOVERED_MODEL_CHECKS=off` and restart. Pending rows turn on, and models with a verdict stay off until the operator turns them on. The table can stay, because nothing else reads it.

## Future cases, not built now

- A vision check and a context-window check, as new entries in `CHECKS`.
- The same probe for models that the custom-endpoint sync adds.
- A badge in the dashboard, which can read `unavailable_reason`.
- Limits learned from rate-limit headers during the probe.
