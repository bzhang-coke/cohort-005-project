# Discussion Notifications

Both the lesson discussion action and Instructor questions action call
`submitComment(db, userId, lessonId, parentId, body, now, { notifications? })`.
The synchronous `createComment` mutation retains body, parent, lesson and reply
depth validation. Submission calls Notification delivery only after the insert
has committed, and delivery failure leaves the saved comment and action success
unchanged. Production callers should use submission; synchronous creation is
also available for existing service fixtures.

A Discussion Question is a top-level comment by someone other than the owning
Instructor, including a Platform Admin. Its only recipient is the owning
Instructor. A Discussion Reply targets only the qualifying Question's author;
other participants and the Instructor do not receive copies. The shared
`deliverNotification` helper excludes the actor. An owning Instructor's
top-level post and responses to it stay valid comments but do not produce these
catalogue events.

The two workflows are `cadence-discussion-question-created` and
`cadence-discussion-reply-created`. Their categories are `discussion-questions`
and `discussion-replies`, respectively, with one feed step each and preference
overrides disabled. Both default on through the shared preference contract.
The checked-in definitions pass `notifications:provision -- --dry-run`; Git
definitions alone do not publish them. See [provisioning](notification-feed.md).

Event identity is the new persisted comment ID plus kind. Both event payloads
include `source.commentId`, which the shared adapter also writes as a scalar
`commentId` for archive lookup. A Reply uses its own ID. The original trimmed
body, a single-line snippet of at most 160 characters, course/lesson titles,
title and destination are captured before the first external await. Editing
neither sends another Notification nor rewrites this snapshot. Actor identity
uses the shared vendor person reference, allowing the existing feed to show
the current avatar alongside its Discussion icon and relative time.

Destinations are `/courses/<slug>/lessons/<lessonId>#comment-<commentId>`.
The comment component renders the anchor on Questions and Replies, including
visible Replies beneath deleted parents. Existing loader/action access checks
remain in effect: following a retained Notification does not restore lapsed
Enrollment or bypass country restrictions. Comment deletion archival belongs
to the shared deletion service described below.

## Deletion and retained history

The lesson action awaits
`submitCommentDeletion(db, commentId, userId, isStaff, now, { notifications? })`.
It preserves the synchronous `deleteComment` validation and commits the soft
deletion before calling `archiveCommentNotifications`. The transport's
`archiveComment({ commentId, personIds })` operation targets only the originating
comment. A deleted Question leaves its surviving Replies and their Notifications
intact; deleting a Reply leaves the Question and other Replies intact. Editing
still does not rewrite Notification snapshots. Repeated deletion preserves the
first deletion time and safely requests archival again; there is no automatic
retry or delivery queue.

The Knock adapter uses the secret-key global List Messages endpoint with
`channel_id` and `trigger_data={"commentId":<numeric ID>}`, following every
`page_info.after`. It validates each returned item's exact numeric comment ID,
Discussion workflow key, and feed channel before collecting its message ID.
[List Messages](https://docs.knock.app/api-reference/messages/list)

Message logs expire while feed items remain available. Therefore the adapter
also pages every persisted Cadence person's unarchived rich feed, with no age
cutoff and at most four people being scanned concurrently. It inspects retained
`data.commentId` and the two allowed Discussion workflow keys locally, without
depending on an expired trigger-data index. All persisted person IDs are supplied
because course ownership and roles can change after delivery. This adds requests
proportional to people and their feed history, but requires no local Notification
store, message mapping, webhook, or worker. This composition is inferred from
the documented endpoints and remains pending live acceptance.
[Retention policy](https://docs.knock.app/manage-your-account/data-retention),
[server feed API](https://github.com/knocklabs/knock-node/blob/main/src/resources/users/feeds.ts)

All discovered IDs are deduplicated before any archive write, avoiding cursor
changes caused by removing entries during discovery. Each archive is an
independent `PUT /v1/messages/:id/archived`. A failed page or person's feed does
not prevent archiving already discovered matches or scanning the other people;
a failed archive does not skip the rest. The shared helper logs partial failures
after commit and leaves the domain action successful. No new Notification is
emitted. Repeated provider cursors fail without looping indefinitely.

The existing feed controller removes archived rows and reconciles counts on
refresh while retaining surviving read rows and snapshots. Opening the feed,
window focus, and completion of a comment-deletion fetcher refresh the current
person's own feed without a timer or an assumed archive socket event. Tracking
deletion in the feed component also handles a deleted comment form unmounting.

Automated verification uses migrated SQLite, the shared fake transport, real
sessions and route actions, and rendered comment markup. It covers recipient
roles, self-actions, preference independence, original text, invalid/failed
writes, delivery failure, both writing surfaces, exact anchors and destination
access. Shared feed checks own read-before-navigation and checkmark behavior.
Archival tests additionally cover retained old items absent from logs, former
Instructor recipients, exact comment/workflow/channel scope, all lookup pages,
independent errors, post-commit deletion, repeated deletion, authorization, and
the surviving Reply's rendered anchor and feed destination. Controlled API
responses establish request shape and application behavior, not live Knock
semantics.

Live acceptance is pending: credentials were unavailable, and no provider
request or workflow publish was performed. In Knock Development, publish and
inspect both definitions, post a Question and Replies through both surfaces,
check each category's suppression independently, and follow their exact
destinations. Change a sender profile through the existing sync lifecycle and
reload an older Notification to confirm its updated avatar while text remains
unchanged. These checks must not be inferred from the fake-backed tests.
For archival, verify the actual secret-key filtered lookup in Development;
delete a Question with a surviving Reply and then a Reply, and verify feed
disappearance, counts, and the surviving destination. Include retained entries
beyond the message-log window and a former recipient after reassignment. The
implemented approach is filtered lookup plus retained-feed discovery, not a
comment-to-message mapping. Trigger responses contain workflow run IDs before
message creation; the best-effort attempt does not retry a Notification that
appears only after discovery has finished.
