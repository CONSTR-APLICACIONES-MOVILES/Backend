const {createHash} = require('node:crypto');
const {DEFAULT_REMINDER_DELAY_MINUTES, REMINDER_DELAY_CANDIDATES} = require('./insights');

const EXPLORE_BUCKETS = 2;
const EXPLORE_OUT_OF = 10;

/** Assigns one RSVP reminder to a stable 80/10/10 timing cohort. */
function chooseRsvpReminderDelay(activityId, participantId, recommendedDelay, minutesUntilStart) {
  const eligible = REMINDER_DELAY_CANDIDATES.filter(delay => delay < minutesUntilStart);
  if (!eligible.length) return null;

  const published = Number(recommendedDelay);
  const preferred = eligible.includes(published) ? published :
    eligible.includes(DEFAULT_REMINDER_DELAY_MINUTES) ? DEFAULT_REMINDER_DELAY_MINUTES : eligible[eligible.length - 1];
  const alternatives = eligible.filter(delay => delay !== preferred);
  if (!alternatives.length) return preferred;

  const digest = createHash('sha256').update(`${activityId}:${participantId}:bq6`).digest();
  const bucket = digest.readUInt32BE(0) % EXPLORE_OUT_OF;
  if (bucket >= EXPLORE_OUT_OF - EXPLORE_BUCKETS) {
    return alternatives[(bucket - (EXPLORE_OUT_OF - EXPLORE_BUCKETS)) % alternatives.length];
  }
  return preferred;
}

module.exports = {chooseRsvpReminderDelay, EXPLORE_BUCKETS, EXPLORE_OUT_OF};
