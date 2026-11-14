# Spec Delta

## Purpose

Applies the signed model catalog from freellmapi.co to the local model list, and decides what happens to models found by discovery when the catalog adds, lists or removes them.

## ADDED Requirements

### Requirement: Catalog source is unchanged
The system SHALL fetch the free signed catalog from `https://freellmapi.co` by default, verify it against the pinned public key, and check for a new version twice a day. `CATALOG_BASE_URL` and `CATALOG_PUBKEY` SHALL keep their current meaning.

#### Scenario: Default install
- **WHEN** the server starts with no catalog settings
- **THEN** catalog sync fetches from `freellmapi.co` every 12 hours and rejects a document with a bad signature

### Requirement: Catalog keeps unlisted discovered models
When the catalog manages a platform but doesn't list a discovered model on it, catalog sync SHALL keep that discovered model and its settings.

#### Scenario: New model not yet in the free catalog
- **GIVEN** discovery added `groq:new-model` and the applied catalog manages `groq`
- **WHEN** a catalog without `new-model` applies
- **THEN** `groq:new-model` stays, with the same enabled state and limits

### Requirement: Catalog adopts listed discovered models
When the catalog lists a model that discovery added, catalog sync SHALL make the row a catalog row and set the catalog's metadata and limits on it. An enabled state that the operator set to disabled SHALL stay disabled.

#### Scenario: Catalog catches up
- **GIVEN** discovery added `groq:new-model` with default limits
- **WHEN** a catalog that lists `new-model` with an rpm limit of 30 applies
- **THEN** the row becomes a catalog row with an rpm limit of 30

#### Scenario: Operator disabled the discovered model
- **GIVEN** the operator disabled the discovered row `groq:new-model`
- **WHEN** a catalog that lists `new-model` as enabled applies
- **THEN** the row becomes a catalog row and stays disabled

### Requirement: Catalog removal records a tombstone
When catalog sync deletes a chat catalog row because the new catalog no longer lists it, the system SHALL record a `catalog_removed` tombstone for that platform and model id. Views that list models the operator deleted SHALL NOT show these tombstones. Sync SHALL NOT replace a tombstone that the operator made.

#### Scenario: Model dropped from the catalog
- **GIVEN** `groq:old-model` is a catalog row
- **WHEN** a catalog without `old-model` applies
- **THEN** the row is deleted and a `catalog_removed` tombstone exists for `groq:old-model`

#### Scenario: Operator tombstone exists
- **GIVEN** the operator deleted `groq:old-model`, which recorded a user tombstone
- **WHEN** a catalog without `old-model` applies
- **THEN** the tombstone keeps its user source

### Requirement: Catalog listing clears a catalog_removed tombstone
When the catalog lists a model that has a `catalog_removed` tombstone, catalog sync SHALL clear the tombstone and add the model as a catalog row. A user tombstone SHALL keep the model deleted, as it does today.

#### Scenario: Model returns to the catalog
- **GIVEN** a `catalog_removed` tombstone for `groq:old-model`
- **WHEN** a catalog that lists `old-model` applies
- **THEN** the tombstone is gone and `groq:old-model` exists as a catalog row

#### Scenario: User tombstone and catalog listing
- **GIVEN** a user tombstone for `groq:old-model`
- **WHEN** a catalog that lists `old-model` applies
- **THEN** `groq:old-model` stays deleted

### Requirement: Older catalog never removes newer models
Catalog sync SHALL keep skipping a catalog whose version is older than the minimum version that the binary bundles, so that a delayed free snapshot can't delete or tombstone models that a newer release added.

#### Scenario: Stale snapshot
- **GIVEN** the binary's minimum catalog version is `2026.11.01`
- **WHEN** the fetched catalog has version `2026.10.15`
- **THEN** sync applies nothing and records no tombstones
