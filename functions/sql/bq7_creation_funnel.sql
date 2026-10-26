/* BQ7 (Type 3): activity creation abandonment by step. */
WITH starts AS (
  SELECT DISTINCT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'creation_session_id') AS session_id
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_create_attempt'
), steps AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'creation_session_id') AS session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'step') AS step
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name IN ('creation_step_viewed', 'creation_step_completed')
), completed AS (
  SELECT DISTINCT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'creation_session_id') AS session_id
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_create_result'
    AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'result') = 'success'
)
SELECT step, COUNT(DISTINCT s.session_id) AS sessions_reaching_step,
  COUNT(DISTINCT IF(c.session_id IS NULL, s.session_id, NULL)) AS sessions_not_completed
FROM starts base JOIN steps s USING (session_id)
LEFT JOIN completed c USING (session_id)
GROUP BY step
ORDER BY sessions_not_completed DESC;
