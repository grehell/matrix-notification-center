# Privacy

Matrix Notification Center is local-first.

## Repository

The source repository must not contain personal names, real entity IDs, Home
Assistant user IDs, local network addresses, notify services copied from an
installation, passwords, tokens or encryption keys.

The bundled recipient list is empty. Signal support is disabled and has no
default service.

## Runtime

Rules, message text, history, recipients and settings are stored in Home
Assistant's local `.storage` directory. They are not sent to the project
maintainer.

## Network access

The integration contains no telemetry and does not call an external project
API. It invokes only Home Assistant services selected by the local
administrator.

## Diagnostics

Diagnostics contain only the integration version, enabled feature flags and
item counts. They exclude all notification contents and identifiers.
