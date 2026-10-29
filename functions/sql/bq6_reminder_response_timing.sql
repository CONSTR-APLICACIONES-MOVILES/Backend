/* BQ6 (Type 2): response timing after an actually delivered reminder. */
WITH reminder_events AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    COALESCE(NULLIF(user_id, ''), user_pseudo_id) AS participant,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'reminder_id') AS reminder_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'strategy') AS strategy,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'sequence') AS sequence,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'reminder_sent_at_ms') AS reminder_sent_at_ms,
    event_timestamp AS logged_ts
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'reminder_sent'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
), reminders AS (
  SELECT *,
    COALESCE(TIMESTAMP_MILLIS(reminder_sent_at_ms), TIMESTAMP_MICROS(logged_ts)) AS reminder_ts,
    COALESCE(reminder_id, CONCAT(activity_id, ':', strategy, ':', CAST(sequence AS STRING), ':', CAST(logged_ts AS STRING))) AS reminder_key
  FROM reminder_events
  WHERE activity_id IS NOT NULL AND participant IS NOT NULL AND strategy IS NOT NULL
), deduplicated_reminders AS (
  SELECT *
  FROM reminders
  QUALIFY ROW_NUMBER() OVER (PARTITION BY participant, reminder_key ORDER BY logged_ts) = 1
), responses AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    COALESCE(NULLIF(user_id, ''), user_pseudo_id) AS participant,
    TIMESTAMP_MICROS(event_timestamp) AS response_ts
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'rsvp_submitted'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
), reminders_with_next AS (
  SELECT *, LEAD(reminder_ts) OVER (
    PARTITION BY activity_id, participant ORDER BY reminder_ts
  ) AS next_reminder_ts
  FROM deduplicated_reminders
), paired AS (
  SELECT r.activity_id, r.participant, r.reminder_key, r.strategy, r.sequence, r.reminder_ts,
    MIN(a.response_ts) AS response_ts
  FROM reminders_with_next r
  LEFT JOIN responses a
    ON a.activity_id = r.activity_id
    AND a.participant = r.participant
    AND a.response_ts >= r.reminder_ts
    AND (r.next_reminder_ts IS NULL OR a.response_ts < r.next_reminder_ts)
  GROUP BY r.activity_id, r.participant, r.reminder_key, r.strategy, r.sequence, r.reminder_ts
)
SELECT strategy, sequence, COUNT(*) AS reminders_sent,
  COUNTIF(response_ts IS NOT NULL) AS responses_after_reminder,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(response_ts IS NOT NULL), COUNT(*)), 1) AS response_pct,
  ROUND(AVG(IF(response_ts IS NULL, NULL,
    TIMESTAMP_DIFF(response_ts, reminder_ts, SECOND) / 60.0)), 1) AS avg_response_minutes
FROM paired
GROUP BY strategy, sequence
ORDER BY response_pct DESC, avg_response_minutes ASC;
