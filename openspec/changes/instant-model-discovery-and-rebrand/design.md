# Design

## Context

See proposal.md for the motivation, and the three specs for the required behavior. The current code has these facts that shape the design:

- `builtin-model-discovery.ts` decides eligibility with `BUILTIN_DISCOVERY_PLATFORMS` (two entries), an `instanceof OpenAICompatProvider` check, and two "catalog-managed" checks (`appliedCatalogPlatforms`, `hasCatalogOwnedRows`).
- `autoRegistrable()` already skips non-chat models and models that the list prices as not free. It accepts a model with no price, so it isn't a free filter for most providers.
- `registerDiscoveredModels()` is insert-only, writes `source = 'discovered'`, writes `NULL` limits, and appends the model to the end of `fallback_config`. A `NULL` rpm limit escapes pre-throttling (`ratelimit.ts:607`).
- `applyCatalog()` in `catalog-sync.ts` adopts a listed discovered row (line 653), deletes catalog rows that the new catalog doesn't list (about line 893), and deletes every discovered row on a managed platform (about line 909).
- `catalog_model_tombstones.source` is free text with values `user` and `upstream_eol`. `isCatalogModelTombstoned()` returns true only for `user`.
- The event trigger (`triggerBuiltinModelDiscovery`) skips a platform that already has models. So on a catalog-managed platform, only the scheduled pass finds new models.

## Goals / Non-Goals

**Goals:**

- Keep every change inside the existing modules and their extension seams, so that an upstream merge touches few lines.
- Make "add a provider to the free policy" a one-line data change.
- Make "support a provider that isn't OpenAI-compatible" (Google) an addition, not an edit of the discovery loop.

**Non-Goals:**

- No new database tables or columns.
- No change to how the router picks a model or to the rate limiter.
- No change to the dashboard's "Fetch models" flow beyond what the specs say.

## Decisions

### D1. Free policy as a data table plus one evaluator per kind

A new module `server/src/services/free-policy.ts` holds:

```ts
type FreePolicy =
  | { kind: 'free-key' }
  | { kind: 'priced-listing' }
  | { kind: 'pattern'; patterns: readonly string[] };

const FREE_POLICIES: Partial<Record<Platform, FreePolicy>> = { ... };
const DEFAULT_POLICY: FreePolicy = { kind: 'pattern', patterns: [] };

const evaluators: { [K in FreePolicy['kind']]: (m: DiscoveredModel, p: Extract<FreePolicy, { kind: K }>) => boolean } = { ... };

export function freePolicyFor(platform: string): FreePolicy;
export function acceptsModel(platform: string, model: DiscoveredModel): boolean;
```

The pattern is a strategy through a function map, keyed by a discriminated union. It is the lightest form that gives the extension point. A new provider is one entry in `FREE_POLICIES`. A new kind of policy is one union member and one evaluator, and the mapped type makes the compiler reject a missing evaluator. A class hierarchy would add ceremony with no gain, because each evaluator is a pure predicate with no state.

`autoRegistrable()` keeps its non-chat check and the global `CUSTOM_MODEL_SYNC_FREE_PATTERNS` check, and calls `acceptsModel()` in place of its own price check. The `free-key` evaluator still rejects a model that the list prices as not free, so it keeps today's protection.

The module also holds `NON_CHAT_PATTERNS` (`*guard*`, `*moderation*`, `*-ocr*`, `*orpheus*`, `*-tts*`), which `acceptsModel()` checks before any policy. The review found that the id classifier in `model-discovery.ts` labels these families as chat. Groq and Mistral list several of them, and without the check the router could send a normal request to a safety classifier. A new family is one more entry in the list.

`patternMatches()` exists twice today, in `builtin-model-discovery.ts` and `custom-model-sync.ts`. The new module exports one copy, and both callers import it.

Alternatives: patterns from an env var only (rejected, because a safe default must ship in the binary), or a policy field on each provider adapter (rejected, because it spreads policy across 40 files and every upstream adapter change would conflict).

