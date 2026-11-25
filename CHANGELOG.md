# Changelog

All notable changes to the Forum Fortress NodeBB plugin are documented here.

## 1.0.7 - 2026-11-25

- Clarify the public package description and link directly to the platform, installation guide and support pages.

## 1.0.6 - 2026-11-25

- Report the visitor IP automatically behind reverse proxies that forward it.
- Send post and topic identifiers as strings so content checks reach the API.

## 1.0.5 - Unreleased

- Reuse one registration decision across repeated callbacks for the same native signup.
- Keep the same registration check ID during endpoint failover.

## 1.0.4 - 2026-10-14

- Require three cleanup-certified BLOCKs scoring 80 or above within 24 hours
  and at most five member posts before the cleanup mode applies a ban and
  cleans eligible content. The existing ban-only threshold is unchanged.
- Use a separate cleanup evidence window and revalidate the five-post cap in
  the background worker.
- Add the cleanup-specific server advisory to NodeBB's response handling.
- Preserve JSON cleanup receipts across native database workers and clear
  pending intent explicitly so interruption/restoration retries remain safe.
- Require the matching native ban history entry and expiry before cleanup;
  preserve topic starters, replacement bans and guest-unreadable content.
- Allow queue/lease failures before native ban writes to retry safely and verify
  actual NodeBB 4.16.2 lifecycle, public upgrade and concurrent cron workers.

## 1.0.3 - Unreleased (included in 1.0.4)

- Add an opt-in seven-day ban and background cleanup mode for eligible repeat
  spammers. Cleanup uses NodeBB's reversible per-post moderation API and keeps
  public posts by other members intact.
- Exclude private topics, profile fields, posts with uncertain ownership, and
  content in categories not readable by guests. Keep background batches bounded
  and retain durable cleanup receipts for safe retries.
- Preserve Off as the default and existing ban-only settings on upgrades.
- Add ACP guidance and cleanup worker regression coverage.

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
