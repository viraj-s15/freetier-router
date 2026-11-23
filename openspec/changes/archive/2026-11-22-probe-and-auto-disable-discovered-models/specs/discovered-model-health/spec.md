# Spec Delta

## Purpose

Keeps models that built-in discovery added, which nobody tested, out of routing until they answer, and turns them off when they keep failing with errors that won't go away on their own.

## ADDED Requirements

### Requirement: Probe before a discovered model routes traffic
The system SHALL keep a model that an automatic discovery pass adds turned off until a probe passes. The probe SHALL send one small chat request to the model with a usable key for its provider. The system SHALL turn the model on when the probe passes. The probe SHALL turn on only a model that the health checks turned off, and never a model that something else turned off.

#### Scenario: Probe passes
- **GIVEN** an automatic pass adds `openrouter:vendor/new-model:free`, and the model answers the probe
- **WHEN** the probe finishes
- **THEN** the model is turned on and `auto` can route to it

#### Scenario: Model is off until its probe
- **GIVEN** an automatic pass adds a model, and its probe hasn't run yet
- **WHEN** a request for `auto` arrives
- **THEN** the router doesn't route the request to that model

#### Scenario: Empty answer at the token limit
- **GIVEN** a reasoning model that spends the whole probe token limit on reasoning and returns no text
- **WHEN** the probe finishes with the length finish reason
- **THEN** the probe counts as passed

### Requirement: Probe outcomes
The system SHALL count a permanent model error, any other 400 answer and an empty answer as a failed probe. An empty answer that stopped at the token limit SHALL count as passed. The system SHALL count a rate limit, a 5xx answer, a timeout, a network error or a key error, including a 400 that rejects the key, as an inconclusive probe. After 3 failed probes the model SHALL stay off. An inconclusive probe SHALL NOT count, and the system SHALL probe the model again on the next pass.

#### Scenario: Permanent error
- **GIVEN** a pending model whose provider answers the probe with 404 model not found
- **WHEN** the probe finishes
- **THEN** the model stays off, and its failed-probe count goes up by one

#### Scenario: Third failed probe
- **GIVEN** a pending model with 2 failed probes
- **WHEN** its third probe fails with a permanent model error
- **THEN** the model stays off, the system stops probing it, and the system records the reason `probe_failed`

#### Scenario: Bad request
- **GIVEN** a pending model whose provider answers the probe with 400 "Provider returned error"
- **WHEN** the probe finishes
- **THEN** the failed-probe count goes up by one

#### Scenario: Empty answer
- **GIVEN** a pending model that answers the probe with no text, and the finish reason isn't length
- **WHEN** the probe finishes
- **THEN** the failed-probe count goes up by one

#### Scenario: Rate limit during the probe
- **GIVEN** a pending model whose provider answers the probe with 429
- **WHEN** the probe finishes
- **THEN** the failed-probe count doesn't change, and the next pass probes the model again

### Requirement: Probe key and limits
The probe SHALL use the first usable key of the provider, in the order that discovery uses, which puts healthy keys first. The probe SHALL skip a model whose rpm or rpd limit has no requests left on that key, and the skip SHALL count as inconclusive.

#### Scenario: Limit used up
- **GIVEN** a pending model with no rpd requests left on the probe key
- **WHEN** the pass reaches the model
- **THEN** the system sends no request, the failed-probe count doesn't change, and the next pass tries again

### Requirement: The probe step doesn't depend on the model list
For each platform that a pass covers, the probe step SHALL run after the model-list step, even when the model-list call fails or adds no models.

#### Scenario: Model list fails
- **GIVEN** a platform with a pending model, and its `/models` call fails with a 503
- **WHEN** the pass runs
- **THEN** the pass still probes the pending model

### Requirement: One probe run for each provider at a time
The system SHALL run at most one probe step for a provider at a time. A pass that finds a probe step in progress for the provider SHALL skip the probe step for that provider.

#### Scenario: Scheduled pass and event pass together
- **GIVEN** the scheduled pass is probing OpenRouter models
- **WHEN** a key save starts an event pass for OpenRouter
- **THEN** the event pass doesn't probe, and no model gets two probes from the two passes

### Requirement: Tool check
After a chat probe passes, the system SHALL send one small request with one tool to the model. The system SHALL mark the model as tool-capable only when its answer calls the tool. A text answer or a request error that names tools SHALL mark it as not tool-capable. An inconclusive tool check SHALL keep the current tool-capable flag.

