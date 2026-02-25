# Data Feed Research + Scaffold Plan

## Scope

Design a non-disruptive data feed for the intent computer so activity outside the markdown vault can be captured as structured inbox inputs.

This pass is additive only:

- no hook rewiring
- no behavior changes to existing plugin runtime
- scaffold interfaces and a local Chrome connector

## Key research constraints (official sources)

### Browser history (local-only)

- Chrome user data lives in profile directories under the browser user data directory; on macOS default Chrome path is `~/Library/Application Support/Google/Chrome` with profile subdirectories like `Default`.
  - Source: <https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md>
- Chrome history schema is SQLite-backed with `urls` and `visits` tables (and `visit_source`) in Chromium source.
  - Source: <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/history/core/browser/url_database.cc?format=TEXT>
  - Source: <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/history/core/browser/visit_database.cc?format=TEXT>
- For safe reads on hot SQLite files, URI modes support read-only and immutable options (`mode=ro`, `immutable=1`); these semantics matter when reading while Chrome is running.
  - Source: <https://www.sqlite.org/uri.html>

### Gmail incremental sync

- Gmail sync model is explicitly full sync first, then partial sync using `historyId` (`users.history.list`).
  - Source: <https://developers.google.com/workspace/gmail/api/guides/sync>
- Push model uses `users.watch` with Pub/Sub, includes expirations, and should be renewed (daily recommended).
  - Source: <https://developers.google.com/workspace/gmail/api/guides/push>

### Microsoft 365 / Outlook incremental sync

- Graph delta query lifecycle requires following `@odata.nextLink` pages until `@odata.deltaLink`, then persisting delta link/token.
  - Source: <https://learn.microsoft.com/en-us/graph/delta-query-overview>
  - Source: <https://learn.microsoft.com/en-us/graph/api/message-delta>
- Delta can return `410 Gone` requiring sync reset/full resync.
  - Source: <https://learn.microsoft.com/en-us/graph/delta-query-overview>

### Generic IMAP

- IMAP UID semantics (`UIDVALIDITY`, `UIDNEXT`, UID fetch/search) are the correct cursor foundation for incremental mailbox sync.
  - Source: <https://www.rfc-editor.org/rfc/rfc3501>
- IMAP IDLE is the push-style wakeup mechanism for new mailbox events.
  - Source: <https://www.rfc-editor.org/rfc/rfc2177>

### Event/webhook sources (for later feed expansion)

- Slack Events API is HTTP push, requires fast acknowledgments, and retries on failures.
  - Source: <https://docs.slack.dev/apis/events-api/>
- GitHub webhooks include delivery headers/signatures and payload size limits.
  - Source: <https://docs.github.com/en/webhooks/webhook-events-and-payloads>
- Google Calendar supports full + incremental sync using `nextSyncToken` and uses 410 invalidation semantics.
  - Source: <https://developers.google.com/workspace/calendar/api/guides/sync>

## Mapping to existing Mind thesis

- Existing thoughts already identify missing trigger runtime and async processing gap:
  - `the Mind system has trigger declarations without a trigger runtime`
  - `the-cloud-processing-pipeline-can-grow-the-vault-while-the-user-is-absent-and-this-is-a-qualitative-shift`
- Data feed connectors are the missing perception substrate feeding that trigger runtime.
- Existing `inbox_capture -> surface -> reflect -> revisit -> verify` pipeline remains the transformation engine.

## Proposed feed architecture

### Canonical flow

1. Connector pulls or receives external events.
2. Connector normalizes each item to a canonical `FeedRecord`.
3. Policy layer filters/redacts by sensitivity and connector allowlist.
4. Sink writes feed captures to vault inbox as markdown artifacts.
5. Existing pipeline ingests those artifacts.
6. Cursor/checkpoint is advanced.

### Cursor model

- Local poll sources: monotonically increasing IDs or timestamps (`visits.id` for Chrome).
- Remote delta sources: provider tokens (`historyId`, `@odata.deltaLink`, `syncToken`).
- Webhook sources: delivery IDs + replay protection store.

### Non-disruptive integration strategy

- Keep feed runtime out-of-band initially (manual command or separate cron/worker).
- Do not wire into session hooks until source quality and policy controls are validated.
- Default to metadata-only capture for email-like sources.

## Scaffold delivered in code

- `packages/plugin/src/data-feed/types.ts`
- `packages/plugin/src/data-feed/contracts.ts`
- `packages/plugin/src/data-feed/policy.ts`
- `packages/plugin/src/data-feed/checkpoints.ts`
- `packages/plugin/src/data-feed/runtime.ts`
- `packages/plugin/src/data-feed/sinks/vault-inbox-sink.ts`
- `packages/plugin/src/data-feed/sources/chrome-history-local.ts`
- `packages/plugin/src/data-feed/sources/email-gmail.ts`
- `packages/plugin/src/data-feed/sources/email-microsoft-graph.ts`
- `packages/plugin/src/data-feed/sources/email-imap.ts`
- `packages/plugin/src/data-feed/index.ts`

## Next build steps

1. Add one command entrypoint to run feed sync manually (`/arscontexta:feed`).
2. Enable only `chrome-history-local` first, metadata-only mode.
3. Validate quality and dedupe against existing `inbox` workflow.
4. Add Gmail (historyId), then Graph (deltaLink), then IMAP fallback.
5. Only after stable signal quality: enable background trigger runtime.
