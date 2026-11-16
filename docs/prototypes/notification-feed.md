# Notification Feed UI prototype

This throwaway prototype asks: **What does the Notification Feed look like in Cadence?**

Decision ticket: [What does the Notification Feed look like in Cadence?](https://github.com/bzhang-coke/cohort-005-project/issues/15).
Map: [Wayfinder: In-app notifications for Cadence](https://github.com/bzhang-coke/cohort-005-project/issues/8).

**Human verdict:** A, the compact bell popover, is selected with its demonstrated read, history, preference, and destination behavior. The canonical resolution is on [the decision ticket](https://github.com/bzhang-coke/cohort-005-project/issues/15). Do not merge this branch or treat these fixtures as a delivery implementation.

## Run and compare

Use Node 24 with the repository's dependencies installed and its ordinary local sample database available in a disposable checkout. The prepared worktree at `/private/tmp/cadence-notification-feed-prototype` already has both; its database is a separate snapshot of the local development database.

```sh
npm run prototype:notifications
```

Open http://127.0.0.1:5174/dashboard?variant=A and select a person using DevUI. The existing dashboard and layout loaders still run; the prototype does not bypass authentication. If no person is selected, the host dashboard can return its normal 401 until DevUI selects someone.

| URL parameter | Layout                                              | Question to assess                                             |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `?variant=A`  | Bell popover over the existing dashboard            | Is this enough space to scan and act without leaving the page? |
| `?variant=B`  | Persistent side drawer over the dashboard           | Is the extra height worth covering part of the current work?   |
| `?variant=C`  | Full-page list with a destination preview beside it | Does a dedicated feed make longer history easier to handle?    |

Use the bottom arrows, or left/right keyboard arrows, to cycle. Keyboard arrows leave inputs, selects, and editable content alone. The selected variant stays in the URL. At narrow widths, the full-page layout switches between list and destination; use Back to feed to return.

Review snapshots: [A — bell popover](notification-feed-A.png), [B — side drawer](notification-feed-B.png), [C — full-page feed](notification-feed-C.png). Use the running demo to assess interactions.

The review toolbar has populated/loading/empty/error scenes, an Add sample event button, a Reset demo button, and a full state inspector. These are prototype controls, not proposed product UI. Switching variants preserves the sample state. Reloading or switching people resets it. The entire prototype, including the switcher, is gated out of the layout in production.

## Suggested walkthrough

1. Select Emma Wilson (Student), Sarah Chen (Instructor), Alex Rivera (Platform Admin), and Bossy McBossface or Ava Nakamura (Team Admin) in DevUI. The role-specific examples change and each new person starts with separate sample state. Team Admin is a responsibility alongside their platform role.
2. Open and close the feed: the unread count stays put. Open an entry: it becomes read. Try its individual read/unread control, the Unread filter, and Mark all read.
3. Open Notification preferences. Mute Discussion activity, add a sample discussion event, and observe no new entry or unread count. Existing entries retain their state. Re-enable the category: missed activity does not return. Add another event: it arrives.
4. As a Team Admin, repeat for Seat claims. Refund Request Notifications have no mute control. The proposed preference presentation shows both optional categories to everyone, describing when each applies; the human can refine this presentation without changing the agreed personal scope.
5. Open the deleted discussion, expired Enrollment, and country-restricted examples. Their history remains visible, and the destination explains why it cannot be opened. No unavailable lesson content is displayed.
6. Use Load older Notifications to inspect earlier history. Each event remains a separate row. Try the empty and error scenes, and Try again in the error state.

## Decisions already fixed

[Which Notifications does Cadence send, and to whom?](https://github.com/bzhang-coke/cohort-005-project/issues/11) defines eligible events and recipients. Fixtures illustrate that catalogue, with no self-notifications or bundled events. Refund approvals do not claim that money has been returned.

[Which Notifications may people mute in the Notification Feed?](https://github.com/bzhang-coke/cohort-005-project/issues/16) sets two optional categories (Discussion activity and Seat claims), mandatory Refund Request Notifications, all enabled by default, per-person scope across courses/Teams/roles, and future-only changes without history removal or replay. **Notification Preference** means a person's choice about whether to receive an optional category in their Notification Feed.

## Demonstrated behavior

- A is a compact bell popover in the page header, using the existing dashboard and sidebar as context.
- The badge counts unread entries; viewing an entry makes it seen without marking it read. Opening a row marks it read, including when its destination is unavailable. Manual read/unread and Mark all read are available; Mark all read includes older loaded and unloaded sample entries.
- Newest first, one row per event, All/Unread filters, and progressive access to older history. Actual retention duration remains an integration decision.
- Opening a row takes the person to its exact discussion/reply, Refund Request, or Seat claim. The demo presents an illustrative destination with the target highlighted; it does not navigate to real application records or invent working anchors.
- Unavailable or unauthorized destinations retain a clear path back to the feed. Existing Notification text is retained; no unavailable destination content is revealed.
- Personal preferences are reachable from the feed's settings button. Mandatory Refund Requests are explained rather than given a disabled toggle.

## Limits and handoff

Notification data, preferences, read/seen state, and destinations live only in React memory. The surrounding dashboard reads a separate local database snapshot. Notification interactions never create a discussion, process a Refund Request, claim a Seat, or contact a vendor. Examples are fictional and do not assert that the selected person performed those events in the real database.

This prototype establishes no evidence about vendor APIs, SDK compatibility, persistence, secure user tokens, delivery, retry behavior, retention limits, or real destination navigation. [Do any remaining vendor questions require a live service?](https://github.com/bzhang-coke/cohort-005-project/issues/19) should evaluate any specific uncertainty exposed by the human's review. Signup remains deferred. The integration ticket owns real anchor/navigation mechanics, storage, preference synchronization, and delayed-dispatch semantics.

The prototype skill normally folds a winner into real code. This map's destination explicitly defers production implementation, so only the human's verdict should become a planning decision. Keep this branch as its source artifact; do not promote prototype code into main.

## Verification

- `npm run typecheck` passed, followed by `npm run test`: 405 tests passed across 15 files, using Node 24 (the installed SQLite binding's runtime).
- Browser walkthrough covering all three layouts, read/seen separation, muting/history/no replay, destination previews, filters and older history, simulated loading/error/empty states, all four roles, resets when switching people, narrow-screen overflow, and browser exceptions.
- No new automated test suite was added for the throwaway code.
