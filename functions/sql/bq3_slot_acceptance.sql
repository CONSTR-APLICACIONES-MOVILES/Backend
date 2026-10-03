/* Optional Firebase Analytics mirror; the nightly BQ3 function uses Firestore.
   Both events require recommendation_id. Legacy acceptance-only events cannot
   establish the denominator and are excluded. Mirror slot_presented after a
   successful presentation call and slot_accepted after a successful decision.
   modified = 0 for unchanged acceptance, 1 for a modified selection. */
WITH events AS (
  SELECT event_name, event_timestamp,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'recommendation_id') AS recommendation_id,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'slot_position') AS slot_position,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'modified') AS modified
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name IN ('slot_presented', 'slot_accepted')
    AND _TABLE_SUFFIX <= FORMAT_DATE('%Y%m%d', CURRENT_DATE())
), presented AS (
  SELECT recommendation_id, slot_position, event_timestamp
  FROM events
  WHERE event_name = 'slot_presented' AND recommendation_id IS NOT NULL AND slot_position IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY recommendation_id ORDER BY event_timestamp) = 1
), decisions AS (
  SELECT recommendation_id, modified, event_timestamp
  FROM events
  WHERE event_name = 'slot_accepted' AND recommendation_id IS NOT NULL AND modified IN (0, 1)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY recommendation_id ORDER BY event_timestamp) = 1
), by_position AS (
  SELECT p.slot_position, COUNT(*) AS presented,
    COUNT(d.recommendation_id) AS accepted, COUNTIF(d.modified = 0) AS accepted_unchanged
  FROM presented p LEFT JOIN decisions d
    ON p.recommendation_id = d.recommendation_id AND d.event_timestamp >= p.event_timestamp
  WHERE TIMESTAMP_MICROS(p.event_timestamp) BETWEEN TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
                                              AND CURRENT_TIMESTAMP()
  GROUP BY p.slot_position
)
SELECT *,
  ROUND(100 * SAFE_DIVIDE(accepted_unchanged, presented), 1) AS pct_unchanged_in_position,
  ROUND(100 * SAFE_DIVIDE(SUM(accepted_unchanged) OVER (), SUM(presented) OVER ()), 1) AS pct_unchanged_overall,
  SAFE_DIVIDE(accepted_unchanged, presented) = MAX(SAFE_DIVIDE(accepted_unchanged, presented)) OVER () AS is_recommended
FROM by_position
ORDER BY slot_position;
