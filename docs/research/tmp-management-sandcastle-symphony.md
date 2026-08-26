# Research: temporary storage in Sandcastle, OpenAI Symphony, and deadloop

## Summary

Sandcastle and Symphony both make the main coding workspace identifiable, but neither is a complete disk-pressure solution. Sandcastle puts Git worktrees under the repository at `.sandcastle/worktrees/`, runs best-effort orphan pruning before creation, and normally removes clean top-level worktrees; Symphony creates one reusable directory per issue, but its default root is explicitly `System.tmp_dir!()/symphony_workspaces`, keeps that directory through ordinary success/failure/retry, and removes it only when the issue becomes terminal. Neither examined implementation sets `TMPDIR`, reserves space, enforces byte/inode budgets, responds specially to `ENOSPC`, or performs general age/size-based garbage collection.

For deadloop, the observed `/tmp` tmpfs per-user-quota `ENOSPC` incident should be treated as a host-capacity failure, not as a Git-worktree cleanup failure. Immediate mitigation is to put `TMPDIR` and Herdr/worktree roots on a monitored persistent filesystem and cap concurrency. The durable design should add a deadloop-owned per-attempt runtime root, explicit environment propagation, byte/inode admission checks, leases/journals, and conservative startup garbage collection, while preserving deadloop's deliberate distinction between disposable Herdr workspaces and durable Git branch worktrees.

## Scope and evidence discipline

Primary sources only were used: the official repositories `https://github.com/mattpocock/sandcastle` and `https://github.com/openai/symphony`, their source/ADRs/issues, and deadloop's checked-in source/docs. External commentary was excluded. Sandcastle citations are pinned to commit `e99f832f`; Symphony implementation citations are pinned to `58cf97da06d556c019ccea20c67f4f77da124bf3`. Negative findings (for example, no disk budget) mean “not present in the examined source/configuration surfaces,” not a claim about every dependency or future revision.

## Findings

### 1. Sandcastle uses repository-local durable paths, not OS `/tmp`, for production worktrees

