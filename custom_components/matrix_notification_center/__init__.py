"""Matrix Notification Center for Home Assistant."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timedelta
from http import HTTPStatus
import json
import logging
from pathlib import Path
import time
from typing import Any
from uuid import uuid4

from aiohttp import web

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import (
    KEY_HASS,
    KEY_HASS_USER,
    HomeAssistantView,
    StaticPathConfig,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Context, Event, HomeAssistant, ServiceCall, callback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.storage import Store

from .const import (
    DATA_HTTP_REGISTERED,
    DATA_MANAGER,
    DATA_PANEL_REGISTERED,
    DOMAIN,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    SERVICE_EVALUATE,
    SERVICE_SEND,
    STATIC_URL,
    STORE_KEY,
    STORE_VERSION,
    UPDATE_EVENT,
    VERSION,
)

_LOGGER = logging.getLogger(__name__)


def _now() -> float:
    return time.time()


def _iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _to_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


class NotificationManager:
    """Store rules and execute the notification engine."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, STORE_KEY)
        self.data: dict[str, Any] = {}
        self.last_run: str | None = None
        self.last_error: str | None = None
        self.started_at = _iso()
        self._save_lock = asyncio.Lock()
        self._unsubs: list[Any] = []
        self._entity_index: dict[str, set[str]] = {}
        self._node_runtime: dict[str, dict[str, Any]] = {}
        self._transitions: dict[str, dict[str, Any]] = {}
        self._kiosk_sequence = 0
        self._kiosk_events: list[dict[str, Any]] = []

    def default_data(self) -> dict[str, Any]:
        return {
            "rules": [],
            "active": [],
            "manual": [],
            "history": [],
            "settings": {
                "enabled": True,
                "persistent": True,
                "signal_enabled": False,
                "quiet_enabled": False,
                "quiet_start": "22:00",
                "quiet_end": "07:00",
                "recipients": {},
                "signal_service": "",
                "kiosk_enabled": True,
                "kiosk_min_level": "informacja",
                "kiosk_info_duration": 8,
                "kiosk_task_duration": 15,
                "kiosk_warning_duration": 30,
                "kiosk_wake_enabled": False,
                "kiosk_wake_entity": "",
            },
        }

    @staticmethod
    def _sanitize_kiosk_targets(raw: Any) -> list[str]:
        """Return a compact list of kiosk profile identifiers."""
        values = raw if isinstance(raw, list) else str(raw or "*").split(",")
        result: list[str] = []
        for value in values:
            target = str(value).strip()[:80]
            if target and target not in result:
                result.append(target)
        return result[:20] or ["*"]

    @staticmethod
    def _sanitize_kiosk_mode(raw: Any, fallback: str = "auto") -> str:
        mode = str(raw or fallback).strip().lower()
        return mode if mode in {"auto", "banner", "card", "fullscreen"} else fallback

    def _sanitize_recipients_map(
        self,
        raw: Any,
        fallback: dict[str, Any] | None = None,
    ) -> dict[str, dict[str, Any]]:
        """Normalize dynamically managed notification-center users."""
        source = raw if isinstance(raw, dict) else {}
        result: dict[str, dict[str, Any]] = {}
        for raw_name, raw_cfg in list(source.items())[:100]:
            name = str(raw_name).strip()[:60]
            if not name or name.lower() == "signal" or not isinstance(raw_cfg, dict):
                continue
            result[name] = {
                "enabled": bool(raw_cfg.get("enabled", True)),
                "service": str(raw_cfg.get("service", "")).strip()[:180],
                "admin": bool(raw_cfg.get("admin", False)),
                "ha_user_id": str(raw_cfg.get("ha_user_id", "")).strip()[:80],
            }
        if not result and isinstance(fallback, dict):
            return self._sanitize_recipients_map(fallback)
        return result

    def _default_recipient_name(self) -> str | None:
        recipients = self.data.get("settings", {}).get("recipients", {})
        for name, cfg in recipients.items():
            if cfg.get("enabled") and cfg.get("service"):
                return name
        return next(iter(recipients), None)

    @staticmethod
    def _sanitize_phone_options(
        raw: Any,
        old: Any = None,
        confirmation_default: bool = False,
    ) -> dict[str, Any]:
        """Normalize phone presentation options shared by rules and manual sends."""
        raw = raw if isinstance(raw, dict) else {}
        old = old if isinstance(old, dict) else {}

        def pick(key: str, default: Any) -> Any:
            return raw[key] if key in raw else old.get(key, default)

        importance = str(pick("importance", "auto")).lower()
        if importance not in {"auto", "min", "low", "default", "high", "max"}:
            importance = "auto"
        channel = str(pick("channel", "auto")).strip()[:80] or "auto"
        open_url = str(
            pick("open_url", "/centrum-powiadomien?tab=powiadomienia")
        ).strip()[:500]
        return {
            "include_title_in_message": bool(
                pick("include_title_in_message", True)
            ),
            "show_actions": bool(pick("show_actions", True)),
            "sticky": bool(pick("sticky", confirmation_default)),
            "persistent_on_phone": bool(pick("persistent_on_phone", False)),
            "subtitle": str(pick("subtitle", ""))[:140],
            "subject": str(pick("subject", ""))[:220],
            "channel": channel,
            "importance": importance,
            "vibration_pattern": str(pick("vibration_pattern", ""))[:100],
            "led_color": str(pick("led_color", ""))[:30],
            "timeout": _to_int(pick("timeout", 0), 0, 0, 86400),
            "image": str(pick("image", ""))[:500],
            "open_url": open_url or "/centrum-powiadomien?tab=powiadomienia",
        }

    def is_center_admin(self, user: Any) -> bool:
        """Return whether a HA user can administer this notification center."""
        if user is None:
            return False
        if bool(getattr(user, "is_admin", False)):
            return True
        user_id = str(getattr(user, "id", ""))
        if not user_id:
            return False
        return any(
            cfg.get("admin") and str(cfg.get("ha_user_id", "")) == user_id
            for cfg in self.data.get("settings", {}).get("recipients", {}).values()
        )

    async def available_ha_users(self) -> list[dict[str, Any]]:
        """Return selectable, non-system Home Assistant users."""
        result: list[dict[str, Any]] = []
        for user in await self.hass.auth.async_get_users():
            if getattr(user, "system_generated", False):
                continue
            result.append(
                {
                    "id": user.id,
                    "name": user.name or user.id,
                    "is_admin": bool(user.is_admin),
                    "is_owner": bool(user.is_owner),
                    "is_active": bool(user.is_active),
                }
            )
        return sorted(result, key=lambda item: item["name"].lower())

    async def async_load(self) -> None:
        loaded = await self.store.async_load()
        defaults = self.default_data()
        if not isinstance(loaded, dict):
            loaded = defaults
        loaded_settings = loaded.get("settings", defaults["settings"])
        if not isinstance(loaded_settings, dict):
            loaded_settings = deepcopy(defaults["settings"])
        self.data = {
            "rules": loaded.get("rules", []),
            "active": loaded.get("active", []),
            "manual": loaded.get("manual", []),
            "history": loaded.get("history", []),
            "settings": loaded_settings,
        }
        for key, value in defaults["settings"].items():
            if key != "recipients":
                self.data["settings"].setdefault(key, deepcopy(value))
        self.data["settings"]["recipients"] = self._sanitize_recipients_map(
            self.data["settings"].get("recipients"),
            defaults["settings"]["recipients"],
        )

        # Migracja 1.0.x -> 1.1.0: pojedynczy warunek staje się grupą AND.
        migrated: list[dict[str, Any]] = []
        for raw_rule in self.data.get("rules", []):
            if isinstance(raw_rule, dict):
                migrated.append(self._sanitize_rule(raw_rule, raw_rule))
        self.data["rules"] = migrated
        self._reindex()
        await self.async_save()

    async def async_start(self) -> None:
        self._unsubs.append(self.hass.bus.async_listen(EVENT_STATE_CHANGED, self._state_changed))
        self._unsubs.append(async_track_time_interval(self.hass, self._timer, timedelta(seconds=30)))
        self._unsubs.append(
            self.hass.bus.async_listen("mobile_app_notification_action", self._mobile_action)
        )
        self.hass.async_create_task(self.async_evaluate())

    async def async_stop(self) -> None:
        """Stop listeners and timers owned by the notification engine."""
        for unsubscribe in self._unsubs:
            try:
                unsubscribe()
            except Exception:  # pragma: no cover - defensive cleanup
                _LOGGER.debug("Unable to remove a listener", exc_info=True)
        self._unsubs.clear()

    async def async_save(self) -> None:
        async with self._save_lock:
            await self.store.async_save(self.data)

    async def changed(self) -> None:
        await self.async_save()
        self.hass.bus.async_fire(UPDATE_EVENT)

    def _reindex(self) -> None:
        index: dict[str, set[str]] = {}
        for rule in self.data.get("rules", []):
            for entity_id in self._condition_entity_ids(rule.get("conditions")):
                index.setdefault(entity_id, set()).add(rule["id"])
        self._entity_index = index

    def _condition_entity_ids(self, node: Any) -> set[str]:
        result: set[str] = set()
        if not isinstance(node, dict):
            return result
        if node.get("type") == "group":
            for item in node.get("items", []):
                result.update(self._condition_entity_ids(item))
        elif node.get("type") == "entity":
            for key in ("entity_id", "compare_entity_id"):
                entity_id = str(node.get(key, "")).strip()
                if entity_id:
                    result.add(entity_id)
        return result

    def _first_entity_condition(self, node: Any) -> dict[str, Any] | None:
        if not isinstance(node, dict):
            return None
        if node.get("type") == "entity":
            return node
        for item in node.get("items", []):
            found = self._first_entity_condition(item)
            if found:
                return found
        return None

    def _sanitize_condition(self, raw: Any, depth: int = 0) -> dict[str, Any] | None:
        """Normalize a nested condition tree and migrate old nodes."""
        if not isinstance(raw, dict) or depth > 6:
            return None

        node_type = str(raw.get("type", "entity"))
        node_id = str(raw.get("id") or uuid4())
        common = {
            "id": node_id,
            "negate": bool(raw.get("negate", False)),
            "for_seconds": _to_int(raw.get("for_seconds", 0), 0, 0, 86400),
        }

        if node_type == "group":
            logic = str(raw.get("logic", "and")).lower()
            allowed_logic = {"and", "or", "none", "at_least", "exactly", "majority", "xor"}
            if logic not in allowed_logic:
                logic = "and"
            items: list[dict[str, Any]] = []
            for item in raw.get("items", [])[:100]:
                sanitized = self._sanitize_condition(item, depth + 1)
                if sanitized:
                    items.append(sanitized)
            return {
                **common,
                "type": "group",
                "logic": logic,
                "threshold": _to_int(raw.get("threshold", 1), 1, 1, 100),
                "collapsed": bool(raw.get("collapsed", False)),
                "label": str(raw.get("label", ""))[:80],
                "items": items,
            }

        if node_type == "time":
            weekdays = raw.get("weekdays", [])
            if not isinstance(weekdays, list):
                weekdays = []
            allowed_days = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
            return {
                **common,
                "type": "time",
                "after": str(raw.get("after", "00:00"))[:5],
                "before": str(raw.get("before", "23:59"))[:5],
                "weekdays": [str(day) for day in weekdays if str(day) in allowed_days],
            }

        operators = {
            "stan równy",
            "stan różny",
            "jeden z",
            "żaden z",
            "zawiera",
            "nie zawiera",
            "powyżej",
            "poniżej",
            "większe lub równe",
            "mniejsze lub równe",
            "pomiędzy",
            "poza zakresem",
            "równe encji",
            "większe od encji",
            "mniejsze od encji",
            "dostępna",
            "niedostępna",
            "zmieniło się na",
            "zmieniło się z na",
            "zmieniło się o co najmniej",
            "zmieniło się w ciągu",
        }
        operator = str(raw.get("operator", "stan równy"))
        if operator not in operators:
            operator = "stan równy"

        try:
            hysteresis = max(0.0, min(1000000.0, float(raw.get("hysteresis", 0) or 0)))
        except (TypeError, ValueError):
            hysteresis = 0.0

        resolved_level = str(raw.get("resolved_level", "same"))
        if resolved_level not in {
            "same",
            "informacja",
            "zadanie",
            "ostrzezenie",
            "krytyczne",
        }:
            resolved_level = "same"

        return {
            **common,
            "type": "entity",
            "entity_id": str(raw.get("entity_id", "")).strip(),
            "operator": operator,
            "value": str(raw.get("value", "")),
            "value2": str(raw.get("value2", "")),
            "compare_entity_id": str(raw.get("compare_entity_id", "")).strip(),
            "case_sensitive": bool(raw.get("case_sensitive", False)),
            "window_minutes": _to_int(raw.get("window_minutes", 5), 5, 1, 10080),
            "hysteresis": hysteresis,
            "event_description": str(raw.get("event_description", ""))[:500],
            "resolved_description": str(raw.get("resolved_description", ""))[:500],
            "notify_on_resolved": bool(raw.get("notify_on_resolved", False)),
            "resolved_require_confirmation": bool(
                raw.get("resolved_require_confirmation", False)
            ),
            "resolved_level": resolved_level,
        }

    @callback
    def _state_changed(self, event: Event) -> None:
        entity_id = str(event.data.get("entity_id", ""))
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        if old_state is not None and new_state is not None and old_state.state != new_state.state:
            self._transitions[entity_id] = {
                "from": old_state.state,
                "to": new_state.state,
                "at": _now(),
            }
        ids = self._entity_index.get(entity_id)
        if ids:
            self.hass.async_create_task(self.async_evaluate(set(ids)))

    @callback
    def _timer(self, _now_dt: datetime) -> None:
        self.hass.async_create_task(self.async_evaluate())

    @callback
    def _mobile_action(self, event: Event) -> None:
        action = event.data.get("action")
        if not isinstance(action, str):
            return
        actor = event.context.user_id or event.data.get("device_id") or "telefon"
        context = Context(user_id=event.context.user_id)
        if action.startswith("MNC_ACK_"):
            self.hass.async_create_task(
                self.async_ack(action.removeprefix("MNC_ACK_"), str(actor), context)
            )
        elif action.startswith("MNC_SNOOZE_"):
            self.hass.async_create_task(
                self.async_snooze(action.removeprefix("MNC_SNOOZE_"), 120, str(actor), context)
            )
        elif action.startswith("MNC_IGNORE_"):
            self.hass.async_create_task(
                self.async_snooze(action.removeprefix("MNC_IGNORE_"), 1440, str(actor), context)
            )

    def _find_rule(self, rule_id: str) -> dict[str, Any] | None:
        return next((r for r in self.data["rules"] if r.get("id") == rule_id), None)

    def _find_active(self, active_id: str) -> dict[str, Any] | None:
        return next((a for a in self.data["active"] if a.get("id") == active_id), None)

    def _sanitize_rule(self, raw: dict[str, Any], old: dict[str, Any] | None = None) -> dict[str, Any]:
        old = old or {}
        level = str(raw.get("level", old.get("level", "zadanie")))
        if level not in {"informacja", "zadanie", "ostrzezenie", "krytyczne"}:
            level = "zadanie"
        default_recipient = self._default_recipient_name()
        recipients = raw.get(
            "recipients",
            old.get("recipients", [default_recipient] if default_recipient else []),
        )
        if not isinstance(recipients, list):
            recipients = []
        allowed = set(self.data["settings"]["recipients"])
        recipients = [str(x) for x in recipients if str(x) in allowed]
        if not recipients and default_recipient:
            recipients = [default_recipient]

        raw_conditions = raw.get("conditions")
        if not isinstance(raw_conditions, dict):
            raw_conditions = old.get("conditions")
        if not isinstance(raw_conditions, dict):
            # Zgodność ze starymi regułami jednoencjowymi.
            raw_conditions = {
                "type": "group",
                "logic": "and",
                "negate": False,
                "items": [
                    {
                        "type": "entity",
                        "entity_id": str(raw.get("entity_id", old.get("entity_id", ""))).strip(),
                        "operator": str(raw.get("operator", old.get("operator", "stan równy"))),
                        "value": str(raw.get("value", old.get("value", ""))),
                    }
                ],
            }
        conditions = self._sanitize_condition(raw_conditions)
        if not conditions or conditions.get("type") != "group":
            conditions = {"id": str(uuid4()), "type": "group", "logic": "and", "negate": False, "items": []}
        first = self._first_entity_condition(conditions) or {}
        require_confirmation = bool(
            raw.get("require_confirmation", old.get("require_confirmation", True))
        )
        phone_options = self._sanitize_phone_options(
            raw.get("phone_options"),
            old.get("phone_options"),
            require_confirmation,
        )
        return {
            "id": str(raw.get("id") or old.get("id") or uuid4()),
            "name": str(raw.get("name", old.get("name", "Nowa reguła")))[:100],
            "enabled": bool(raw.get("enabled", old.get("enabled", True))),
            "conditions": conditions,
            "allow_duplicate_entities": bool(
                raw.get("allow_duplicate_entities", old.get("allow_duplicate_entities", False))
            ),
            "include_matched_conditions": bool(
                raw.get(
                    "include_matched_conditions",
                    old.get("include_matched_conditions", True),
                )
            ),
            # Pola legacy pozostają, aby stare szablony treści nadal działały.
            "entity_id": str(first.get("entity_id", "")),
            "operator": str(first.get("operator", "stan równy")),
            "value": str(first.get("value", "")),
            "duration_seconds": _to_int(raw.get("duration_seconds", old.get("duration_seconds", 60)), 60, 0, 86400),
            "level": level,
            "category": str(raw.get("category", old.get("category", "Zadania")))[:80],
            "recipients": recipients,
            "require_confirmation": require_confirmation,
            "repeat": bool(raw.get("repeat", old.get("repeat", True))),
            "interval_minutes": _to_int(raw.get("interval_minutes", old.get("interval_minutes", 60)), 60, 1, 10080),
            "signal": bool(raw.get("signal", old.get("signal", False))),
            "bypass_quiet_hours": bool(
                raw.get(
                    "bypass_quiet_hours",
                    old.get("bypass_quiet_hours", False),
                )
            ),
            "phone_options": phone_options,
            "kiosk_enabled": bool(
                raw.get("kiosk_enabled", old.get("kiosk_enabled", True))
            ),
            "kiosk_targets": self._sanitize_kiosk_targets(
                raw.get("kiosk_targets", old.get("kiosk_targets", ["*"]))
            ),
            "kiosk_mode": self._sanitize_kiosk_mode(
                raw.get("kiosk_mode", old.get("kiosk_mode", "auto"))
            ),
            "kiosk_duration_seconds": _to_int(
                raw.get(
                    "kiosk_duration_seconds",
                    old.get("kiosk_duration_seconds", 0),
                ),
                0,
                0,
                86400,
            ),
            "kiosk_wake": bool(
                raw.get("kiosk_wake", old.get("kiosk_wake", True))
            ),
            "ack_timeout_minutes": _to_int(raw.get("ack_timeout_minutes", old.get("ack_timeout_minutes", 0)), 0, 0, 10080),
            "title": str(raw.get("title", old.get("title", "Powiadomienie")))[:140],
            "message": str(raw.get("message", old.get("message", "")))[:1200],
            "created_at": old.get("created_at", _iso()),
            "updated_at": _iso(),
            "condition_since": old.get("condition_since"),
            "last_sent": old.get("last_sent"),
            "snoozed_until": old.get("snoozed_until"),
            "acknowledged": old.get("acknowledged", False),
            "acknowledged_until": old.get("acknowledged_until"),
        }

    async def save_rule(self, raw: dict[str, Any], actor: str) -> dict[str, Any]:
        old = self._find_rule(str(raw.get("id", ""))) if raw.get("id") else None
        rule = self._sanitize_rule(raw, old)
        if old:
            self.data["rules"][self.data["rules"].index(old)] = rule
            event = "zaktualizowano regułę"
        else:
            self.data["rules"].append(rule)
            event = "utworzono regułę"
        self._reindex()
        prefix = f"{rule['id']}:"
        self._node_runtime = {
            key: value
            for key, value in self._node_runtime.items()
            if not key.startswith(prefix)
        }
        self.history(event, rule["title"], rule["message"], actor, rule["level"])
        await self.changed()
        self.hass.async_create_task(self.async_evaluate({rule["id"]}))
        return deepcopy(rule)

    async def delete_rule(self, rule_id: str, actor: str) -> bool:
        rule = self._find_rule(rule_id)
        if not rule:
            return False
        await self._clear(f"rule_{rule_id}", None)
        self.data["active"] = [x for x in self.data["active"] if x.get("rule_id") != rule_id]
        self.data["rules"].remove(rule)
        prefix = f"{rule_id}:"
        self._node_runtime = {key: value for key, value in self._node_runtime.items() if not key.startswith(prefix)}
        self._reindex()
        self.history("usunięto regułę", rule["title"], "", actor, rule["level"])
        await self.changed()
        return True

    async def toggle_rule(self, rule_id: str, enabled: bool, actor: str) -> bool:
        rule = self._find_rule(rule_id)
        if not rule:
            return False
        rule["enabled"] = enabled
        rule["updated_at"] = _iso()
        if not enabled:
            await self._resolve(rule, "wyłączono regułę")
        self.history("włączono regułę" if enabled else "wyłączono regułę", rule["title"], "", actor, rule["level"])
        await self.changed()
        return True

    def condition(
        self,
        rule: dict[str, Any],
        update_runtime: bool = False,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        """Evaluate the complete condition tree."""
        return self._evaluate_condition_node(
            rule.get("conditions", {}),
            str(rule.get("id", "draft")),
            update_runtime,
        )

    def _runtime(
        self,
        rule_id: str,
        node_id: str,
        update_runtime: bool,
    ) -> dict[str, Any]:
        key = f"{rule_id}:{node_id}"
        if update_runtime:
            return self._node_runtime.setdefault(key, {})
        return self._node_runtime.get(key, {})

    def _apply_node_duration(
        self,
        raw_met: bool,
        node: dict[str, Any],
        rule_id: str,
        update_runtime: bool,
    ) -> tuple[bool, int]:
        runtime = self._runtime(rule_id, str(node.get("id", "")), update_runtime)
        required = _to_int(node.get("for_seconds", 0), 0, 0, 86400)
        now = _now()
        if raw_met:
            since = runtime.get("since")
            if since is None:
                if update_runtime:
                    runtime["since"] = now
                since = now
            elapsed = max(0, int(now - float(since)))
            return elapsed >= required, elapsed
        if update_runtime:
            runtime.pop("since", None)
        return False, 0

    @staticmethod
    def _split_values(value: str) -> list[str]:
        return [
            item.strip()
            for item in str(value).replace("\n", ",").split(",")
            if item.strip()
        ]

    def _evaluate_condition_node(
        self,
        node: Any,
        rule_id: str,
        update_runtime: bool,
    ) -> tuple[bool, str, list[dict[str, Any]]]:
        if not isinstance(node, dict):
            return False, "brak warunku", []

        node_type = node.get("type")
        node_id = str(node.get("id", ""))

        if node_type == "group":
            child_results = [
                self._evaluate_condition_node(item, rule_id, update_runtime)
                for item in node.get("items", [])
            ]
            values = [result[0] for result in child_results]
            passed = sum(1 for value in values if value)
            count = len(values)
            logic = str(node.get("logic", "and"))
            threshold = _to_int(node.get("threshold", 1), 1, 1, max(1, count))

            if not values:
                base = False
            elif logic == "and":
                base = all(values)
            elif logic == "or":
                base = any(values)
            elif logic == "none":
                base = passed == 0
            elif logic == "at_least":
                base = passed >= threshold
            elif logic == "exactly":
                base = passed == threshold
            elif logic == "majority":
                base = passed > count / 2
            elif logic == "xor":
                base = passed == 1
            else:
                base = all(values)

            if node.get("negate"):
                base = not base
            met, elapsed = self._apply_node_duration(base, node, rule_id, update_runtime)

            labels = {
                "and": "WSZYSTKIE",
                "or": "DOWOLNY",
                "none": "ŻADEN",
                "at_least": f"CO NAJMNIEJ {threshold}",
                "exactly": f"DOKŁADNIE {threshold}",
                "majority": "WIĘKSZOŚĆ",
                "xor": "TYLKO JEDEN",
            }
            label = labels.get(logic, "WSZYSTKIE")
            if node.get("negate"):
                label = f"NIE ({label})"
            if node.get("for_seconds"):
                label += f" · {elapsed}/{node.get('for_seconds')} s"

            flat: list[dict[str, Any]] = []
            for _, _, details in child_results:
                flat.extend(details)
            flat.insert(
                0,
                {
                    "id": node_id,
                    "type": "group",
                    "met": met,
                    "raw_met": base,
                    "label": f"{label}: {passed}/{count}",
                    "passed": passed,
                    "count": count,
                    "logic": logic,
                    "threshold": threshold,
                    "elapsed_seconds": elapsed,
                    "for_seconds": node.get("for_seconds", 0),
                },
            )
            return met, f"{label}: {passed}/{count}", flat

        if node_type == "time":
            now_dt = datetime.now().astimezone()
            weekdays = node.get("weekdays", [])
            weekday_keys = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
            day_ok = not weekdays or weekday_keys[now_dt.weekday()] in weekdays
            try:
                ah, am = map(int, str(node.get("after", "00:00")).split(":"))
                bh, bm = map(int, str(node.get("before", "23:59")).split(":"))
                current_minutes = now_dt.hour * 60 + now_dt.minute
                after_minutes = ah * 60 + am
                before_minutes = bh * 60 + bm
                time_ok = (
                    after_minutes <= current_minutes <= before_minutes
                    if after_minutes <= before_minutes
                    else current_minutes >= after_minutes or current_minutes <= before_minutes
                )
            except (ValueError, TypeError):
                time_ok = False
            raw_met = day_ok and time_ok
            if node.get("negate"):
                raw_met = not raw_met
            met, elapsed = self._apply_node_duration(raw_met, node, rule_id, update_runtime)
            label = f"czas {node.get('after', '00:00')}–{node.get('before', '23:59')}"
            if node.get("negate"):
                label = f"NIE ({label})"
            detail = {
                "id": node_id,
                "type": "time",
                "met": met,
                "raw_met": raw_met,
                "label": label,
                "current": now_dt.strftime("%a %H:%M"),
                "elapsed_seconds": elapsed,
                "for_seconds": node.get("for_seconds", 0),
            }
            return met, label, [detail]

        entity_id = str(node.get("entity_id", "")).strip()
        state = self.hass.states.get(entity_id)
        current = state.state if state else "unavailable"
        wanted = str(node.get("value", ""))
        wanted2 = str(node.get("value2", ""))
        compare_entity_id = str(node.get("compare_entity_id", "")).strip()
        compare_state = self.hass.states.get(compare_entity_id) if compare_entity_id else None
        compare_current = compare_state.state if compare_state else "unavailable"
        operator = str(node.get("operator", "stan równy"))
        case_sensitive = bool(node.get("case_sensitive", False))
        window_minutes = _to_int(node.get("window_minutes", 5), 5, 1, 10080)
        hysteresis = max(0.0, float(node.get("hysteresis", 0) or 0))
        runtime = self._runtime(rule_id, node_id, update_runtime)
        latched = bool(runtime.get("latched", False))
        raw_met = False

        left_text = current if case_sensitive else current.lower()
        wanted_text = wanted if case_sensitive else wanted.lower()
        wanted2_text = wanted2 if case_sensitive else wanted2.lower()

        if operator == "stan równy":
            raw_met = left_text == wanted_text
        elif operator == "stan różny":
            raw_met = left_text != wanted_text
        elif operator == "jeden z":
            values = self._split_values(wanted)
            if not case_sensitive:
                values = [value.lower() for value in values]
            raw_met = left_text in values
        elif operator == "żaden z":
            values = self._split_values(wanted)
            if not case_sensitive:
                values = [value.lower() for value in values]
            raw_met = left_text not in values
        elif operator == "zawiera":
            raw_met = wanted_text in left_text
        elif operator == "nie zawiera":
            raw_met = wanted_text not in left_text
        elif operator == "dostępna":
            raw_met = current not in {"", "unknown", "unavailable"}
        elif operator == "niedostępna":
            raw_met = current in {"", "unknown", "unavailable"}
        elif operator in {
            "powyżej",
            "poniżej",
            "większe lub równe",
            "mniejsze lub równe",
            "pomiędzy",
            "poza zakresem",
        }:
            try:
                current_number = float(current)
                first_number = float(wanted)
                second_number = float(wanted2) if wanted2 else first_number
                low, high = sorted((first_number, second_number))
                if operator == "powyżej":
                    raw_met = current_number > (first_number - hysteresis if latched else first_number)
                elif operator == "poniżej":
                    raw_met = current_number < (first_number + hysteresis if latched else first_number)
                elif operator == "większe lub równe":
                    raw_met = current_number >= (first_number - hysteresis if latched else first_number)
                elif operator == "mniejsze lub równe":
                    raw_met = current_number <= (first_number + hysteresis if latched else first_number)
                elif operator == "pomiędzy":
                    raw_met = low <= current_number <= high
                else:
                    raw_met = current_number < low or current_number > high
            except (TypeError, ValueError):
                raw_met = False
        elif operator in {"równe encji", "większe od encji", "mniejsze od encji"}:
            if operator == "równe encji":
                raw_met = current == compare_current
            else:
                try:
                    left_number = float(current)
                    right_number = float(compare_current)
                    raw_met = left_number > right_number if operator == "większe od encji" else left_number < right_number
                except (TypeError, ValueError):
                    raw_met = False
        elif operator in {"zmieniło się na", "zmieniło się z na", "zmieniło się o co najmniej"}:
            transition = self._transitions.get(entity_id)
            recent = bool(transition and _now() - float(transition.get("at", 0)) <= window_minutes * 60)
            if operator == "zmieniło się na":
                raw_met = bool(recent and str(transition.get("to")) == wanted)
            elif operator == "zmieniło się z na":
                raw_met = bool(
                    recent
                    and str(transition.get("from")) == wanted
                    and str(transition.get("to")) == wanted2
                )
            else:
                try:
                    raw_met = bool(
                        recent
                        and abs(float(transition.get("to")) - float(transition.get("from"))) >= float(wanted)
                    )
                except (TypeError, ValueError):
                    raw_met = False
        elif operator == "zmieniło się w ciągu":
            try:
                minutes = float(wanted or window_minutes)
                raw_met = bool(
                    state
                    and _now() - state.last_changed.timestamp() <= minutes * 60
                )
            except (TypeError, ValueError):
                raw_met = False

        if update_runtime:
            runtime["latched"] = raw_met
        if node.get("negate"):
            raw_met = not raw_met
        met, elapsed = self._apply_node_duration(raw_met, node, rule_id, update_runtime)

        friendly = state.attributes.get("friendly_name", entity_id) if state else entity_id
        unit = state.attributes.get("unit_of_measurement", "") if state else ""
        compare_name = (
            compare_state.attributes.get("friendly_name", compare_entity_id)
            if compare_state
            else compare_entity_id
        )
        value_label = compare_name if compare_entity_id else wanted
        if wanted2:
            value_label = f"{value_label} … {wanted2}"
        label = f"{friendly}: {current} {operator} {value_label}".strip()
        if node.get("negate"):
            label = f"NIE ({label})"
        if node.get("for_seconds"):
            label += f" · {elapsed}/{node.get('for_seconds')} s"
        detail = {
            "id": node_id,
            "type": "entity",
            "met": met,
            "raw_met": raw_met,
            "label": label,
            "entity_id": entity_id,
            "entity_name": friendly,
            "current": current,
            "unit": unit,
            "negate": bool(node.get("negate", False)),
            "operator": operator,
            "value": wanted,
            "value2": wanted2,
            "compare_entity_id": compare_entity_id,
            "compare_current": compare_current,
            "elapsed_seconds": elapsed,
            "for_seconds": node.get("for_seconds", 0),
            "event_description": str(node.get("event_description", "")),
            "resolved_description": str(node.get("resolved_description", "")),
            "notify_on_resolved": bool(node.get("notify_on_resolved", False)),
            "resolved_require_confirmation": bool(
                node.get("resolved_require_confirmation", False)
            ),
            "resolved_level": str(node.get("resolved_level", "same")),
        }
        return met, label, [detail]

    def quiet(self, level: str, bypass: bool = False) -> bool:
        settings = self.data["settings"]
        if bypass or level == "krytyczne" or not settings.get("quiet_enabled"):
            return False
        try:
            now_minutes = datetime.now().hour * 60 + datetime.now().minute
            sh, sm = map(int, settings.get("quiet_start", "22:00").split(":"))
            eh, em = map(int, settings.get("quiet_end", "07:00").split(":"))
            start, end = sh * 60 + sm, eh * 60 + em
            return (start <= now_minutes < end) if start <= end else (now_minutes >= start or now_minutes < end)
        except (ValueError, TypeError):
            return False

    async def async_evaluate(self, only_ids: set[str] | None = None) -> None:
        if not self.data["settings"].get("enabled", True):
            return
        self.last_run = _iso()
        changed = False
        try:
            for rule in list(self.data["rules"]):
                if only_ids and rule["id"] not in only_ids:
                    continue
                if await self._evaluate_rule(rule):
                    changed = True
            for manual in list(self.data["manual"]):
                if not manual.get("active") or not manual.get("repeat"):
                    continue
                if self.quiet(
                    str(manual.get("level", "informacja")),
                    bool(manual.get("bypass_quiet_hours", False)),
                ):
                    continue
                now = _now()
                snooze = manual.get("snoozed_until")
                if snooze and now < snooze:
                    continue
                last = manual.get("last_sent")
                if last is None or now - last >= manual.get("interval_minutes", 60) * 60:
                    active = self._find_active(manual["id"])
                    if active:
                        await self._send(active, None)
                        manual["last_sent"] = now
                        changed = True
            self.last_error = None
        except Exception as err:  # noqa: BLE001
            self.last_error = str(err)
            _LOGGER.exception("Matrix Notification Center engine error")
        if changed:
            await self.changed()

    @staticmethod
    def _matched_entity_details(details: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Return unique entity conditions that currently satisfy the rule."""
        matched: list[dict[str, Any]] = []
        seen: set[str] = set()
        for detail in details:
            if detail.get("type") != "entity" or not detail.get("met"):
                continue
            entity_id = str(detail.get("entity_id", "")).strip()
            if not entity_id or entity_id in seen:
                continue
            seen.add(entity_id)
            state_value = str(detail.get("current", "unavailable"))
            unit = str(detail.get("unit", "") or "").strip()
            matched.append(
                {
                    "entity_id": entity_id,
                    "entity_name": str(detail.get("entity_name", entity_id)),
                    "state": state_value,
                    "unit": unit,
                    "state_with_unit": f"{state_value} {unit}".strip(),
                    "condition_id": str(detail.get("id", "")),
                    "operator": str(detail.get("operator", "")),
                    "value": str(detail.get("value", "")),
                    "label": str(detail.get("label", "")),
                    "event_description": str(
                        detail.get("event_description", "")
                    ).strip(),
                    "resolved_description": str(
                        detail.get("resolved_description", "")
                    ).strip(),
                    "notify_on_resolved": bool(
                        detail.get("notify_on_resolved", False)
                    ),
                    "resolved_require_confirmation": bool(
                        detail.get("resolved_require_confirmation", False)
                    ),
                    "resolved_level": str(
                        detail.get("resolved_level", "same")
                    ),
                }
            )
        return matched

    @staticmethod
    def _matched_context(matched: list[dict[str, Any]]) -> dict[str, str]:
        """Build text variables describing conditions that matched."""
        return {
            "matched_count": str(len(matched)),
            "matched_entities": ", ".join(item["entity_name"] for item in matched),
            "matched_entity_ids": ", ".join(item["entity_id"] for item in matched),
            "matched_states": ", ".join(item["state_with_unit"] for item in matched),
            "matched_entities_with_state": "\n".join(
                f"• {item['entity_name']}: {item['state_with_unit']}"
                for item in matched
            ),
            "matched_conditions": "\n".join(
                f"• {item['label']}" for item in matched
            ),
            "matched_descriptions": "\n".join(
                f"• {item['event_description']}"
                for item in matched
                if item.get("event_description")
            ),
            "matched_entities_with_description": "\n".join(
                f"• {item['entity_name']}: {item['event_description']}"
                for item in matched
                if item.get("event_description")
            ),
            "first_matched_entity": matched[0]["entity_name"] if matched else "",
            "first_matched_entity_id": matched[0]["entity_id"] if matched else "",
            "first_matched_state": matched[0]["state_with_unit"] if matched else "",
            "first_matched_description": next(
                (
                    item["event_description"]
                    for item in matched
                    if item.get("event_description")
                ),
                "",
            ),
        }

    def _append_condition_descriptions(
        self,
        message: str,
        message_template: str,
        rule: dict[str, Any],
        matched: list[dict[str, Any]],
        entity_details: list[dict[str, Any]],
    ) -> str:
        """Append custom event descriptions or the standard entity list."""
        uses_matched_variable = (
            "{{ matched_" in message_template
            or "{{ first_matched_" in message_template
        )
        if (
            not rule.get("include_matched_conditions", True)
            or not matched
            or uses_matched_variable
        ):
            return message

        described = [
            item for item in matched if item.get("event_description")
        ]
        if described:
            lines = self._matched_context(described)[
                "matched_entities_with_description"
            ]
            return f"{message}\n\nSzczegóły zdarzenia:\n{lines}"

        if len(entity_details) > 1:
            lines = self._matched_context(matched)[
                "matched_entities_with_state"
            ]
            return f"{message}\n\nSpełnione czujniki:\n{lines}"

        return message

    async def _evaluate_rule(self, rule: dict[str, Any]) -> bool:
        met, summary, details = self.condition(rule, update_runtime=True)
        now = _now()
        active_id = f"rule_{rule['id']}"
        if not rule.get("enabled"):
            if (
                rule.get("condition_since")
                or rule.get("last_sent")
                or self._find_active(active_id)
            ):
                await self._resolve(
                    rule,
                    "reguła wyłączona",
                    details,
                    send_resolution=False,
                )
                return True
            return False
        if not met:
            if (
                rule.get("condition_since")
                or rule.get("last_sent")
                or self._find_active(active_id)
            ):
                await self._resolve(
                    rule,
                    "warunek ustąpił",
                    details,
                    send_resolution=True,
                )
                return True
            return False
        if not rule.get("condition_since"):
            rule["condition_since"] = now
            return True
        if rule.get("acknowledged"):
            until = rule.get("acknowledged_until")
            if until and now >= until:
                rule["acknowledged"] = False
                rule["acknowledged_until"] = None
                rule["last_sent"] = None
                return True
            return False
        snooze = rule.get("snoozed_until")
        if snooze and now < snooze:
            return False
        if snooze and now >= snooze:
            rule["snoozed_until"] = None
            rule["last_sent"] = None
        if now - rule["condition_since"] < rule["duration_seconds"] or self.quiet(
            rule["level"], rule.get("bypass_quiet_hours", False)
        ):
            return False
        last = rule.get("last_sent")
        due = last is None or (rule.get("repeat") and now - last >= rule["interval_minutes"] * 60)
        if not due:
            return False
        entity_details = [detail for detail in details if detail.get("type") == "entity"]
        matched = self._matched_entity_details(details)
        first = self._first_entity_condition(rule.get("conditions")) or {}
        first_entity = (
            matched[0]["entity_id"]
            if matched
            else str(first.get("entity_id", ""))
        )
        first_state = self.hass.states.get(first_entity) if first_entity else None
        current = (
            matched[0]["state"]
            if matched
            else first_state.state if first_state else summary
        )
        title = self.render(rule["title"], rule, current, summary, matched)
        message_template = rule["message"]
        message = self.render(message_template, rule, current, summary, matched) or summary

        message = self._append_condition_descriptions(
            message,
            message_template,
            rule,
            matched,
            entity_details,
        )

        active = {
            "id": active_id,
            "kind": "rule",
            "rule_id": rule["id"],
            "title": title,
            "message": message,
            "level": rule["level"],
            "category": rule["category"],
            "recipients": list(rule["recipients"]),
            "require_confirmation": rule["require_confirmation"],
            "signal": rule["signal"],
            "bypass_quiet_hours": rule.get("bypass_quiet_hours", False),
            "phone_options": deepcopy(rule.get("phone_options", {})),
            "kiosk_enabled": rule.get("kiosk_enabled", True),
            "kiosk_targets": list(rule.get("kiosk_targets", ["*"])),
            "kiosk_mode": rule.get("kiosk_mode", "auto"),
            "kiosk_duration_seconds": rule.get("kiosk_duration_seconds", 0),
            "kiosk_wake": rule.get("kiosk_wake", True),
            "source_entity": first_entity or None,
            "source_state": current if len(matched) == 1 else summary,
            "matched_conditions": matched,
            "resolution_descriptions": [
                {
                    "condition_id": item.get("condition_id", ""),
                    "entity_id": item.get("entity_id", ""),
                    "entity_name": item.get("entity_name", ""),
                    "previous_state": item.get("state_with_unit", ""),
                    "message": item.get("resolved_description", ""),
                    "require_confirmation": bool(
                        item.get("resolved_require_confirmation", False)
                    ),
                    "level": str(item.get("resolved_level", "same")),
                }
                for item in matched
                if item.get("notify_on_resolved")
                and item.get("resolved_description")
            ],
            "condition_details": details,
            "created_at": (self._find_active(active_id) or {}).get("created_at", _iso()),
            "last_sent_at": _iso(),
        }
        self.upsert_active(active)
        await self._send(active, None)
        rule["last_sent"] = now
        self.history("wysłano", title, message, "system", rule["level"])
        return True

    def render(
        self,
        text: str,
        rule: dict[str, Any],
        current: str,
        summary: str = "",
        matched: list[dict[str, Any]] | None = None,
    ) -> str:
        matched = matched or []
        first = self._first_entity_condition(rule.get("conditions")) or {}
        entity_id = (
            matched[0]["entity_id"]
            if matched
            else str(first.get("entity_id", rule.get("entity_id", "")))
        )
        state = self.hass.states.get(entity_id)
        name = (
            matched[0]["entity_name"]
            if matched
            else state.attributes.get("friendly_name", entity_id) if state else entity_id
        )
        matched_context = self._matched_context(matched)
        replacements = {
            "{{ entity_id }}": entity_id,
            "{{ entity_name }}": str(name),
            "{{ state }}": current,
            "{{ value }}": str(first.get("value", rule.get("value", ""))),
            "{{ rule_name }}": rule.get("name", ""),
            "{{ conditions_summary }}": summary,
            "{{ matched_count }}": matched_context["matched_count"],
            "{{ matched_entities }}": matched_context["matched_entities"],
            "{{ matched_entity_ids }}": matched_context["matched_entity_ids"],
            "{{ matched_states }}": matched_context["matched_states"],
            "{{ matched_entities_with_state }}": matched_context["matched_entities_with_state"],
            "{{ matched_conditions }}": matched_context["matched_conditions"],
            "{{ matched_descriptions }}": matched_context["matched_descriptions"],
            "{{ matched_entities_with_description }}": matched_context[
                "matched_entities_with_description"
            ],
            "{{ first_matched_entity }}": matched_context["first_matched_entity"],
            "{{ first_matched_entity_id }}": matched_context["first_matched_entity_id"],
            "{{ first_matched_state }}": matched_context["first_matched_state"],
            "{{ first_matched_description }}": matched_context[
                "first_matched_description"
            ],
        }
        result = str(text)
        for key, value in replacements.items():
            result = result.replace(key, value)
        # Dodatkowa składnia: {{ state:sensor.nazwa_encji }}
        import re
        def replace_state(match: re.Match[str]) -> str:
            return self.hass.states.get(match.group(1)).state if self.hass.states.get(match.group(1)) else "unavailable"
        return re.sub(r"\{\{\s*state:([a-z0-9_]+\.[a-z0-9_]+)\s*\}\}", replace_state, result, flags=re.IGNORECASE)

    def upsert_active(self, active: dict[str, Any]) -> None:
        old = self._find_active(active["id"])
        if old:
            self.data["active"][self.data["active"].index(old)] = active
        else:
            self.data["active"].insert(0, active)

    async def _resolve(
        self,
        rule: dict[str, Any],
        event: str,
        current_details: list[dict[str, Any]] | None = None,
        send_resolution: bool = True,
    ) -> None:
        active_id = f"rule_{rule['id']}"
        active = self._find_active(active_id)
        self.data["active"] = [
            item for item in self.data["active"] if item.get("id") != active_id
        ]
        rule["condition_since"] = None
        rule["last_sent"] = None
        rule["snoozed_until"] = None
        rule["acknowledged"] = False
        rule["acknowledged_until"] = None
        await self._clear(active_id, None)

        resolution_sent = False
        if active and send_resolution:
            current_by_id = {
                str(item.get("id", "")): item
                for item in (current_details or [])
                if item.get("type") == "entity"
            }
            resolved_items: list[dict[str, Any]] = []
            for item in active.get("resolution_descriptions", []):
                current = current_by_id.get(str(item.get("condition_id", "")))
                if current is not None and current.get("met"):
                    continue
                raw_message = str(item.get("message", "")).strip()
                if not raw_message:
                    continue

                current_state = (
                    str(current.get("current", "unavailable"))
                    if current
                    else "unavailable"
                )
                unit = (
                    str(current.get("unit", "") or "").strip()
                    if current
                    else ""
                )
                rendered = raw_message
                replacements = {
                    "{{ entity_id }}": str(item.get("entity_id", "")),
                    "{{ entity_name }}": str(item.get("entity_name", "")),
                    "{{ state }}": f"{current_state} {unit}".strip(),
                    "{{ previous_state }}": str(item.get("previous_state", "")),
                    "{{ rule_name }}": str(rule.get("name", "")),
                }
                for key, value in replacements.items():
                    rendered = rendered.replace(key, value)
                requested_level = str(item.get("level", "same"))
                resolved_level = (
                    str(active.get("level", "informacja"))
                    if requested_level == "same"
                    else requested_level
                )
                if resolved_level not in {
                    "informacja",
                    "zadanie",
                    "ostrzezenie",
                    "krytyczne",
                }:
                    resolved_level = str(active.get("level", "informacja"))

                resolved_items.append(
                    {
                        "entity_name": str(item.get("entity_name", "")),
                        "message": rendered,
                        "require_confirmation": bool(
                            item.get("require_confirmation", False)
                        ),
                        "level": resolved_level,
                    }
                )

            # Pozycje są grupowane według poziomu i wymogu potwierdzenia.
            # Dzięki temu każda encja zachowuje własne ustawienia wiadomości
            # końcowej również w rozbudowanych regułach grupowych.
            resolution_groups: dict[
                tuple[str, bool],
                list[dict[str, Any]],
            ] = {}
            for item in resolved_items:
                group_key = (
                    str(item.get("level", "informacja")),
                    bool(item.get("require_confirmation", False)),
                )
                resolution_groups.setdefault(group_key, []).append(item)

            for (
                resolved_level,
                resolved_requires_confirmation,
            ), group_items in resolution_groups.items():
                bypass_quiet_hours = bool(
                    active.get("bypass_quiet_hours", False)
                )
                if self.quiet(resolved_level, bypass_quiet_hours):
                    continue

                lines = "\n".join(
                    (
                        f"• {item['entity_name']}: {item['message']}"
                        if item["entity_name"]
                        else f"• {item['message']}"
                    )
                    for item in group_items
                )
                phone_options = deepcopy(active.get("phone_options", {}))
                phone_options["show_actions"] = resolved_requires_confirmation
                phone_options["sticky"] = resolved_requires_confirmation
                phone_options["persistent_on_phone"] = (
                    resolved_requires_confirmation
                )
                resolved_active = {
                    "id": f"resolved_{uuid4()}",
                    "kind": "resolved",
                    "title": (
                        f"✅ {rule.get('name', active.get('title', 'Zdarzenie zakończone'))}"
                    ),
                    "message": lines,
                    "level": resolved_level,
                    "category": active.get("category", "Informacyjne"),
                    "recipients": list(active.get("recipients", [])),
                    "require_confirmation": resolved_requires_confirmation,
                    "signal": bool(active.get("signal", False)),
                    "bypass_quiet_hours": bypass_quiet_hours,
                    "phone_options": phone_options,
                    "kiosk_enabled": active.get("kiosk_enabled", True),
                    "kiosk_targets": list(active.get("kiosk_targets", ["*"])),
                    "kiosk_mode": active.get("kiosk_mode", "auto"),
                    "kiosk_duration_seconds": active.get(
                        "kiosk_duration_seconds", 0
                    ),
                    "kiosk_wake": active.get("kiosk_wake", True),
                    "source_entity": (
                        group_items[0].get("entity_name")
                        if len(group_items) == 1
                        else None
                    ),
                    "source_state": "resolved",
                    "created_at": _iso(),
                    "last_sent_at": _iso(),
                }
                if resolved_requires_confirmation or resolved_level == "krytyczne":
                    self.upsert_active(resolved_active)

                await self._send(
                    resolved_active,
                    None,
                    create_persistent_ha=(
                        resolved_requires_confirmation
                        or resolved_level == "krytyczne"
                    ),
                )
                self.history(
                    "wysłano zakończenie",
                    resolved_active["title"],
                    resolved_active["message"],
                    "system",
                    str(resolved_active["level"]),
                )
                resolution_sent = True

        if active and not resolution_sent:
            self.history(
                event,
                active["title"],
                active["message"],
                "system",
                active["level"],
            )

    async def send_manual(
        self,
        raw: dict[str, Any],
        actor: str,
        context: Context | None,
    ) -> dict[str, Any]:
        active_id = f"manual_{uuid4()}"
        recipients = [
            str(item)
            for item in raw.get("recipients", [])
            if str(item) in self.data["settings"]["recipients"]
        ]
        default_recipient = self._default_recipient_name()
        if not recipients and default_recipient:
            recipients = [default_recipient]
        require_confirmation = bool(raw.get("require_confirmation", False))
        level = str(raw.get("level", "informacja"))
        if level not in {"informacja", "zadanie", "ostrzezenie", "krytyczne"}:
            level = "informacja"
        active = {
            "id": active_id,
            "kind": "manual",
            "title": str(raw.get("title", "Powiadomienie"))[:140],
            "message": str(raw.get("message", ""))[:1200],
            "level": level,
            "category": str(raw.get("category", "Informacyjne"))[:80],
            "recipients": recipients,
            "require_confirmation": require_confirmation,
            "signal": bool(raw.get("signal", False)),
            "bypass_quiet_hours": bool(raw.get("bypass_quiet_hours", False)),
            "phone_options": self._sanitize_phone_options(
                raw.get("phone_options"), None, require_confirmation
            ),
            "kiosk_enabled": bool(raw.get("kiosk_enabled", True)),
            "kiosk_targets": self._sanitize_kiosk_targets(
                raw.get("kiosk_targets", ["*"])
            ),
            "kiosk_mode": self._sanitize_kiosk_mode(raw.get("kiosk_mode", "auto")),
            "kiosk_duration_seconds": _to_int(
                raw.get("kiosk_duration_seconds", 0), 0, 0, 86400
            ),
            "kiosk_wake": bool(raw.get("kiosk_wake", True)),
            "source_entity": None,
            "source_state": None,
            "created_at": _iso(),
            "last_sent_at": _iso(),
        }
        if (
            active["require_confirmation"]
            or raw.get("repeat")
            or (active["kiosk_enabled"] and level == "krytyczne")
        ):
            self.upsert_active(active)
            self.data["manual"].append(
                {
                    "id": active_id,
                    "active": True,
                    "repeat": bool(raw.get("repeat", False)),
                    "interval_minutes": _to_int(
                        raw.get("interval_minutes", 60), 60, 1, 10080
                    ),
                    "last_sent": _now(),
                    "snoozed_until": None,
                    "level": level,
                    "bypass_quiet_hours": bool(
                        raw.get("bypass_quiet_hours", False)
                    ),
                }
            )
        await self._send(active, context)
        self.history(
            "wysłano ręcznie",
            active["title"],
            active["message"],
            actor,
            active["level"],
        )
        await self.changed()
        return active

    async def async_ack(self, active_id: str, actor: str, context: Context | None) -> bool:
        active = self._find_active(active_id)
        if not active:
            return False
        self.data["active"].remove(active)
        if active.get("kind") == "rule":
            rule = self._find_rule(active.get("rule_id", ""))
            if rule:
                rule["acknowledged"] = True
                timeout = rule.get("ack_timeout_minutes", 0)
                rule["acknowledged_until"] = _now() + timeout * 60 if timeout else None
        else:
            manual = next((x for x in self.data["manual"] if x.get("id") == active_id), None)
            if manual:
                manual["active"] = False
        await self._clear(active_id, context)
        self.history("potwierdzono", active["title"], active["message"], actor, active["level"])
        await self.changed()
        return True

    async def async_snooze(self, active_id: str, minutes: int, actor: str, context: Context | None) -> bool:
        active = self._find_active(active_id)
        if not active:
            return False
        self.data["active"].remove(active)
        until = _now() + _to_int(minutes, 120, 1, 10080) * 60
        if active.get("kind") == "rule":
            rule = self._find_rule(active.get("rule_id", ""))
            if rule:
                rule["snoozed_until"] = until
                rule["last_sent"] = None
        else:
            manual = next((x for x in self.data["manual"] if x.get("id") == active_id), None)
            if manual:
                manual["snoozed_until"] = until
                manual["last_sent"] = None
        await self._clear(active_id, context)
        self.history(f"odłożono na {minutes} min", active["title"], active["message"], actor, active["level"])
        await self.changed()
        return True

    async def dismiss(self, active_id: str, actor: str, context: Context | None) -> bool:
        active = self._find_active(active_id)
        if not active:
            return False
        self.data["active"].remove(active)
        await self._clear(active_id, context)
        self.history("zamknięto", active["title"], active["message"], actor, active["level"])
        await self.changed()
        return True

    async def _send(
        self,
        active: dict[str, Any],
        context: Context | None,
        create_persistent_ha: bool = True,
    ) -> None:
        settings = self.data["settings"]
        critical = active["level"] == "krytyczne"
        options = self._sanitize_phone_options(
            active.get("phone_options"),
            None,
            bool(active.get("require_confirmation", False)),
        )
        actions = []
        if active.get("require_confirmation") and options.get("show_actions", True):
            actions = [
                {"action": f"MNC_ACK_{active['id']}", "title": "POTWIERDŹ"},
                {"action": f"MNC_SNOOZE_{active['id']}", "title": "ODŁÓŻ 2H"},
                {"action": f"MNC_IGNORE_{active['id']}", "title": "POMIŃ 24H"},
            ]

        phone_message = str(active.get("message", ""))
        if options.get("include_title_in_message") and active.get("title"):
            phone_message = f"{active['title']}\n\n{phone_message}".strip()

        channel = options.get("channel", "auto")
        if not channel or channel == "auto":
            channel = "alarm_stream" if critical else "matrix_notification_center"
        importance = options.get("importance", "auto")
        if importance == "auto":
            importance = "max" if critical else "high"

        open_url = options.get(
            "open_url", "/centrum-powiadomien?tab=powiadomienia"
        )
        notification_data: dict[str, Any] = {
            "tag": self.tag(active["id"]),
            "group": "matrix_notification_center",
            "color": self.color(active["level"]),
            "sticky": bool(options.get("sticky", False)),
            "persistent": bool(options.get("persistent_on_phone", False)),
            "ttl": 0,
            "priority": "high",
            "channel": channel,
            "importance": importance,
            "url": open_url,
            "clickAction": open_url,
            "actions": actions,
            "push": {
                "interruption-level": "critical" if critical else "active",
            },
        }
        if critical:
            notification_data["push"]["sound"] = {
                "name": "default",
                "critical": 1,
                "volume": 1.0,
            }
        if options.get("subtitle"):
            notification_data["subtitle"] = options["subtitle"]
        if options.get("subject"):
            notification_data["subject"] = options["subject"]
        if options.get("vibration_pattern"):
            notification_data["vibrationPattern"] = options["vibration_pattern"]
        if options.get("led_color"):
            notification_data["ledColor"] = options["led_color"]
        if options.get("timeout", 0):
            notification_data["timeout"] = options["timeout"]
        if options.get("image"):
            notification_data["image"] = options["image"]

        payload = {
            "title": active["title"],
            "message": phone_message,
            "data": notification_data,
        }
        for name in active.get("recipients", []):
            cfg = settings["recipients"].get(name, {})
            if cfg.get("enabled") and cfg.get("service"):
                await self.call_notify(cfg["service"], payload, context)
        if (
            active.get("signal")
            and settings.get("signal_enabled")
            and settings.get("signal_service")
        ):
            await self.call_notify(
                settings["signal_service"],
                {"title": active["title"], "message": active["message"]},
                context,
            )
        if create_persistent_ha and settings.get("persistent"):
            await self.hass.services.async_call(
                "persistent_notification",
                "create",
                {
                    "notification_id": self.tag(active["id"]),
                    "title": active["title"],
                    "message": active["message"],
                },
                blocking=False,
                context=context,
            )
        if active.get("kind") != "test":
            await self._publish_kiosk_event(active)

    @staticmethod
    def _level_rank(level: str) -> int:
        return {
            "informacja": 0,
            "zadanie": 1,
            "ostrzezenie": 2,
            "krytyczne": 3,
        }.get(str(level), 0)

    def _kiosk_duration(self, active: dict[str, Any]) -> int:
        configured = _to_int(active.get("kiosk_duration_seconds", 0), 0, 0, 86400)
        if configured:
            return configured
        settings = self.data.get("settings", {})
        level = str(active.get("level", "informacja"))
        key = {
            "informacja": "kiosk_info_duration",
            "zadanie": "kiosk_task_duration",
            "ostrzezenie": "kiosk_warning_duration",
        }.get(level)
        return _to_int(settings.get(key, 0), 0, 0, 86400) if key else 0

    def _kiosk_item(
        self,
        active: dict[str, Any],
        sequence: int = 0,
    ) -> dict[str, Any]:
        """Expose only presentation data safe for an authenticated kiosk."""
        level = str(active.get("level", "informacja"))
        require_confirmation = bool(active.get("require_confirmation", False))
        is_active = self._find_active(str(active.get("id", ""))) is not None
        mode = self._sanitize_kiosk_mode(active.get("kiosk_mode", "auto"))
        if mode == "auto":
            mode = {
                "informacja": "banner",
                "zadanie": "card",
                "ostrzezenie": "card",
                "krytyczne": "fullscreen",
            }.get(level, "banner")
        return {
            "id": str(active.get("id", "")),
            "sequence": sequence,
            "kind": str(active.get("kind", "notification")),
            "title": str(active.get("title", "Powiadomienie"))[:140],
            "message": str(active.get("message", ""))[:1200],
            "level": level,
            "category": str(active.get("category", "Informacyjne"))[:80],
            "created_at": str(active.get("created_at", _iso())),
            "last_sent_at": str(active.get("last_sent_at", _iso())),
            "require_confirmation": require_confirmation,
            "active": is_active,
            "mode": mode,
            "duration_seconds": self._kiosk_duration(active),
            "targets": self._sanitize_kiosk_targets(
                active.get("kiosk_targets", ["*"])
            ),
            "actions": {
                "ack": require_confirmation and is_active,
                "snooze": require_confirmation and is_active,
                "dismiss": is_active,
            },
        }

    def _kiosk_allowed(self, active: dict[str, Any]) -> bool:
        settings = self.data.get("settings", {})
        if not settings.get("kiosk_enabled", True) or not active.get(
            "kiosk_enabled", True
        ):
            return False
        minimum = str(settings.get("kiosk_min_level", "informacja"))
        return self._level_rank(str(active.get("level", "informacja"))) >= self._level_rank(
            minimum
        )

    async def wake_kiosk_entity(self, raw_entity_id: str) -> tuple[bool, str]:
        """Turn on a kiosk screen switch or press a dedicated wake button."""
        entity_id = str(raw_entity_id or "").strip().lower()
        if not entity_id or "." not in entity_id:
            return False, "Wpisz poprawną encję ekranu tabletu."
        domain = entity_id.split(".", 1)[0]
        if domain == "button":
            service_domain, service = "button", "press"
        elif domain in {"sensor", "binary_sensor", "camera", "device_tracker"}:
            return False, f"Encji {entity_id} nie można włączyć ani nacisnąć."
        else:
            service_domain, service = "homeassistant", "turn_on"
        if not self.hass.services.has_service(service_domain, service):
            return False, f"Brak usługi {service_domain}.{service} dla {entity_id}."
        try:
            await self.hass.services.async_call(
                service_domain,
                service,
                {"entity_id": entity_id},
                blocking=True,
            )
        except Exception as err:  # Home Assistant integrations expose varied errors.
            _LOGGER.warning("Could not wake kiosk through %s: %s", entity_id, err)
            return False, f"Nie udało się wybudzić tabletu przez {entity_id}."
        return True, f"Wysłano wybudzenie przez {entity_id}."

    async def _publish_kiosk_event(self, active: dict[str, Any]) -> None:
        if not self._kiosk_allowed(active):
            return
        self._kiosk_sequence += 1
        item = self._kiosk_item(active, self._kiosk_sequence)
        self._kiosk_events.insert(0, item)
        del self._kiosk_events[50:]
        self.hass.bus.async_fire(
            UPDATE_EVENT,
            {
                "sequence": self._kiosk_sequence,
                "level": item["level"],
                "active_count": len(self.data.get("active", [])),
            },
        )
        settings = self.data.get("settings", {})
        wake_entity = str(settings.get("kiosk_wake_entity", "")).strip()
        if (
            settings.get("kiosk_wake_enabled", False)
            and active.get("kiosk_wake", True)
            and wake_entity
        ):
            success, message = await self.wake_kiosk_entity(wake_entity)
            if not success:
                _LOGGER.warning("Kiosk wake request failed: %s", message)

    @staticmethod
    def _matches_kiosk_profile(item: dict[str, Any], profile: str) -> bool:
        profile = str(profile or "default").strip().lower()
        targets = {str(value).strip().lower() for value in item.get("targets", ["*"])}
        return bool({"*", "all", "wszystkie"} & targets) or profile in targets

    def kiosk_snapshot(self, profile: str) -> dict[str, Any]:
        active = [
            self._kiosk_item(item)
            for item in self.data.get("active", [])
            if self._kiosk_allowed(item)
        ]
        events = list(self._kiosk_events)
        return {
            "bridge_version": 1,
            "sequence": self._kiosk_sequence,
            "enabled": bool(self.data.get("settings", {}).get("kiosk_enabled", True)),
            "active": [
                item for item in active if self._matches_kiosk_profile(item, profile)
            ],
            "events": [
                item for item in events if self._matches_kiosk_profile(item, profile)
            ],
        }

    async def _clear(self, active_id: str, context: Context | None) -> None:
        tag = self.tag(active_id)
        for cfg in self.data["settings"]["recipients"].values():
            if cfg.get("service"):
                await self.call_notify(cfg["service"], {"message": "clear_notification", "data": {"tag": tag}}, context, True)
        if self.hass.services.has_service("persistent_notification", "dismiss"):
            await self.hass.services.async_call(
                "persistent_notification", "dismiss", {"notification_id": tag}, blocking=False, context=context
            )

    async def call_notify(self, full_service: str, data: dict[str, Any], context: Context | None, ignore: bool = False) -> None:
        full_service = str(full_service).strip()
        if not full_service.startswith("notify."):
            if not ignore:
                _LOGGER.warning("Unsupported notification service: %s", full_service)
            return
        domain, service = full_service.split(".", 1)
        if not self.hass.services.has_service(domain, service):
            if not ignore:
                _LOGGER.warning("Missing notify service: %s", full_service)
            return
        await self.hass.services.async_call(domain, service, data, blocking=False, context=context)

    def history(self, event: str, title: str, message: str, actor: str, level: str) -> None:
        self.data["history"].insert(
            0,
            {"id": str(uuid4()), "timestamp": _iso(), "event": event, "title": title, "message": message, "actor": actor, "level": level},
        )
        del self.data["history"][300:]

    async def clear_history(self, actor: str) -> int:
        """Remove the complete notification history.

        Rules, active notifications and manual notifications are preserved.
        The action itself is intentionally not written back to history,
        otherwise the list would never be completely empty.
        """
        removed = len(self.data.get("history", []))
        self.data["history"] = []
        _LOGGER.info(
            "Matrix Notification Center history cleared by %s; removed %s entries",
            actor,
            removed,
        )
        await self.changed()
        return removed

    async def update_settings(
        self,
        raw: dict[str, Any],
        actor: str,
    ) -> dict[str, Any]:
        settings = self.data["settings"]
        for key in (
            "enabled",
            "persistent",
            "signal_enabled",
            "quiet_enabled",
            "kiosk_enabled",
            "kiosk_wake_enabled",
        ):
            if key in raw:
                settings[key] = bool(raw[key])
        for key in (
            "quiet_start",
            "quiet_end",
            "signal_service",
            "kiosk_wake_entity",
        ):
            if key in raw:
                settings[key] = str(raw[key])[:180]
        if "kiosk_min_level" in raw:
            level = str(raw["kiosk_min_level"])
            if level in {"informacja", "zadanie", "ostrzezenie", "krytyczne"}:
                settings["kiosk_min_level"] = level
        for key in (
            "kiosk_info_duration",
            "kiosk_task_duration",
            "kiosk_warning_duration",
        ):
            if key in raw:
                settings[key] = _to_int(raw[key], 0, 0, 86400)
        if isinstance(raw.get("recipients"), dict):
            new_recipients = self._sanitize_recipients_map(raw["recipients"])
            if new_recipients:
                settings["recipients"] = new_recipients
                self.data["rules"] = [
                    self._sanitize_rule(rule, rule)
                    for rule in self.data.get("rules", [])
                    if isinstance(rule, dict)
                ]
                self._reindex()
        self.history(
            "zmieniono ustawienia",
            "Ustawienia systemu",
            "",
            actor,
            "informacja",
        )
        await self.changed()
        return deepcopy(settings)

    async def test_service(
        self,
        service: str,
        name: str,
        context: Context | None,
    ) -> bool:
        service = str(service).strip()
        if (
            not service.startswith("notify.")
            or not self.service_exists(service)
        ):
            return False
        title = "✅ Test Centrum Powiadomień"
        await self.call_notify(
            service,
            {
                "title": title,
                "message": f"{title}\n\nKanał {name or service} działa poprawnie.",
                "data": {
                    "tag": f"mnc_test_{uuid4().hex[:8]}",
                    "channel": "matrix_notification_center",
                    "importance": "high",
                    "ttl": 0,
                    "priority": "high",
                    "url": "/centrum-powiadomien?tab=powiadomienia",
                    "clickAction": "/centrum-powiadomien?tab=powiadomienia",
                },
            },
            context,
        )
        return True

    async def test_recipient(
        self,
        name: str,
        context: Context | None,
    ) -> bool:
        service = (
            self.data["settings"].get("signal_service")
            if name == "Signal"
            else self.data["settings"]["recipients"].get(name, {}).get("service")
        )
        return await self.test_service(str(service or ""), name, context)

    def _rule_notification_content(
        self,
        rule: dict[str, Any],
    ) -> tuple[str, str, str, list[dict[str, Any]], list[dict[str, Any]], bool]:
        met, summary, details = self.condition(rule)
        matched = self._matched_entity_details(details)
        first = self._first_entity_condition(rule.get("conditions")) or {}
        first_entity = (
            matched[0]["entity_id"] if matched else str(first.get("entity_id", ""))
        )
        first_state = self.hass.states.get(first_entity) if first_entity else None
        current = (
            matched[0]["state"]
            if matched
            else first_state.state if first_state else summary
        )
        title = self.render(rule["title"], rule, current, summary, matched)
        message_template = rule["message"]
        message = self.render(
            message_template, rule, current, summary, matched
        ) or summary
        entity_details = [
            detail for detail in details if detail.get("type") == "entity"
        ]
        message = self._append_condition_descriptions(
            message,
            message_template,
            rule,
            matched,
            entity_details,
        )
        return title, message, summary, details, matched, met

    async def send_test_draft(
        self,
        raw: dict[str, Any],
        recipient: str,
        context: Context | None,
    ) -> dict[str, Any]:
        if recipient not in self.data["settings"]["recipients"]:
            return {"success": False, "error": "Nieznany odbiorca"}
        rule = self._sanitize_rule(raw)
        title, message, summary, details, matched, met = self._rule_notification_content(rule)
        active = {
            "id": f"preview_{uuid4()}",
            "kind": "test",
            "title": title or "Test powiadomienia",
            "message": message or "Test powiadomienia z kreatora.",
            "level": rule["level"],
            "category": rule["category"],
            "recipients": [recipient],
            "require_confirmation": rule["require_confirmation"],
            "signal": False,
            "phone_options": deepcopy(rule.get("phone_options", {})),
            "source_entity": matched[0]["entity_id"] if matched else None,
            "source_state": matched[0]["state"] if matched else summary,
            "created_at": _iso(),
            "last_sent_at": _iso(),
        }
        await self._send(active, context, create_persistent_ha=False)
        return {
            "success": True,
            "condition_met": met,
            "summary": summary,
            "details": details,
            "recipient": recipient,
        }

    async def snapshot(self, user: Any) -> dict[str, Any]:
        admin = self.is_center_admin(user)
        result = {
            "active": deepcopy(self.data["active"]),
            "history": deepcopy(self.data["history"][:100]),
            "is_admin": admin,
            "current_user": {
                "id": str(getattr(user, "id", "")),
                "name": str(getattr(user, "name", "") or ""),
                "is_ha_admin": bool(getattr(user, "is_admin", False)),
                "is_center_admin": admin,
            },
            "diagnostics": self.diagnostics(),
        }
        if admin:
            result["rules"] = deepcopy(self.data["rules"])
            result["settings"] = deepcopy(self.data["settings"])
            result["ha_users"] = await self.available_ha_users()
        return result

    def diagnostics(self) -> dict[str, Any]:
        services = {}
        for name, cfg in self.data["settings"]["recipients"].items():
            services[name] = self.service_exists(cfg.get("service", ""))
        services["Signal"] = self.service_exists(self.data["settings"].get("signal_service", ""))
        return {
            "started_at": self.started_at,
            "last_run": self.last_run,
            "last_error": self.last_error,
            "rules": len(self.data["rules"]),
            "enabled_rules": sum(1 for x in self.data["rules"] if x.get("enabled")),
            "active": len(self.data["active"]),
            "history": len(self.data["history"]),
            "services": services,
        }

    def service_exists(self, full: str) -> bool:
        if "." not in full:
            return False
        domain, service = full.split(".", 1)
        return self.hass.services.has_service(domain, service)

    @staticmethod
    def tag(active_id: str) -> str:
        return "mnc_" + "".join(x if x.isalnum() or x in "_-" else "_" for x in active_id)

    @staticmethod
    def color(level: str) -> str:
        return {"krytyczne": "#ff315c", "ostrzezenie": "#ff9f1c", "zadanie": "#35ff9a"}.get(level, "#20eaff")


class BaseView(HomeAssistantView):
    requires_auth = True

    @staticmethod
    def manager(request: web.Request) -> NotificationManager:
        domain_data = request.app[KEY_HASS].data.get(DOMAIN, {})
        manager = domain_data.get(DATA_MANAGER)
        if manager is None:
            raise web.HTTPServiceUnavailable(
                text="Matrix Notification Center is not configured"
            )
        return manager

    @classmethod
    def center_admin_user(cls, request: web.Request) -> Any:
        user = request[KEY_HASS_USER]
        if not cls.manager(request).is_center_admin(user):
            raise web.HTTPForbidden(
                text="Brak uprawnień administratora Centrum Powiadomień"
            )
        return user


class StateView(BaseView):
    url = "/api/matrix_notification_center/state"
    name = "api:matrix_notification_center:state"

    async def get(self, request: web.Request) -> web.Response:
        user = request[KEY_HASS_USER]
        return self.json(await self.manager(request).snapshot(user))


class KioskView(BaseView):
    url = "/api/matrix_notification_center/kiosk"
    name = "api:matrix_notification_center:kiosk"

    async def get(self, request: web.Request) -> web.Response:
        return self.json(
            self.manager(request).kiosk_snapshot(request.query.get("profile", "default"))
        )


class RulesView(BaseView):
    url = "/api/matrix_notification_center/rules"
    name = "api:matrix_notification_center:rules"

    async def post(self, request: web.Request) -> web.Response:
        body = await request.json()
        user = self.center_admin_user(request)
        rule = await self.manager(request).save_rule(body, user.name or user.id)
        return self.json(rule)


class RuleView(BaseView):
    url = "/api/matrix_notification_center/rules/{rule_id}"
    name = "api:matrix_notification_center:rule"

    async def delete(self, request: web.Request, rule_id: str) -> web.Response:
        user = self.center_admin_user(request)
        ok = await self.manager(request).delete_rule(rule_id, user.name or user.id)
        return self.json({"success": ok}, HTTPStatus.OK if ok else HTTPStatus.NOT_FOUND)


class RuleActionView(BaseView):
    url = "/api/matrix_notification_center/rules/{rule_id}/{action}"
    name = "api:matrix_notification_center:rule_action"

    async def post(self, request: web.Request, rule_id: str, action: str) -> web.Response:
        user = self.center_admin_user(request)
        body = await request.json() if request.can_read_body else {}
        if action == "toggle":
            ok = await self.manager(request).toggle_rule(rule_id, bool(body.get("enabled")), user.name or user.id)
            return self.json({"success": ok})
        if action == "test":
            rule = self.manager(request)._find_rule(rule_id)
            if not rule:
                return self.json_message("Rule not found", HTTPStatus.NOT_FOUND)
            met, summary, details = self.manager(request).condition(rule)
            return self.json({"condition_met": met, "current_state": summary, "summary": summary, "details": details})
        return self.json_message("Unknown action", HTTPStatus.BAD_REQUEST)


class ManualView(BaseView):
    url = "/api/matrix_notification_center/manual"
    name = "api:matrix_notification_center:manual"

    async def post(self, request: web.Request) -> web.Response:
        user = self.center_admin_user(request)
        active = await self.manager(request).send_manual(await request.json(), user.name or user.id, self.context(request))
        return self.json(active)


class ActiveActionView(BaseView):
    url = "/api/matrix_notification_center/active/{active_id}/{action}"
    name = "api:matrix_notification_center:active_action"

    async def post(self, request: web.Request, active_id: str, action: str) -> web.Response:
        user = request[KEY_HASS_USER]
        body = await request.json() if request.can_read_body else {}
        if action == "ack":
            ok = await self.manager(request).async_ack(active_id, user.name or user.id, self.context(request))
        elif action == "snooze":
            ok = await self.manager(request).async_snooze(active_id, _to_int(body.get("minutes", 120), 120, 1, 10080), user.name or user.id, self.context(request))
        elif action == "dismiss":
            ok = await self.manager(request).dismiss(active_id, user.name or user.id, self.context(request))
        else:
            return self.json_message("Unknown action", HTTPStatus.BAD_REQUEST)
        return self.json({"success": ok})


class SettingsView(BaseView):
    url = "/api/matrix_notification_center/settings"
    name = "api:matrix_notification_center:settings"

    async def post(self, request: web.Request) -> web.Response:
        user = self.center_admin_user(request)
        settings = await self.manager(request).update_settings(await request.json(), user.name or user.id)
        return self.json(settings)


class UtilityView(BaseView):
    url = "/api/matrix_notification_center/{action}"
    name = "api:matrix_notification_center:utility"

    async def post(self, request: web.Request, action: str) -> web.Response:
        user = self.center_admin_user(request)
        body = await request.json() if request.can_read_body else {}
        if action == "clear_history":
            removed = await self.manager(request).clear_history(
                user.name or user.id
            )
            return self.json(
                {
                    "success": True,
                    "removed": removed,
                }
            )
        if action == "evaluate":
            await self.manager(request).async_evaluate()
            return self.json({"success": True})
        if action == "test_draft":
            temporary = self.manager(request)._sanitize_rule(body)
            met, summary, details = self.manager(request).condition(temporary)
            return self.json(
                {
                    "condition_met": met,
                    "summary": summary,
                    "details": details,
                }
            )
        if action == "send_test_draft":
            result = await self.manager(request).send_test_draft(
                body.get("draft", {}),
                str(body.get("recipient", "")),
                self.context(request),
            )
            return self.json(result)
        if action == "test_service":
            ok = await self.manager(request).test_service(
                str(body.get("service", "")),
                str(body.get("name", "")),
                self.context(request),
            )
            return self.json({"success": ok})
        if action == "test_kiosk_wake":
            success, message = await self.manager(request).wake_kiosk_entity(
                str(body.get("entity_id", ""))
            )
            return self.json({"success": success, "message": message})
        if action == "test_recipient":
            ok = await self.manager(request).test_recipient(
                str(body.get("recipient", "")), self.context(request)
            )
            return self.json({"success": ok})
        return self.json_message("Unknown action", HTTPStatus.BAD_REQUEST)


type MatrixNotificationCenterConfigEntry = ConfigEntry[NotificationManager]


async def async_setup(hass: HomeAssistant, _config: dict[str, Any]) -> bool:
    """Register shared HTTP resources."""
    domain_data = hass.data.setdefault(
        DOMAIN,
        {
            DATA_MANAGER: None,
            DATA_HTTP_REGISTERED: False,
            DATA_PANEL_REGISTERED: False,
        },
    )

    if not domain_data[DATA_HTTP_REGISTERED]:
        frontend_dir = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(frontend_dir), False)]
        )
        for view in (
            StateView,
            KioskView,
            RulesView,
            RuleView,
            RuleActionView,
            ManualView,
            ActiveActionView,
            SettingsView,
            UtilityView,
        ):
            hass.http.register_view(view)
        domain_data[DATA_HTTP_REGISTERED] = True

    return True


async def async_setup_entry(
    hass: HomeAssistant,
    entry: MatrixNotificationCenterConfigEntry,
) -> bool:
    """Set up Matrix Notification Center from a config entry."""
    domain_data = hass.data[DOMAIN]
    manager = NotificationManager(hass)
    await manager.async_load()
    await manager.async_start()

    entry.runtime_data = manager
    domain_data[DATA_MANAGER] = manager

    if not frontend.async_panel_exists(hass, PANEL_URL):
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_URL,
            webcomponent_name="matrix-notification-center-panel",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            module_url=f"{STATIC_URL}/panel.js?v={VERSION}",
            require_admin=False,
        )
        domain_data[DATA_PANEL_REGISTERED] = True
    else:
        domain_data[DATA_PANEL_REGISTERED] = False
        _LOGGER.warning(
            "Panel path '%s' is already registered. Remove the old panel_custom "
            "entry from configuration.yaml to let the integration manage it.",
            PANEL_URL,
        )

    async def handle_send(call: ServiceCall) -> None:
        await manager.send_manual(
            dict(call.data),
            call.context.user_id or "service",
            call.context,
        )

    async def handle_evaluate(_call: ServiceCall) -> None:
        await manager.async_evaluate()

    hass.services.async_register(DOMAIN, SERVICE_SEND, handle_send)
    hass.services.async_register(DOMAIN, SERVICE_EVALUATE, handle_evaluate)
    return True


async def async_unload_entry(
    hass: HomeAssistant,
    entry: MatrixNotificationCenterConfigEntry,
) -> bool:
    """Unload Matrix Notification Center."""
    manager = entry.runtime_data
    await manager.async_stop()

    domain_data = hass.data.get(DOMAIN, {})
    if domain_data.get(DATA_PANEL_REGISTERED):
        frontend.async_remove_panel(hass, PANEL_URL, warn_if_unknown=False)
        domain_data[DATA_PANEL_REGISTERED] = False

    for service in (SERVICE_SEND, SERVICE_EVALUATE):
        if hass.services.has_service(DOMAIN, service):
            hass.services.async_remove(DOMAIN, service)

    domain_data[DATA_MANAGER] = None
    return True