#### Scenario: Model calls the tool
- **WHEN** the model answers the tool check with a tool call
- **THEN** the model is marked as tool-capable, and the router can send it requests with tools

#### Scenario: Model answers with text
- **WHEN** the model answers the tool check with text and no tool call
- **THEN** the model is turned on but marked as not tool-capable, and the router doesn't send it requests with tools

#### Scenario: Tool check is inconclusive for a new model
- **GIVEN** a new model whose chat probe passed, and the tool check gets a 429
- **WHEN** the pass ends
- **THEN** the model is turned on and stays marked as not tool-capable, and the next pass runs the tool check again

#### Scenario: Tool check is inconclusive for an existing model
- **GIVEN** an existing discovered model that is marked as tool-capable, and the tool check gets a 503
- **WHEN** the pass ends
- **THEN** the model stays marked as tool-capable, and the next pass runs the tool check again

#### Scenario: Operator sets the tool flag
- **GIVEN** a model that waits for a tool check
- **WHEN** the operator changes its tool-capable flag in the dashboard
- **THEN** the system keeps the operator's value and doesn't run the tool check on that model again

### Requirement: Probe budget for each pass
A discovery pass SHALL probe at most 10 models for each provider, oldest first. The pass SHALL leave the other pending models for the next pass. A probe SHALL count toward the model's rate limits like any other request.

#### Scenario: Many new models
- **GIVEN** an automatic pass adds 25 OpenRouter models
- **WHEN** the pass runs the probes
- **THEN** it probes 10 of them, and the next two passes probe the rest

### Requirement: Probe the existing discovered models once
The system SHALL probe each discovered model that existed and was on before this capability, as it probes a new model. The model SHALL stay on while its probes run, and the system SHALL turn it off only after 3 failed probes. A discovered model that was already off SHALL count as an operator choice, and the system SHALL NOT probe it or turn it on.

#### Scenario: Existing model that fails
- **GIVEN** a discovered model that is on and was added before this capability, and every probe gets 403
- **WHEN** its third probe fails
- **THEN** the system turns the model off and records the reason `probe_failed`

#### Scenario: Existing model that works
- **GIVEN** a discovered model that was added before this capability and answers the probe
- **WHEN** the probe and the tool check finish
- **THEN** the model stays on, and its tool-capable flag matches the tool check

#### Scenario: Existing model that the operator turned off
- **GIVEN** a discovered model that the operator turned off before this capability
- **WHEN** the server starts and the next pass runs
- **THEN** the model stays off, and the system doesn't probe it

### Requirement: Turn off a discovered model after repeated permanent errors
The system SHALL turn off a discovered model that is on and not under operator control after 3 separate requests get a permanent model error from it within 24 hours. Retries of one request across keys or models SHALL count once. The count SHALL survive a server restart. The rule SHALL apply to a model whose probes are still running, and a turn-off by this rule SHALL end its probes.

#### Scenario: Three requests in a day
- **GIVEN** a discovered model that is on
- **WHEN** 3 separate requests within 24 hours get a 403 model-access error from it
- **THEN** the system turns the model off and records the reason `auto_disabled`

#### Scenario: One request fails over across keys
- **GIVEN** a discovered model with 3 keys
- **WHEN** one request gets a 404 from the model on each of the 3 keys
- **THEN** the failure count goes up by one, and the model stays on

#### Scenario: Errors spread over more than a day
- **WHEN** a discovered model gets a permanent model error on 3 requests, and the first and third are more than 24 hours apart
- **THEN** the model stays on

### Requirement: Which errors count
A permanent model error SHALL be a model-not-found answer, such as 404, 410 or a 400 that says the model doesn't exist, or a model-access-forbidden answer, such as 403 or a 400 that says the key may not use the model. A rate limit, a 5xx answer, a timeout, a client cancel, an account suspension and a key authentication error SHALL NOT count.

#### Scenario: Server errors
- **WHEN** a discovered model gets a 503 on 5 separate requests within 24 hours
- **THEN** the model stays on

#### Scenario: Bad key
- **WHEN** a discovered model gets a bare 401 that rejects the key on 3 separate requests
- **THEN** the model stays on, and the existing key checks handle the key

### Requirement: A served request clears the count
The system SHALL clear the failure count of a discovered model when the model serves a request.

#### Scenario: Failure, then success
- **GIVEN** a discovered model with 2 counted failures
- **WHEN** the model serves a request, and then 1 more request gets a permanent model error
- **THEN** the model stays on with a count of 1

