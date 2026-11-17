# Notification Feed: confirmations and history (#37–#38)

A successful Refund Request produces one best-effort buyer confirmation, including a Team Licence's buyer. The shared submission service commits the existing domain write, attempts the Notification, and then sends the existing email. Delivery errors are logged and caught; an email exception keeps its existing behavior but cannot bypass the feed attempt. A muted feed category does not affect email. There is no delivery queue, retry, database migration, local Notification history, or replay.

The bell beside Cadence opens a keyboard-accessible popover. Its badge counts unseen Notifications (9+ above nine); opening marks the whole channel seen without marking rows read. Read confirmation rows remain in the feed. The checkmark marks one row read, and activating a destination-less confirmation keeps the popover open. Loading, failure, and true empty states are distinct. The header offers Mark all as read without a count, and the gear opens `/settings#notifications`. Scrolling inside the popover loads older history by cursor, retaining one newest-first list.

## Shared server contract

`NotificationEvent` in `app/lib/notifications.ts` contains `kind`, persisted `recordId`, explicit `recipientIds`, `actorId` (null for system confirmation), and Cadence-authored `data`. Data contains a category, title, context line, optional destination, source identifiers and snapshot facts. Amounts use integer cents and the existing formatter. Delivery text never comes from vendor HTML.

Call `deliverNotification(event, injectedTransport?)` after all domain writes commit. It deduplicates recipients, excludes the actor except for confirmation, and requires explicit saved true for Enrollment feed delivery. Existing preferences/default initialization remain owned by #36. Other feed preferences are enforced by the workflow's category; the fake models that suppression. Call the helper separately for each catalogue event so failure of one cannot suppress another.

