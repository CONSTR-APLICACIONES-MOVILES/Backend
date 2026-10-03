# Firestore data model

This is the contract between the backend and both clients, the Android app ([Sprint-2-Java](https://github.com/CONSTR-APLICACIONES-MOVILES/Sprint-2-Java)) and the Flutter app. Both apps must read and write exactly these fields. `firestore.rules` rejects anything else.

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
| `category` | string | `study`, `sports`, `social` or `other` (BQ10) |
| `date`, `time`, `location` | string | Free text for now, may be empty |
| `status` | string | `PROPOSED` or `CONFIRMED` |
| `createdBy` | string | Must equal the author's UID |
| `createdAt` | timestamp | Must be `FieldValue.serverTimestamp()` |

No other fields are allowed. Only the author can edit, confirm or delete an activity, and `groupId`/`createdBy` never change. **Queries must filter by `groupId`**, otherwise the rules reject them:

```dart
db.collection('activities').where('groupId', isEqualTo: groupId).orderBy('createdAt', descending: true);
```

That query uses the composite index in `firestore.indexes.json`.

## `insights/bq3_slot_acceptance`

Written every night by `refreshSlotRecommendation`. Clients can read it but not write it.

| Field | Type | Notes |
|---|---|---|
| `recommended_position` | number | Slot position (0 = best match) to mark as "Recommended". Stays `0` until at least 20 accepted slots have been logged |
| `pct_unchanged_overall` | number or null | BQ3 answer: % of suggested slots accepted without changes |
| `sample_size` | number | Accepted slots in the last 30 days |
| `by_position` | array | `{slot_position, accepted, accepted_unchanged}` |
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

**RSVPs restart with each activity.** `resetRsvpOnNewActivity` empties `goingIds` and `maybeIds` of the group when an activity is created, because a new activity is a new invitation (BQ5).


## Analytics events

The events are not stored in Firestore. Both apps send them to Firebase Analytics with these exact names, because the queries in `functions/sql/` depend on them. The source of truth is `AnalyticsEvents.java` in the Android app.

| Event | Parameters | Question |
|---|---|---|
| `availability_calc` | `group_size`, `duration_ms`, `slot_count`, `ranker`, `source` | BQ1 |
| `slot_accepted` | `group_size`, `slot_position`, `recommended_position`, `modified` (0/1) | BQ3 |
| `feature_used` | `feature` (`groups`, `compare_availability`, `schedule`, `invitations`, `alerts`), `screen` | BQ8 |
| `activity_created` | `category`, `source` | |
| `rsvp_submitted` | `activity_id` (string), `group_size` (int), `response_ms` (int), `response` (`going`/`maybe`) | BQ5 |

Every event also carries `client_ts` (ms). User IDs are sent as a SHA-256 hash (first 16 bytes, hex), never the raw UID.

`rsvp_submitted` is logged by the person who answers, right after the RSVP is saved. `activity_id` is the latest activity of the group (`activities where groupId == X orderBy createdAt desc limit 1`), `group_size` is `members.length` and `response_ms` is now minus that activity's `createdAt`. Skip the event when the group has no activity yet.
