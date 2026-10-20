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
