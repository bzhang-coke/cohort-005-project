# Seat claim Notifications

The redeem action uses `submitSeatClaim` in `app/lib/enrollments.server.ts`. It
calls the existing synchronous `claimSeat` transaction, then attempts delivery
only after both the Claimed Seat and Enrollment are committed. Its final optional
dependency is `{ notifications?: NotificationTransport }`, injectable through
`notificationTransportContext` at the route. Delivery failure is logged and the
successful claim still redirects to the course welcome screen.

The sole recipient is the buyer of the claimed Seat's Purchase. Team membership
does not expand the audience. Shared delivery excludes the claimant's own action;
the `seatClaims` category honors the buyer's saved feed preference. The event is
`seat-claimed`, with `cadence:seat-claimed:<seatId>` as its idempotency key.

Cadence snapshots claimant name, course title and remaining available Seats on
that specific Purchase synchronously before external delivery begins. Other
licences, claimed Seats and refunded Seats do not count. Claiming the last Seat
sends the normal claim event with zero remaining; it adds no all-Seats event.
Rejected, repeated, competing unsuccessful and rolled-back claims send nothing.
Actor identity and avatar come from the shared provider identity mapping.

The destination is `/team#seat-<seatId>`. The Team table renders that stable ID,
reveals the Seat when a previous course filter hid it, and scrolls to it on
navigation, including the same hash. The existing authenticated Team Admin
loader scopes every visible Seat; a notification does not grant Team access.

`notifications/workflows/cadence-seat-claimed.json` defines category `seat-claims`
with one feed delivery step and preference overrides disabled. Validate it with
`KNOCK_FEED_CHANNEL_KEY=cadence-feed npm run notifications:provision -- --dry-run`.
This prints the intended Development request without publishing or delivering.
See [Notification Feed setup](notification-feed.md) for operator provisioning.

SQLite/fake-adapter service and real action tests cover recipient selection,
preferences, snapshots, complete commit, rejection and failure. The Cadence
client test covers exact navigation and read-only checkmark behavior; Team route
tests cover rendered anchors and access. Live Development workflow publication,
delivery, preference suppression and avatar refresh require separate acceptance
with credentials.
