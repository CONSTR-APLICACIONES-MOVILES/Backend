/*BQ1 (Type 1, App Telemetry)"
  What is the average response time of the availability engine when calculating common time
    slots for groups of different sizes?
    Source event: availability_calc, logged by AvailabilityEngine.findCommonSlotsAsync().
    Schedule: daily scheduled query, destination table parchapp_analytics.bq1_availability_latency,
    shown in the team Looker Studio dashboard.
    The table name is a placeholder: src/insights.js loadQuery() replaces it with the real export dataset. When pasting into the BigQuery console, replace `parchapp.analytics_PROPERTY_ID` by hand. */

WITH calculations AS (
  SELECT
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'group_size') AS group_size,
    (SELECT value.double_value FROM UNNEST(event_params) WHERE key = 'duration_ms') AS duration_ms,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'ranker') AS ranker
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'availability_calc'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
)
SELECT
  group_size,
  ranker,
  COUNT(*) AS calculations,
  ROUND(AVG(duration_ms), 3) AS avg_duration_ms,
  ROUND(APPROX_QUANTILES(duration_ms, 100)[OFFSET(95)], 3) AS p95_duration_ms
FROM calculations
WHERE group_size IS NOT NULL AND duration_ms IS NOT NULL
GROUP BY group_size, ranker
ORDER BY group_size, ranker;
