# ParchApp shared Firebase backend

Shared server contracts for Flutter and Android Java. Live project: **parchapp-ee6cc**, Firestore default database, Functions **us-central1**. The current BQ runtime aggregates Firestore records; a live Firebase Analytics→BigQuery export is not certified.

## Documentation

- [Analytics and shared dashboard](docs/analytics-dashboard.md): BQ2/3/13/14, security, local verification and publication boundary.
- [Data model](docs/data-model.md): shared collection/field contracts.
- Flutter's separate repository has the canonical architecture, feature inventory and test guide under ParchApp-Flutter/docs/.

## Local setup

Use Node.js 22, npm and Java 21. From this checkout:

```powershell
npm ci
npm --prefix functions ci
npm run emulators
```

Standard ports: Auth 9099, Firestore 8080, Functions 5001. The CLI uses an explicit demo project in the emulator launcher; read scripts before running seeds/reset commands. Keep local emulator exports/configuration and credentials outside commits.

```powershell
npm run test:functions
npm run test:rules
```

Unit tests include aggregate builders and dashboard/server contract checks. Rules/API tests require isolated Firebase emulators. Several legacy tests expect standard ports; the current metrics suites also support an explicitly supplied FIRESTORE_EMULATOR_HOST.

## Runtime map

| Path | Responsibility |
|---|---|
| functions/index.js | Exports callables, schedules and triggers |
| functions/src/mobileCallables.js | Authenticated DTO and UID boundary |
| functions/src/activityService.js | Activity recommendations and decisions |
| functions/src/activityLifecycle.js | Idempotent publication/edit/cancel |
| functions/src/activityParticipants.js | Group-scoped participation and consented friend invitations |
| functions/src/socialService.js | Username claims and versioned friendships |
| functions/src/activityInsights.js | BQ2/BQ3/BQ13 aggregation and ranking feedback |
| functions/src/reminderInsights.js | BQ14 policy, delivery deduplication and aggregation |
| dashboard/index.html | Shared organization dashboard with existing team cards |
| dashboard/activity-questions.mjs | Contributor cards for BQ2/3/13/14 |
| firestore.rules / firestore.indexes.json | Client authorization and query indexes |

## Verified cloud connection — 2026-10-30

The user subsequently authorized connection without a commit. Sources were downloaded from the deployed Cloud Functions and Hosting before publication. Only recordCreationAttempt, refreshActivityInsights and Hosting were deployed; team functions were preserved. The deployed dashboard retains **ParchApp login for every reader**. Any signed-in account can read; only orgAnalytics accounts can refresh. No anonymous Firestore access was published, and the existing cloud read rule was retained.

Authorized refresh returned HTTP 200 and the four aggregate documents were read with Firebase Auth: BQ2 has 0 uploaded attempts (rate unavailable); BQ3 has 0/19 unchanged acceptances (0%); BQ13 has 19 historical opportunities without sufficient attribution and no mature denominator; BQ14 has 5 pending instrumented activities and no mature strategy comparison. No fictional records were created. recordCreationAttempt now rejects anonymous requests with JSON 401 instead of transport 403. Reopen the app to retry any locally retained telemetry and refresh again after actual activity use.

Live dashboard: https://parchapp-ee6cc.web.app/ . A commit is still needed for source traceability. Physical-device acceptance, distribution, submission and video remain separate pending tasks.
