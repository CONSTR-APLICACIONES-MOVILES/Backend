/* LEGACY selection diagnostic: this query measures acceptance, NOT confirmation.
   Canonical BQ13: slotRecommendations + coordinationMeasurements confirmation snapshot
   -> activityInsights.js -> insights/bq13_recommendation_confirmation. */
WITH presented AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'recommendation_id') AS recommendation_id,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'slot_position') AS slot_position
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'slot_presented'
), decisions AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'recommendation_id') AS recommendation_id,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'modified') AS modified
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'slot_accepted'
)
SELECT p.slot_position, COUNT(*) AS presented,
  COUNTIF(d.recommendation_id IS NOT NULL) AS selected,
  COUNTIF(d.modified = 0) AS selected_unchanged,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(d.modified = 0), COUNT(*)), 1) AS unchanged_pct
FROM presented p LEFT JOIN decisions d USING (recommendation_id)
WHERE p.recommendation_id IS NOT NULL
GROUP BY p.slot_position ORDER BY unchanged_pct DESC;