**Severity: informational / favorable for the incident class.** `WorktreeManager.create()` constructs `<repo>/.sandcastle/worktrees/<generated-name>`; generated names combine a timestamp with random bytes to avoid same-second branch-name collision. Production worktree creation therefore does not inherently consume `/tmp`. [`src/WorktreeManager.ts`, creation and naming](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/WorktreeManager.ts#L20-L31) and [`src/WorktreeManager.ts`, worktree root and path](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/WorktreeManager.ts#L291-L371).

Node `tmpdir()` does appear heavily in tests to create fixture repositories, but that is not the production workspace policy. Sandcastle also writes default run logs under `<repo>/.sandcastle/logs`, not `/tmp`. [`src/createWorktree.ts`, default log path](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/createWorktree.ts#L444-L456).

### 2. Sandcastle has cleanup finalizers and per-create stale pruning, but intentionally preserves evidence in several cases

**Severity: medium residual accumulation risk.** Before creating a worktree, `createWorktree()` invokes `pruneStale()` best-effort. Pruning runs `git worktree prune` and deletes directories under `.sandcastle/worktrees/` only when Git does not report them as active. This is per-acquisition reconciliation, not a daemon startup sweep and not age/size GC. [`src/createWorktree.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/createWorktree.ts#L218-L236); [`src/WorktreeManager.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/WorktreeManager.ts#L461-L539).

The independent `Worktree.close()` is idempotent, checks uncommitted changes, preserves a dirty tree, and removes a clean tree. Top-level sandbox acquisition uses nested `Effect.acquireUseRelease`, so a worktree is finalized even if copy/hooks/container startup fail; cleanup preserves on a failed run when evidence is dirty and removes otherwise. [`src/createWorktree.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/createWorktree.ts#L237-L263); [`src/SandboxFactory.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/SandboxFactory.ts#L585-L731).

The first-class `createWorktree()` API deliberately outlives `run()`, `interactive()`, and child sandboxes until its owner calls `close()`; abort paths are documented to preserve it. Thus Sandcastle favors recoverability over unconditional reclamation. [`README.md`, independent worktree lifecycle](https://github.com/mattpocock/sandcastle/blob/e99f832f/README.md#L598-L690).

### 3. Sandcastle's crash recovery is bounded to recognizable orphan state; an active Git registration can remain indefinitely

**Severity: medium.** `pruneStale()` removes missing-Git-registration directories and stale Git metadata, but it deliberately does not remove a directory still reported as an active worktree. Consequently, a crash after successful worktree registration can leave a clean but “active” worktree outside the orphan collector. Sandcastle issue #674 documented exactly this acquire/finalizer gap and the need for manual `git worktree remove --force`; later source at the examined commit nests acquisition to cover setup failures, but the collector itself still cannot infer that an active registered tree is abandoned. [`src/WorktreeManager.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/WorktreeManager.ts#L461-L539); [official issue #674](https://github.com/mattpocock/sandcastle/issues/674).

This is an important design lesson for deadloop: filesystem existence plus Git registration is insufficient ownership evidence. A lease/journal that identifies the owning run is necessary for safe reclamation.

### 4. Sandcastle concurrency is safe for unique generated branches, but the examined snapshot does not enforce same-named-branch exclusion in source

**Severity: high for callers that reuse a named branch concurrently; low for unique merge-to-head runs.** Random branch suffixes prevent generated-name collisions, and different branches receive different worktrees. However, `WorktreeManager.create()` reuses an existing managed worktree—even dirty—with only a warning; two processes targeting the same named branch can therefore share it. [`src/WorktreeManager.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/WorktreeManager.ts#L291-L366).

ADR 0007 specifies atomic PID lock files under `.sandcastle/locks/`, live-PID fail-fast behavior, dead-PID recovery, and stale-lock pruning. But at pinned commit `e99f832f`, `WorktreeManager.ts` has no lock acquisition/release/import and the expected `WorktreeLock` source is absent; the ADR is design evidence, not evidence that this snapshot enforces it. [`docs/adr/0007-worktree-locking.md`](https://github.com/mattpocock/sandcastle/blob/e99f832f/docs/adr/0007-worktree-locking.md#L16-L68); [official implementation tracking issue #427](https://github.com/mattpocock/sandcastle/issues/427).

### 5. Sandcastle does not set `TMPDIR` or enforce storage budgets

**Severity: high under host tmpfs pressure.** Agent/provider environment is merged and passed through, so a caller can supply `TMPDIR`, but Sandcastle does not synthesize a run-local temp directory or override it. Its configuration exposes operation timeouts, not byte/inode quotas. The examined code has no `ENOSPC` recovery, free-space admission check, per-run size accounting, retention budget, or LRU/age eviction. [`src/createWorktree.ts`, environment merge](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/createWorktree.ts#L350-L360); [`src/createWorktree.ts`, timeout-only options](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/createWorktree.ts#L47-L66).

Thus repository-local worktrees reduce dependence on `/tmp`, but package managers, compilers, agents, Docker, or inherited process defaults may still write there.

### 6. Symphony uses stable per-issue directories and reuses them across attempts

**Severity: informational / good for retry continuity, medium for accumulation.** `Workspace.create_for_issue()` sanitizes the issue identifier, computes `<workspace.root>/<identifier>`, creates it if absent, and reports `created?`; an existing directory is reused and the `after_create` hook runs only for a newly created directory. This is per-issue durable state rather than per-run state. [`elixir/lib/symphony_elixir/workspace.ex`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/workspace.ex#L1-L72).

The sample first-party workflow chooses a persistent home-directory root (`~/code/symphony-workspaces`) and clones/bootstrap dependencies in `after_create`, showing the intended operational override. [`elixir/WORKFLOW.md`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/WORKFLOW.md#L19-L33).

### 7. Symphony does rely on OS temp by default and explicitly leaves `/tmp` available to Codex

**Severity: critical for a `/tmp` tmpfs quota incident unless configured otherwise.** The schema default is `Path.join(System.tmp_dir!(), "symphony_workspaces")`; config finalization uses the same fallback. On Linux this is commonly `/tmp/symphony_workspaces`, so workspace clones and dependencies can directly consume tmpfs unless `workspace.root` is overridden. [`elixir/lib/symphony_elixir/config/schema.ex`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/config/schema.ex#L72-L84) and [`config/schema.ex`, fallback resolution](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/config/schema.ex#L235-L251).

Symphony does not set `TMPDIR`. Its default Codex turn policy says `excludeTmpdirEnvVar: false` and `excludeSlashTmp: false`, so inherited `TMPDIR` and `/tmp` remain writable/visible. [`config/schema.ex`, default sandbox policy](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/config/schema.ex#L302-L313).

### 8. Symphony removes workspaces on terminal issue transitions—not on ordinary run success or failure

**Severity: medium-to-high accumulation risk.** Agent normal exit schedules a continuation check; abnormal exit schedules retry. Neither path removes the workspace. Running reconciliation removes it only when the tracker reports a terminal state; retry reconciliation does likewise. This allows the same checkout/dependency cache to survive multiple Codex turns and failures. [`elixir/lib/symphony_elixir/orchestrator.ex`, DOWN handling](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/orchestrator.ex#L104-L158); [`orchestrator.ex`, terminal reconciliation](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/orchestrator.ex#L287-L337); [`workspace.ex`, removal](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/workspace.ex#L74-L136).

`before_remove` failure is intentionally ignored and recursive removal continues, which is favorable for eventual cleanup but means hook failure is not a reclamation blocker. [`workspace.ex`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/workspace.ex#L168-L221).

### 9. Symphony performs startup terminal cleanup, but not general garbage collection

**Severity: medium.** During `Orchestrator.init`, Symphony queries terminal issues and removes their matching workspaces. If the tracker query fails, startup continues after a warning. This is tracker-driven crash recovery without a durable orchestrator database. It does not scan unknown directories, expire old active/non-visible workspaces, measure size, or reclaim by pressure. [`orchestrator.ex`, initialization](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/orchestrator.ex#L43-L68); [`orchestrator.ex`, startup cleanup](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/orchestrator.ex#L536-L553); [`SPEC.md`, startup cleanup contract](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/SPEC.md#L789-L806).

A crash therefore loses in-memory `running`, `claimed`, retry, and timer state; recovery derives dispatch eligibility from the tracker and reuses filesystem workspaces. Untracked or nonterminal stale directories can persist.

### 10. Symphony serializes scheduling in one GenServer and caps agents, but has no per-workspace filesystem lock

**Severity: medium.** The GenServer owns `running` and `claimed`; dispatch requires neither set already contains the issue and requires global/state/worker slots. The default global maximum is 10. This prevents duplicate dispatch within one orchestrator process and bounds concurrent writers, but it is not a cross-process lease or filesystem lock. Two Symphony services sharing a workspace root need external single-owner deployment discipline. [`orchestrator.ex`, state and dispatch predicates](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/orchestrator.ex#L19-L42) and [`orchestrator.ex`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/orchestrator.ex#L389-L430); [`config/schema.ex`, concurrency defaults](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/config/schema.ex#L96-L116).

### 11. Neither reference system has a disk-pressure control plane

**Severity: critical for unattended long-running hosts.** Neither system exposes minimum free bytes/inodes, total retained bytes, per-run maximum bytes, admission refusal based on `statvfs`, a cleanup watermark, or ENOSPC-specific classification. Concurrency limits only indirectly reduce simultaneous growth. Sandcastle's orphan pruning and Symphony's terminal cleanup are lifecycle collectors, not capacity managers.

## Comparison with deadloop Pi + Herdr

Deadloop already has stronger *ownership correctness* than either reference in several respects:

- It explicitly separates “Git worktree is durable branch state” from “Herdr attempt workspace is disposable runtime state,” and writes an atomic launch-unique attempt journal before external mutation. [`docs/herdr-runner.md:19-39`](../herdr-runner.md#L19-L39).
- It uses a repository-ID-scoped OS `flock`, launch-unique agent names, exact checkout/workspace ownership checks, and suppresses another attempt when retained state is ambiguous. [`extensions/deadloop/README.md`, State](../../extensions/deadloop/README.md#L23-L35); [`docs/herdr-runner.md:60-82`](../herdr-runner.md#L60-L82).
- Successful attempts close the Herdr workspace only after GitHub-side evidence is proven, while linked worktrees remain until a separate merged/closed-PR safety gate. This intentionally differs from Sandcastle's usual clean-worktree deletion and is closer to Symphony's durable per-issue workspace, but with stronger journal binding. [`docs/herdr-runner.md:47-82`](../herdr-runner.md#L47-L82).
- The adapter calls Herdr/Git with inherited environment; it does not pass an explicit `env`, set `TMPDIR`, or check capacity. [`src/herdr-runner.cts:194-196`](../../src/herdr-runner.cts#L194-L196), [`src/herdr-runner.cts:222-257`](../../src/herdr-runner.cts#L222-L257).

The gap exposed by the observed incident is therefore *resource containment and capacity*, not primarily state identity. A user-scoped `/tmp` tmpfs quota can return `ENOSPC` even when system-wide disk appears free; every same-user Pi/Herdr/agent process inherits the same pressure domain. Closing a terminal or deleting a worktree on another filesystem does not guarantee relief if agent scratch files, sockets, downloads, compiler intermediates, or Herdr runtime artifacts remain in `/tmp`. Because deadloop and Workers run as the same OS user and Herdr is not a filesystem sandbox, the host must deliberately route and account for temporary storage.

## Exact feature matrix

| Question | Sandcastle (`e99f832f`) | Symphony (`58cf97d`) | deadloop today |
|---|---|---|---|
| Main workspace uses OS `/tmp`? | No; `<repo>/.sandcastle/worktrees` | **Yes by default**; `System.tmp_dir!/symphony_workspaces`; configurable | Herdr/worktree root configurable, but subprocess scratch inherits host defaults |
| Per-run durable directory? | Unique worktree for generated strategy; first-class handles may persist | No: stable **per-issue** directory reused across runs/retries | Yes: `~/.pi/agent/deadloop/runs/<uuid>` journal/report directory; linked branch worktree persists |
| Remove on success? | Usually clean top-level worktree; first-class worktree only on explicit close | No; waits for terminal tracker state | Close Herdr workspace after proven success; preserve linked worktree |
| Remove on failure? | Finalizers normally remove clean and may preserve dirty; crashes can retain active registrations | No; retry reuses workspace | Retain ambiguous/failed attempts for evidence; explicit guarded abandonment |
| Sets `TMPDIR`? | No | No; default Codex policy explicitly permits inherited TMPDIR and `/tmp` | No evidence in adapter |
| Disk/inode budget? | No | No | No |
| Startup/per-run GC? | Best-effort orphan prune before worktree creation, not age/size GC | Startup cleanup for tracker-terminal issues only | Reconciliation is evidence-driven; no capacity GC |
| Concurrency protection? | Unique generated names; same named branch unsafe in pinned source (ADR lock design exists) | In-process GenServer claims and max-agent slots; no cross-process workspace lock | Kernel repo lock plus per-attempt ownership/claim gates |

## Recommendation

### Immediate operational mitigation (hours to days)

1. **Move temp writes off the quota-limited tmpfs.** Before starting Pi/Herdr, create a user-owned persistent directory such as `$HOME/.local/state/deadloop/tmp` (mode `0700`) on a filesystem with known headroom and export `TMPDIR`, `TMP`, and `TEMP` to it. Restart the Herdr server and Pi from that environment so descendants inherit it. Do not point these at a repository checkout.
2. **Put Herdr worktree roots and deadloop run state on persistent storage.** Verify each project's `worktreeRoot` is not below `/tmp`; retain `~/.pi/agent/deadloop/runs` on a persistent filesystem. If Herdr has separate server/runtime storage configuration, place it there too and confirm with actual process open-file/path inspection.
3. **Reduce concurrent agents immediately.** Use one attempt per affected filesystem/project until headroom and growth rates are known. This is only a rate limiter, not a quota solution.
4. **Measure both bytes and inodes in the correct quota domain.** Record `df -h`, `df -i`, mount type/options for `/tmp`, user quota output where available, and `du` by top-level owner directories. `df` alone may not expose a per-user tmpfs quota.
5. **Reclaim only proven-owned stale data.** Stop/quiet Pi and Herdr first; archive incident evidence; delete only paths whose journals/workspaces establish ownership and terminality. Do not blanket-delete `/tmp`, active Herdr workspaces, dirty worktrees, or retained failed attempts.
6. **Add a host-level alert/runbook now.** Warn at conservative free-byte and free-inode thresholds and on the first `ENOSPC`; stop new scheduling while allowing already-running cleanup/reporting when safe.

### Durable deadloop design (implementation project)

1. **Introduce a deadloop-owned runtime root and per-attempt scratch directory.** Add an operator setting such as `runtimeRoot` on persistent storage. For each attempt create `<runtimeRoot>/attempts/<attempt-id>/{tmp,logs,transport}` with `0700`, record canonical paths/device IDs in `attempt.json`, and launch Herdr/agent with `TMPDIR=.../tmp` (plus `TMP`/`TEMP`). Keep Git worktrees separate under `worktreeRoot`.
2. **Make capacity admission deterministic.** Before claim/worktree/workspace mutation, measure free bytes and inodes for every target filesystem (runtime root and worktree root). Refuse launch below configurable reserve floors. Also enforce host/project concurrency based on worst-case reserved bytes, not only issue eligibility.
3. **Add accounting and budgets.** Persist per-attempt observed high-water bytes/inodes and aggregate retained usage. Support soft warning, hard admission stop, and a total retained-artifact budget. Treat `ENOSPC`/`EDQUOT` as a distinct resource-exhausted state with actionable paths and metrics, never as a generic agent failure to retry rapidly.
4. **Use leases plus journals for crash recovery.** Extend the existing strong journal model with owner PID/start time/host identity and heartbeat or Herdr-agent evidence. On startup, scan only under the configured runtime root; classify live, terminal, cleanup-pending, and ambiguous. Reclaim terminal scratch idempotently. Never infer abandonability from age alone.
5. **Separate scratch GC from evidence/worktree GC.** Scratch can be deleted after the strong completion/abandonment receipt. Logs/reports follow an explicit retention policy. Linked worktrees remain subject to existing merged/closed/clean/exact-identity gates. This preserves deadloop's safer semantics rather than copying Sandcastle's broad clean-tree cleanup or Symphony's tracker-only cleanup.
6. **Run GC at startup and before admission, with watermarks.** Startup GC should finish or produce a blocking diagnostic before scheduling. Pressure GC should delete only terminal scratch oldest-first until the low-water target is met; ambiguous data remains visible and blocks if the reserve cannot be restored.
7. **Keep locking cross-process and filesystem-aware.** Retain the repository `flock`; add atomic per-attempt lease creation under runtime root. Avoid PID-only stale detection across hosts/containers. If worktree roots can be shared remotely, require host identity and a lease backend with valid shared-filesystem semantics.
8. **Test the incident class.** Add tests with an injected filesystem-capacity provider: byte-low, inode-low, `ENOSPC`, `EDQUOT`, crash between each lifecycle phase, two hosts/processes, startup GC, cleanup interruption, and preservation of dirty/ambiguous worktrees. Each should assert one observable outcome, consistent with project test policy.

## Review findings

1. **critical — Symphony `elixir/lib/symphony_elixir/config/schema.ex:72-84`**: the default workspace root is the system temp directory, directly reproducing the risk class when `/tmp` is quota-limited.
2. **critical — deadloop `src/herdr-runner.cts:194-196, 222-257`**: child commands inherit ambient temp settings and there is no free-space/inode admission gate or ENOSPC classification.
3. **high — both upstream systems**: no storage budget or pressure-triggered GC exists; lifecycle cleanup cannot prevent quota exhaustion from live or retained runs.
4. **high — Sandcastle `src/WorktreeManager.ts:291-366` at `e99f832f`**: named-branch worktree reuse has no source-enforced exclusion despite ADR 0007; concurrent same-branch writers can share a directory.
5. **medium — Symphony `orchestrator.ex` startup cleanup**: only known terminal tracker issues are reclaimed; unknown/nonterminal stale directories are not collected, and cleanup is skipped when tracker fetch fails.
6. **medium — Sandcastle `pruneStale()`**: registered-but-abandoned worktrees are not orphaned by its definition and can persist after crashes.
7. **no blocker to the recommendation**: deadloop's existing journal/ownership model is an appropriate foundation; capacity management can be added without weakening evidence-preserving cleanup.

## Sources

### Kept

- [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle) — official repository.
- [`src/WorktreeManager.ts` at `e99f832f`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/WorktreeManager.ts) — authoritative worktree location, creation, removal, and pruning.
- [`src/createWorktree.ts` at `e99f832f`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/createWorktree.ts) — first-class lifecycle, environment propagation, and default log location.
- [`src/SandboxFactory.ts` at `e99f832f`](https://github.com/mattpocock/sandcastle/blob/e99f832f/src/SandboxFactory.ts) — acquire/release behavior on success/failure.
- [`docs/adr/0007-worktree-locking.md` at `e99f832f`](https://github.com/mattpocock/sandcastle/blob/e99f832f/docs/adr/0007-worktree-locking.md) and [official issue #427](https://github.com/mattpocock/sandcastle/issues/427) — first-party concurrency design/status context.
- [official Sandcastle issue #674](https://github.com/mattpocock/sandcastle/issues/674) — direct crash/orphan failure analysis and remediation history.
- [openai/symphony](https://github.com/openai/symphony) — official repository.
- [`workspace.ex` at `58cf97d`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/workspace.ex) — authoritative per-issue creation/reuse/removal.
- [`orchestrator.ex` at `58cf97d`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/orchestrator.ex) — retries, terminal cleanup, startup recovery, concurrency.
- [`config/schema.ex` at `58cf97d`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/elixir/lib/symphony_elixir/config/schema.ex) — `/tmp` default, concurrency defaults, and Codex temp access policy.
- [`SPEC.md` at `58cf97d`](https://github.com/openai/symphony/blob/58cf97da06d556c019ccea20c67f4f77da124bf3/SPEC.md) — first-party normative lifecycle/recovery contract.
- deadloop [`docs/herdr-runner.md`](../herdr-runner.md), [`extensions/deadloop/README.md`](../../extensions/deadloop/README.md), and [`src/herdr-runner.cts`](../../src/herdr-runner.cts) — local architecture and actual adapter behavior.

### Dropped

- Search-engine/explainer summaries — excluded because the task requires primary sources.
- Sandcastle test-only `node:os.tmpdir()` fixtures — not evidence of the production workspace policy.
- Unpinned `main` claims where the pinned implementation was available — avoided to prevent line drift.
- OpenAI Symphony Discussion #64 — first-party-hosted but user-authored operational report; unnecessary because source and SPEC directly establish the relevant behavior.

## Gaps and residual risks

- The incident's process-level evidence (which PID/path consumed the tmpfs quota, mount configuration, quota counters, and whether Herdr itself stores artifacts in `/tmp`) was not provided. The recommendation addresses the demonstrated failure domain but cannot attribute the largest consumer.
- Herdr's repository/source was not part of the requested two-system primary-source comparison and was not located in the supplied project docs. Its own temp/runtime behavior should be audited before choosing the final `runtimeRoot` contract.
- Negative source-search findings cannot prove transitive tools never use `/tmp`; package managers, compilers, agents, containers, and OS libraries remain relevant. Explicit environment plus monitoring is required.
- PID leases alone are unsafe across reboot, PID reuse, containers, and multi-host shared storage; deadloop should bind leases to host/process-start identity and authoritative attempt/runner evidence.
- A persistent temp filesystem prevents tmpfs quota exhaustion but can still fill the main disk; budgets and watermarks are required, not merely relocation.
