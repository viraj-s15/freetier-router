# branding Specification

## Purpose
Gives the fork its own user-facing name and update source, while it credits the upstream FreeLLMAPI project and keeps internal identifiers that upstream merges depend on.

## Requirements

### Requirement: Product name
Every place where a user sees the product name SHALL show `FreeTier Router`. These places are the page title, the dashboard header, the sign-in screen, the update dialog, all 60 locale files, the desktop app name, and the README title.

#### Scenario: Dashboard header
- **WHEN** a user opens the dashboard
- **THEN** the header and the browser tab show `FreeTier Router`

#### Scenario: Non-English locale
- **WHEN** a user picks any of the 60 locales
- **THEN** no visible string contains `FreeLLMAPI` as the product's own name

### Requirement: Command and image names
The CLI command SHALL be `freetier-router`, and the Docker image SHALL publish as `ghcr.io/<owner>/freetier-router`. The desktop app SHALL use its own app id, so that it installs beside an upstream install and doesn't replace it.

#### Scenario: Docker build on the fork
- **WHEN** the Docker workflow runs on `viraj-s15/freetier-router`
- **THEN** it pushes `ghcr.io/viraj-s15/freetier-router`

#### Scenario: CLI install
- **WHEN** a user installs the CLI package from the fork
- **THEN** the `freetier-router` command is on the path

### Requirement: Updates come from the fork
The update check, the release links, the source-update command and the docs links SHALL point to `viraj-s15/freetier-router`. No part of the product SHALL tell a user to install a release from the upstream repository.

#### Scenario: New release check
- **WHEN** the server checks for a new release
- **THEN** it asks `api.github.com/repos/viraj-s15/freetier-router/releases/latest`

#### Scenario: Source update command
- **WHEN** a user of a source install opens the update dialog
- **THEN** the shown command fetches from `github.com/viraj-s15/freetier-router`

### Requirement: Internal identifiers stay
Package names under `@freellmapi/`, settings keys, `localStorage` keys, database names and the Docker volume name SHALL NOT change, so that existing data loads without a migration and upstream merges stay simple.

#### Scenario: Upgrade from an upstream server or Docker install
- **GIVEN** a server data directory or a `freellmapi-data` volume that an upstream install made
- **WHEN** FreeTier Router starts on it
- **THEN** it loads the same keys, models and settings without a migration

#### Scenario: Desktop app beside an upstream desktop install
- **GIVEN** the upstream desktop app is installed
- **WHEN** a user installs the FreeTier Router desktop app
- **THEN** each app keeps its own data folder, and neither changes the other's data

### Requirement: Credit to upstream
The README SHALL state that FreeTier Router is a fork of FreeLLMAPI, link to the upstream repository, and keep the upstream MIT copyright notice in `LICENSE`. The README SHALL state that the free catalog comes from freellmapi.co and that the fork has no connection to Neu Software LLC.

#### Scenario: README credit
- **WHEN** a user reads the README
- **THEN** it names FreeLLMAPI as the upstream project, links to `github.com/tashfeenahmed/freellmapi`, and states that the fork is unofficial

#### Scenario: License file
- **WHEN** a user opens `LICENSE`
- **THEN** it holds the original copyright line for Tashfeen Ahmed
