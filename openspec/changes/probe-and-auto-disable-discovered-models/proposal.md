# Proposal

## Why

Built-in discovery adds every model that a provider lists and its free policy allows, and it turns each one on with no test. Some of these models never work: on this install, the two OpenRouter Lyria models are music models, and `inkling-2-small` answers 403 outside agent apps. They stay in the `auto` chain until the operator finds them by hand. Upstream benches a failing model for only 10 minutes and turns a model off for good only on a clear end-of-life answer, so a model that always answers 403 or 404 comes back every 10 minutes. Discovery also marks every model as tool-capable, so the router can send pi's tool requests to a model that can't call tools.

## What Changes

- Discovery adds a new model turned off. A probe then sends the model one small chat request with the key that listed it. If the model answers, the probe turns it on.
- The probe also sends one small request with a tool. It sets `supports_tools` from the result, so the router sends tool requests only to models that called the tool.
- A 429, a 5xx answer or a timeout during the probe is inconclusive, and the probe tries again on the next discovery pass. A permanent model error counts as one failed probe. After 3 failed probes the model stays off, and the operator can still turn it on by hand.
- The probe runs once on the discovered models that exist before this change, which are on today. It turns one off only after 3 failed probes, the same as a new model.
- A discovered model that gets a permanent model error on 3 separate requests within 24 hours is turned off. Permanent model errors are the ones that upstream already classifies as model-not-found or model-access-forbidden, such as 404, 410, 403 and model-level 400 answers. A 429, a 5xx answer, a timeout or a key error such as a bare 401 never counts. A served request clears the count.
- A model that a probe or the failure rule turned off comes back only when the operator turns it on. After that, the fork leaves that model alone.
- `/v1/models` shows `probe_failed` or `auto_disabled` in `unavailable_reason` for a model that this change turned off, and the server logs each verdict. The dashboard code doesn't change.
- `DISCOVERED_MODEL_CHECKS=off` turns the probe and the failure rule off, and discovery then adds models turned on as it does today.
- These rules apply only to rows with `source = 'discovered'`. Catalog rows and user rows keep the upstream behavior. When catalog sync adopts a discovered row, the fork stops checking it.

## Out of Scope

- A badge or a reason in the dashboard.
- Probes for models from custom endpoints, which are also untested.
- Probes for vision support or the real context window.
- Limits learned from rate-limit headers.
- A probe for a model that the operator picks in the dashboard. The operator chose that model, so it is added turned on, as today.

## Capabilities

### New Capabilities
- `discovered-model-health`: probes for new discovered models, the tool check, and the rule that turns off a discovered model after repeated permanent errors.

### Modified Capabilities
- `model-discovery`: a model from an automatic pass is added turned off until its probe passes, and the health checks may change `enabled` and `supports_tools` on discovered rows.

## Impact

- New fork files: a probe service, a failure-rule service, a service that creates the new `discovered_model_checks` table on demand, and tests. No entry goes into the upstream migration list.
- `server/src/services/builtin-model-discovery.ts`: new models are inserted turned off, and each pass runs the probes after it reads the model list.
- `server/src/lib/fallback-loop.ts`: one call on the retryable-failure path and one on the success path. This is an upstream file, so the hooks stay at one line each.
- `server/src/routes/proxy.ts`: one change to the `unavailable_reason` value for disabled models.
- `server/src/__tests__/fork/fork-guard.test.ts`: lists the new test files.
- Each probe uses a provider request. A pass probes at most 10 models for each provider.
