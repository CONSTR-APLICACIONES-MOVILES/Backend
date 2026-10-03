# Activity Details and slot recommendations

Both Java and Flutter use the same Firebase **HTTPS callable functions**, deployed
in `us-central1`. These use the existing Firebase Auth accounts and Firestore
groups/activities. They are not REST GET routes. The SDK includes the signed-in
user's token; a raw HTTP caller must follow the [Firebase callable protocol](https://firebase.google.com/docs/functions/callable-reference).

## Contract

Every call takes a JSON object containing `activityId`. Unknown input fields are
rejected. Activity Details requires group membership; all recommendation,
presentation, decision and activity analytics calls additionally require
`createdBy == current user`. Callers cannot supply another organizer, a fake
current time, or replacement participant schedules.

| Callable | Additional input | Result |
|---|---|---|
| `getActivity` | None | Activity DTO below |
| `getActivityRecommendations` | `durationMinutes` (integer 15–720, required unless activity has one); optional `date` (`YYYY-MM-DD`, today only), `minimumNoticeMinutes` (0–1440, default 60), `limit` (1–10, default 5) | `{activityId, batchId, date, timeZone, durationMinutes, minimumNoticeMinutes, recommendations}` |
| `presentActivityRecommendations` | `recommendationIds`: 1–10 distinct IDs actually displayed | `{presented}`: number of acknowledged IDs, including retries |
| `acceptActivityRecommendation` | `recommendationId` | `{recommendationId, outcome: "ACCEPTED_UNCHANGED", startTime, endTime}` |
| `modifyActivityRecommendation` | `recommendationId`, `startTime`, `endTime` | Same shape, with `outcome: "MODIFIED"` |
| `getActivityRecommendationAnalytics` | None | `{activityId, recommendations_presented, accepted_recommendations_unchanged, pct_unchanged_overall, sample_size, recommended_position, by_position}` |

Times in callable responses are UTC ISO 8601 strings; `timeZone` is
`America/Bogota`. Modified times must include a UTC offset and have minute
precision. They must differ from the suggested interval and satisfy the same
duration, availability and minimum-notice constraints. This also records an
organizer choosing a different custom time. Selecting another suggested
candidate unchanged uses **that candidate's ID** with the accept callable.

Example `getActivity` response:

```json
{
  "id": "activity123",
  "groupId": "roomies",
  "createdBy": "organizerUid",
  "title": "House dinner",
  "description": "Bring something to share",
  "category": "social",
  "date": "2026-10-02",
  "time": "19:30",
  "startTime": "2026-10-03T00:30:00.000Z",
  "endTime": "2026-10-03T01:30:00.000Z",
  "durationMinutes": 60,
  "timeZone": "America/Bogota",
  "status": "PROPOSED",
  "location": "Home",
  "participants": [
    {"id": "organizerUid", "name": "Alex", "initials": "AL", "groupRsvpStatus": "GOING", "availability": "AVAILABLE"}
  ]
}
```

Participants are all existing `group.members`, including those without an RSVP.
`groupRsvpStatus` is `GOING`, `MAYBE`, or `NO_RESPONSE`; it describes the existing
**group** RSVP, not a new per-activity attendance record. `availability` is
`AVAILABLE`, `BUSY`, or `UNKNOWN` for the activity's scheduled interval.
Legacy free-text dates/times are preserved; canonical times and duration are
`null`, description defaults to `""`, and availability is `UNKNOWN`. The backend
does not guess a duration or parse ambiguous display strings.

Example candidate:

```json
{
  "id": "55e80648-ab59-44c4-8bb5-8184b982dbbf",
  "startTime": "2026-10-03T00:30:00.000Z",
  "endTime": "2026-10-03T01:30:00.000Z",
  "availableParticipants": 4,
  "totalParticipants": 4,
  "score": 0.85,
  "reasons": [
    "All participants are available",
    "Meets minimum notice",
    "Matches preferred hours for 2 of 4 participants"
  ]
}
```

## Client sequence

1. Fetch Activity Details. The organizer requests recommendations with a duration.
2. Render candidates and acknowledge **only the displayed IDs** with
   `presentActivityRecommendations`. Await success before submitting a decision;
   retry the same IDs after a network failure.
3. Accept the selected candidate's ID, or submit edited times using modify.
4. Refresh Activity Details. A decision atomically writes canonical Firestore
   timestamps, `durationMinutes`, and compatible Bogotá `date`/`time` display
   fields. Status is preserved; the existing confirmation flow still applies.