Initial table. Each entry needs a check against the provider's billing docs in task 2.2, and an entry that the check can't confirm stays out:

| policy | candidates | source of the claim |
| --- | --- | --- |
| `free-key` | `groq`, `cerebras`, `mistral`, `sealion`, `llm7` | `docs/en/providers/01-supported-platforms.md` and provider pricing pages |
| `priced-listing` | `openrouter` | OpenRouter's `/models` reply has a `pricing` object |
| `pattern` | `unorouter` (`*:free`), `bazaarlink` (`auto:free`) | same doc, which names the `:free` suffix and the `auto:free` route |

Result of the check in task 2.2 (2026-11-14):

- Confirmed `free-key`: `groq` (the Free tier answers 429 at its limits, and billing starts only after an upgrade with a payment method), `mistral` (the Experiment plan is free with no card, and billing starts when a payment method is added), and `sealion` (the API issues only a free trial key).
- Excluded `cerebras`: the free offer is a one-time $5 trial credit that expires after 30 days, and there is no recurring free tier. The catalog still covers it.
- Excluded `llm7`: free tokens cover only `turbo` models, and `pro` models bill from a paid balance. The `/models` reply marks the tier in a `tier` field that the price parser doesn't read, so neither `free-key` nor `priced-listing` is safe.

`openrouter` can have only one policy. It uses `priced-listing`, because the price is a stronger signal than the `:free` suffix. `kilo` isn't in the table, for the reason in D2.

### D2. Eligibility through a capability check, not a class check

Replace the allowlist and the `instanceof` check with one function:

```ts
function modelLister(provider: BaseProvider): OpenAICompatProvider | undefined
```

Today it returns the provider when it is an `OpenAICompatProvider`. To support Google later, this function and `discoverBuiltinModels()` gain a branch for a new lister type. The discovery loop doesn't change. The design doesn't build a `ModelLister` interface now, because only one lister type exists, and an interface with one implementation is speculative.

The `catalog_managed` reason goes away. A new reason, `catalog_ruled_out`, covers the spec rule that a catalog with only disabled rows for a platform rules it out. The check reads the applied catalog document (setting `catalog_applied_json`, parsed and cached the same way as `appliedCatalogPlatforms()` at `catalog-sync.ts:466`), not the local `models.enabled` column. The local column also holds the operator's own disables, so a query on it would rule out a provider whose models the operator turned off. `BUILTIN_DISCOVERY_PLATFORMS` and its comment are deleted.

Keyless platforms (`kilo`, `ovh`, `aihorde`) have no rows in `api_keys`, so `usableKeys()` returns nothing and discovery never runs for them. This is the intended result, because `kilo` logs prompts for training and an automatic pass must not add it to the chain.

### D3. Own schedule for discovery

`startBuiltinModelDiscovery()` reads `BUILTIN_MODEL_DISCOVERY_INTERVAL_MS` (default `6 * 60 * 60 * 1000`) in place of `customModelSyncIntervalMs()`. Add the variable to `.env.example` and to the list in `server/src/lib/env-drift.ts`, next to the catalog variables.

The event trigger stays as it is. Changing it to run for platforms that already have models would call `/models` on every 5-minute health check.

### D4. Catalog sync: keep, adopt, tombstone, clear

Inside the existing transaction in `applyCatalog()`:

1. Adopt (line 653). No change.
2. Before inserting a listed model, if its tombstone source is `catalog_removed`, clear the tombstone. The insert path at line 628 already skips only `user` tombstones, so a `user` tombstone still blocks the insert, as today. The clear keeps the table from holding stale rows.
3. Prune catalog rows (about line 893). After each delete, call `recordCatalogModelTombstone(db, 'chat', platform, modelId, { source: 'catalog_removed' })`, unless a `user` tombstone already exists.
4. Retire discovered rows (about line 909). Delete this block. A discovered row that the catalog lists was adopted in step 1. Any other discovered row stays.

