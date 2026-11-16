/* BQ12 (Type 4): category, group size and time period demand. */
SELECT
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'category') AS category,
  (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'group_size') AS group_size,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'time_bucket') AS time_bucket,
  COUNT(*) AS confirmed_activities
FROM `parchapp.analytics_PROPERTY_ID.events_*`
WHERE event_name = 'activity_confirmed'
  AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
                        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
GROUP BY category, group_size, time_bucket
ORDER BY confirmed_activities DESC;
