# Knock Development verification, 2026-11-17–18

The notification setup was resumed from `b8332d0`. Runtime credentials and the `in-app` channel were already configured. A management service token supplied locally enabled inspection and publishing. No secret values are recorded here.

## Corrections verified against Knock

- Knock rejected the original feed templates because they omitted both an action URL and action buttons. All eight now reference the Cadence destination with `action_url: "{{ data.destination }}"`; destinationless notifications remain destinationless in the Cadence feed.
- Committing workflows also required their six preference categories to exist in the project-wide catalog. Provisioning now validates all local definitions, ensures those category names, and commits the eight workflows in Development. Provider field errors are included in failure output.
- Knock returned indistinguishable all-null default sets for untouched people and explicitly saved empty sets. With the user's approval, both now receive Enrollments off and the other five categories on. Any actual saved preference preserves the existing set. Malformed known fields fail without writing defaults.
- Live recovery checks exposed HTTP 429 responses during bursts of page reconciliation and status confirmation. Feed reads are now serialized per client with at least 250 ms between starts, within Knock's five-per-second per-user limit. Disposal prevents queued reads from being sent. This schedules requested reads without adding polling or write retries. [Feed limits](https://docs.knock.app/api-reference/users/feeds), [rate-limit tiers](https://docs.knock.app/api-reference/overview#rate-limits)
- A date-dependent Seat test fixture surfaced after the calendar day changed. Its Purchase timestamp now uses the same fixed date as its refund check.

## Live results

| Check | Result |
| --- | --- |
| Workflow publishing | All eight committed definitions are active and valid, each with the expected category and one `in-app` feed step. The channel ID matches runtime configuration. |
| Preferences and identity | Nine synthetic people in an isolated SQLite fixture were synced/backfilled. Fresh and saved-empty sets received defaults. Enrollment opt-in, mutes, overlapping category changes, future-channel data, and name/avatar updates survived repeated sync/backfill. |
| Signed feed access | The production RS256 helper produced a token accepted for its person (200). Missing and invalid tokens were rejected (400); another person's feed was rejected (403). |
| Workflow delivery | Each of the eight workflows delivered to a synthetic recipient and was parsed by the production feed adapter. Three smoke payloads used null destinations and retained them. These payloads test nullable templates, not the exact destinations produced by domain actions. |
| Preferences during delivery | A muted Refund Request workflow completed without adding a feed row. The production delivery helper did not trigger Enrollment when its saved preference was off. |
| Cross-person status writes | A signed token could neither mark another synthetic person's message read nor bulk-mark that person's feed read; both requests returned 403. |
| Recent feed status | The production adapter marked the channel seen without clearing unread state, marked an individual row read, and marked the channel read. All eight feed rows remained available. |

The initial delivery run completed on 2026-11-18 with correlation prefix `live-1795008229892`. It left eight test feed entries for the synthetic Instructor and one for the synthetic buyer. Their temporary Enrollment opt-in and category mute were restored afterward. No Production workflow was published. Subsequent browser checks and the authorized application backfill are recorded below.

Local evidence is saved under `/private/tmp/cadence-spec-33/`: `knock-setup-status.json`, `workflow-validation.json`, `live-preferences-resumed-result.json`, and `live-workflows-resumed-result.json`. These scratch artifacts contain no credential values and are not required by the automated tests.

## Browser and application verification on 2026-11-18

The browser used this worktree's app, the real Knock adapter, a separate migrated SQLite database, and nine new synthetic people. Transactional emails were saved to the fixture's local outbox. Provider assertions were paced separately because server inspections consume the same per-person feed quota as the browser.

