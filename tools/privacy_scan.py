#!/usr/bin/env python3
"""Fail when likely private Home Assistant data is committed."""
from __future__ import annotations

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]

PATTERNS = {
    "private IPv4 address": re.compile(
        r"\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b"
    ),
    "Home Assistant user ID": re.compile(r"\b[a-f0-9]{32}\b", re.I),
}

BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".zip", ".pyc"}
problems: list[str] = []

for path in ROOT.rglob("*"):
    if not path.is_file() or ".git" in path.parts:
        continue
    if path.suffix.lower() in BINARY_SUFFIXES:
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    for label, pattern in PATTERNS.items():
        if pattern.search(text):
            problems.append(f"{path.relative_to(ROOT)}: {label}")

if problems:
    print("Potential private data found:")
    print("\n".join(f"- {item}" for item in problems))
    sys.exit(1)

print("Privacy scan passed.")
