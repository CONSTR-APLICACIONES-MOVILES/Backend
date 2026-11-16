# Flutter mobile integration API

All endpoints are authenticated HTTPS callables in `us-central1`. UID always
comes from Firebase Auth; supplying another UID or unexpected fields is rejected.
These additions retain the previous Java activity/group contracts. No Java source
or Firestore client permissions changed.

| Callable | Input | Result / behavior |
| --- | --- | --- |
| getScheduleFriends | `{}` | Unique other members of shared groups; id, name, initials only |
| getScheduleDay | `{date, friendIds}` | Bogotá date, up to 10 shared peers, per-owner known/busy/updatedAt |
| importCalendarAvailability | `{startDate, days, intervals}` | Starts today in Bogotá, 1–56 days, at most 2000 ISO start/end intervals |
| getProfile | `{}` | Own profile, Auth UID/verification, derived group/plan counters |
| updateProfile | `{fields}` | Own editable fields; returns acknowledged profile without a post-write refresh |
| getAlerts | `{}` | Most recent 200 activity invitations from shared groups, at most 100 per group |
| getActivities | `{}` | Membership-scoped JSON activity summaries for Home/offline reads |
| markAlertsRead | `{ids}` | Persist read state for up to 200 visible authorized activity IDs |
| respondToActivityInvitation | `{id, response}` | accepted/maybe/declined; transactional, identical retries are idempotent |
| setActivityReminder | `{activityId, minutesBefore}` | Organizer sets or disables a reminder (0, 15, 30 or 60 minutes before); requires a scheduled future activity |

## Availability and Java compatibility

The client reads Google's primary calendar through FreeBusy with the
`calendar.freebusy` permission. It never requests event content. Reference:
[Google FreeBusy query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).

`availability/{uid}/days/{YYYY-MM-DD}` contains `date`, `busy` (integer minutes
since Bogotá midnight), `source` and `updatedAt`. Missing data is unknown, not
free. Imported empty days are explicitly saved as an empty busy list. Overlaps
are merged, seconds round outward, and midnight-spanning intervals are split.
Resynchronization replaces snapshots in the supplied window, removing deleted
provider events. A validation/provider failure must not erase the previous data.

An import atomically writes snapshots and mirrors today's busy intervals into
the existing `groups.members[].busy` field. Other members and RSVP arrays remain
unchanged. Imported members also carry `calendarSync: true` and `busyDate`.
The activity repository resolves synced members from the snapshot for the
service's actual date, so tomorrow's recommendations do not reuse yesterday's
mirrored blocks. Missing imported days fail recommendation preconditions.
Legacy members without the marker retain the previous today-only behavior.

Snapshots are read only through callables: a caller can read their own and
selected members of their current shared groups. Only intervals are returned;
no calendar titles, descriptions, places or attendee lists are stored.
Synchronization is user initiated. Snapshot age is returned; background sync,
expiry UX, disconnect/delete controls and offline reconciliation remain work
for the next iteration.

## Private profiles

`profiles/{uid}` is callable-only. Editable fields: name, program, campus,
university, studentId, semester (0 = unset), year (0 = unset), academicLevel,
status (active/busy), photoData. Verification and counters cannot be written by
clients. Name/initials are mirrored to existing group membership records in the
same transaction; other academic/profile fields remain private.

Photos use a bounded inline JPEG/PNG/WebP data URI, at most 130000 decoded bytes,
for this prototype. No local device path is persisted. The camera adapter limits
image dimensions and size; missing photos use initials. Larger media storage is
outside this contract. On-time rate is null because attendance telemetry does
not exist. Completed plans count ended, confirmed activities authored by the
caller; it is not an attendance statistic. Quick active/busy status is a profile
setting and does not fabricate calendar events.

## Activity invitations

An activity created in a shared group is visible in each other member's inbox.
The author does not receive their own invitation. Read state and one response
live at `inboxes/{uid}/items/{activityId}`. Direct Firestore access is denied,
including for the owner; callables validate membership before every mutation.
Independent activity responses do not change the legacy group-level RSVP arrays.
Details DTOs include `participants[].activityRsvpStatus` alongside the original
`groupRsvpStatus`; existing Java consumers can ignore the new field.

This is an in-app inbox, not push delivery or reminder scheduling. It is refreshed
on opening or pulling to refresh. Accepted responses do not auto-confirm quorum,
reserve calendar blocks or imply attendance. Those workflows need separate
commands; no such success is claimed by this API. Time changes currently update
the activity description, not a separate unread alert revision.

