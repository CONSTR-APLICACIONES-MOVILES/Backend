/* BQ2 (Type 1): activity creation reliability.
   Every client creation flow must emit one attempt and one result with the same session ID. */
WITH attempts AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'creation_session_id') AS session_id,
    event_timestamp AS attempt_ts
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_create_attempt'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
), results AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'creation_session_id') AS session_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'result') AS result,
    (SELECT value.double_value FROM UNNEST(event_params) WHERE key = 'duration_ms') AS duration_ms
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_create_result'
), joined AS (
  SELECT a.session_id, r.result, r.duration_ms
  FROM attempts a JOIN results r USING (session_id)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY a.session_id ORDER BY a.attempt_ts) = 1
)
SELECT
  COUNT(*) AS attempts,
  COUNTIF(result = 'success') AS successful_attempts,
  COUNTIF(result = 'failure') AS failed_attempts,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(result = 'failure'), COUNT(*)), 1) AS failure_pct,
  COUNTIF(duration_ms > 8000) AS timeout_attempts,
  ROUND(AVG(duration_ms), 1) AS avg_duration_ms,
  APPROX_QUANTILES(duration_ms, 100)[SAFE_OFFSET(95)] AS p95_duration_ms
FROM joined;