`CatalogTombstoneSource` gains `'catalog_removed'`. A new helper `blocksAutomaticDiscovery(db, kind, platform, modelId)` returns true for `user` and `catalog_removed`, and `registerDiscoveredModels()` calls it in place of `isCatalogModelTombstoned()` when `explicit` is false. `isCatalogModelTombstoned()` keeps its meaning, because other callers rely on it to mean "the operator deleted this".

The dashboard must not show `catalog_removed` tombstones as models that the operator deleted. Two readers join the table without a source filter: `model-state.ts:403` and `model-state.ts:410`, and `routes/fallback.ts:174`. Task 4.4 adds a source filter to each one that means "operator deleted". Only chat rows get the new tombstone, because discovery adds only chat models.

### D5. Default limits

`registerDiscoveredModels()` writes `rpm_limit = 10` and `rpd_limit = 250` in place of `NULL`, from two named constants in `builtin-model-discovery.ts`. Token limits stay `NULL`. The values sit at the low end of the free tiers in the platform doc (`sealion` allows 10 RPM, and `requesty` allows 200 requests a day shared across models), so a new model is unlikely to cause 429 storms before the catalog catches up. A limit, even a loose one, also brings the model under pre-throttling, which a `NULL` limit escapes. Adoption overwrites both values with catalog values.

### D6. Rebrand

- Display name `FreeTier Router`, command and image name `freetier-router`, desktop app id `io.github.viraj-s15.freetier-router`.
- Locale files: one scripted replace of `FreeLLMAPI` with `FreeTier Router` across `client/src/i18n/locales/*.json`, then a check that each file still parses and that `client/scripts/check-i18n.mjs` passes. All 8 strings in each file name the app itself.
- Repository constants: `server/src/routes/update.ts` (`REPOSITORY`), `client/src/lib/updates.ts`, `client/src/components/updates-dialog.tsx`, `desktop/src/updater.ts`, `desktop/electron-builder.yml` (`owner`, `appId`, `productName`), `client/src/data/agent-tools.json`, `cli/src/tools.ts`.
- `server/src/docs/openapi.ts` keeps the license link to upstream's `LICENSE`, because that file is the source of the license.
- `desktop/src/main.ts:23` pins the desktop data folder to `<appData>/FreeLLMAPI` with `app.setPath('userData', ...)`, so a new `productName` alone doesn't move it. The fork sets that path to `<appData>/FreeTier Router`, so its desktop app doesn't read or overwrite an upstream desktop install. Server and Docker installs keep their data path, because the data directory and the `freellmapi-data` volume don't change.
- The Premium license screen stays. Users of the fork can still buy the upstream live feed, and the catalog code needs no change for that.

## Risks / Trade-offs

- [A `free-key` provider starts billing a key after the operator adds a payment method] → The README states that `free-key` assumes an account with no payment method, and names the providers in that list. `BUILTIN_MODEL_DISCOVERY=manual` is the escape hatch.
- [A discovered model fails because it needs a special request shape, or doesn't support tools] → It sits at the end of the fallback chain, so the router tries it last, and the existing health and cooldown paths disable a failing model.
- [The free catalog never lists a model, so it keeps default limits forever] → This is acceptable: the limits are conservative, and the operator can change them in the dashboard.
- [A model leaves the free tier but stays in `/models`, and the catalog never listed it] → Only the policy protects this case. `free-key` providers can't bill, and `pattern` relies on the provider's naming. This is the residual risk of the fork.
- [Upstream merges conflict in `builtin-model-discovery.ts` and `catalog-sync.ts`] → Changes stay small and local, and the policy table lives in a new file.
- [The 6-hour schedule calls many `/models` endpoints] → At most one call per eligible provider with a key, every 6 hours. That is far below any provider's rate limit.

## Migration Plan

1. Existing installs need no data migration. The first scheduled pass after an upgrade adds new models.
2. Existing discovered rows on managed platforms were deleted by upstream sync. They come back on the first pass if the policy accepts them.
3. Rollback: set `BUILTIN_MODEL_DISCOVERY=off` and delete rows with `source = 'discovered'` from the dashboard, or install the previous release. `catalog_removed` tombstones have no effect on upstream code, because upstream reads only `user`.
