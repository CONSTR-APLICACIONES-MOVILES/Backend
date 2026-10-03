# ParchApp Backend

Firebase backend shared by the ParchApp **Android (Java)** and **Flutter** apps. Firebase is the server side of the client-server architecture: Authentication for sign-in, Cloud Firestore for groups and activities, Firebase Analytics exported to BigQuery for the Business Questions, and Cloud Functions for the jobs the apps shouldn't do.

```
firestore.rules            Who can read and write what (tested in tests/)
firestore.indexes.json     Composite index for activities by group
docs/data-model.md         Field-by-field contract both apps must follow
functions/
  index.js                 Cloud Functions
  src/demoData.js          Demo groups, port of DemoData.java
  src/insights.js          Turns the BQ3 and BQ5 query results into insights/ documents  sql/                     One BigQuery query per implemented Business Question
  scripts/seed.js          Writes the demo groups to Firestore
tests/                     Security rules tests (Firestore emulator)
```

## Cloud Functions

| Function | Trigger | What it does |
|---|---|---|
| `refreshSlotRecommendation` | Every day, 4:00 AM Bogotá | Runs `sql/bq3_slot_acceptance.sql` and writes the slot position organisers accept most often to `insights/bq3_slot_acceptance`. The apps mark that slot "Recommended". This is the BQ3 Type 2 feedback loop |
| `refreshResponseTimeInsight` | Every day, 4:15 AM Bogotá | Runs `sql/bq5_response_time.sql` and writes the expected time until everyone answers an invitation, per group size, to `insights/bq5_response_time`. The Active Groups card shows it. This is the BQ5 Type 2 feedback loop |
| `resetRsvpOnNewActivity` | New `activities` document | Empties `goingIds` and `maybeIds` of the activity's group, so every invitation starts with no answers (BQ5) |
| `joinDemoGroupsOnSignUp` | New Firebase Auth account | Adds the account to the demo groups so a new user can RSVP and create activities immediately. Remove it once the apps can create and join groups |

BQ1 and BQ8 aren't run by a function: set them up as BigQuery **scheduled queries** feeding the Looker Studio dashboard (see Setup, step 5).

## Local development

Requirements: Node 22 and Java 11+ (for the emulators).

```bash
npm install                    # root: Firebase CLI and test tools
npm --prefix functions install
npm test                       # function unit tests + security rules tests
npm run emulators              # Auth, Firestore, Functions and the Emulator UI at http://localhost:4000
```

To seed the running emulator, in a second terminal:

```bash
cd functions
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed -- --project demo-parchapp
```

(PowerShell: `$env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"; npm run seed -- --project demo-parchapp`)

`demo-parchapp` is an emulator-only project ID, so nothing you do locally touches a real project. On Windows, if an emulator reports "port taken", a previous run left its Java process open; close it in Task Manager.

## Setup on a real Firebase project

1. Create the project in the Firebase console and register both apps (Android package `com.example.parchapp`, plus the Flutter app). Each app keeps its own `google-services.json` / `GoogleService-Info.plist`; they never go in this repo.
2. Enable **Authentication → Email/Password** and create the **Firestore** database.
3. Link the project to this repo and deploy the rules:
   ```bash
   npx firebase login
   npx firebase use --add          # pick the project, alias "default"
   npm run deploy:rules
   ```
4. Seed the demo groups (once):
   ```bash
   gcloud auth application-default login
   npm --prefix functions run seed -- --project <project-id>
   ```
5. **Analytics → BigQuery.** In Project settings -> Integrations, link BigQuery with daily export. Put the dataset name (`analytics_<property id>`) in `functions/.env` as `ANALYTICS_DATASET`. For BQ1 and BQ8, paste `functions/sql/bq1_*.sql` and `bq8_*.sql` into BigQuery as scheduled queries (replace the table placeholder by hand) and connect their destination tables to Looker Studio.
BQ5 runs inside `refreshResponseTimeInsight`, so it needs no scheduled query.
6. Deploy the functions. This needs the **Blaze** (pay-as-you-go) plan, and it stays in the free tier at this scale:
   ```bash
   npm run deploy:functions
   ```

## Rules for both apps

- Never write a group's `members`, `memberIds`, `name` or `planTitle` from a client; the rules reject it.
- Always use `arrayUnion`/`arrayRemove` for `goingIds`, `maybeIds` and `pendingInvites`.
- Query activities with `where('groupId', ...)`.
- Keep analytics event names identical to `AnalyticsEvents.java`.

Details and code snippets for Java and Dart are in [docs/data-model.md](docs/data-model.md).

## Tests

- `functions/test/`: demo data matches `DemoData.java`, BQ3 result → insight document, SQL table substitution.
- `tests/firestore.rules.test.js`: runs the exact writes the Android app makes (RSVP, invitations, activity creation) and checks what outsiders and signed-out users are denied.
