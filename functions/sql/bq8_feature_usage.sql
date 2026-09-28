  /*BQ8 (Type 3, Feature Analysis)
    Which core coordination functionalities are used least frequently during the process of organizing an activity?

      Source event: feature_used (params: feature, screen), logged through
      AnalyticsTracker.trackFeature(). Features: groups, compare_availability, schedule, invitations, alerts.
      
      Schedule: daily scheduled query, destination table parchapp_analytics.bq8_feature_usage, shown in the team Looker Studio dashboard. Least used features come first.
      The table name is a placeholder: src/insights.js loadQuery() replaces it with the real export dataset. When pasting into the BigQuery console, replace `parchapp.analytics_PROPERTY_ID` by hand. */

WITH features AS (
  SELECT 'groups' AS feature UNION ALL
  SELECT 'compare_availability' UNION ALL
  SELECT 'schedule' UNION ALL
  SELECT 'invitations' UNION ALL
  SELECT 'alerts'
),
uses AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'feature') AS feature,
    user_pseudo_id
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'feature_used'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
)
/*In this case the LEFT JOIN keeps features that were never used, which are kinda the most important answer. */
SELECT
  f.feature,
  COUNT(u.feature) AS uses,
  COUNT(DISTINCT u.user_pseudo_id) AS users,
  ROUND(100 * COUNT(u.feature) / NULLIF(SUM(COUNT(u.feature)) OVER (), 0), 1) AS pct_of_uses
FROM features f
LEFT JOIN uses u ON u.feature = f.feature
GROUP BY f.feature
ORDER BY uses ASC, f.feature;
