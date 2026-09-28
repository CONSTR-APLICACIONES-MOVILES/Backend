  /*BQ3 (Type 2, Direct User Experience Improvement)
    What percentage of the time slots suggested by the recommendation engine are accepted by the
    organizer without being changed?

      Source event: slot_accepted, logged by CreateActivitySheet when an activity is created from a
      slot chosen in Compare Availability. slot_position is the slot's place in the ranked list
      (0 = best match); modified = 1 when the organiser changed the time or the group before creating.
      
      Feedback loop: the row with is_recommended = TRUE gives the value that must be copied to the
      Firestore document insights/bq3_slot_acceptance, field recommended_position (a number). The app
      reads it in FirestoreInsightsRepository and marks that slot as Recommended (feature F2).

      The table name is a placeholder: src/insights.js loadQuery() replaces it with the real export dataset. When pasting into the BigQuery console, replace `parchapp.analytics_PROPERTY_ID` by hand. */

WITH accepted AS (
  SELECT
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'slot_position') AS slot_position,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'modified') AS modified
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'slot_accepted'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
),
by_position AS (
  SELECT
    slot_position,
    COUNT(*) AS accepted,
    COUNTIF(modified = 0) AS accepted_unchanged
  FROM accepted
  WHERE slot_position IS NOT NULL
  GROUP BY slot_position
)
SELECT
  slot_position,
  accepted,
  accepted_unchanged,
  ROUND(100 * accepted_unchanged / accepted, 1) AS pct_unchanged_in_position,
  ROUND(100 * SUM(accepted_unchanged) OVER () / SUM(accepted) OVER (), 1) AS pct_unchanged_overall,
  accepted_unchanged = MAX(accepted_unchanged) OVER () AS is_recommended
FROM by_position
ORDER BY slot_position;
