# Spec Delta

## MODIFIED Requirements

### Requirement: Discovery never changes existing rows
The system SHALL only insert new models during discovery. A model already present for the platform, from any source, SHALL keep its current settings. The one exception is the discovered-model health checks, which MAY change only the on/off state and the tool-capable flag of a row with the discovered source.

#### Scenario: Model already in the catalog
- **GIVEN** `groq:llama-x` exists as a catalog row that the operator disabled
- **WHEN** an automatic pass sees `llama-x` in the model list
- **THEN** the row stays disabled and unchanged

#### Scenario: Health check on a discovered row
- **GIVEN** a discovered row that the operator tuned to an rpm limit of 5
- **WHEN** its tool check finds that it can't call tools
- **THEN** the row is marked as not tool-capable, and its rpm limit stays 5

## ADDED Requirements

### Requirement: A model from an automatic pass starts off
The system SHALL insert a model from an automatic pass turned off and marked as not tool-capable, while discovered-model checks are on. A pick in the dashboard SHALL insert the model turned on, as before.

#### Scenario: Automatic pass
- **GIVEN** discovered-model checks are on
- **WHEN** an automatic pass adds `groq:new-model`
- **THEN** the row exists, is off, and waits for its probe

#### Scenario: Dashboard pick
- **WHEN** the operator picks `groq:new-model` under Fetch models
- **THEN** the row is on at once
