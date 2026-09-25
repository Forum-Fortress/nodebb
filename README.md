# Forum Fortress for NodeBB

Forum Fortress adds cloud-based spam and abuse protection to NodeBB 4.16 and
later 4.x releases. The
plugin checks supported local forum actions before NodeBB writes them and
enforces `allow`, `review`, and `block` decisions from the Forum Fortress API.

The npm package is `nodebb-plugin-forum-fortress`; public source and issues are
maintained in the official `Forum-Fortress/nodebb` repository.

## Compatibility

- NodeBB 4.16+ (tested against NodeBB 4.16; compatibility range is limited to
  NodeBB 4.x)
- Node.js 22 or newer, matching current NodeBB 4.x requirements
- Outbound HTTPS access to Forum Fortress

## Install

From the NodeBB root:

```bash
npm install nodebb-plugin-forum-fortress@1.0.0 --save
./nodebb activate nodebb-plugin-forum-fortress
./nodebb build
./nodebb restart
```

The plugin can also be installed and activated from **ACP > Extend > Plugins**
after it is published to npm and accepted by the NodeBB package registry.

After activation, open **ACP > Plugins > Forum Fortress**. Bootstrap is
automatic and anonymous: the plugin persists the returned site ID and API key
in NodeBB's native `meta.settings` store. An outage during bootstrap does not
prevent NodeBB from starting; the next protected request, status refresh, or
scheduled heartbeat retries it. A recovery token is stored during bootstrap so
a response lost after remote site creation can be recovered safely.

## Configuration

The ACP page exposes:

- protection enable/disable;
- Global, UK, EU, or US API routing;
- optional global emergency fallback for a regional configuration;
- optional manually supplied site API key and registration email;
- explicit site registration/re-linking from the saved registration email;
- per-request timeout, fail-open behavior, and debug logging.

The API key is never included in ACP status responses or plugin logs. GET
credentials are sent in the `X-FF-Key` header rather than a URL query string.
Production endpoints are HTTPS-only and are fixed to the Forum Fortress global
and regional hostnames; administrators cannot enter arbitrary endpoints.

## Checked activity

The plugin uses blocking NodeBB filters, so checks run before the relevant
NodeBB persistence operation:

- `filter:register.check` -> `register` for native HTTP registrations;
- `filter:post.create` -> `topic` for an initial topic post, or `reply` for a
  reply;
- `filter:post.edit` -> `topic` or `reply` with `action: "edit"`;
- `filter:user.updateProfile` -> `profile` for username, full name, signature,
  or about-me changes.

Topic checks send `title + blank line + body`; reply checks send the body. HTTP
and HTTPS links are extracted, deduplicated, and filtered so the forum's own
hostname and subdomains are not sent as external links. Passwords, password
hashes, sessions, cookies, CSRF tokens, OAuth tokens, private messages, and
unrelated profile fields are not sent.

Review decisions follow the Flarum integration's v1 behavior and are allowed.
NodeBB does not currently expose a clean, supported native approval-queue API
that maps to Flarum's moderation bridge, so moderation synchronization is
intentionally not included in this release.

## ActivityPub safety

Incoming federation content is excluded. The plugin skips NodeBB events marked
with ActivityPub metadata and events containing URI-style remote user, topic,
post, or parent-post IDs. Local registered users and ordinary local guest
posting remain eligible for checks. Administrator actions are identified with
NodeBB's `user.isAdministrator` API and bypass protection checks.

IP and User-Agent values come from NodeBB's hook request context. The plugin
uses NodeBB's configured proxy handling (`req.ip`); it does not parse or trust
`X-Forwarded-For` itself. When no reliable context is available, the field is
omitted.

## Fail-open and routing

The default is fail-open, matching the Flarum integration: a Forum Fortress
transport failure, timeout, malformed response, or unavailable bootstrap does
not block the local action. If fail-open is disabled, the action is rejected
with a translated temporary-unavailability error. An invalid decision is
treated as unavailable, never as an implicit allow.

Check traffic follows the selected region, with optional global fallback. The
client uses a one-second per-endpoint check timeout and a five-second total
check budget. Portal, Attack Mode, and deprovision use the global control plane
at `api.ffapi.net`; registration, heartbeats, site status, forum stats,
capabilities, and protection checks follow the selected regional routing policy.

## Attack Mode, Portal, and heartbeat

The ACP provides connection test, portal launch, Attack Mode start/end, and
manual synchronization. The plugin registers a ten-minute job with NodeBB's
built-in cron facility. NodeBB's job runner owns which process runs scheduled
jobs; an in-process due-time gate limits normal plans to approximately hourly
heartbeats and Pro/MultiMod plans to ten minutes. No `setInterval` is used.

## Disconnect and removal

Disabling or uninstalling the plugin does not automatically delete the remote
Forum Fortress site. NodeBB's deactivation hook is not awaited by core, so the
plugin deliberately does not use it for remote cleanup. While the plugin is
active, an administrator can use **Disconnect and remove site** in the ACP.
That explicit action calls the Forum Fortress deprovision API, clears local
identity only after confirmed success, and pauses automatic bootstrap. If it
fails, identity is retained so the operation can be retried or handled with
support.

## Backend requirement

The plugin uses the public generic bootstrap contract used by the live Forum
Fortress control plane:

```text
POST /v1/site/bootstrap
```

The request includes `platform: "nodebb"`, the actual NodeBB version, and this
plugin version. The response must return the normal site `api_key` and
`site_id` identity fields. If a deployment exposes the newer dedicated
`/v1/site/nodebb/bootstrap` route instead, the plugin retries that route after
a generic-route `404`. It never falls back to the Flarum bootstrap route.

## Troubleshooting

1. Confirm the plugin is active and rebuild NodeBB assets after installation.
2. Open the Forum Fortress ACP page and run **Refresh** and **Connection test**.
3. Check the NodeBB log with debug logging enabled; API keys are redacted.
4. Confirm outbound HTTPS access to `api.ffapi.net` and the selected regional
   hostname.
5. If the backend reports an unknown bootstrap route, deploy
   `/v1/site/nodebb/bootstrap` before retrying **Synchronize now**.
6. Contact [Forum Fortress support](https://forumfortress.com/#support) and
   include the sanitized error, selected region, and NodeBB/plugin versions.

## Links

- [Forum Fortress documentation](https://forumfortress.com/docs/)
- [NodeBB installation documentation](https://docs.nodebb.org/)
- [Service status](https://status.forumfortress.com/)
- [Support](https://forumfortress.com/#support)
- [Source and issues](https://github.com/Forum-Fortress/nodebb)

## Licence

Forum Fortress for NodeBB is licensed under the GNU General Public License,
version 2 or later (`GPL-2.0-or-later`). The hosted Forum Fortress service is
separate and governed by its service terms.
