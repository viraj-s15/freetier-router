# Spec Delta

## Purpose

Finds new chat models from each built-in provider's own model list as soon as the provider publishes them, and adds only models that the provider's free policy allows, so that no automatic pass can route traffic to a paid model.

## ADDED Requirements

### Requirement: Discovery covers every model-listing provider
The system SHALL treat every built-in provider that can list its models through an OpenAI-compatible `/models` endpoint as eligible for discovery. A provider SHALL stay eligible when the applied catalog manages it, unless the catalog rules the provider out (see the next requirement).

#### Scenario: Catalog-managed provider is eligible
- **GIVEN** the applied catalog has enabled rows for `groq`
- **WHEN** a discovery pass runs and `groq` has a usable key
- **THEN** the pass reads the `groq` model list and considers every model in it

#### Scenario: Provider without a model list is not eligible
- **GIVEN** a built-in provider whose adapter can't list models in the OpenAI-compatible format, such as `google`
- **WHEN** a discovery pass runs
- **THEN** the pass skips that provider and reports no failure for it

#### Scenario: Provider without a usable key is skipped
- **GIVEN** an eligible provider with no enabled key, or only keys marked invalid
- **WHEN** a discovery pass runs
- **THEN** the pass makes no request to that provider

### Requirement: Catalog verdict rules a provider out
The system SHALL skip discovery for a provider when the applied catalog document carries rows for it and the document marks every one of those rows disabled, because a catalog that disables a whole provider has judged it not free. Models that the operator disabled locally SHALL NOT count toward this rule.

#### Scenario: All catalog rows disabled
- **GIVEN** the applied catalog lists `opencode` models and all of them are disabled
- **WHEN** a discovery pass runs
- **THEN** the pass makes no request to `opencode`

#### Scenario: One catalog row enabled
- **GIVEN** the applied catalog lists `requesty` models and at least one is enabled
- **WHEN** a discovery pass runs
- **THEN** `requesty` stays eligible

#### Scenario: Operator disabled every model
- **GIVEN** the applied catalog lists enabled `groq` models, and the operator disabled all of them in the dashboard
- **WHEN** a discovery pass runs
- **THEN** `groq` stays eligible

### Requirement: Automatic discovery is the default
The system SHALL run discovery automatically when `BUILTIN_MODEL_DISCOVERY` is unset. The values `manual` and `off` SHALL keep their current meaning: `manual` registers models only from a pick in the dashboard, and `off` turns discovery off.

#### Scenario: Unset mode
- **WHEN** the server starts with `BUILTIN_MODEL_DISCOVERY` unset
- **THEN** scheduled and event-driven discovery passes run

#### Scenario: Manual mode
- **WHEN** the server starts with `BUILTIN_MODEL_DISCOVERY=manual`
- **THEN** no automatic pass runs, and the dashboard can still fetch and add models

### Requirement: Discovery has its own schedule
The system SHALL run a scheduled discovery pass every 6 hours by default. `BUILTIN_MODEL_DISCOVERY_INTERVAL_MS` SHALL override the interval, and a value of `0` SHALL turn the scheduled pass off. The schedule SHALL NOT depend on `CUSTOM_MODEL_SYNC_INTERVAL_MS`.

#### Scenario: Default interval
- **WHEN** the server runs in automatic mode with no interval set
- **THEN** a scheduled pass runs every 6 hours

#### Scenario: Interval set to zero
- **WHEN** `BUILTIN_MODEL_DISCOVERY_INTERVAL_MS=0`
- **THEN** no scheduled pass runs, and event-driven passes still run

#### Scenario: Custom-model sync turned off
- **WHEN** `CUSTOM_MODEL_SYNC_INTERVAL_MS=0` and the discovery interval is unset
- **THEN** the scheduled discovery pass still runs every 6 hours

### Requirement: Free policy for each provider
The system SHALL give each provider exactly one free policy: `free-key`, `priced-listing` or `pattern`. A provider with no assigned policy SHALL use `pattern` with no patterns. An automatic pass SHALL add only chat models that the provider's policy accepts.

#### Scenario: Provider with no entry
- **GIVEN** a provider with no assigned policy
- **WHEN** an automatic pass reads its model list
- **THEN** the pass adds no models for that provider

