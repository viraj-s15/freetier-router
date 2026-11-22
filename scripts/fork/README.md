# Fork sync

This folder holds the tools that sync this fork with upstream FreeLLMAPI and check that the fork's features still work. Upstream never changes these files, so they do not cause merge conflicts.

## Sync with upstream

1. Commit or stash your changes on `main`.
2. Run `scripts/fork/sync-upstream.sh`.
3. If the script stops with merge conflicts, fix them in `../freetier-router-sync`. Keep the fork's features and names, and take upstream's new code.
4. If you fixed conflicts, run `git -C ../freetier-router-sync add -A`, and then run `scripts/fork/sync-upstream.sh --continue`.
5. When the script passes, push `main` yourself.

The script does these steps in order, and it stops at the first failure:

1. It merges `upstream/main` into a new branch in the worktree `../freetier-router-sync`, so the live checkout stays as it is.
2. It runs `npm ci`, the lint, the build, the fork guard test, the full `npm test` suite and the pi client tests in `pi-config/extensions/freetier/test`. It skips `sync.test.mjs`, because that test checks only the pi-config docs.
3. It starts the new build on port 6970 with a copy of `server/data/freeapi.db`. Then it runs `smoke.mjs`, checks that the migration kept the discovered models, and sends one `ftr ask` through the pi client.
4. It moves `main` forward to the merge, and removes the worktree and the branch.
5. It backs up the DB and the old build to `server/data/backups/sync-<time>`, builds `main`, and restarts the router on port 6969. If the new router fails the smoke checks, the script resets `main`, restores the old build and the DB, and starts the old router again.

The chat checks use two free-tier requests. Add `--no-chat` to skip them. Add `--no-restart` to sync and check without a change to the live router. Run `--check` to run steps 2 and 3 on the current `main` with no merge, for example after you build a new feature.

## The fork guard test

`server/src/__tests__/fork/fork-guard.test.ts` fails when a sync loses one of these:

- the fork's feature test files, with their minimum test counts,
- the discovery defaults (`auto`, every 6 hours, 10 rpm and 250 a day),
- a working model lister for each provider in `FREE_POLICIES`,
- the port 6969 setting in `opencode.json` and the `freetier-router` CLI name,
- each branded line in `rebrand-manifest.json`.

If you add a feature, add its test file to `FORK_TEST_FILES` in the guard test. If you rebrand more text on purpose, run `node scripts/fork/gen-rebrand-manifest.mjs` to record the new lines.
