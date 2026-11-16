/* BQ4 (Type 2): acceptance when the participant was busy when invited. */
WITH invitations AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    user_pseudo_id AS participant,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'availability_at_invitation') AS availability
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'invitation_sent'
), responses AS (
  SELECT
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'activity_id') AS activity_id,
    user_pseudo_id AS participant,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'response') AS response
  FROM `parchapp.analytics_PROPERTY_ID.events_*`
  WHERE event_name = 'rsvp_submitted'
)
SELECT
  COUNT(*) AS busy_invitations,
  COUNTIF(r.response = 'accepted' OR r.response = 'going') AS busy_acceptances,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(r.response IN ('accepted', 'going')), COUNT(*)), 1) AS acceptance_pct
FROM invitations i
LEFT JOIN responses r USING (activity_id, participant)
WHERE i.availability = 'BUSY';