BQ5 client events after accepted/maybe/declined responses use the actual activity
ID, creation timestamp, group size and anonymized UID. Existing SQL deduplicates
the first answer per activity/responder and remains compatible. Legacy Going
responses on group cards retain their previous semantics.

## Local verification and deployment

Run `npm run test:functions` and `npm run test:rules` with Java 21. API tests use
Firestore transactions and injected Auth context; the Flutter SDK smoke exercises
actual Auth/Functions HTTP transport with two local users.

New account demo-group enrollment now creates missing demo groups transactionally
and tolerates concurrent/repeated Auth trigger deliveries. Existing seeded group
data is preserved.

No live deployment was performed. Deploy the new Functions alongside existing
ones before switching Flutter to `USE_FIREBASE_EMULATORS=false`. The defaults
still use demo-parchapp locally. Validate Google OAuth client/package/signature
configuration and camera permission on physical hardware; emulators cannot
establish that those external platform flows work on the team's devices.

## BQ2 / BQ13 — shared metrics contracts (30 October 2026)

`publishActivity` keeps its existing Java/Flutter payload, stable requestId and
idempotent receipt. Telemetry is an independent callable, never a prerequisite
for publishing. Legacy Java publications remain valid; BQ2 coverage currently
means the instrumented Flutter client only, not every request from Java.

### recordCreationAttempt

Authenticated; accepts `attemptId`, `requestId`, `phase`, `startedAt`, optional
`outcome`, `durationMs`, `errorCode`, `clientUserId`. IDs are bounded document IDs;
clientUserId, if supplied, must equal the authenticated UID. Phases are start,
result and reconcile. Result outcomes success/failure/timeout are immutable;
reconcile records late success/failure without rewriting the observed timeout.
The server hashes UID/attemptId, accepts identical retries and out-of-order start,
and rejects reusing a key for a different publication/start/outcome. Environment
comes from the server project, not an arbitrary client field.

Flutter persists independent phase observations in a project/UID-scoped outbox,
uses Stopwatch for duration and an actual 8-second acknowledgement deadline.
A timeout retains the publication journal. Recovery reuses requestId but creates
a new attemptId. Telemetry retries at restored session, reconnect and later
publications, without blocking creation on a telemetry-network error. A process
exit before result leaves an unresolved attempt. Validation, local storage and
blocked-offline actions are outside the network denominator. The coverage value
measures uploaded observations with a terminal result, not observations still
on an unreachable device or lost to a local storage failure.

Canonical BQ2: `creationAttempts` -> server `buildCreationInsight` ->
`insights/bq2_creation_reliability`. Counts include unresolved starts; empty rates
are null; slow successful responses are not timeouts. Reports duration p95,
logical publication count, business/network/other failure categories and late
reconciliation separately. The Analytics-export SQL is explicitly legacy.

### BQ13 confirmation and ranking

Candidates generated by the shared `getActivityRecommendations` callable carry
schemaVersion 2, participant count/category and environment. First presentation
anchors a common batch window; IDs and presentation/decision callables remain
compatible with Java. Decisions add an internal `recommendationAttribution`
field to the activity. This field cannot be forged through mobile fields or
legacy Firestore update rules. The first CONFIRMED transition freezes the
candidate/batch and actual interval in coordinationMeasurements, both for the
transactional Flutter edit and the Firestore trigger used by Java transitions.
Creation already confirmed cannot retroactively convert a later recommendation.

Canonical BQ13: `slotRecommendations` + first-confirmation snapshot ->
`insights/bq13_recommendation_confirmation`. An opportunity is one unique exposed
candidate. All candidates in a batch mature after 24 hours from FIRST exposure
of that batch (a fixed exposure anchor, rather than resetting at selection).
Only the selected, unchanged candidate can convert, if first confirmation is
between selection and the end of that observation window and its actual interval
matches the frozen recommendation. Others remain in the denominator. Historical
records without attribution are unknown; young batches are pending. Cancellation
counts are visible without removing failed opportunities. This is the activity
status transition, not a claim that every participant accepted RSVP.

Segments: size 2–3 / 4–6 / 7+ (solo separate), category, weekday and morning before
12:00 / afternoon before 18:00 / evening, America/Bogota. The shared backend
reorders already feasible slots only, where each comparable segment has at least
20 mature opportunities and its aggregate is at most 48 hours old. Unknown
segments retain their base positions. Reasons explain historical use or base
fallback; both Java and Flutter receive the same ordering. No new occupied slot
can be generated by historical ranking.

