"""Create repository and manual-install archives."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)
VERSION = json.loads(
    (ROOT / "custom_components" / "matrix_notification_center" / "manifest.json").read_text()
)["version"]
EXCLUDED_PARTS = {
    "dist",
    "__pycache__",
    ".pytest_cache",
    ".git",
    ".mypy_cache",
    ".ruff_cache",
}


def should_skip(path: Path) -> bool:
    return bool(EXCLUDED_PARTS.intersection(path.parts))


def build_repository() -> Path:
    target = DIST / f"matrix-notification-center-repository-v{VERSION}.zip"
    with ZipFile(target, "w", ZIP_DEFLATED) as archive:
        for path in ROOT.rglob("*"):
            if not path.is_file() or should_skip(path):
                continue
            archive.write(path, Path("matrix-notification-center") / path.relative_to(ROOT))
    return target


def build_manual() -> Path:
    target = DIST / f"matrix-notification-center-manual-install-v{VERSION}.zip"
    component_root = ROOT / "custom_components" / "matrix_notification_center"
    with ZipFile(target, "w", ZIP_DEFLATED) as archive:
        for path in component_root.rglob("*"):
            if not path.is_file() or should_skip(path):
                continue
            archive.write(
                path,
                Path("custom_components/matrix_notification_center")
                / path.relative_to(component_root),
            )
    return target


if __name__ == "__main__":
    print(build_repository())
    print(build_manual())
