#!/usr/bin/env python3
"""Decide whether a PR branch can be updated mechanically or needs one worker."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


class CommandError(RuntimeError):
    pass


def run_git(repo: str, args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-C", repo, *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise CommandError((result.stderr or result.stdout or f"git failed: {args!r}").strip())
    return result


def count_commits(repo: str, rev_range: str) -> int:
    output = run_git(repo, ["rev-list", "--count", rev_range]).stdout.strip()
    return int(output or "0")


def merge_tree_is_clean(repo: str, head_ref: str, base_ref: str) -> bool:
    result = run_git(repo, ["merge-tree", "--write-tree", head_ref, base_ref], check=False)
    return result.returncode == 0


def worktree_is_clean(repo: str) -> bool:
    return run_git(repo, ["status", "--short"]).stdout.strip() == ""


def rev_parse(repo: str, ref: str) -> str:
    return run_git(repo, ["rev-parse", "--verify", ref]).stdout.strip()


def decide(
    ahead: int,
    behind: int,
    conflict_free: bool,
    clean_worktree: bool = True,
    head_matches_expected: bool = True,
) -> dict[str, Any]:
    diverged = ahead > 0 and behind > 0
    if not clean_worktree:
        action = "blocked"
        reason = "dirty_worktree"
    elif not head_matches_expected:
        action = "blocked"
        reason = "stale_head"
    elif behind <= 0:
        action = "no_update"
        reason = "head_contains_base"
    elif conflict_free:
        action = "mechanical_update"
        reason = "fast_forward" if ahead == 0 else "clean_merge"
    else:
        action = "delegate_worker"
        reason = "merge_conflict"

    return {
        "action": action,
        "reason": reason,
        "ahead": ahead,
        "behind": behind,
        "diverged": diverged,
        "conflictFree": conflict_free,
        "cleanWorktree": clean_worktree,
        "headMatchesExpected": head_matches_expected,
    }


def decide_live(repo: str, head_ref: str, base_ref: str, expected_head_ref: str | None) -> dict[str, Any]:
    head_oid = rev_parse(repo, head_ref)
    run_git(repo, ["rev-parse", "--verify", base_ref])
    expected_head_oid = rev_parse(repo, expected_head_ref) if expected_head_ref else head_oid
    ahead = count_commits(repo, f"{base_ref}..{head_ref}")
    behind = count_commits(repo, f"{head_ref}..{base_ref}")
    conflict_free = True if behind <= 0 else merge_tree_is_clean(repo, head_ref, base_ref)
    decision = decide(
        ahead=ahead,
        behind=behind,
        conflict_free=conflict_free,
        clean_worktree=worktree_is_clean(repo),
        head_matches_expected=head_oid == expected_head_oid,
    )
    decision.update({
        "headRef": head_ref,
        "baseRef": base_ref,
        "headOid": head_oid,
        "expectedHeadRef": expected_head_ref,
        "expectedHeadOid": expected_head_oid,
    })
    return decision


def decide_fixture(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text())
    return decide(
        ahead=int(data.get("ahead", 0)),
        behind=int(data.get("behind", 0)),
        conflict_free=bool(data.get("conflictFree", True)),
        clean_worktree=bool(data.get("cleanWorktree", True)),
        head_matches_expected=bool(data.get("headMatchesExpected", True)),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="Repository path for live git checks.")
    parser.add_argument("--head", help="PR head ref, for example origin/my-branch.")
    parser.add_argument("--base", help="Base ref, for example origin/main.")
    parser.add_argument("--fixture", help="Fixture JSON with ahead, behind, and conflictFree.")
    parser.add_argument("--expected-head-ref", help="Optional ref that local head must match before updating.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.fixture:
        decision = decide_fixture(args.fixture)
    else:
        if not args.repo or not args.head or not args.base:
            raise ValueError("--repo, --head, and --base are required unless --fixture is used")
        decision = decide_live(args.repo, args.head, args.base, args.expected_head_ref)
    print(json.dumps(decision, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"pr-branch-update-decision.py: {error}", file=sys.stderr)
        raise SystemExit(2)