`refreshActivityInsights` is authenticated, takes no metric payload and writes
BQ2/BQ3/BQ13 in the existing insights collection. The 04:00 Bogotá job also
refreshes them. The dashboard's Refresh invokes this alongside the EXISTING team
aggregator; deployment of this feature must not replace the team's BQ1/7/8/9
implementation with an older local branch. Dashboard cards show environment,
window, samples, unknown/pending and null rates. BQ14 remains phase 4.

Verification: `npm --prefix functions test`; with a separate Firestore emulator,
`node --test tests/activity.metrics.test.js` (dedicated demo project; no production
writes). Flutter: creation_attempt_monitor_test.dart plus regression suite.

## BQ14 / public usernames / friendships (30 October 2026)

BQ14 reuses shared publishActivity and the scheduler, without new required fields
for Java. Scheduled activities with at least two participants freeze reminderPolicy:
single_after_30_min or single_after_60_min, initial group size, allocation method
and in-app channel. Stable activity-ID hashing balances assignment; a fresh
server insight may supply a policy only after clear joint improvement with
sufficient mature samples. It is observational evidence, not randomized causal
proof. Activities already CONFIRMED at creation are reported separately and
cannot establish the automatic winner.

Each RSVP reminder has a single transactional dispatch: re-read SCHEDULED,
activity, group membership, response, first confirmation and closing deadline;
then write the deterministic alert, SENT state, counter and one delivery receipt
atomically. Concurrent scheduler execution cannot count twice. Responses,
cancellation, prior confirmation, leaving the group and closed invitation windows
suppress delivery. Organizer before-start reminders keep their existing purpose
and are excluded from BQ14. This is an in-app alert, not push reception.

Canonical records: reminderMeasurements (one per eligible activity),
reminderDeliveries (deduplicated by recipient/policy/sequence) and
coordinationMeasurements firstConfirmedAt. The 30-day panel includes mature
24-hour invitation cohorts, activities confirmed before any reminder (zero
alerts), non-confirmed, pending and missing-projection coverage. Times are from
invitation to first confirmation; per-activity burden includes failed outcomes.
Notifications per confirmed activity = ALL cohort notifications / confirmed
activities. Null time estimates remain null with no confirmations. Automatic
choice requires both policy samples >=20, >=5 confirmations each, no initial
confirmations in either compared row, no lower confirmation rate, a shorter
median and no more alerts per activity; otherwise no winner is asserted.

New authenticated callables:

- setUsername {username, clientUserId?}: normalizes optional @ and lower case,
  validates 3–24 ASCII letters/numbers/dots/underscores, reserves usernames/name
  transactionally, releases the caller's old claim and writes publicPeople/uid.
  Existing accounts retain no username until they explicitly choose one.
- searchPeople {query, cursor?, limit?}: username prefix >=2, max 30 results,
  query/user-bound cursor. Returns only id, display name and username.
- getPublicPerson {userId}: minimal identity plus viewer's own relationship state,
  version and direction. No email, student ID, calendar, location or private photo.
- getFriends {cursor?, limit?}: canonical pending/accepted relationships involving
  the authenticated UID, paginated up to 50, minimal person DTOs only.
- changeFriendship {userId, action, expectedVersion, clientUserId?}: request,
  accept, decline, cancel or remove. One SHA256 key per sorted UID pair, server
  version and command fingerprint. Only the recipient responds, only the sender
  cancels, either accepted friend removes. Identical retry is idempotent; stale
  responses after removal/re-request are rejected. Both accounts need usernames
  to initiate a request. No implicit acceptance of reversed/crossed requests.

Raw usernames/publicPeople/friendships and reminder measurement collections are
server-owned and denied by client rules. Profile name edits update the opted-in
public directory in the same transaction. Friendship does not grant group
membership, schedule/close-friends privileges or modify legacy group data.
Profile share codes can resolve opted-in minimal identities without a shared
group, but still require a separate friendship request and recipient acceptance.
Legacy shared-group identities without usernames keep their existing read-only
fallback. Code expiry/revocation remains enforced; native App Links are not added.

Flutter adds Profile -> Username / Friends, global username search from Discover,
and relationship actions on /people/:userId. Request screens preserve the exact
version/action after a missing ACK. Search uses debounce/revision checks. Friends
pages are copied into the existing project/UID offline cache with age, invalidated
after acknowledged changes; search and mutations require connection and are not
queued as accepted relationships. Calendar access continues to use shared groups
and privacy settings. Java can use all the additive backend contracts but no new
Java UI was implemented; its legacy callable payloads and confirmation rules are
preserved and tested.
