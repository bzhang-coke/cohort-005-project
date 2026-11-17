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
to #41.

Automated verification uses migrated SQLite, the shared fake transport, real
sessions and route actions, and rendered comment markup. It covers recipient
roles, self-actions, preference independence, original text, invalid/failed
writes, delivery failure, both writing surfaces, exact anchors and destination
access. Shared feed checks own read-before-navigation and checkmark behavior.

Live acceptance is pending: credentials were unavailable, and no provider
request or workflow publish was performed. In Knock Development, publish and
inspect both definitions, post a Question and Replies through both surfaces,
check each category's suppression independently, and follow their exact
destinations. Change a sender profile through the existing sync lifecycle and
reload an older Notification to confirm its updated avatar while text remains
unchanged. These checks must not be inferred from the fake-backed tests.
