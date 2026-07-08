# Token hygiene through deterministic automation drivers

## Problem

pi-looper currently sends large automation prompts into the long-lived Pi session whenever an automation becomes due. The current prompt files are large (`issue-coordinator.prompt.md` is roughly 14.6k characters and `pr-reviewer.prompt.md` is roughly 23.7k characters), and repeated scheduled runs can accumulate old automation history in the same context window.

This wastes tokens and makes orchestration quality dependent on a large natural-language procedure. It also conflicts with the project direction: deterministic decisions should live in scripts or TypeScript functions, while LLM prompts should handle only ambiguous judgment and language synthesis.

## Goals

- Reduce the default automation prompt surface substantially.
- Avoid invoking the LLM for deterministic skip/wait/cleanup cases.
- Move deterministic orchestration decisions into tested scripts or TypeScript functions.
- Preserve the existing safety rules for labels, comments, worktrees, launch behavior, promise files, and auto-merge.
- Add tests that prevent prompt size from growing back accidentally.

## Non-goals

- Do not weaken worker or reviewer safety constraints.
- Do not enable automatic merge or queueing as part of this work.
- Do not change the supported runner away from Herdr.
- Do not remove LLM review or implementation quality checks; make them more bounded.

## Proposed shape

Add a deterministic automation driver seam. A scheduled automation may run a driver before sending any prompt to the Pi conversation. The driver returns a small JSON result:

- `skip`: no work is needed; do not send an LLM prompt.
- `done`: deterministic work completed; report a concise summary only.
- `needs_llm`: send a short, generated prompt with bounded evidence.
- `error`: record failure and surface a concise operator summary.

This seam lets pi-looper keep the extension scheduler small while pushing workflow-specific behavior into scripts with focused tests.

## Rollout plan

1. Add prompt budget tests and a small token-hygiene measurement baseline.
2. Add the automation driver result contract to the scheduler without changing existing automations.
3. Extract deterministic issue-coordinator rendering helpers for blocked comments and worker prompts.
4. Implement an issue-coordinator driver that covers select/gate/claim/launch/watch/PR creation and reduce the front prompt to a thin wrapper.
5. Apply the same pattern to PR reviewer in smaller follow-up slices.

## Acceptance criteria

- Prompt size budgets are enforced by tests.
- The scheduler can run a deterministic driver and skip `pi.sendUserMessage` when no LLM judgment is needed.
- Driver results are recorded in `state.json` with enough information for status/doctor diagnostics.
- Existing prompt-based automations still work when no driver is configured.
- The issue-coordinator prompt shrinks by moving deterministic text and rendering into scripts.
- All changes pass the repository verification commands.

## Prompt budget baseline

Issue #70 adds the first guardrail without shrinking prompts yet. The initial budgets are deliberately loose so the current repository passes while still making prompt growth visible:

- `issue-coordinator.prompt.md`: initially approximately 14.6k characters with a 16k budget; issue #73 moved the front prompt to a driver wrapper, so the current budget is 4k characters.
- `pr-reviewer.prompt.md`: initially approximately 23.7k characters with a 25k budget; issue #74 moved the front prompt to a driver wrapper, so the current budget is 5k characters.

Follow-up driver work should continue lowering these budgets as deterministic workflow text moves into scripts.

## Implementation issues

The GitHub issues created from this PRD are intentionally not labeled `agent:implement` by default. Add that label when a human is ready to let pi-looper pick up a specific slice.

- [#70](https://github.com/yasuhito/pi-looper/issues/70) Add prompt budget tests for automation token hygiene
- [#71](https://github.com/yasuhito/pi-looper/issues/71) Add deterministic automation driver seam to the scheduler
- [#72](https://github.com/yasuhito/pi-looper/issues/72) Extract issue-coordinator blocked-comment and worker-prompt renderers
- [#73](https://github.com/yasuhito/pi-looper/issues/73) Implement deterministic issue-coordinator driver and shrink front prompt
- [#74](https://github.com/yasuhito/pi-looper/issues/74) Reduce PR reviewer prompt with deterministic driver slices
