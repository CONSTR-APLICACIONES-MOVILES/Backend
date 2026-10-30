# Firestore data model

This is the contract between the backend and both clients, the Android app ([Sprint-2-Java](https://github.com/CONSTR-APLICACIONES-MOVILES/Sprint-2-Java)) and the Flutter app. Both apps must read and write exactly these fields. `firestore.rules` rejects anything else.

Additive dated availability, private profiles and per-activity inbox responses
are documented in [the mobile API contract](mobile-api.md). Legacy group arrays
and existing activity commands retain their original behavior.

Times of day are **minutes since midnight** (`1110` = 6:30 PM). Calendars are stored only as free/busy blocks, never event titles, places or attendees (data minimisation, Sprint 1 scenario 9.5).

## `groups/{groupId}`

Created by the backend only, through `functions/scripts/seed.js` and the `joinDemoGroupsOnSignUp` trigger. The demo IDs are `roomies`, `eng`, `intramurals`, `thesis` and `choir`.

| Field | Type | Written by | Notes |
|---|---|---|---|
| `name` | string | backend | "Roomies Main St" |
| `icon` | string | backend | Emoji or symbol shown on the card |
| `planTitle` | string | backend | Current plan of the group, may be empty |
| `members` | array of maps | backend | See below |
| `memberIds` | array of strings | backend | Same IDs as `members[].id`. Used only by the security rules; apps can ignore it |
| `goingIds` | array of strings | clients | User IDs that RSVP'd "Going" |
| `maybeIds` | array of strings | clients | User IDs that RSVP'd "Maybe" |
| `pendingInvites` | array of strings | clients | Invited emails, at most 50 |

Each entry in `members`:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Firebase Auth UID (demo members use short IDs such as `mateo`) |
| `name` | string | |
| `initials` | string | |
| `preferredStart`, `preferredEnd` | number | Preferred hours, used by `PreferenceRanking` |
| `busy` | array of `{start, end}` | Busy blocks for today |

**Client writes.** A member may change only `goingIds`, `maybeIds` and `pendingInvites`, and in `goingIds`/`maybeIds` only their own UID. Use `arrayUnion`/`arrayRemove`, not a full overwrite, so two people RSVP-ing at once don't erase each other:

```java
// Android (FirestoreGroupRepository.setRsvp)
ref.update("goingIds", FieldValue.arrayUnion(uid), "maybeIds", FieldValue.arrayRemove(uid));
```

```dart
// Flutter
ref.update({'goingIds': FieldValue.arrayUnion([uid]), 'maybeIds': FieldValue.arrayRemove([uid])});
```

## `activities/{activityId}`

Created by clients with an auto-generated ID.

| Field | Type | Notes |
|---|---|---|
| `groupId` | string | The author must be a member of this group |
| `title` | string | 1 to 120 characters |
| `description` | string, optional | Up to 5000 characters; missing means an empty description |
| `category` | string | `study`, `sports`, `social` or `other` (BQ10) |
| `date`, `time`, `location` | string | Free text for now, may be empty |
| `status` | string | `PROPOSED` or `CONFIRMED` |
| `createdBy` | string | Must equal the author's UID |
| `createdAt` | timestamp | Must be `FieldValue.serverTimestamp()` |
| `startTime`, `endTime` | timestamp, optional | Backend-managed canonical schedule; callable DTOs serialize these as UTC ISO strings |
| `durationMinutes` | integer, optional | Backend-managed duration (15–720 minutes) |
| `confirmedAt` | timestamp, optional | Backend-managed first transition to `CONFIRMED` |
| `planningContext` | map, optional | Immutable, coarse planning dimensions used by analytics |
| `reminderMinutesBefore` | integer, optional | Organizer preference, 0 (disabled), 15, 30 or 60; changed only through `setActivityReminder` |

Clients may create the original fields plus `description`. Only the author can edit, confirm or delete an activity, and `groupId`/`createdBy` never change. Canonical schedule fields can only be written through the recommendation decision callables. After those fields exist, direct client edits of `date`/`time` are rejected to prevent inconsistent schedules. Legacy activities remain readable without a migration. **Queries must filter by `groupId`**, otherwise the rules reject them:

`planningContext` contains `groupSizeAtCreation`, `minimumNoticeMinutes`, `comparisonUsed`, `comparisonId`, `locationAreaId` and `timeBucket`. Location areas are coarse identifiers such as `central_library`, `mario_laserna`, `campus_north`, `campus_south`, `outside_campus` and `unknown`; exact coordinates are not stored for analytics.

Every backend-created activity also receives an immutable lifecycle projection at
`activities/{activityId}/lifecycle/{eventId}`. Mobile clients cannot read or write this
projection directly. Event types are `CREATED`, `INVITATION_SENT`, `RESPONSE_RECEIVED`,
`CONFIRMED`, `CANCELLED` and `UPDATED`.

```dart
db.collection('activities').where('groupId', isEqualTo: groupId).orderBy('createdAt', descending: true);
```

That query uses the composite index in `firestore.indexes.json`.

Activity Details, participant availability, recommendation DTOs and Java/Flutter
call examples are documented in [activity-api.md](activity-api.md).

## `slotRecommendations/{recommendationId}`

Backend-only records; direct client reads/writes are denied. `ActivityRepository`
accesses them for the authenticated callable service and scheduled insight.

| Fields | Meaning |
|---|---|
| `activityId`, `organizerId`, `batchId`, `position` | Activity/organizer association, generated list ID, zero-based rank |
| `startTime`, `endTime` | Immutable suggested instants, UTC ISO strings |
| `availableParticipants`, `totalParticipants`, `score`, `reasons` | Candidate DTO data |
| `participantIds`, `minimumNoticeMinutes` | Context for acceptance revalidation |
| `generatedAt`, `presentedAt`, `decidedAt` | Server timestamps; presentation and decision initially null |
| `outcome` | null, `ACCEPTED_UNCHANGED`, `MODIFIED`, or `NOT_SELECTED` |
| `selectedStartTime`, `selectedEndTime` | Actual selected instants once the batch is decided |

Each candidate counts once when its organizer acknowledges display. Transactions
make presentation and decision retries idempotent and permit one decision per
batch. Choosing a slot updates the activity and all batch outcomes atomically.

## `insights/bq3_slot_acceptance`

Written every night by `refreshSlotRecommendation` from backend recommendation
records first presented within the preceding 30 days. Clients can read it but not write it.

| Field | Type | Notes |
|---|---|---|
| `recommended_position` | number | Position with highest unchanged acceptance rate; defaults to `0` until 20 presentations and one unchanged acceptance |
| `pct_unchanged_overall` | number or null | BQ3 answer: % of suggested slots accepted without changes |
| `sample_size`, `recommendations_presented` | number | Presented candidates in the cohort, including unselected/undecided candidates |
| `accepted_recommendations_unchanged` | number | Presented candidates accepted unchanged |
| `by_position` | array | `{slot_position, presented, accepted, accepted_unchanged}`; accepted includes modified choices |
| `window_start`, `window_end` | timestamp | Presentation cohort boundaries |
| `updated_at` | timestamp | |

If the document is missing or can't be read, clients should use position `0`, as `FirestoreInsightsRepository` does.

## `insights/bq5_response_time`

Written every night by `refreshResponseTimeInsight`. Clients can read it but not write it.

| Field | Type | Notes |
|---|---|---|
| `by_group_size` | array | One entry per group size, see below |
| `invitations` | number | Invitations with at least one answer in the last 30 days |
| `completed` | number | Invitations that everyone answered |
| `min_completed`, `min_responses` | number | Thresholds used to choose the estimate |
| `updated_at` | timestamp | |

Each entry in `by_group_size`: `group_size`, `invitations`, `completed`, `pct_completed`, `avg_minutes_all_responded`, `median_minutes_all_responded`, `responses`, `avg_minutes_per_response`, and the two fields the apps show:

| Field | Type | Notes |
|---|---|---|
| `estimate_minutes` | number or null | Expected minutes. `null` means there is not enough data, so show nothing |
| `estimate_kind` | string or null | `all_responded`: time until everyone answers. `per_response`: time one member usually takes, used while few invitations are complete |

If the document is missing or can't be read, clients show no estimate.

## `insights/bq6_reminder_timing`

`refreshReminderTimingInsight` updates this document daily from BQ6 Analytics events. New scheduled invitations use the published delay for most participants and keep a small deterministic exploration cohort on the other supported delays, so the comparison continues to learn without sending extra reminders.

| Field | Type | Notes |
|---|---|---|
| `recommended_delay_minutes` | number | Delay after invitation before the single RSVP reminder; supported arms are 30, 60 and 120 minutes; defaults to 60 until a delay has enough data |
| `recommended_strategy` | string | Strategy name corresponding to the selected delay |
| `recommendation_ready` | boolean | True after at least 20 delivered RSVP reminders and one response exist for a delay |
| `sample_size` | number | Delivered RSVP reminders in the 30-day window |
| `min_reminders_per_delay` | number | Minimum denominator required to select a delay |
| `by_delay` | array | Per delay: `delay_minutes`, `reminders`, `responses_after_reminder`, `response_rate_pct`, `avg_response_minutes` |
| `updated_at` | timestamp | |

If the document is unavailable or no arm has enough data, new invitations use the 60-minute default. If the activity starts within 30 minutes, no RSVP reminder is scheduled.

## Activity inbox and reminders

`inboxes/{uid}/items/{activityId}` is the backend-owned per-participant response record.
It contains `invitedAt`, `response`, `respondedAt`, `responseMs`,
`availabilityAtInvitation` (`AVAILABLE`, `BUSY` or `UNKNOWN`), `reminderCount`,
`lastReminderAt` and `lastReminderStrategy`. The availability value is a snapshot taken
when the invitation is created; it never contains calendar titles or locations.

Scheduled in-app reminders live at
`inboxes/{uid}/items/{activityId}/reminders/{reminderId}`. They contain `strategy`,
`sequence`, `delayMinutes`, `scheduledAt`, `sentAt`, `deliveredAt`, `openedAt`, `respondedAt` and
`status` (`SCHEDULED`, `SENT`, `OPENED`, `RESPONDED`, `EXPIRED` or `CANCELLED`).
The `dispatchPendingReminders` function marks due reminders as sent and creates an
in-app alert. A response cancels the reminder on the next dispatch pass.

**RSVPs restart with each activity.** `resetRsvpOnNewActivity` empties `goingIds` and `maybeIds` of the group when an activity is created, because a new activity is a new invitation (BQ5).


## Analytics events

The events below are Firebase Analytics events. BQ1/BQ8 keep their existing client
contract. BQ3 now uses authoritative `slotRecommendations` Firestore records;
clients may optionally mirror successful presentation/decision calls to the
events below to use the updated SQL. Legacy `slot_accepted` events without
recommendation IDs do not establish a BQ3 denominator.

| Event | Parameters | Question |
|---|---|---|
| `availability_calc` | `group_size`, `duration_ms`, `slot_count`, `ranker`, `source` | BQ1 |
| `slot_presented` | `recommendation_id`, `slot_position` | Optional BQ3 mirror, one event per displayed candidate |
| `slot_accepted` | `recommendation_id`, `slot_position`, `modified` (0/1); existing `group_size`/`recommended_position` may remain | Optional BQ3 decision mirror |
| `feature_used` | `feature` (`groups`, `compare_availability`, `schedule`, `invitations`, `alerts`), `screen` | BQ8 |
| `activity_created` | `category`, `source` | |
| `rsvp_submitted` | `activity_id` (string), `group_size` (int), `response_ms` (int), `response` (`going`/`maybe`) | BQ5 |
| `activity_create_attempt` | `creation_session_id`, `source`, `group_size` | BQ2 |
| `activity_create_result` | `creation_session_id`, `result`, `duration_ms`, optional `error_code`, `activity_id` | BQ2 |
| `invitation_sent` | `activity_id`, `availability_at_invitation` | BQ4 |
| `reminder_sent` | `activity_id`, `reminder_id`, `reminder_purpose`, `strategy`, `sequence`, `delay_minutes`, `reminder_sent_at_ms` | BQ6/BQ14 |
| `response_after_reminder` | `activity_id`, `reminder_id`, `strategy`, `sequence`, `delay_minutes`, `response_delay_ms`, `response_at_ms` | BQ6/BQ14 |
| `creation_step_viewed` | `creation_session_id`, `step` | BQ7 |
| `creation_step_completed` | `creation_session_id`, `step` | BQ7 |
| `creation_abandoned` | `creation_session_id`, `last_step`, `duration_ms` | BQ7 |
| `comparison_started` | `comparison_id`, `group_size` | BQ9 |
| `activity_confirmed` | `activity_id`, `category`, `group_size`, `time_bucket`, `location_area_id` | BQ9-BQ12 |

Every event also carries `client_ts` (ms). User IDs are sent as a SHA-256 hash (first 16 bytes, hex), never the raw UID.

`rsvp_submitted` is logged by the person who answers, right after the RSVP is saved. `activity_id` is the latest activity of the group (`activities where groupId == X orderBy createdAt desc limit 1`), `group_size` is `members.length` and `response_ms` is now minus that activity's `createdAt`. Skip the event when the group has no activity yet.
