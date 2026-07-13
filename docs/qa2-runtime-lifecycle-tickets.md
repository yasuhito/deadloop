# Runtime lifecycle implementation tickets

## Ticket 1 — Safely replace completed reviewers

**Depends on:** none

- Add `closeTab` to the runner boundary and Herdr adapter.
- Classify exact-name reviewer matches as absent, active, replaceable Done, or ambiguous.
- Replace exactly one Done reviewer; never close active or ambiguous candidates.
- Make close/start failure results actionable and reset failure streak after recovery.
- Add the blocked → fixed → review integration path.
- Document reviewer lifecycle behavior.

**Acceptance:** all reviewer lifecycle cases in `qa2-runtime-lifecycle-spec.md` pass without accumulating names or repeated `agent_name_taken` warnings.

## Ticket 2 — Isolate runtime artifacts from project checks

**Depends on:** none

- Add packaged `run-project-check.ts` with a durable recovery manifest.
- Isolate only `.deadloop/` and `.pi-subagents/` on the same filesystem.
- Preserve exact command status and restore evidence on every supported exit path.
- Recover abandoned manifests and fail closed on restoration conflicts.
- Route issue-worker and reviewer validation instructions through the helper.
- Add a recursive JSON formatter fixture and failure/signal/timeout tests.

**Acceptance:** generated malformed JSON is invisible to validation, tracked malformed JSON still fails, and all evidence bytes are restored.

## Ticket 3 — Complete runtime cleanup and operational verification

**Depends on:** Ticket 1, Ticket 2

- Close reviewer tabs only after GitHub outcome persistence.
- Remove generated artifacts immediately before merged/closed workspace removal.
- Recheck worktree cleanliness and retain unknown dirty files.
- Synchronize README, example configuration, Herdr runner documentation, and doctor/status messages.
- Run the complete deadloop verification suite.
- Verify one safe qa2-love2d re-review with automatic merge disabled.

**Acceptance:** completed reviewer tabs do not accumulate, removable merged workspaces disappear automatically, unsafe workspaces remain with a clear reason, and qa2-love2d completes the documented re-review path.

## Execution order

Ticket 1 and Ticket 2 may run in isolated worktrees in parallel. Ticket 3 starts only after both have landed.
