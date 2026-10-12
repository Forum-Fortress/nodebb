# Changelog

All notable changes to the Forum Fortress NodeBB plugin are documented here.

## 1.0.2 - 2026-10-12

- Add opt-in, default-off seven-day native bans after two distinct high-confidence
  spam BLOCKs above score 80 within 24 hours.
- Local expiring counters, retry deduplication, staff exemption and safe actor
  attribution. No new HTTP calls or changes for existing installations.
- Include ACP controls, automated tests and updated documentation.

## 1.0.1 - 2026-09-25

- Updated the NodeBB package catalogue description.

## 1.0.0 - 2026-09-25

- Initial production NodeBB 4.x integration.
- Added registration, topic, reply, edit, and profile checks.
- Added fail-open/fail-closed handling, regional routing, recovery bootstrap,
  endpoint state, heartbeat, portal, Attack Mode, and connection controls.
- Added a shared NodeBB database lease to coordinate concurrent bootstrap
  across workers.
- Added ActivityPub/federated-content exclusion and native ACP settings/status.
- Preserved an administrator's disabled/disconnected state during dashboard and
  connection reads.
- Validated service, usage, and Attack Mode responses before treating actions
  as successful.
- Serialized ACP service actions and improved ACP heading and dismiss-label
  accessibility.
- Documented the required `/v1/site/nodebb/bootstrap` backend capability.
- Released under `GPL-2.0-or-later`.