Flutter call example:

```dart
final functions = FirebaseFunctions.instanceFor(region: 'us-central1');
final details = await functions.httpsCallable('getActivity')
    .call({'activityId': activityId});
final slots = await functions.httpsCallable('getActivityRecommendations')
    .call({'activityId': activityId, 'durationMinutes': 60});
```

Java call example:

```java
FirebaseFunctions functions = FirebaseFunctions.getInstance("us-central1");
Map<String, Object> input = new HashMap<>();
input.put("activityId", activityId);
input.put("durationMinutes", 60);
functions.getHttpsCallable("getActivityRecommendations").call(input);
```

Call generation on an explicit search/refresh, not every screen rebuild. Each
generation creates new IDs. Retain the returned IDs for presentation and decision
retries. Generated candidates that were never shown do not count toward BQ3.
Presentation retries and identical decision retries are idempotent, including
concurrent calls. Each batch permits one decision; its other candidates become
`NOT_SELECTED`. A conflicting later decision fails. Generate a new batch for a
new choice. Retrying a previous decision never overwrites a newer schedule.

## Availability and ranking

The engine uses existing `group.members[].busy` blocks in minutes since midnight,
preferred start/end minutes, server time, requested duration, and minimum notice.
It searches today's Bogotá calendar day on a 15-minute start grid and only returns
intervals where every participant is free. Busy intervals are half-open, so a
slot may start when a busy block ends. Empty results are valid.

Ranking strategy: `score = 0.7 + 0.3 × preferred-hour match fraction`. A preferred
window matches only if it contains the entire slot. Members without valid
preferences are excluded from that fraction; no preferences gives 0.7. Ties use
earliest start. Scores are deterministic heuristics, not probabilities. The
service accepts an injected `rank(slots, context)` strategy and clock for testing.

The current stored schedules are **undated, today-only prototype data**. Empty
busy arrays mean free under that contract, including newly registered users;
they do not prove that a real external calendar is empty. Missing/invalid busy
arrays fail generation. Recommendations for other dates fail. Activity
availability outside today is `UNKNOWN`. Calendar freshness, Google Calendar
sync, travel constraints, participant subsets and other time zones require an
extended data source and are not fabricated here. Acceptance rechecks current
membership, participant IDs, busy blocks and minimum notice inside the same
transaction as the schedule update.

## BQ3 and feedback

The unit is an **individual candidate**, not a request/list. Three displayed
candidates and one unchanged acceptance means **33.3%**. A displayed but ignored,
modified or unselected candidate remains in the denominator. Generation alone
is excluded. The stored initial batch decision determines unchanged acceptance;
later scheduling attempts are separate batches.

```text
percentage = 100 × accepted_recommendations_unchanged / recommendations_presented
```

No presentations returns `null`, not 0%. The activity endpoint covers all of that
activity's records. The nightly `refreshSlotRecommendation` uses records whose
first `presentedAt` lies in the preceding 30 days and updates the existing
`insights/bq3_slot_acceptance` document. `sample_size` now means presented
candidates. The recommended position uses unchanged acceptance **rate**, with
lowest position winning ties; it stays 0 until at least 20 presentations and one
unchanged acceptance exist. Clients can continue reading that insight for their
Recommended badge.

The server records are authoritative. The existing BQ3 SQL is an optional
Firebase Analytics mirror: it now requires `slot_presented` and `slot_accepted`
events carrying the same `recommendation_id` and `slot_position`; acceptance
also includes `modified` (0/1). Mirror only successful callable results. SQL
deduplicates by recommendation ID and scans history to identify first
presentation. Existing acceptance-only events cannot provide the corrected
denominator and are excluded. This change does not automatically export the
Firestore records to BigQuery. BQ1 and BQ8 remain unchanged.

## Errors and verification

Clients receive standard callable codes: `unauthenticated`, `permission-denied`,
`not-found`, `invalid-argument`, or `failed-precondition` (stale/unavailable slot,
unsupported date, unacknowledged presentation or conflicting decision). Refresh
recommendations after a failed precondition about availability or participants.

`npm test` runs ranking/insight unit tests, real Firestore transaction tests
through callable handlers, and security-rule tests. Integration tests inject
verified-auth context and a fixed clock; they do not exercise Firebase's HTTP
token verification. No additional composite indexes are needed.
