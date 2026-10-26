/* BQ6 (Type 2): response timing after a reminder. */
WITH reminders AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    user_pseudo_id AS participant,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'strategy') AS strategy,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'sequence') AS sequence,
    event_timestamp AS reminder_ts
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'reminder_sent'
), responses AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    user_pseudo_id AS participant,
    event_timestamp AS response_ts
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'rsvp_submitted'
), paired AS (
  SELECT r.strategy, r.sequence, r.reminder_ts,
    MIN(a.response_ts) AS response_ts
  FROM reminders r LEFT JOIN responses a USING (activity_id, participant)
  WHERE a.response_ts IS NULL OR a.response_ts >= r.reminder_ts
  GROUP BY r.strategy, r.sequence, r.reminder_ts
)
SELECT strategy, sequence, COUNT(*) AS reminders,
  COUNTIF(response_ts IS NOT NULL) AS responses_after_reminder,
  ROUND(AVG(IF(response_ts IS NULL, NULL, (response_ts - reminder_ts) / 60000000)), 1)
    AS avg_response_minutes
FROM paired
GROUP BY strategy, sequence
ORDER BY responses_after_reminder DESC, avg_response_minutes ASC;
