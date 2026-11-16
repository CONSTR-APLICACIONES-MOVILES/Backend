WITH responses AS (
  SELECT
    COALESCE(user_id, user_pseudo_id) AS responder,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'group_size') AS group_size,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'response_ms') AS response_ms
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'rsvp_submitted'
    AND _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))
                          AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())
),
first_answers AS (
  SELECT activity_id, group_size, responder, MIN(response_ms) AS response_ms
  FROM responses
  WHERE activity_id IS NOT NULL AND group_size IS NOT NULL AND response_ms >= 0
  GROUP BY activity_id, group_size, responder
),
invitations AS (
  SELECT
    activity_id,
    group_size,
    COUNT(*) AS responders,
    MAX(response_ms) AS last_response_ms
  FROM first_answers
  GROUP BY activity_id, group_size
),
by_size AS (
  SELECT
    group_size,
    COUNT(*) AS invitations,
    COUNTIF(responders >= group_size) AS completed,
    ROUND(AVG(IF(responders >= group_size, last_response_ms, NULL)) / 60000, 1) AS avg_minutes_all_responded,
    ROUND(APPROX_QUANTILES(IF(responders >= group_size, last_response_ms, NULL), 100)[SAFE_OFFSET(50)] / 60000, 1)
      AS median_minutes_all_responded
  FROM invitations
  GROUP BY group_size
),
per_response AS (
  SELECT
    group_size,
    COUNT(*) AS responses,
    ROUND(AVG(response_ms) / 60000, 1) AS avg_minutes_per_response
  FROM first_answers
  GROUP BY group_size
)
SELECT
  s.group_size,
  s.invitations,
  s.completed,
  ROUND(100 * s.completed / s.invitations, 1) AS pct_completed,
  s.avg_minutes_all_responded,
  s.median_minutes_all_responded,
  r.responses,
  r.avg_minutes_per_response
FROM by_size s
JOIN per_response r USING (group_size)
ORDER BY s.group_size;
