# Matrix Notification Center

A local, full-screen notification center for Home Assistant with nested rules,
group conditions, acknowledgements, quiet hours, critical notifications,
notification history and a Matrix-style interface.

> **Privacy:** this repository contains no user names, entity IDs, notify
> services, IP addresses, tokens or settings copied from a Home Assistant
> installation. Recipients are added locally after setup.

## Features

- Automatic sidebar panel.
- Installation through Home Assistant's user interface.
- Nested `AND`, `OR`, `NONE`, `XOR`, majority and N-of-M condition groups.
- Per-condition event and resolution descriptions.
- Group notifications listing only matched entities.
- Manual sends and draft tests to a selected recipient.
- Android and iOS display options.
- Critical notifications, acknowledgement, snooze and repeat handling.
- Authenticated local bridge for Matrix Energy Center kiosk panels.
- Per-rule kiosk targets, banner/card/fullscreen presentation and display time.
- Optional tablet wake-up through a Home Assistant screen entity.
- Quiet hours with a per-rule bypass.
- Local rules, history and settings.
- Privacy-safe diagnostics.
- No project cloud, telemetry or external data collection.

## Prepare the public repository

Replace `grehell` with your public GitHub username:

```bash
python tools/prepare_repository.py --owner grehell
```

Create a public GitHub repository named `matrix-notification-center` and upload all
contents of this directory to its root.

Recommended repository metadata:

- Description: `Local advanced notification center for Home Assistant`
- Topics: `home-assistant`, `hacs`, `notifications`, `custom-integration`
- Issues: enabled

Create release `v1.5.1` after the validation workflows pass.

## Install through HACS

1. In HACS open the three-dot menu.
2. Select **Custom repositories**.
3. Add the GitHub URL and select **Integration**.
4. Download Matrix Notification Center.
5. Restart Home Assistant.
6. Open **Settings → Devices & services → Add integration**.
7. Add **Matrix Notification Center**.
8. Open **Centrum Powiadomień** from the sidebar.
9. Add recipients and their `notify.*` services in the panel settings.

No `matrix_notification_center:` or `panel_custom:` YAML is required.

## Matrix Energy Center kiosk bridge

When Matrix Energy Center 8.1.2 or newer is installed, its kiosk view detects
this integration automatically. No IP address, token, Browser Mod or iframe is
needed. Both panels use the current authenticated Home Assistant session.

In **Centrum Powiadomień → Ustawienia → Panel kiosku** you can enable the
bridge, set the minimum severity, default display times and enter either a
screen switch such as `switch.tablet_screen` or a dedicated wake entity such as
`button.tablet_screen_on`. Version 1.5.1 wakes the configured entity for every
kiosk message and provides a test button in the same settings card. Every rule
can target all kiosks with `*` or selected profile IDs such as `salon` and
`kuchnia`.

Presentation defaults are:

- information: top banner,
- task and warning: centered card,
- critical: blocking full-screen alarm until an action is performed.

Acknowledgement, two-hour snooze and dismissal are sent back to this
integration, so the notification state remains identical on the phone, kiosk
and Notification Center panel.

## Migration from a manual version

The integration keeps the same local storage key:

```text
/config/.storage/matrix_notification_center
```

Existing rules, history and settings are preserved. Remove the old top-level
`matrix_notification_center:` YAML block and only the Matrix Notification
Center item from `panel_custom:`. Do not delete `.storage`.

## Service example

```yaml
action: matrix_notification_center.send
data:
  title: "Appliance"
  message: "The cycle has finished."
  recipients:
    - Phone
```

```yaml
action: matrix_notification_center.evaluate
```

## Privacy

All runtime data stays inside Home Assistant. Diagnostics exclude message text,
entity IDs, recipients, Home Assistant user IDs and notify service names.

See [PRIVACY.md](PRIVACY.md).

## License

MIT
