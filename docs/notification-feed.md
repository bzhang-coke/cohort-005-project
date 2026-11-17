# Notification Feed: confirmation slice (#37)

A successful Refund Request produces one best-effort buyer confirmation, including a Team Licence's buyer. The shared submission service commits the existing domain write, attempts the Notification, and then sends the existing email. Delivery errors are logged and caught; an email exception keeps its existing behavior but cannot bypass the feed attempt. A muted feed category does not affect email. There is no delivery queue, retry, database migration, local Notification history, or replay.

The bell beside Cadence opens a keyboard-accessible popover. Its badge counts unseen Notifications (9+ above nine); opening marks the whole channel seen without marking rows read. Read confirmation rows remain in the feed. The checkmark marks one row read, and activating a destination-less confirmation keeps the popover open. Loading, failure, and true empty states are distinct. The gear opens `/settings#notifications`. Pagination controls and Mark all as read UI are the separate #38 slice; the client port already exposes cursor listing and bulk read for it.

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
5. Create more than one page of unseen/unread history. Open the popover and inspect remote counts to verify channel-wide seen completion includes unloaded and old history while leaving unread state intact. Test per-row read and destination-less activation; confirm read rows remain. Old-history bulk behavior requires vendor confirmation or real aged data because the bulk endpoint carries a retention-policy label.
6. Switch DevUI people while reads/status operations/renewal are pending, then log out. Check the old socket closes, no old rows/badges appear, and fresh credentials identify the new person. Exercise a short test token lifetime to observe renewal and reconnection.
7. Simulate unavailable/invalid provider credentials and bulk completion delays. Verify loading/error/still-processing states, recovery, and no false empty state or confirmed badge clear. Check keyboard controls and a narrow viewport in the real app.

Full history browsing and Mark all as read UI remain #38. Other catalogue producers remain their assigned tickets; discussion archive and avatar-history acceptance remain #41/#36 respectively.
