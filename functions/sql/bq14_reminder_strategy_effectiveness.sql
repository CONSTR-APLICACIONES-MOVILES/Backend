/* LEGACY Analytics-export diagnostic, not the active BQ14 definition.
   Canonical: reminderMeasurements + reminderDeliveries + coordinationMeasurements
   -> reminderInsights.js -> insights/bq14_reminder_effectiveness.
   The canonical pipeline aggregates one activity, includes zero-alert cases and
   uses first confirmation from invitation; personal organizer reminders excluded. */
WITH reminders AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'strategy') AS strategy,
    event_timestamp
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'reminder_sent'
), confirmations AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    event_timestamp AS confirmed_ts
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_confirmed'
)
SELECT r.strategy, COUNT(*) AS reminders_sent,
  COUNT(DISTINCT r.activity_id) AS activities,
  COUNT(DISTINCT c.activity_id) AS confirmed_activities,
  ROUND(AVG(IF(c.confirmed_ts IS NULL, NULL,
    (c.confirmed_ts - r.event_timestamp) / 60000000)), 1) AS avg_minutes_to_confirmation
FROM reminders r LEFT JOIN confirmations c USING (activity_id)
GROUP BY r.strategy ORDER BY avg_minutes_to_confirmation ASC;
