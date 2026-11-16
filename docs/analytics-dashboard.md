# Activity analytics and dashboard

## Verified cloud connection — 2026-10-30

The user subsequently authorized connection without a commit. Sources were downloaded from the deployed Cloud Functions and Hosting before publication. Only recordCreationAttempt, refreshActivityInsights and Hosting were deployed; team functions were preserved. The deployed dashboard retains **ParchApp login for every reader**. Any signed-in account can read; only orgAnalytics accounts can refresh. No anonymous Firestore access was published, and the existing cloud read rule was retained.

Authorized refresh returned HTTP 200 and the four aggregate documents were read with Firebase Auth: BQ2 has 0 uploaded attempts (rate unavailable); BQ3 has 0/19 unchanged acceptances (0%); BQ13 has 19 historical opportunities without sufficient attribution and no mature denominator; BQ14 has 5 pending instrumented activities and no mature strategy comparison. No fictional records were created. recordCreationAttempt now rejects anonymous requests with JSON 401 instead of transport 403. Reopen the app to retry any locally retained telemetry and refresh again after actual activity use.

Live dashboard: https://parchapp-ee6cc.web.app/ . A commit is still needed for source traceability. Physical-device acceptance, distribution, submission and video remain separate pending tasks.

## Implementation and verification

The cloud-derived release used the ZIP of the most recently deployed markNotificationEventsRead package, whose aggregate builders match the local implementation. Existing deployed Hosting definitions BQ1/BQ8/BQ7/BQ9 were compared and preserved. New cards are imported from dashboard/activity-questions.mjs. Refresher access requires Auth + orgAnalytics; telemetry requires Auth + UID validation. The authorized public callable transport does not remove these guards.

Sources: creationAttempts → bq2_creation_reliability; presented slotRecommendations → bq3_slot_acceptance; candidates/coordinationMeasurements → bq13_recommendation_confirmation; reminderMeasurements/reminderDeliveries → bq14_reminder_effectiveness. All live in the shared insights collection, not a separate contributor database.

BQ2 retains timeouts after late success and distinguishes unresolved observations. BQ3 denominator includes all unique exposed candidates. BQ13 uses first attributable confirmation, not acceptance/attendance consensus. BQ14 uses mature 24-hour activity cohorts, deduplicated notifications and insufficient-evidence fallbacks; in-app SENT is not push receipt or causal effectiveness.

Unit verification passed 78 tests including cards connected to real builders; the focused emulator integration/rules run passed 30 tests. The final signed-in-read/anonymous-denial policy also passed its two rules tests after the user's access clarification. Tests and isolated fixtures are not production outcomes.

Localhost defaults to emulators (Auth 9099, Firestore 8080, Functions 5001); live Hosting uses parchapp-ee6cc. To test localhost, use demo fixtures rather than production credentials. Never seed production to fill a chart.

Future changes should start from reviewed source/cloud provenance and deploy only affected functions. Do not replace refreshTeamInsights or the whole shared codebase. Claim provisioning was authorized for the nominated QA organization account and preserved other claims; no password/token is documented.
