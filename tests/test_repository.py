"""Release checks that do not require a Home Assistant installation."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "custom_components" / "matrix_notification_center"


def test_manifest_and_version() -> None:
    manifest = json.loads((COMPONENT / "manifest.json").read_text())
    constants = (COMPONENT / "const.py").read_text()
    assert manifest["domain"] == "matrix_notification_center"
    assert manifest["version"] == "1.5.0"
    assert 'VERSION = "1.5.0"' in constants


def test_python_sources_compile() -> None:
    for path in COMPONENT.rglob("*.py"):
        compile(path.read_text(), str(path), "exec")


def test_authenticated_kiosk_bridge() -> None:
    source = (COMPONENT / "__init__.py").read_text()
    assert 'url = "/api/matrix_notification_center/kiosk"' in source
    assert "requires_auth = True" in source
    assert "kiosk_snapshot" in source
    assert "_publish_kiosk_event" in source
    assert '"bridge_version": 1' in source
    assert '"recipients"' not in source[source.index("def _kiosk_item"):source.index("def _kiosk_allowed")]
    assert "KioskView," in source


def test_kiosk_rule_and_global_settings() -> None:
    source = (COMPONENT / "__init__.py").read_text()
    frontend = (COMPONENT / "frontend" / "panel.js").read_text()
    for token in (
        "kiosk_enabled",
        "kiosk_targets",
        "kiosk_mode",
        "kiosk_duration_seconds",
        "kiosk_wake",
        "kiosk_wake_entity",
    ):
        assert token in source
        assert token in frontend
    assert "PANEL KIOSKU" in frontend
    assert "WYŚWIETLANIE NA PANELU KIOSKU" in frontend


def test_frontend_syntax() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is unavailable")
    subprocess.run(
        [node, "--check", str(COMPONENT / "frontend" / "panel.js")],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


def test_release_packager_exists() -> None:
    assert (ROOT / "scripts" / "package_release.py").is_file()
