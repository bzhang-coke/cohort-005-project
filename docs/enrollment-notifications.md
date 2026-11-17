# Enrollment Notifications

The Individual Purchase and Seat claim actions use the complete Enrollment submission services in `app/lib/enrollments.server.ts`. The synchronous domain helpers retain their atomic transactions. Submission snapshots a new Enrollment event only after the Purchase or Seat claim and Enrollment commit. Delivery failure is logged without reversing the action.

`enrollment-created` targets the course's Instructor and identifies the enrolled Student as its actor. The shared delivery policy excludes the actor and requires a confirmed saved `enrollments.channels.feed === true` before triggering. Default false, a missing preference set or category, and a failed initialization/read never imply opt-in. Identity synchronization initializes defaults without replacing existing choices; Settings updates the person's existing preference set. No historical Enrollment events are emitted by sync or backfill.

The event uses the new persisted AUTOINCREMENT Enrollment ID for `cadence:enrollment-created:<id>`. A Lapsed Student's new Enrollment has a new identity while their progress remains intact. Rejected or duplicate submissions, and buying a Team Licence without claiming a Seat, produce no Enrollment event.

The destination is `/instructor/<courseId>/students#student-<studentId>`. It resolves the durable Student row and retains the roster's existing Instructor/Platform Admin authorization. The shared feed displays the synced Student avatar, Enrollment icon and snapshotted course context. Row activation marks read before navigating; the separate checkmark only marks read.

Seat claims independently deliver `seat-claimed` to the Team Licence buyer and `enrollment-created` to an opted-in Instructor. Both event snapshots are captured before external work. Category preferences and failures are independent; a person who is both buyer and Instructor can receive both catalogue entries unless they are the actor.

## Workflow and Development acceptance

`notifications/workflows/cadence-enrollment-created.json` uses runtime category `enrollments`, honors provider preferences, and contains one feed step. Validate configuration without publishing:

```sh
KNOCK_FEED_CHANNEL_KEY=cadence-feed npm run notifications:provision -- --dry-run
```

Automated checks use migrated SQLite, the shared fake transport, real authenticated actions/Settings, and the existing feed client interface. They prove local gating and modeled provider suppression, not live Knock behavior.

Knock credentials were unavailable for this implementation. The workflow has not been provisioned or committed in Development, and no live message creation, avatar synchronization, or vendor preference suppression has been verified. With credentials, follow `docs/notification-feed.md` to provision, then verify:

1. A new Individual Purchase and Claimed Seat produce no Enrollment feed message before opt-in.
2. After the Instructor enables Enrollments in Settings, each path creates one Enrollment row with the Student avatar, course context and exact roster destination. Checkmarks remain on the current page; row activation marks read and navigates.
3. Approve an eligible Individual Purchase Refund Request, then have that Lapsed Student return. Their new Enrollment creates a distinct event and retained progress remains present.
4. Disable Enrollments, make another qualifying purchase/claim, and confirm no new Enrollment message. Seat claim Notifications can remain enabled independently.
5. Inspect the committed workflow category and provider message activity to establish that its disabled preference suppresses message creation. Do not infer this from tenant defaults or only from the application gate.
