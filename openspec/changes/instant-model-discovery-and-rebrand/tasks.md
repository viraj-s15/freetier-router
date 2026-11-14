# Tasks

## 1. Baseline

- [x] 1.1 Run `npm ci` and the server test suite on the unchanged fork, and record the result, so later failures can be told apart from failures that already exist

## 2. Free policy module

- [x] 2.1 Create `server/src/services/free-policy.ts` with the `FreePolicy` union, `FREE_POLICIES`, `DEFAULT_POLICY`, the evaluator map, `freePolicyFor()`, `acceptsModel()` and the shared `patternMatches()` (design D1), and verify `npm run build:server` and `npm run lint` pass
- [x] 2.2 Check each candidate in the design D1 table against the provider's billing docs and `docs/en/providers/01-supported-platforms.md`, add only the confirmed entries to `FREE_POLICIES` with a one-line source comment each, and verify each excluded candidate is named with its reason in the change's `design.md`
- [x] 2.3 Add `server/src/__tests__/services/free-policy.test.ts` that covers each scenario in the spec requirements "Free policy for each provider", "free-key policy", "priced-listing policy" and "pattern policy", and verify the tests pass
- [x] 2.4 Make `custom-model-sync.ts` import `patternMatches()` from the new module, delete its local copy, and verify the existing custom-model-sync tests pass

## 3. Discovery eligibility, schedule and registration

- [x] 3.1 Replace the allowlist, the `instanceof` check and the `catalog_managed` checks with `modelLister()` and the `catalog_ruled_out` check that reads the applied catalog document (design D2), update `ineligibleMessage()`, and verify the spec scenarios under "Discovery covers every model-listing provider" and "Catalog verdict rules a provider out" with new tests, including the scenario where the operator disabled every model
- [x] 3.2 Change the default of `builtinDiscoveryMode()` to `auto`, and verify the spec scenarios under "Automatic discovery is the default" with tests
- [x] 3.3 Read `BUILTIN_MODEL_DISCOVERY_INTERVAL_MS` in `startBuiltinModelDiscovery()` with a 6-hour default, add the variable to `.env.example` (env-drift reads commented keys there as documented, so `env-drift.ts` needs no entry), and verify the spec scenarios under "Discovery has its own schedule" with scheduler tests
- [x] 3.4 Make `autoRegistrable()` call `acceptsModel()` for each platform, and verify that a pass over a mixed model list adds only the accepted models
- [x] 3.5 Write `rpm_limit = 10` and `rpd_limit = 250` from named constants in `registerDiscoveredModels()`, and verify the spec scenario "New discovered model" with a test
- [x] 3.6 Update `server/src/__tests__/services/builtin-model-discovery.test.ts` and `server/src/__tests__/routes/builtin-model-discovery.test.ts` for the new rules, delete tests that assert the old allowlist, and verify both files pass
- [x] 3.7 Rewrite the comment block at the top of `builtin-model-discovery.ts` to state the fork's rules, and verify it no longer names `BUILTIN_DISCOVERY_PLATFORMS`

## 4. Tombstones and catalog sync

- [x] 4.1 Add `'catalog_removed'` to `CatalogTombstoneSource` and add `blocksAutomaticDiscovery()` in `model-state.ts`, and verify with unit tests that it returns true for `user` and `catalog_removed` and false for `upstream_eol`
- [x] 4.2 Make `registerDiscoveredModels()` call `blocksAutomaticDiscovery()` when `explicit` is false, and verify the spec scenarios under "Discovery never adds a removed model" with tests
- [x] 4.3 In `applyCatalog()`, record a `catalog_removed` tombstone after each pruned catalog row unless a `user` tombstone exists, clear a `catalog_removed` tombstone before inserting a listed model, and delete the retire block for discovered rows (design D4)
- [x] 4.4 Check the tombstone joins at `model-state.ts:403`, `model-state.ts:410` and `routes/fallback.ts:174`, re-run `rg -n catalog_model_tombstones server/src` to confirm no other reader exists, and verify with a test that a `catalog_removed` tombstone never counts as an operator deletion (result: all readers already filter on `source`, so no code change was needed)
- [x] 4.5 Add `server/src/__tests__/services/catalog-sync-discovered.test.ts` (a new file, so the upstream test file stays merge-friendly) for the spec requirements "Catalog keeps unlisted discovered models", "Catalog adopts listed discovered models", "Catalog removal records a tombstone", "Catalog listing clears a catalog_removed tombstone" and and verify it passes; "Older catalog never removes newer models" stays covered by the existing `MIN_CATALOG_VERSION` test in `catalog-sync.test.ts`
- [x] 4.6 Update `docs/en/architecture/05-catalog-sync.md` section 4 with a short "In FreeTier Router" note for the keep and tombstone rules, and verify the note matches the specs

## 5. Rebrand

- [x] 5.1 Change the visible name in `client/index.html`, `client/src/App.tsx`, `client/src/components/auth-gate.tsx` and `client/src/components/updates-dialog.tsx`, and verify with `rg -n "FreeLLMAPI" client/src --glob '!*.test.*'` that no match outside locales remains
- [x] 5.2 Replace `FreeLLMAPI` with `FreeTier Router` in all 60 locale files, and verify each file parses as JSON and `npm run check:i18n --prefix client` passes
- [x] 5.3 Point `REPOSITORY` in `server/src/routes/update.ts`, `RELEASES_URL` in `client/src/lib/updates.ts` and `desktop/src/updater.ts`, `SOURCE_COMMAND` in `updates-dialog.tsx`, and the docs links in `client/src/data/agent-tools.json` and `cli/src/tools.ts` to `viraj-s15/freetier-router`, and verify with `rg -n "tashfeenahmed" --glob '!docs/**' --glob '!LICENSE' --glob '!README*'` that only the OpenAPI license link remains
- [x] 5.4 Set `appId`, `productName` and `owner` in `desktop/electron-builder.yml`, the package `name`, `bin`, `description` and URLs in `cli/package.json`, and `IMAGE` in `.github/workflows/docker.yml`, and verify the CLI and desktop builds succeed and the CLI test snapshot is updated on purpose (also done: `artifactName` values spelled `FreeTierRouter-...` with no space because the updater needs space-free names, the desktop data folder in `desktop/src/main.ts`, the desktop UI strings, the macOS and Windows smoke scripts, `docker-compose.yml` image and `SECURITY.md` links)
- [x] 5.5 Rewrite the top of `README.md` with the new name, the fork credit, the "unofficial, no connection to Neu Software LLC" line, the freellmapi.co catalog note, the `free-key` billing assumption and the new env variables, and keep `LICENSE` unchanged, and verify against the "Credit to upstream" spec scenarios
- [x] 5.6 Add a one-line note at the top of `README.ru.md`, `README.tr.md`, `README.uz.md` and `README.zh-cn.md` that links to the English README for fork changes, and verify the links resolve

## 6. Integration check

- [x] 6.1 Run the full test suite, lint and build for server, client, CLI and desktop, and verify all pass or match the baseline from 1.1
- [ ] 6.2 Start the server locally with one free key (for example `groq`), and verify in the logs that a discovery pass runs, that new models appear at the end of the chain with limits 10 and 250, and that a forced catalog sync keeps them
  - Partial run on 2026-11-14 with a dummy key: the real free catalog from freellmapi.co applied (513 new, 41 updated, 77 removed, 73 `catalog_removed` tombstones), saving a `groq` key started a pass that reached Groq's real `/models` and logged a clean 401, and a `longcat` key (no policy) made no call and kept the catalog notice. Still open: a run with a real free key, to see new models land with limits 10 and 250.
