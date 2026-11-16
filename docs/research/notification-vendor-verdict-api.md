# Knock API fit for the vendor verdict

Accessed **2026-11-16** for [the vendor decision](https://github.com/bzhang-coke/cohort-005-project/issues/18), against [the accepted integration checkpoint](https://github.com/bzhang-coke/cohort-005-project/issues/17#issuecomment-6928618372). Public documentation and schemas only; no account, authenticated service test, dependency installation, or application change.

**Assessment:** no documented hard incompatibility found. Knock has a credible server-mediated implementation path. Current OpenAPI evidence resolves the earlier uncertainty about bulk operations on old feed history. Exact cutoff sourcing, concurrent execution, failure recovery, and cleanup deadlines remain implementation decisions and acceptance checks; this note does not demonstrate them or select the vendor.

## Documented capabilities and integration implications

| Requirement | Documented fact | Cadence implementation inference |
| --- | --- | --- |
| Browser calls Cadence; credentials stay server-side | Secret keys may call every API. Feed retrieval supports All/Unread, pagination and insertion filters; message APIs support read/unread. [Authentication](https://docs.knock.app/api-reference/overview#api-keys), [feed API](https://docs.knock.app/api-reference/users/feeds), [message API](https://docs.knock.app/api-reference/messages) | Use server REST calls from the authenticated Cadence identity; validate ownership of supplied message IDs. The custom UI need not depend on Knock's browser SDK or React provider. |
| No direct public-key bypass | Enhanced security is off by default; when enabled, public-key requests without a signed user token are rejected. Keys can be revoked. [Enhanced security](https://docs.knock.app/in-app-ui/security-and-authentication), [key management](https://docs.knock.app/api-reference/overview#api-keys) | Enable enhanced security in every live environment, issue no browser vendor tokens, and revoke obsolete client credentials. Merely hiding a public key is insufficient. Cadence must clear old UI state and reject stale responses after account switching. |
| Cadence owns every preference decision | Committed workflow setting `override_preferences=true` bypasses recipient preferences for all channels. [Preference overrides](https://docs.knock.app/preferences/overview#advanced-concepts), [workflow schema](https://docs.knock.app/mapi-reference/workflows) | Apply this to **every catalogue workflow**, including optional categories; Cadence performs their suppression. Configure only the intended in-app step, without independent preference conditions. Audit deployed workflow configuration. |
| Fixed candidate recipients and permanent suppression | Triggers accept explicit user IDs and run asynchronously. Object recipients can fan out to subscribers. [Trigger API](https://docs.knock.app/send-notifications/triggering-workflows/api) | Persist intent with the business transaction; serialize mute cancellation and submission start locally. Submit only the narrowed explicit recipient IDs, freezing payload and identity thereafter. Avoid dynamic vendor subscriber expansion. These atomicity guarantees belong to Cadence, not Knock. |

## Ninety-day history and deletion

Non-Enterprise diagnostic logs expire after 30 days, while feed items remain retrievable and their statuses mutable indefinitely. Custom **log** retention is unavailable; this does not impose a 30-day feed limit. [Retention guide](https://docs.knock.app/manage-your-account/data-retention)

The decisive newer detail is in the official [OpenAPI JSON](https://docs.knock.app/openapi.json), JSON pointer `/components/schemas/BulkUpdateMessagesForChannelRequest/description`:

> For in-app channels, messages can be updated indefinitely via this operation.

The remainder distinguishes other channel types, which stop being updated after their retention window. The same operation accepts `read` and `delete`, with `older_than` and `recipient_ids` filters. Thus the generic retention badge on the [bulk endpoint](https://docs.knock.app/api-reference/channels/bulk/update_message_status) does **not** establish a 30-day restriction for in-app updates. Downloaded schema SHA-256: `0eb4a5449d039131c4c0504f324fe14e8055c271ba9f3919fc83a4a21c0037b8`.

**Inference:** a scheduled channel-scoped `delete` operation, using a 90-day age cutoff and no read/seen restriction, can remove both read and unread expired items. Confirm completion and absence from the feed; retry/alert on failure. Define sweep frequency and outage recovery in the integration plan. This is a feed-deletion path, not a claim about backup purging. Archiving is reversible and cannot substitute for deletion. [Bulk API](https://docs.knock.app/api-reference/channels/bulk/update_message_status), [archive semantics](https://docs.knock.app/api-reference/messages)

[Pricing](https://knock.app/pricing) separately advertises configurable feed retention. No concrete setting or schedule was located in the reviewed [feed integration guide](https://docs.knock.app/integrations/in-app/feeds) or [channel management schema](https://docs.knock.app/mapi-reference/channels), whose environment settings are opaque. The proposed path therefore relies on explicit deletion, not an assumed automatic setting.

## Read-all: supported predicate, unfinished boundary design

`POST /v1/channels/{channel_id}/messages/bulk/read` accepts one fixed `older_than=T`, meaning messages inserted strictly before `T`, and a recipient filter. Its result is asynchronous. Poll `GET /v1/bulk_operations/{id}` for terminal status and errors; estimated and processed row counts need not match. [Bulk read](https://docs.knock.app/api-reference/channels/bulk/update_message_status), [operation status](https://docs.knock.app/api-reference/bulk_operations/get)

**Inference:** persist the person's operation and `T`; block explicit mark-unread across sessions while it may still mutate entries, retain actual unread counts, and retry the same boundary after failure. The OpenAPI exception above supports unloaded history beyond 30 days. A fallback is to paginate `status=all` with `inserted_at.lt=T`, collect IDs, then batch-read them; use a stable all-items traversal rather than mutating the unread collection while paging. Reconcile the bounded feed afterward. [Feed filters](https://docs.knock.app/api-reference/users/feeds), [explicit-ID batch read](https://docs.knock.app/api-reference/messages)

**Unknown:** the reviewed APIs supply no documented snapshot token or provider-clock endpoint for choosing `T`. They do not establish clock-skew handling, atomic pagination, timestamp precision/monotonicity, or identical timing between bulk message insertion and feed-item insertion. A Cadence `now()` or an assumed HTTP `Date` header is not proof of the agreed boundary. The plan must define and verify cutoff sourcing, equal timestamps, delayed workflow insertion, concurrent arrivals, and partial failure. Fixed timestamp filtering is credible; exact command-time behavior remains unproven. [Bulk predicate](https://docs.knock.app/api-reference/channels/bulk/update_message_status), [feed schema](https://docs.knock.app/api-reference/users/feeds), [published API schema](https://docs.knock.app/openapi.json)

Batch/bulk deduplication may return `2xx` with some entities unchanged and identify them in `x-ratelimited-{param}`. Completion checks must inspect results and reconcile rather than treating any success response as full completion. [Deduplication limits](https://docs.knock.app/api-reference/overview#batch-and-bulk-endpoint-deduplication-rate-limits)

## Dispatch identity, recovery, and arrival

Identical trigger requests with the same `Idempotency-Key` replay within **24 hours**; mismatched parameters fail. Only successful responses are cached; `4xx`/`5xx` failures are not. Other endpoints ignore that header. [Idempotency contract](https://docs.knock.app/api-reference/overview#idempotent-requests)

**Inference:** one durable event/recipient submission identity and immutable payload make an atomic local dispatch ledger viable. Record first-attempt time, acceptance ID, and reconciliation evidence; bound retries conservatively inside the verified window. A timeout or server error must not be assumed to prove that nothing happened. After protection expires, unresolved sends remain flagged and paused under the accepted policy; a stable key alone does not provide permanent deduplication.

Trigger acceptance returns `workflow_run_id`, not proof of feed insertion. Messages can be queried by that ID; recipient-run APIs expose status, errors and event history, but their logs expire. A short scalar dispatch ID in trigger data can support feed reconciliation. Finding an entry proves existence; failing to find one does not prove that queued work cannot still insert it. [Trigger response](https://docs.knock.app/api-reference/workflows/trigger), [message lookup](https://docs.knock.app/api-reference/messages), [recipient runs](https://docs.knock.app/api-reference/workflow_recipient_runs), [feed filtering](https://docs.knock.app/api-reference/users/feeds)

In-app `delivered` means delivery to the recipient's feed. No 60-second delivery guarantee was established; Cadence's worker, 15-second active polling, rate-limit handling and observed vendor latency must meet that acceptance target. [Delivery statuses](https://docs.knock.app/send-notifications/message-statuses), [checkpoint](https://github.com/bzhang-coke/cohort-005-project/issues/17#issuecomment-6928618372)

## Account deletion and verification boundary

`DELETE /v1/users/{user_id}` removes associated user data. The guide includes messages, preferences, schedules, subscriptions and activity, allows up to **10 minutes** for processing, and permits later recreation under the same ID. Cadence therefore needs a durable deleted-person guard, suppression of pending work, and reconciliation of submissions already underway. [Delete API](https://docs.knock.app/api-reference/users/delete), [deletion behavior](https://docs.knock.app/managing-recipients/deleting-users)

The remaining work is implementation and focused live verification of isolation, deployed overrides, cutoff behavior, old-history read/delete, ambiguous-send recovery, and latency. A new account alone cannot prove long-age or concurrency guarantees. No new signup prerequisite follows from this research. Commercial acceptance remains a separate vendor-decision input. No application checks were run because no `app/` files changed.
