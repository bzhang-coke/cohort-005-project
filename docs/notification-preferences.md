# Notification preferences and identity lifecycle

Ticket [#36](https://github.com/bzhang-coke/cohort-005-project/issues/36) implements the identity and preference slice of [PRD #33](https://github.com/bzhang-coke/cohort-005-project/issues/33). It does not enable Notification delivery or create a feed.

The Notifications card immediately follows Profile in Settings. Each applicable category has one feed switch. Visibility combines responsibilities and holdings: owning a Purchase or Team Licence counts independently of account role, and a course owner retains Instructor responsibilities. Hidden preferences remain saved in Knock.

`NotificationTransport` is the injectable server boundary. The Knock adapter owns vendor keys and HTTP shapes; the fake records external state in memory for tests; the logging no-op reports preferences unavailable. There is no local preference mirror. The browser uses the Cadence `NotificationPreferencesClient` and authenticated `/api/notification-preferences` resource route. That route accepts only a category, the feed channel, and a boolean; recipient fields are rejected. Preference saves never submit Profile fields.

## Configuration

Use Node 24 and the existing server environment names:

- `KNOCK_SECRET_API_KEY`
- `KNOCK_PUBLIC_API_KEY`
- `KNOCK_SIGNING_KEY`
- `KNOCK_FEED_CHANNEL_ID`

The server loads local `.env` with Node's `loadEnvFile`; deployment-provided environment variables take precedence. These names and credentials never appear in client responses. Do not prefix private configuration with `VITE_`.

Fully keyless development uses the logging no-op. Its switches are unavailable and it cannot report a successful save. Any partial configuration, or keyless production, produces a configuration error rather than falling back silently. Identity sync logs configuration/provider failures after the Cadence write and does not undo that write.

## Sync and backfill

Signup, Profile updates, Platform Admin edits, and seeding identify the person with name, email, and avatar. No account role is sent. Identity sync initializes all six category/feed defaults only when no person-owned default set exists: Enrollments off, the other five on. Existing sets, including explicit empty sets, are preserved. Failed initialization stays distinct from confirmed defaults.

Before enabling later delivery slices, run this against the intended `data.db` and Knock environment:

```sh
npm run notifications:backfill
```

The command reads people from the existing database, syncs identities/defaults, and prints ready/failed/disabled totals. It exits nonzero if any person failed or Notifications were disabled. It is safe to repeat after fixing configuration or a provider failure: saved choices are preserved, and no historical domain events are replayed. Seeding uses the same operation after its domain writes, without treating provider failure as a failed Cadence seed.

Run the initial backfill before accepting preference changes or enabling delivery. Cadence's one-process architecture (ADR 0006) permits shared per-person serialization for identity writes, initialization, and preference saves. A separate backfill process cannot share that in-memory coordination; do not run independent bootstrap writers concurrently.

Later Enrollment delivery must require a confirmed, explicit feed opt-in. A missing set, missing Enrollment leaf, provider error, or failed initialization is not an opt-in. Knock's permissive missing-preference fallback is not a safe Enrollment default.

## Merge behavior

The adapter uses vendor-side deep merge with only the changed category/feed leaf. It preserves unknown categories, workflow settings, future-channel booleans and conditions, and unrelated channel IDs. An existing override for the configured feed channel is updated with its channel-type value. UI saves are ordered, with pending changes applied over confirmed snapshots; a failed save reloads saved state and shows a toast. A second failure retains the last confirmed snapshot.

A legacy category-wide boolean is normalized when edited. A scalar mute becomes explicit false values for the six currently documented preference-map channel types, then the requested feed value is changed. This keeps current email, SMS, push, chat, and HTTP choices muted while allowing feed opt-in. It does not promise inherited scalar semantics for vendor channel types that do not yet exist. Existing object-shaped unknown channel data is left untouched. Global/workflow restrictions remain in Knock; a category switch controls that category, not those other restrictions.

The adapter reads the list of person preference sets to distinguish an absent set from an explicit empty one. The direct default-set endpoint can return inherited environment defaults and is unsuitable for that distinction. The list endpoint is documented as listing a person's sets, but its omission of inherited/synthetic sets is still an inference requiring live verification. Unexpected list shapes and failed requests are errors, never evidence of absence. See [Knock preference APIs](https://docs.knock.app/api-reference/users/list_preferences), [custom preference centers](https://docs.knock.app/preferences/custom-preference-center), and [preference merge behavior](https://docs.knock.app/preferences/overview).

## Verification and remaining live acceptance

Automated tests use migrated SQLite and fake transports, plus controlled HTTP responses at the Knock adapter boundary. They cover visibility, defaults, preserved/hidden choices, future-channel data, authentication and recipient rejection, overlapping saves, incomplete configuration, identity lifecycle failures, and Profile independence. No Vitest test requires Knock.

Focused browser checks on 2026-11-17 used the real Settings page and GET route with controlled save responses: card placement, responsibilities plus holdings, optimistic feedback, persistence, rapid and overlapping flips, toast/rollback, pending-response isolation on person switching, and keyboard operation passed. The existing fixed sidebar squeezes Settings at narrow viewport widths; this ticket does not redesign that shell. These checks do not establish live provider behavior.

**Live Knock Development acceptance remains pending: no credentials were available.** Before closing #36 or enabling delivery:

1. For a fresh identified person, compare the list-sets and direct-default endpoints. Verify the list distinguishes no stored set, an explicit empty set, and inherited defaults. Revisit the absence detector if it does not.
2. Verify all six stored category/feed defaults, opt into Enrollments, mute another category, and add an unrelated future-channel choice. Repeat identity sync and backfill; inspect fresh external state to confirm all choices persist and the standard avatar field updates.
3. Exercise overlapping category saves and rapid same-category flips, then read the external saved result. Confirm the configured feed-channel override and partial-merge behavior match the controlled adapter tests.
4. Simulate a failed initialization and confirm later Enrollment logic treats it as unavailable, never opted in. Delivery suppression itself belongs to subsequent event slices.

Do not record these live checks as passed based only on the fake or historical prototypes.
