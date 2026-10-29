/* BQ9 (Type 3, Feature Analysis), by Juan David Guzmán Casadiego:
   How often is Compare Availability used before creating an activity, and how does its use affect
   the percentage of activities that reach Confirmed?
   Events:
   - activity_created: with_comparison when it has comparison_id (Flutter) or source = 'suggested_slot'
     (Android, the plan was made from a Compare Availability slot).
   - activity_confirmed: logged once per activity when it reaches CONFIRMED.
   Last 30 days, one row per usage. Shown in the team dashboard, not to users.
   Replace `parchapp.analytics_PROPERTY_ID` with the Firebase Analytics export dataset. */
WITH created AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'comparison_id') AS comparison_id,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'source') AS source
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_created'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
), confirmed AS (
  SELECT DISTINCT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'activity_confirmed'
)
SELECT
  -- IFNULL: an event without source must count as without_comparison, a NULL comparison would put it in the other group
  IF(c.comparison_id IS NULL AND IFNULL(c.source, '') != 'suggested_slot', 'without_comparison', 'with_comparison') AS comparison_usage,
  COUNT(*) AS created_activities,
  COUNTIF(f.activity_id IS NOT NULL) AS confirmed_activities,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(f.activity_id IS NOT NULL), COUNT(*)), 1) AS confirmation_pct
FROM created c LEFT JOIN confirmed f USING (activity_id)
WHERE c.activity_id IS NOT NULL
GROUP BY comparison_usage;
