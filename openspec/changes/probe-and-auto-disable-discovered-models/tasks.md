# Tasks

## 1. Check state and the error predicate

- [x] 1.1 Create `server/src/services/discovered-model-checks.ts` with the table setup (`CREATE TABLE IF NOT EXISTS discovered_model_checks`, once for each DB handle), and read and write functions for each state. Add `server/src/__tests__/services/discovered-model-checks.test.ts`, and verify that the table appears on a fresh DB and that a second setup call doesn't fail.
- [x] 1.2 Add the `DISCOVERED_MODEL_CHECKS` setting (`on` by default, `off`), and verify each value and an unknown value in the same test file.
- [x] 1.3 Add `isPermanentModelError(err)` as in design Decision 5, and verify that it is true for 404, 410, 403 and a model-level 400, and false for 429, 503, a timeout, a client cancel, an account suspension and a bare 401.
- [x] 1.4 Add `operator` detection: a row with `held_off = 1` whose model has `models.enabled = 1` becomes `operator`. Run the check at the start of each probe step and in the failure hook, and write `models` and the check row in one transaction. Verify it with a test that turns the model on through `PATCH /api/models/:id`, and with a test that a probe pass doesn't set `operator`.
- [x] 1.4a Add the `tools_value` column and the tool-flag operator check. Verify that a `supportsTools` change through `PATCH /api/models/:id` sets `tools_checked = 1`, and that the next tool check doesn't run.
- [x] 1.5 Add the backfill: when the table first appears, add a `pending` row with `held_off = 0` for each `source = 'discovered'` model with no row. Give a model that is already off a row with `state = 'operator'`. Verify that the existing models stay on and get rows, that a model that is off stays off and is never probed, and that a second start adds no duplicates.
- [x] 1.6 Add the cleanup: delete check rows whose model is gone or no longer has `source = 'discovered'`, apply the adoption rules of design Decision 1, and rebuild the set and the reason map. Verify that an adopted pending row turns on, that an adopted `probe_failed` row stays off, and that a deleted model leaves no check row.

## 2. New models start off

- [x] 2.1 Change `registerDiscoveredModels` so that an automatic pass inserts rows with `enabled = 0` and `supports_tools = 0`, plus a `pending` row with `held_off = 1`, while checks are on. Keep explicit picks and `off` as they are today. Update `builtin-model-discovery.test.ts`, and verify the three cases.
- [x] 2.2 At startup with checks `off`, turn on rows that are `pending` with `held_off = 1`, and leave rows with a verdict off. Do the same when `BUILTIN_MODEL_DISCOVERY` is `manual` or `off`. Verify each case with a test, and verify that an unknown `DISCOVERED_MODEL_CHECKS` value acts as `on` and logs a warning.

## 3. The probe

- [x] 3.1 Create `server/src/services/discovered-model-probe.ts` with the `ProbeCheck` type and `chatCheck`, as in design Decision 3. Add `server/src/__tests__/services/discovered-model-probe.test.ts`, which mocks the adapter. Verify pass on text, pass on an empty answer with `length`, fail on 404 and 403, and inconclusive on 429, 503 and a timeout.
- [x] 3.2 Add `toolCheck`, and verify that a tool call sets `supports_tools = 1`, that text or a tools-named 400 sets 0, and that an inconclusive result leaves `tools_checked = 0` for a retry and keeps the current `supports_tools` value, for a new model (0) and a backfill model (1).
- [x] 3.3 Add the probe runner: it takes up to 10 `pending` rows for each platform, oldest first, and applies the outcomes. On pass it turns the model on and sets `ok`, a fail adds 1 to `probe_failures`, and at 3 it sets `probe_failed` and turns the model off. Verify with tests for each outcome, the 3-failure limit, the budget of 10 with 25 rows, that a backfill row stays on until its third fail, that a key error and an empty rpm or rpd budget count as inconclusive, and that a second probe step for the same platform returns at once while the first one runs.
- [x] 3.4 Count probe usage with `recordRequest`, `recordTokens` and `logRequest` with the client `model-probe`. Verify that a probe adds one request to the model's rpm count.
- [x] 3.5 Call the runner from `runBuiltinModelDiscovery` for each eligible platform after registration, with the same key, even when the list adds no new models. Give the probe step its own `try`. Verify with discovery tests that a pass with no new models still probes pending rows, and that a pass whose `/models` call fails still probes them.

## 4. The failure rule

- [x] 4.1 Create `server/src/services/discovered-model-failures.ts` with `noteDiscoveredModelFailure` and `noteDiscoveredModelSuccess`, as in design Decision 4. Include the persisted `failure_times`, the 24-hour window, deduplication by request trace and the in-memory set. Add `server/src/__tests__/services/discovered-model-failures.test.ts`, and verify every scenario in the spec's failure-rule requirements.
- [x] 4.2 Add the two hook lines in `server/src/lib/fallback-loop.ts`, next to `noteModelRetirementSignal` and `clearModelFailure`. Verify with a fallback-loop test that a discovered model goes off after 3 requests with 403 on the proxy path, and that a catalog model stays on.
- [x] 4.3 Verify that the success hook does no DB write for a model with no counted failures, with a test that spies on the DB handle.

## 5. Visibility and docs

- [x] 5.1 Add `discoveredDisableReason` and the one-line change in `server/src/routes/proxy.ts`. Key the reason map by the listed id, as in design Decision 6. Verify that `/v1/models` shows `probe_failed` and `auto_disabled`, still shows `disabled` for other models that are off, and shows `disabled` for a merged entry where one row is off for another reason.
- [x] 5.2 Log each verdict with the model, the verdict and the redacted last error. Verify with a test on the log output.
- [x] 5.3 Add `DISCOVERED_MODEL_CHECKS` to the fork's "Model discovery" block in `.env.example`, and add one line to the README's "What this fork changes" section. Then run `node scripts/fork/gen-rebrand-manifest.mjs`, and verify that the fork guard passes.

## 6. Fork guard and integration

- [x] 6.1 Add the four new test files to `FORK_TEST_FILES` in `server/src/__tests__/fork/fork-guard.test.ts`, and add a check that `discovered_model_checks` exists after `initDb`. Verify that the fork guard passes.
- [x] 6.2 Run `npm run lint`, `npm run build` and `npm test`, and verify that all pass.
- [x] 6.3 Run `scripts/fork/sync-upstream.sh --check`. Verify that the smoke checks pass on a copy of the live DB, and that the 9 existing discovered models get `pending` rows. Also verify that a pass probes them and turns off the Lyria models after their third fail.

## Workflow follow-up

- Restart the live router on 6969 after review, with a sync run or the restart steps in `scripts/fork/README.md`.
- Archive the change with `/opsx-archive` after the user reviews the result.
