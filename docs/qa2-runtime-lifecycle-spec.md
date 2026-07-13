# Runtime lifecycle and project-check isolation

## Status

Implementation specification derived from the qa2-love2d dogfooding failures recorded on 2026-07-13.

## Problem

deadloop currently leaks two runner concerns into repository automation:

1. A completed Herdr reviewer keeps its deterministic name. Re-reviewing the same PR can fail forever with `agent_name_taken`.
2. `.deadloop/` and `.pi-subagents/` are created inside a worktree. Recursive project formatters inspect their JSON and can fail even when tracked project files are valid.

GitHub state and promise reports are authoritative. Herdr `agent_status` is lifecycle evidence, not completion authority.

## Reviewer lifecycle

A reviewer name identifies one project and PR: `<projectId>-pr-<number>-reviewer`.

Before launch, deadloop must inspect exact-name matches:

- no match: launch normally;
- one `working` or `idle` match: do not launch a second reviewer;
- one `done` match: require a dedicated tab ID, close that tab, then launch the replacement with the same name;
- multiple matches, a missing tab ID, or a mixed active/done set: fail closed without closing any candidate.

Only an exact name match may be closed. A reviewer belonging to another project or PR must never be changed.

After a reviewer writes `complete` or `blocked`, deadloop must first persist the outcome in GitHub comments and labels. It may close the dedicated reviewer tab only after persistence succeeds. A persistence failure retains the tab and evidence.

If replacement tab closure succeeds but replacement launch fails, deadloop must record an actionable error, clear no evidence, and retry only through the normal schedule. It must not merge or silently treat the review as complete.

A successful later automation result resets `failureStreak`. `lastError` must either be cleared on recovery or explicitly presented as historical data.

## Project-check isolation

All configured `checkCommand` executions launched by deadloop must go through a deterministic helper. Direct execution from worker/reviewer prompts is not allowed.

The helper must:

1. operate only on the exact top-level `.deadloop` and `.pi-subagents` directories under the selected worktree;
2. atomically rename existing directories to unique holding paths on the same filesystem;
3. write an external recovery manifest before running the project command;
4. execute the original command in the worktree and preserve its exit result;
5. restore both artifact trees after success, command failure, spawn failure, timeout, SIGINT, and SIGTERM;
6. recover a manifest left by abrupt termination before starting another check;
7. fail closed rather than overwrite either tree if new artifacts appear during isolation;
8. preserve promise and diagnostic bytes exactly.

The helper must not hide errors in tracked files. A malformed tracked JSON file must still fail the project formatter.

SIGKILL and power loss cannot run cleanup handlers; durable manifest recovery on the next invocation is therefore part of the contract.

## Workspace cleanup

A merged or closed PR workspace is removable only when:

- it is a linked worktree under the configured worktree root;
- its Herdr workspace identity is known;
- no non-generated changes are present;
- closed-but-unmerged head preservation checks pass.

`.deadloop/` and `.pi-subagents/` are generated evidence and may be removed immediately before workspace removal. The implementation must re-run `git status --short` after removing them and abort if any other change remains. Files such as `luac.out` remain a blocker.

## Verification

Required automated coverage:

- initial reviewer launch;
- active reviewer suppresses duplicate launch;
- one Done reviewer is safely replaced;
- ambiguous/malformed candidates fail without closing tabs;
- blocked, fixed, and requeued PR reaches a second review;
- artifact-only formatter failure becomes success through isolation;
- malformed tracked JSON remains a failure;
- artifact bytes survive command failure, exception, timeout, and signals;
- abandoned manifests recover on the next run;
- cleanup removes generated-only merged workspaces but retains other dirty files.

The qa2-love2d operational check must run with automatic merge disabled or on a PR that cannot pass merge gates accidentally.