The server adapter maps kind to `cadence-${kind}` and derives no new domain facts. The helper supplies `Idempotency-Key: cadence:${kind}:${recordId}`. Separate kinds never share an identity. Use a genuinely new persisted identity for a later event; Enrollment IDs may be reused after deletion by SQLite, so the Enrollment implementation must include a durable creation identity such as its persisted timestamp. This key is a vendor deduplication hint, not an exactly-once guarantee. Knock documents a finite deduplication period. [Trigger and idempotency APIs](https://docs.knock.app/api-reference/overview)

| Kind                          | Category               |
| ----------------------------- | ---------------------- |
| `refund-request-confirmed`    | `refundRequestUpdates` |
| `refund-request-approved`     | `refundRequestUpdates` |
| `refund-request-declined`     | `refundRequestUpdates` |
| `refund-request-opened`       | `openRefundRequests`   |
| `seat-claimed`                | `seatClaims`           |
| `enrollment-created`          | `enrollments`          |
| `discussion-question-created` | `discussionQuestions`  |
| `discussion-reply-created`    | `discussionReplies`    |

Only confirmation is produced by a domain service in #37. The adapter also adds scalar `eventKind` and `eventId` fields and, when present, scalar `commentId` copied from `source.commentId`. Later deletion lookup must use the originating comment, including a reply's own ID. The richer Cadence payload remains available with rich feed mode. The fake's `triggers` records attempted external calls; `deliveries` records preference-permitted deliveries. It does not claim to prove vendor deduplication or preference enforcement.

Production refund actions call `submitRefundRequest(db, purchaseId, buyerId, reason, now, { notifications?, mail? })`. Existing synchronous domain helpers remain available to the established eligibility/decision tests. Routes inject through `notificationTransportContext` and `mailTransportContext`, with the existing runtime transports as defaults.

## Credentials and client lifecycle

Use Node 24. The runtime requires `KNOCK_SECRET_API_KEY`, `KNOCK_PUBLIC_API_KEY`, `KNOCK_SIGNING_KEY` and `KNOCK_FEED_CHANNEL_ID`. The server loads local `.env`; deployment variables take precedence. Signing keys can be PEM, escaped-newline PEM or base64-encoded PEM. Do not use `VITE_` names for private keys. Restart the server after changing runtime configuration.

Enable enhanced security in Knock Development before testing. `/api/notification-credentials` validates the current session person against Cadence's database and returns only its public configuration, ID, one-hour RS256 token, and expiry. It ignores browser recipient query fields and uses `Cache-Control: no-store`. Missing/nonexistent sessions fail. Partial configuration and keyless production fail visibly. Fully keyless development returns an explicitly disabled identity; the client stays empty without importing or connecting the vendor adapter. Keyless server delivery logs its no-op. This extends, rather than replaces, [the identity/preference setup](notification-preferences.md). [Knock authentication](https://docs.knock.app/in-app-ui/security-and-authentication)

`NotificationFeedClient` owns listing with an optional older-page cursor, channel counts, per-row read, channel-wide seen/read, subscriptions and disposal. `createNotificationFeedController` owns ephemeral display state and rejects responses, events, credentials and status completions from a replaced identity. It coalesces refreshes when events arrive during a request, shares in-flight renewal, clears on logout or renewal identity failure, and creates one client per selected person. The component is keyed by person ID to avoid rendering the preceding person's state while effects switch.

The Knock adapter uses locked `@knocklabs/client` 0.23.1 with rich/all/unarchived feed options, server-owned identification (`skip`), and the SDK token-expiration callback. SDK subscriptions provide live invalidation; signed API requests provide validated snapshots and authoritative counts. The adapter avoids the SDK's optimistic status store and detects HTTP failures returned as values. Subscription/socket handlers are detached on disposal and rebound on token renewal. There is no recurring feed refresh timer. [SDK feed reference](https://docs.knock.app/in-app-ui/javascript/sdk/feed-client)

A bulk status request includes `recipient_ids: [signedInPersonId]` and `archived: exclude`, with no loaded-ID list or age cutoff. Knock accepts these as asynchronous operations. When queued, the adapter makes at most five signed feed reads over 3.75 seconds to confirm the relevant count reached zero; these follow one explicit mutation and never retry that write. It reports a still-processing state if unconfirmed. Request timeouts also produce recoverable feedback. The generic bulk progress endpoint is absent from the documented public-key allowlist, so the browser does not use it or follow `progress_path` URLs. This reconciliation is an implementation inference from the public feed/bulk APIs; live completion semantics remain to be verified. [Bulk status API](https://docs.knock.app/api-reference/channels/bulk/update_message_status), [public-key endpoints](https://docs.knock.app/in-app-ui/security-and-authentication)

## History and channel statuses (#38)

`loadMore()` advances the opaque older-page cursor until exhaustion. An intersection observer inside the focusable scroll region requests the next page near the bottom; it stops after an error until the person chooses Try again. Initial loading, older-page loading, failed requests, and an empty feed have separate messages. Read rows remain alongside unread rows. The popover opens beside the sidebar on desktop and below the bell on narrow screens, with its height constrained to the available viewport.

`markAllRead()` uses the client's channel-wide operation, including unread entries that have never loaded. It does not construct a batch of loaded IDs. A successful mutation reconciles the visible history and channel counts. A failed or still-processing operation keeps failure feedback and reconciles any partial remote change; it does not pretend the requested operation completed.

Live events and status changes refresh from the newest page through the previously loaded boundary, keeping the previous view until reconciliation succeeds. The boundary cursor stays usable when its row remains; if that row was archived, reconciliation continues past its former position. This also removes archived older rows instead of preserving stale local copies. Duplicate IDs collapse into one row, rows remain newest first, and events arriving during pagination queue a refresh before the operation finishes. Every response remains guarded by the current person session. These are ephemeral display snapshots, not a local history store. Refresh work grows with the amount of history the person has loaded and happens only on explicit actions or live invalidation.

### Retention evidence and unresolved provider behavior

Checked against official Knock documentation on 2026-11-17: in-app `FeedItem` history remains available indefinitely, including after message-log expiry, and feed-item status updates remain possible. Message logs have separate plan-dependent retention: 30 days normally and 90 days on Enterprise. The documentation says custom retention windows are not currently supported. Cadence therefore uses the feed endpoint with `status=all`, `archived=exclude`, rich payloads and no date constraint; it does not use message logs as history or impose an application cutoff. [Knock retention policy](https://docs.knock.app/manage-your-account/data-retention), [feed API](https://docs.knock.app/api-reference/users/feeds/list_items)

The channel bulk-status reference separately carries a “Retention policy applied” label. Its recipient-scoped request shape does **not** prove that bulk seen/read covers entries older than the message-log window. That remains unresolved until real aged entries or vendor confirmation establish the behavior. No account configuration, old-item bulk operation, or Development paging was verified because credentials were unavailable. Do not substitute a finite history window or mark the live acceptance complete from fake tests or a recent-item smoke test. [Bulk status API](https://docs.knock.app/api-reference/channels/bulk/update_message_status)

## Publish the workflow in Development

`notifications/workflows/cadence-refund-request-confirmed.json` is a management-API definition, not a Knock CLI file. It specifies `refund-request-updates`, `override_preferences: false`, and exactly one feed delivery step. Its step array can accept a later email step without changing the event/category model. This version enables only feed delivery.

Provisioning requires a separate `KNOCK_MANAGEMENT_SERVICE_TOKEN` and `KNOCK_FEED_CHANNEL_KEY`. The channel **key** is distinct from the runtime feed channel UUID. Keep management credentials out of application deployment configuration. [Management API authentication](https://docs.knock.app/mapi-reference/overview)

With those operator-only variables available locally, review and publish using:

```sh
npm run notifications:provision -- --dry-run
npm run notifications:provision
```

The command upserts each checked-in definition in Development with `commit=true`. It does not publish to Production or automatically retry failures. Inspect the published workflow using the dashboard or `GET /v1/workflows/cadence-refund-request-confirmed?environment=development&hide_uncommitted_changes=true` on `control.knock.app`. Confirm the category, feed step, correct channel, `active: true`, and `valid: true`; activate it if needed. Git commits alone do not publish Knock workflows. [Workflow management API](https://docs.knock.app/mapi-reference/workflows/upsert)

Run `npm run notifications:backfill` against the intended database before accepting delivery. It establishes identities/preferences without replaying historical events and preserves saved choices. Do not run independent bootstrap writers concurrently; see the #36 documentation.

## Verification and pending live acceptance

Automated checks use migrated SQLite, fake server/client ports, generated RSA keys, real session cookies, public route actions and controlled SDK HTTP responses. No test contacts Knock. They cover committed confirmation data and identity, Team Licence ownership, rejected/duplicate actions, feed muting versus email, independent failures, session security, own-action filtering, Enrollment opt-in gating, feed counts/status/errors, live changes, pending-response identity isolation, renewal and keyless behavior. The parent integration owns focused browser verification, including keyboard and narrow-viewport operation.

**No live Knock credentials were available. No live workflow publish, delivery, enhanced-security enforcement, socket behavior or vendor acceptance is claimed. Do not close #37 based on these offline checks.** Complete these exact steps in Development:

1. Supply the four runtime variables; enable enhanced security; publish and inspect the committed workflow as above; complete the #36 backfill/preference acceptance checks.
2. Obtain A's token through an actual session. Verify missing/invalid tokens fail, and A's token cannot list B's feed, mark B's message read, or submit a bulk seen/read request for B. Keep tokens/keys out of screenshots, logs and issues.
3. Raise valid Individual Purchase and Team Licence Refund Requests as their buyers. Confirm one feed entry with the right course, formatted amount, Cadence avatar and no destination. Verify the real live connection updates the closed badge and open popover without polling. Observe the existing email separately.
4. Mute Refund Request updates, raise a genuinely new eligible request, verify no feed delivery and unchanged email. Re-enable it and verify a later request is delivered. Invalid/duplicate actions must produce no new event.
5. Create more than one page of unseen/unread history. Open the popover and inspect remote counts to verify channel-wide seen completion includes unloaded and old history while leaving unread state intact. Use Mark all as read before scrolling; verify unloaded entries become read, then scroll through every cursor to exhaustion. Confirm read rows remain and new arrivals preserve ordering without duplicates. Test failed pages/status changes, retry, per-row read, destination-less activation, and a person switch while an older page is pending. Old-history bulk behavior requires vendor confirmation or real aged data because the bulk endpoint carries a retention-policy label; record the account/channel configuration and evidence separately from a finite smoke test.
6. Switch DevUI people while reads/status operations/renewal are pending, then log out. Check the old socket closes, no old rows/badges appear, and fresh credentials identify the new person. Exercise a short test token lifetime to observe renewal and reconnection.
7. Simulate unavailable/invalid provider credentials and bulk completion delays. Verify loading/error/still-processing states, recovery, and no false empty state or confirmed badge clear. Check keyboard controls and a narrow viewport in the real app.

The #38 history and channel-read behavior is covered through the Cadence fake client with multiple pages, retained read rows, unloaded unread/unseen entries, in-flight page/live/status interactions, failed requests, partial bulk completion and person switching. Parent integration owns the rendered keyboard, scrolling and narrow-viewport checks. Live #37/#38 acceptance remains pending. Other catalogue producers remain their assigned tickets; discussion archive and avatar-history acceptance remain #41/#36 respectively.
