#!/usr/bin/env python3
"""Replace public GitHub URL placeholders before publishing."""
from __future__ import annotations

import argparse
from pathlib import Path
import re

PLACEHOLDER = "grehell"
ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True, help="Public GitHub username")
    args = parser.parse_args()

    owner = args.owner.strip()
    if not re.fullmatch(
        r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?",
        owner,
    ):
        raise SystemExit("Invalid GitHub username.")

    changed = 0
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".git" in path.parts:
            continue
        if path.suffix.lower() not in {
            ".py", ".json", ".md", ".yml", ".yaml", ".txt"
        }:
            continue
        text = path.read_text(encoding="utf-8")
        if PLACEHOLDER not in text:
            continue
        path.write_text(text.replace(PLACEHOLDER, owner), encoding="utf-8")
        changed += 1

    print(f"Updated {changed} files for GitHub owner: {owner}")


if __name__ == "__main__":
    main()
