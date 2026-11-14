# Proposal

## Why

Free installs of the upstream router see a new model 30 days after it launches, because the free catalog from freellmapi.co is a delayed snapshot. Each provider's own `/models` endpoint lists new models on the day they launch, and the upstream code can already read it (`builtin-model-discovery.ts`), but turns it on for only two providers. This fork, freetier-router, turns discovery on for every OpenAI-compatible provider and keeps the free catalog as the source of hand-checked metadata.

## What Changes

- Built-in model discovery runs for every built-in provider whose adapter is an `OpenAICompatProvider`, not only the allowlist (`longcat`, `siliconflow`). A provider that the catalog manages stays eligible, unless the catalog disables every one of its models.
- The default for `BUILTIN_MODEL_DISCOVERY` changes from `manual` to `auto`. **BREAKING** for operators who rely on the old default. They can set `BUILTIN_MODEL_DISCOVERY=manual`.
- Discovery gets its own schedule, every 6 hours by default, set by `BUILTIN_MODEL_DISCOVERY_INTERVAL_MS`. Today it shares the daily `CUSTOM_MODEL_SYNC_INTERVAL_MS` cadence. The event trigger skips any platform that already has models, so on a catalog-managed platform the schedule is the only trigger.
- A free policy for each provider decides which discovered models an automatic pass may add:
  - `free-key`: the key can't be billed, so add every chat model.
  - `priced-listing`: add only models that the `/models` reply marks as free.
  - `pattern`: add only model ids that match a free pattern for that provider, or nothing when no pattern exists.
  - A provider with no entry uses `pattern`, so a new provider can't route traffic to a paid model.
  - An explicit pick in the dashboard skips the policy, as it does today.
- Catalog sync keeps a discovered model on a catalog-managed platform until the catalog lists it. When the catalog lists it, sync adopts the row and sets the real metadata, as it does today.
- When the catalog removes a model, sync records a tombstone with the new source `catalog_removed`. Automatic discovery skips a model with this tombstone. A catalog that lists the model again clears the tombstone. A pick in the dashboard can also clear it.
- A discovered model gets conservative default rate limits until the catalog adopts it. Today a discovered row has no limits (`NULL`).
- The catalog source stays unchanged: the free signed monthly catalog from `freellmapi.co`, checked twice a day.
- Rebrand of user-facing names only: README, page title, dashboard text, CLI command name, Docker image name, desktop app name and id. The update check, the release links and the docs links point to `viraj-s15/freetier-router` instead of upstream, so the fork never tells its users to install upstream. Package names (`@freellmapi/*`), the `docs/` tree, settings keys and `localStorage` keys stay the same, so merges from upstream stay simple and existing installs keep their data. The README credits FreeLLMAPI and keeps the MIT notice.

## Out of Scope

- Discovery for providers that are not OpenAI-compatible: `google`, `cohere`, `cloudflare` and similar `BaseProvider` adapters. Google AI Studio is a strong `free-key` candidate, so the design leaves an extension point for it.
- Limits learned from 429 replies or rate-limit headers.
- A self-hosted catalog, and any use of the Premium live feed.
- Publishing the CLI to npm or the desktop app to a release channel.

## Capabilities

### New Capabilities

- `model-discovery`: which providers discovery covers, its schedule, the free policy for each provider, default limits for discovered models, and the rule that discovery skips models the catalog removed.
- `catalog-sync`: how the signed catalog applies to local models, including discovered rows (keep, adopt, tombstone, clear).
- `branding`: the user-facing product name, the update source and the credit to upstream.

### Modified Capabilities

None. The project has no existing specs.

## Impact

- `server/src/services/builtin-model-discovery.ts`: eligibility, default mode, schedule, free filter.
- A new module for the free policy table, next to `builtin-model-discovery.ts`.
- `server/src/services/catalog-sync.ts`: the prune pass for catalog rows (about line 893) and the retire pass for discovered rows (about line 909).
- `server/src/services/model-state.ts`: the new tombstone source `catalog_removed`. The `source` column on `catalog_model_tombstones` has no check constraint, so no migration is needed.
- Existing tests that assert today's behavior must change: `server/src/__tests__/services/builtin-model-discovery.test.ts`, `server/src/__tests__/routes/builtin-model-discovery.test.ts` and `server/src/__tests__/services/catalog-sync.test.ts`.
- Brand strings and links: `README.md`, `client/index.html`, `client/src/i18n/locales/*.json` (60 files, 8 strings each), `client/src/App.tsx`, `client/src/components/auth-gate.tsx`, `client/src/components/updates-dialog.tsx`, `client/src/lib/updates.ts`, `client/src/data/agent-tools.json`, `server/src/routes/update.ts`, `desktop/src/updater.ts`, `desktop/electron-builder.yml`, `cli/package.json`, `cli/src/tools.ts`, `.github/workflows/docker.yml`.
- Load: at most one `/models` call per 6 hours for each eligible provider that has a key, per install. No call goes to freellmapi.co beyond today's twice-daily catalog check.
- No new runtime dependencies.
