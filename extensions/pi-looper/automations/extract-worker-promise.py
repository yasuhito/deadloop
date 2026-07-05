#!/usr/bin/env python3
"""Validate a worker promise JSON file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

VALID_STATUSES = {"complete", "blocked"}


def invalid(file_path: Path, error: str) -> dict[str, Any]:
    return {"status": "invalid", "file": str(file_path), "error": error}


def validate_promise(file_path: Path) -> dict[str, Any]:
    if not file_path.exists():
        return {"status": "none", "file": str(file_path)}

    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return invalid(file_path, "invalid_json")
    except OSError as error:
        return invalid(file_path, f"read_error: {error}")

    if not isinstance(payload, dict):
        return invalid(file_path, "not_object")

    status = payload.get("status")
    if status not in VALID_STATUSES:
        return invalid(file_path, "invalid_status")

    if not isinstance(payload.get("reason"), str):
        return invalid(file_path, "invalid_reason")

    if not isinstance(payload.get("summary"), str):
        return invalid(file_path, "invalid_summary")

    return {"status": status, "file": str(file_path), "promise": payload}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True, type=Path)
    args = parser.parse_args()

    result = validate_promise(args.file)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in VALID_STATUSES else 1


if __name__ == "__main__":
    raise SystemExit(main())
