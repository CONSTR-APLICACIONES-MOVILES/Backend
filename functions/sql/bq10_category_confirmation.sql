/* BQ10 (Type 3): activity categories and confirmation rates. */
WITH created AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'category') AS category
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_created'
), confirmed AS (
  SELECT DISTINCT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_confirmed'
)
SELECT category, COUNT(*) AS created_activities,
  COUNTIF(f.activity_id IS NOT NULL) AS confirmed_activities,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(f.activity_id IS NOT NULL), COUNT(*)), 1) AS confirmation_pct
FROM created c LEFT JOIN confirmed f USING (activity_id)
GROUP BY category ORDER BY created_activities DESC;