### Requirement: Operator choice wins
A model that the probe or the failure rule turned off SHALL come back only when something other than the health checks turns it on, such as the dashboard or the declarative config. After that, the system SHALL NOT probe it or turn it off again. The system SHALL never change the operator's chain switches.

#### Scenario: Operator turns a failed model back on
- **GIVEN** a model with the reason `probe_failed`
- **WHEN** the operator turns it on in the dashboard, and it then gets 3 permanent model errors in a day
- **THEN** the model stays on

#### Scenario: Operator turned the model off in the chain
- **GIVEN** an existing discovered model that the operator switched off in the fallback chain
- **WHEN** its probe passes
- **THEN** the model's chain switch stays off

### Requirement: Rules cover only discovered rows
The probe and the failure rule SHALL apply only to models with the discovered source. They SHALL stop for a model when catalog sync adopts it. When catalog sync adopts a model that waits for its first verdict and is off, the system SHALL turn it on, because the catalog lists it. A model with the reason `probe_failed` or `auto_disabled` SHALL stay off after adoption, like any local disable. A model that the operator picks in the dashboard SHALL be added turned on with no probe.

#### Scenario: Catalog model fails
- **WHEN** a catalog model gets a permanent model error on 3 separate requests in a day
- **THEN** the upstream rules apply, and this rule doesn't turn the model off

#### Scenario: Catalog adopts a discovered model
- **GIVEN** a discovered model with 2 counted failures
- **WHEN** catalog sync adopts the model
- **THEN** the system stops checking it

#### Scenario: Catalog adopts a pending model that is off
- **GIVEN** a new discovered model that is off and waits for its probe
- **WHEN** catalog sync adopts the model
- **THEN** the model is on, and the system stops checking it

#### Scenario: Model row deleted
- **GIVEN** a discovered model with a check record
- **WHEN** the model row is deleted
- **THEN** the system drops the check record, and the model doesn't show a reason anywhere

### Requirement: The reason is visible
The system SHALL show `probe_failed` or `auto_disabled` as the `unavailable_reason` in `/v1/models` for a model that it turned off for that reason. When one list entry stands for several model rows, the entry SHALL show a health-check reason only when every row in the entry is off for one; it SHALL show `auto_disabled` if any of those rows has it, and `probe_failed` if not. The server log SHALL name the model, the verdict and the last error.

#### Scenario: List the models
- **GIVEN** a discovered model that the failure rule turned off
- **WHEN** a client calls `/v1/models` with the unified key
- **THEN** the entry for that model has `unavailable_reason` set to `auto_disabled`

#### Scenario: Merged entry with one row off by the operator
- **GIVEN** a list entry for two rows, one off with `probe_failed` and one that the operator turned off
- **WHEN** a client calls `/v1/models`
- **THEN** the entry has `unavailable_reason` set to `disabled`

### Requirement: Checks can be turned off
When `DISCOVERED_MODEL_CHECKS=off`, the system SHALL run no probes and apply no failure rule. Discovery SHALL then add new models turned on and marked as tool-capable, as it did before this capability. A value other than `on` or `off` SHALL count as `on`, and the server SHALL log a warning. When `BUILTIN_MODEL_DISCOVERY` is `manual` or `off`, no automatic pass runs, so the system SHALL treat pending models at startup as it does with `DISCOVERED_MODEL_CHECKS=off`.

#### Scenario: Checks off
- **GIVEN** `DISCOVERED_MODEL_CHECKS=off`
- **WHEN** an automatic pass adds a model
- **THEN** the model is on at once, and no probe runs

#### Scenario: Pending models when the checks go off
- **GIVEN** a model that is off and waits for its first verdict, and the server restarts with `DISCOVERED_MODEL_CHECKS=off`
- **WHEN** the server starts
- **THEN** the system turns that model on, and models with the reason `probe_failed` or `auto_disabled` stay off

#### Scenario: Discovery set to manual
- **GIVEN** a model that is off and waits for its first verdict, and the server restarts with `BUILTIN_MODEL_DISCOVERY=manual`
- **WHEN** the server starts
- **THEN** the system turns that model on

#### Scenario: Unknown value
- **GIVEN** `DISCOVERED_MODEL_CHECKS=maybe`
- **WHEN** the server starts
- **THEN** the checks run as with `on`, and the log has a warning that names the value
