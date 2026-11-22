# BQ9 – Google Calendar Schedule Adoption

Implemented by **Gabriel Polania**. Type 3 – Feature Analysis.

> What percentage of all schedule slots in ParchApp originate from the Google Calendar import feature?

This is a distinct metric from Compare Availability versus activity confirmation.
That existing BQ9, `insights/bq9_comparison_confirmation`, its refresh functions,
and its dashboard card remain unchanged. Gabriel's card is `bq9-google`; its
aggregate is `insights/bq9_google_calendar_adoption`.

## Observed implementation and source of truth

There are two active persistence contracts in this checkout:

* `MobileService.importCalendarAvailability` accepts start/end intervals only,
  clips them to a 1–56 day import window beginning today in Bogotá, splits at
  midnight, rounds outward to integer minutes, and merges overlapping or adjacent
  intervals. A transaction replaces `availability/{uid}/days/{YYYY-MM-DD}` with
  `{date, busy: [{start, end}], source: "google", updatedAt}` for every supplied
  day, including empty days. It also updates `calendarImports/{uid}` and mirrors
  today's availability into groups for Java compatibility. It cannot recover
  event counts or content from these merged intervals.
* Flutter's direct Schedule repository stores full private event records in
  `schedules/{uid}/slots/{id}` with `source: "google_calendar"`, plus a matching
  content-free copy in `availability/{uid}/slots/{id}`. Private slots already
  exist in the branch's rules/model; the callable does not write them. Flutter
  replaces both imported representations on reimport. The shared copy has no
  source field under the existing rules.

Group members' legacy undated busy arrays, `calendarImports` counters, activities,
and analytics events are **not** independent Schedule observations and are not
counted. Parent metadata documents need not exist for subcollections to count.

## Counting methodology

`functions/src/scheduleInsights.js` reads projected fields only, in a Firestore
transaction. Collection groups are filtered by exact full paths, so another
feature's `slots` or `days` collection never contributes.

For each owner and Bogotá day, choose one representation:

1. A valid `availability/{uid}/days/{date}` snapshot, including an explicit empty
   busy array; `date` must match the real calendar date in the path.
2. Otherwise, private `schedules/{uid}/slots/{id}` intervals for that day.
3. Otherwise, shared `availability/{uid}/slots/{id}` intervals for that day.

This precedence applies by day, not by write timestamp. These formats represent
alternative snapshots, not independently additive calendars. It deliberately
avoids double counting their mirrors. If both clients write different views of
the same day, the day snapshot is authoritative; a newer private slot does not
override it. An empty snapshot suppresses old copies. If a preferred snapshot is
deleted while a fallback still exists, that fallback becomes measurable again.
Delete obsolete representations at their source if they should no longer count.

Validate day intervals as integer minutes `0 <= start < end <= 1440`; slot
documents must have real Timestamp/Date bounds with `start < end`. Reject corrupt
individual slot ranges exceeding 366 days. Split timestamp intervals at Bogotá
midnight. Deduplicate document paths, then merge overlapping ranges (and adjacent ranges of the same source)
within the chosen day. A merged range with conflicting origins is **unknown**.
Malformed intervals are excluded. An empty dataset has no inferred adoption.

A counted slot is thus a **stored busy interval per owner/day**, not an individual
Google event. Two overlapping events may count once; one overnight event may
count twice. No duration weighting is applied. This consistent definition also
works when the original Google import has already merged event boundaries.

Source normalization trims whitespace and ignores case:

| Stored source | Classification |
| --- | --- |
| `google`, `google_calendar` | Google Calendar |
| Other nonempty strings such as `manual`, `demo`, `outlook` | Other |
| Missing, blank, non-string, `unknown`, conflicting merged sources | Unknown |

Unknown sources stay in the denominator and have their own count/chart segment;
they are never silently labeled Other or assumed Google from their path.

```text
totalSlots = googleSlots + otherSlots + unknownSlots
percentage = round(100 * googleSlots / totalSlots, 2)
```

When `totalSlots == 0`, `percentage` is `null`, not zero. The sample covers **all
currently stored valid days**, historical and future, without a rolling time
window. Retention/deletion policies and imported date ranges therefore affect the
result. Demo data is an Other source; this is a storage census, not a production
user-adoption cohort. The metric says nothing about the percentage of users who
adopt Calendar, unique events, import success, or lifetime imports.

## Aggregate, refresh and concurrency

