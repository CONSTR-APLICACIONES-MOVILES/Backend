/* BQ11 (Type 4): confirmed activities by coarse area and time bucket. */
SELECT
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'location_area_id') AS location_area_id,
  (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'time_bucket') AS time_bucket,
  COUNT(*) AS confirmed_activities
FROM `parchapp.analytics_PROPERTY_ID.events_*`
WHERE event_name = 'activity_confirmed'
  AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY))
                        AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
GROUP BY location_area_id, time_bucket
ORDER BY confirmed_activities DESC;
