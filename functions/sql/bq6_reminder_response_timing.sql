/* BQ6 (Type 2): select when to send the single RSVP reminder. */
WITH reminder_events AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'reminder_id') AS reminder_id,
    user_pseudo_id AS participant,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'strategy') AS strategy,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'sequence') AS sequence,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'delay_minutes') AS delay_minutes,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'reminder_purpose') AS reminder_purpose,
    event_timestamp,
    COALESCE(
      TIMESTAMP_MILLIS((SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'reminder_sent_at_ms')),
      TIMESTAMP_MICROS(event_timestamp)) AS reminder_ts
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'reminder_sent'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
), reminders AS (
  SELECT * FROM reminder_events
  WHERE reminder_purpose = 'rsvp'
    AND delay_minutes IN (30, 60, 120)
    AND activity_id IS NOT NULL AND reminder_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY user_pseudo_id, activity_id, reminder_id ORDER BY event_timestamp) = 1
), response_events AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'reminder_id') AS reminder_id,
    user_pseudo_id AS participant,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'response_delay_ms') AS response_delay_ms,
    event_timestamp
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'response_after_reminder'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
), responses AS (
  SELECT * FROM response_events
  QUALIFY ROW_NUMBER() OVER (PARTITION BY user_pseudo_id, activity_id, reminder_id ORDER BY event_timestamp) = 1
), paired AS (
  SELECT r.activity_id, r.reminder_id, r.participant, r.strategy, r.sequence,
    r.delay_minutes, a.response_delay_ms
  FROM reminders r
  LEFT JOIN responses a USING (activity_id, reminder_id, participant)
)
SELECT delay_minutes, strategy, sequence,
  COUNT(*) AS reminders,
  COUNTIF(response_delay_ms IS NOT NULL) AS responses_after_reminder,
  ROUND(100 * COUNTIF(response_delay_ms IS NOT NULL) / COUNT(*), 1) AS response_rate_pct,
  ROUND(AVG(response_delay_ms / 60000), 1) AS avg_response_minutes
FROM paired
WHERE delay_minutes IN (30, 60, 120)
GROUP BY delay_minutes, strategy, sequence
ORDER BY delay_minutes, strategy, sequence;
