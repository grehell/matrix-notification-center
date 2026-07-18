# Changelog

## 1.5.0

- Added an authenticated local kiosk bridge for Matrix Energy Center 8.1.0.
- Added privacy-safe kiosk snapshots and real-time update events without
  exposing recipients, source entities or administrative settings.
- Added per-rule and manual-message kiosk targets, presentation mode, duration
  and optional wake behavior.
- Added global kiosk severity, duration and Home Assistant screen-entity
  settings.
- Added synchronized acknowledge, snooze and dismiss actions for kiosk cards.
- Critical kiosk messages now remain active until an explicit action.

## 1.4.2

- Added an independent severity level for each resolution notification.
- Resolution level can inherit the main notification or use information,
  task, warning or critical severity.
- Grouped rules split resolution messages by severity and confirmation mode.
- Critical resolution notifications use critical delivery and bypass quiet hours.
- Existing rules automatically default to the main notification level.

## 1.4.1

- Added optional confirmation for per-entity resolution notifications.
- Confirmable resolution messages are shown in the active notification queue.
- Added mobile actions for acknowledge, snooze and ignore.
- Confirmable resolution messages create a Home Assistant persistent notification.
- Existing rules are migrated automatically with confirmation disabled.

## 1.4.0

- Converted the project into a HACS-compatible integration repository.
- Added config flow and single-instance protection.
- Added automatic sidebar panel registration.
- Removed the need for YAML and manual `panel_custom` configuration.
- Removed every bundled personal recipient and notify service.
- Added privacy-safe diagnostics and local brand images.
- Added HACS and hassfest validation workflows.
- Kept the existing storage key for migration from manual versions.