| Check | Result |
| --- | --- |
| History and live updates | Opening loaded 20 of 25 entries and marked unloaded entries seen without marking them read. Mark all read covered unloaded entries; scrolling retained all read history. Real socket events updated the closed badge and open popover. Idle observation showed no feed polling. |
| Browser operation | Destinationless activation stayed in the popover; event rows reached exact Refund Request, Student roster, Seat, and comment anchors. The popover fit a 390px viewport and closed with Escape. |
| Domain actions | Real Purchase, Seat claim, Refund Request approval/decline, lesson discussion, and Instructor question-queue actions exercised all eight event kinds. Buyer/Admin audiences and Individual/Team amounts were checked. Invalid and duplicate requests added no events. A Lapsed Student received a distinct Enrollment event while retaining progress. |
| Preferences | Rapid and overlapping Settings changes persisted their final intent. An injected failed save restored the real saved value and recovered on retry. Feed-channel overrides changed without losing email choices. All eight provider workflows suppressed delivery while their six categories were muted and delivered after enabling, including Enrollment. |
| Identity and archival | Profile name sync and a direct provider avatar change appeared on a retained row without changing its text/read state. Message lookup filtered by originating comment ID. Deleting a Question through the rendered form archived its notification and refreshed the open feed; surviving Replies retained their targets. Deleting one Reply preserved another Reply's notification. Reassigning the course before deletion still archived the former Instructor's entry. |
| Recovery | Injected initial-read, older-page, and per-row failures showed feedback and recovered. A simulated queued bulk response remained unconfirmed, preserved unread state, and sent no repeated write; a later real operation completed. Switching people during a held read closed the old socket and excluded old rows. |
| Renewal and expiry | Actual 35-second signed tokens exercised the SDK renewal callback. Subsequent requests used a renewed token and socket delivery continued. Removing the application session before renewal produced 401, cleared old rows, and removed the bell after reload. The actual logout form also cleared the feed and closed its socket. |
| Session-scoped access | Real session credentials were `no-store` and ignored an arbitrary recipient query. Own feed access returned 200; another person's feed, per-row read, bulk seen, and bulk read returned 403 without changing that person's state. An arbitrary recipient in a preference save returned 400. |

Faults were injected at the browser HTTP boundary; recovery used Knock. Short tokens were signed inside the test process and never written to reports. Development startup may issue a discarded credential request, so the renewal harness shortened the startup batch and confirmed the token actually used by feed requests.

The user authorized backfill of `/Users/O28845/GitHub/AI_hero/cohort-005-project/data.db`. It reported **44 ready, 0 failed, 0 disabled**. Read-back verified all 44 identities' names, emails, avatars, and nonempty default preference sets in Development. No historical events were replayed and no messages were sent by backfill.

Evidence is under `/private/tmp/cadence-spec-33/live-browser-20261118/`: `history-result.json`, `domain-result.json`, `preferences-archive-result.json`, `recovery-result.json`, `renewal-result.json`, `session-security-result.json`, `final-verification-result.json`, `logout-result.json`, and `former-recipient-result.json`. The recovery report has five passing recovery/switching phases followed by a superseded renewal-harness failure; the separate renewal report establishes the passing renewal result. Screenshots include `live-history.png`, `live-feed-narrow.png`, and `live-discussion.png`.

## Repository verification and remaining external evidence

`npm run typecheck` passed, followed by `npm run test`: **731 tests across 35 files**. Coverage includes empty sets, preservation of global/channel/workflow/commercial/future choices, malformed-field failures, read bursts within the provider quota, and disposal of a queued read. Vitest uses fake transports and does not contact Knock.

PRD #33 remains open for evidence beyond message-log retention. The Development channel was created on **2026-11-15**. Confirm that recipient-scoped bulk seen/read includes retained entries after message-log expiry, and that rich data/source fields remain sufficient for old Discussion archival. Recent-item success and fabricated timestamps do not establish those guarantees. Knock documents indefinite feed retention and continued status updates, while its bulk endpoint carries a retention-policy label. [Retention policy](https://docs.knock.app/manage-your-account/data-retention), [bulk status endpoint](https://docs.knock.app/api-reference/channels/bulk/update_message_status)

The [full checklist](notification-feed.md#verification-and-pending-live-acceptance) remains the acceptance contract. These verified scenarios do not establish every failure timing, multi-role combination, or future environment-level preference configuration. Read pacing is per client; multiple tabs and server operations still share the provider quota.