#### Scenario: Non-chat model
- **GIVEN** any policy
- **WHEN** the model list includes an embedding, image, audio, transcription or video model
- **THEN** the pass doesn't add that model

#### Scenario: Classifier or speech model that looks like chat
- **GIVEN** any policy
- **WHEN** the model list includes a safety classifier, moderation, OCR or text-to-speech model, such as `meta-llama/llama-guard-4-12b` or `mistral-ocr-latest`
- **THEN** the pass doesn't add that model

### Requirement: free-key policy
For a provider with the `free-key` policy, an automatic pass SHALL accept every chat model in the model list, unless the model list itself gives a price that isn't free.

#### Scenario: Unpriced model on a free-key provider
- **GIVEN** `cerebras` has the `free-key` policy
- **WHEN** its model list includes a new chat model with no price
- **THEN** the pass adds the model

#### Scenario: Priced model on a free-key provider
- **GIVEN** a `free-key` provider whose model list gives a non-zero price for a model
- **WHEN** an automatic pass runs
- **THEN** the pass doesn't add that model

### Requirement: priced-listing policy
For a provider with the `priced-listing` policy, an automatic pass SHALL accept a chat model only when the model list marks it free. A model with no price or a non-zero price SHALL be skipped.

#### Scenario: Free model
- **GIVEN** `openrouter` has the `priced-listing` policy
- **WHEN** its model list prices a model at zero for prompt and completion
- **THEN** the pass adds the model

#### Scenario: Model with no price
- **GIVEN** a `priced-listing` provider
- **WHEN** its model list has a model with no price field
- **THEN** the pass doesn't add the model

### Requirement: pattern policy
For a provider with the `pattern` policy, an automatic pass SHALL accept a chat model only when its id matches one of that provider's free patterns, where `*` matches any run of characters. The global `CUSTOM_MODEL_SYNC_FREE_PATTERNS` setting SHALL also narrow every policy, as it does today.

#### Scenario: Matching id
- **GIVEN** `unorouter` has the `pattern` policy with the pattern `*:free`
- **WHEN** its model list includes `vendor/model:free` and `vendor/model`
- **THEN** the pass adds `vendor/model:free` and skips `vendor/model`

#### Scenario: Global patterns set
- **GIVEN** `CUSTOM_MODEL_SYNC_FREE_PATTERNS=llama-*` and a `free-key` provider
- **WHEN** its model list includes `llama-4` and `qwen-3`
- **THEN** the pass adds `llama-4` and skips `qwen-3`

### Requirement: Dashboard pick skips the free policy
The system SHALL let the operator add any model that a fetch in the dashboard returns, whatever the provider's free policy, because the operator chose it.

#### Scenario: Pick a model that the policy rejects
- **GIVEN** a `pattern` provider with no patterns
- **WHEN** the operator fetches its models in the dashboard and picks one
- **THEN** the system adds the picked model

### Requirement: Default limits for discovered models
The system SHALL give each discovered model conservative default limits of 10 requests per minute and 250 requests per day, with no token limits, until catalog sync adopts it. The system SHALL put each new discovered model at the end of the fallback chain.

#### Scenario: New discovered model
- **WHEN** an automatic pass adds a model
- **THEN** the model has an rpm limit of 10, an rpd limit of 250, and a lower priority than every model already in the chain

### Requirement: Discovery never adds a removed model
An automatic pass SHALL NOT add a model that has a tombstone because the operator deleted it or because the catalog removed it. A pick in the dashboard SHALL add the model and clear its tombstone.

#### Scenario: Model the catalog removed
- **GIVEN** catalog sync recorded a `catalog_removed` tombstone for `groq:old-model`
- **WHEN** the `groq` model list still includes `old-model`
- **THEN** the automatic pass doesn't add it

#### Scenario: Operator picks a removed model
- **GIVEN** a `catalog_removed` tombstone for `groq:old-model`
- **WHEN** the operator picks `old-model` in the dashboard
- **THEN** the system adds the model and clears the tombstone

### Requirement: Discovery never changes existing rows
The system SHALL only insert new models during discovery. A model already present for the platform, from any source, SHALL keep its current settings.

#### Scenario: Model already in the catalog
- **GIVEN** `groq:llama-x` exists as a catalog row that the operator disabled
- **WHEN** an automatic pass sees `llama-x` in the model list
- **THEN** the row stays disabled and unchanged
