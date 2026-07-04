#!/usr/bin/env python3
"""Extract a worker promise from a Pi session JSONL.

Only assistant normal text content is considered. User prompts, pane text,
thinking blocks, and tool output are ignored so startup instructions do not
produce false positives.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

PROMISE_RE = re.compile(r"<promise>\s*(COMPLETE|BLOCKED:\s*.*?)\s*</promise>", re.DOTALL)


def pane_session_path(pane_id: str) -> Path | None:
    try:
        output = subprocess.check_output(["herdr", "pane", "list", "--json"], text=True, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        output = subprocess.check_output(["herdr", "pane", "list"], text=True)
    data = json.loads(output)
    for pane in data.get("result", {}).get("panes", []):
        if pane.get("pane_id") != pane_id:
            continue
        session = pane.get("agent_session") or {}
        if session.get("kind") == "path" and session.get("value"):
            return Path(session["value"])
    return None


def assistant_texts(message: dict[str, Any]) -> list[str]:
    if message.get("role") != "assistant":
        return []
    content = message.get("content")
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    texts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "text":
            continue
        text = item.get("text")
        if isinstance(text, str):
            texts.append(text)
    return texts


def extract(session_path: Path) -> dict[str, Any]:
    matches: list[dict[str, Any]] = []
    if not session_path.exists():
        return {"status": "missing_session", "session": str(session_path), "matches": []}

    with session_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") != "message":
                continue
            message = entry.get("message") or {}
            for text in assistant_texts(message):
                for match in PROMISE_RE.finditer(text):
                    value = " ".join(match.group(1).split())
                    status = "complete" if value == "COMPLETE" else "blocked"
                    matches.append(
                        {
                            "status": status,
                            "promise": value,
                            "line": line_number,
                            "entryId": entry.get("id"),
                            "timestamp": entry.get("timestamp") or message.get("timestamp"),
                        }
                    )

    if not matches:
        return {"status": "none", "session": str(session_path), "matches": []}
    latest = matches[-1]
    return {"status": latest["status"], "session": str(session_path), "latest": latest, "matches": matches}


def main() -> int:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--session", type=Path)
    source.add_argument("--pane-id")
    args = parser.parse_args()

    session_path = args.session
    if args.pane_id:
        session_path = pane_session_path(args.pane_id)
        if session_path is None:
            print(json.dumps({"status": "missing_pane", "paneId": args.pane_id}, ensure_ascii=False))
            return 2

    result = extract(session_path)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in {"complete", "blocked"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
