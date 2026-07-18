"""Privacy-safe diagnostics for Matrix Notification Center."""
from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from . import MatrixNotificationCenterConfigEntry
from .const import VERSION


async def async_get_config_entry_diagnostics(
    _hass: HomeAssistant,
    entry: MatrixNotificationCenterConfigEntry,
) -> dict[str, Any]:
    """Return diagnostics without messages, entity IDs or notify services."""
    manager = entry.runtime_data
    data = manager.data
    settings = data.get("settings", {})
    return {
        "version": VERSION,
        "statistics": {
            "rules": len(data.get("rules", [])),
            "active_notifications": len(data.get("active", [])),
            "history_entries": len(data.get("history", [])),
            "configured_recipients": len(settings.get("recipients", {})),
        },
        "features": {
            "center_enabled": bool(settings.get("enabled", True)),
            "persistent_notifications": bool(settings.get("persistent", True)),
            "quiet_hours_enabled": bool(settings.get("quiet_enabled", False)),
            "signal_enabled": bool(settings.get("signal_enabled", False)),
        },
    }
