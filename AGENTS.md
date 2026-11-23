# Agent rules for FreeTier Router

This repo is a fork of [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi). The fork's features are built-in model discovery for every provider, the free policy in `server/src/services/free-policy.ts`, the `catalog_removed` tombstone, the health checks for discovered models in `server/src/services/discovered-model-*.ts` and the FreeTier Router rebrand. The live router runs from `server/dist` on port 6969, and the pi agent and `ftr` use it.

## Sync with upstream

1. Make sure that `main` is checked out and has no uncommitted changes.
2. Run `scripts/fork/sync-upstream.sh` with a time limit of at least 20 minutes, because the test suites take several minutes.
3. If the script prints "main already has every upstream commit", stop and tell the user.
4. If the script stops with merge conflicts, fix each file in `../freetier-router-sync`:
   - Keep the fork's logic in discovery, the free policy and catalog sync, and add upstream's new code around it.
   - Keep the fork's names: FreeTier Router, `freetier-router` and `viraj-s15/freetier-router`.
   - For `package-lock.json`, take upstream's copy, and rename the `cli` package and its link back to `freetier-router`. Don't regenerate the whole lockfile.
   - If upstream changed a function signature that the fork also changed, keep the fork's signature and update upstream's new callers and tests.
5. After you fix the conflicts, run `git -C ../freetier-router-sync add -A`, and then run `scripts/fork/sync-upstream.sh --continue`.
6. If a check fails, read its log in the report folder that the script prints. Fix the cause in `../freetier-router-sync`, commit the fix there, and run `--continue` again.
7. Tell the user what upstream added, which conflicts you fixed, and the test results.

Obey these rules during a sync:

- Never push. Give the user the push command.
- Never change the fork guard test, `scripts/fork/fork-tests.json` or `scripts/fork/rebrand-manifest.json` to make a failure go away. A failure there means that the merge lost a fork feature, so fix the merge.
- Don't add fork files to upstream files when a new file can do the job, because each line in an upstream file can conflict on the next sync.
- If the restart fails, the script rolls back on its own. Tell the user, and don't start the router by hand on a broken build.

## Fork edits in upstream files

The fork keeps its code in its own files, but these upstream files carry small fork edits. A sync can conflict on them, or drop them with no conflict. The fork guard checks that each one is still there. If upstream rewrites the code around an edit, put the edit back in the new code, and don't delete it.

- `server/src/lib/fallback-loop.ts`: `noteDiscoveredModelFailure(...)` after `noteModelRetirementSignal(...)`, and `noteDiscoveredModelSuccess(route)` after `clearModelFailure(route)`. They feed the rule that turns off a discovered model after 3 requests with a 403 or 404 in a day.
- `server/src/services/catalog-sync.ts`: `applyCatalog` passes its result through `afterCatalogApply`, so a discovered model that the catalog adopts while it waits for its probe turns on in the same sync.
- `server/src/routes/proxy.ts`: `/v1/models` shows `discoveredDisableReason(m.id) ?? 'disabled'`, so a client sees `probe_failed` or `auto_disabled`.
- `server/vitest.config.ts`: `BUILTIN_MODEL_DISCOVERY: 'off'` in the test env. Each key save starts a background discovery pass. In tests, that pass sent `/models` and probe calls into other tests' `fetch` mocks, and the fusion tests failed at random on CI. Keep it off. The discovery tests set or clear the variable themselves, so they still test `auto`.
- Also, `server/src/services/builtin-model-discovery.ts` and the README are fork files that started as upstream files, so they conflict often. Keep the fork's logic in them.

## After you add a fork feature

1. Put its tests in a new test file.
2. Add that file and its test count to `scripts/fork/fork-tests.json`. The fork guard checks the list, and the sync script runs every file in it.
3. If the feature needs an edit in an upstream file, keep it to one line. Add the file and the reason to "Fork edits in upstream files", and add the line to the hook check in `server/src/__tests__/fork/fork-guard.test.ts`.
4. Run `scripts/fork/sync-upstream.sh --check` to check the feature against the live setup.