The aggregate contains only `totalSlots`, `googleSlots`, `otherSlots`,
`unknownSlots`, `percentage`, `measurement: "stored_busy_intervals"`,
`scope: "all_currently_stored_days"`, the representation precedence, and a server
`updated_at` commit timestamp.

* `refreshScheduleImportInsight`: callable in `us-central1`, no arguments;
  requires Auth plus the trusted `orgAnalytics: true` custom claim through
  `requireOrganizationAnalytics`. A request cannot supply counts or paths.
* `refreshScheduleImportInsightNightly`: daily at **05:00 America/Bogota**, in
  `us-central1`.
* The existing dashboard Refresh button runs this callable alongside the existing
  team/activity refreshes, reports individual failures, then rereads aggregates.

Reads and aggregate replacement occur in one retriable transaction, preventing a
stale concurrent refresh from publishing counts from an older read snapshot.
Source imports are unchanged. Replacements, empty days and deletions are reflected
on the next refresh; there is no incremental counter, stale index or trigger.
Writes after a completed refresh appear on the next one. A failed refresh leaves
the previous aggregate/update timestamp intact.

**Historical backfill:** no source migration or index backfill is required. An
authorized manual refresh scans existing records, including historical records.
Repeating it is safe and never adds counters to previous totals. Unknown source
metadata cannot be recovered from paths or aggregate counters.

This deliberately small implementation scans the two collection groups on each
refresh. It may read projected metadata from unrelated paths before filtering
them. For a much larger dataset, measure read cost and transaction size/time
before introducing a separately versioned, transactional materialized index.
The current implementation requires no new composite index.

## Privacy, UI and deployment

Queries project only `date`, `busy`, `source`, `start`, `end`. They never retrieve
titles, descriptions, attendees or locations. Owner IDs are used transiently to
deduplicate per-day records; no UID, event ID, path or interval boundary is stored
in the aggregate or exposed by its callable.

Existing Firestore rules are unchanged: calendar owners keep access to their own
details; friends retain the existing Busy/Free projection. Even an organization
dashboard user cannot read another person's private calendar. Signed-in dashboard
users can read aggregates under the existing insights rule, clients cannot write
them, and only organization accounts can trigger refreshes. No new analytics
index or permissions are introduced.

The existing dashboard uses a Chart.js doughnut with Google, Other and Unknown
counts, four indicators, an informative empty state, methodology and last
successful update time. Its numeric sorter handles `bq9-google` next to `bq9`
without moving two-digit questions incorrectly. Existing ownership labels stay
unchanged.

After code review, deploy the two new functions and existing dashboard hosting
through the project's normal deployment process. No deployment is performed by
the implementation tests. Until the backend is deployed, Refresh reports that
the callable is unavailable; it does not manufacture a sample.

## Tests

```sh
npm --prefix functions test
PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH npm run test:rules
# Focused emulator integration:
PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH ./node_modules/.bin/firebase emulators:exec \
  --only firestore,auth --project demo-parchapp \
  'node --test --test-concurrency=1 tests/scheduleInsights.emulator.test.js'
```

Use any installed Java 21+ path instead of the Homebrew path on other systems.
Tests cover classification, percentages, empty/unknown samples, invalid data,
path filtering, snapshot precedence, duplicate/overlap handling, history,
replacement, deletion, empty days, callable authorization, privacy, dashboard
values and suffix sorting. Emulator tests exercise actual collection-group
queries, transactional concurrent refresh and security rules.

### Validation in this checkout (2026-11-16)

* Functions: **94/94 passed**, including all existing tests.
* Focused BQ9 emulator integration: **3/3 passed**.
* Full repository emulator suite: **119/127 passed**. Seven existing rules tests
  assume the demo group member `alex`, whereas the already-staged local demo
  fixture uses a real Firebase UID. The eighth existing test expects organization
  claims for insight reads, whereas the current rules permit all signed-in users
  to read aggregates (refresh still requires the claim).
* Running the complete repository suite against a temporary copy of committed
  backend code plus BQ9, without the pre-existing local fixture/config edits,
  gives **126/127 passed**. Only that existing insight-read policy expectation
  remains. BQ9 does not change those rules, fixtures, or existing tests.

These existing suite failures remain visible; they were not bypassed, disabled,
or rewritten to make this feature pass. Reconciling the intended read policy and
the locally customized fixture is separate from the new metric.
