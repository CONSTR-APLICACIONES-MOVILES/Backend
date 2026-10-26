/* BQ9 (Type 3): effect of Compare Availability on confirmation. */
WITH created AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'comparison_id') AS comparison_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'source') AS source
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_created'
), confirmed AS (
  SELECT DISTINCT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_confirmed'
)
SELECT
  IF(c.comparison_id IS NULL AND c.source != 'suggested_slot', 'without_comparison', 'with_comparison') AS comparison_usage,
  COUNT(*) AS created_activities,
  COUNTIF(f.activity_id IS NOT NULL) AS confirmed_activities,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(f.activity_id IS NOT NULL), COUNT(*)), 1) AS confirmation_pct
FROM created c LEFT JOIN confirmed f USING (activity_id)
GROUP BY comparison_usage;
