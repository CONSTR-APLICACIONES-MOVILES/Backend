const fs = require("fs");
const path = require("path");

/* Table name used in the SQL files; replaced with the real Analytics export dataset at run time. */
const TABLE_PLACEHOLDER = "`parchapp.analytics_PROPERTY_ID.events_*`";

/* Same default as InsightsRepository.DEFAULT_RECOMMENDED_POSITION in the Android app: the top-ranked slot. */
const DEFAULT_RECOMMENDED_POSITION = 0;

/* Minimum accepted slots before the result replaces the default; too few events would just be noise. */
const MIN_SAMPLE = 20;

function loadQuery(fileName, projectId, dataset) {
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", fileName), "utf8");
  if (!sql.includes(TABLE_PLACEHOLDER)) {
    throw new Error(`${fileName} no longer contains ${TABLE_PLACEHOLDER}`);
  }
  return sql.split(TABLE_PLACEHOLDER).join(`\`${projectId}.${dataset}.events_*\``);
}

/*Turns the BQ3 query rows into the insights/bq3_slot_acceptance document.
  On a tie the query marks several rows as recommended; the lowest position wins, because it is already the engine's own preference.
 */
function buildSlotInsight(rows) {
  const sample = rows.reduce((sum, row) => sum + Number(row.accepted), 0);
  const recommended = rows
      .filter((row) => row.is_recommended)
      .map((row) => Number(row.slot_position))
      .sort((a, b) => a - b);
  const pctUnchanged = rows.length > 0 ? Number(rows[0].pct_unchanged_overall) : null;

  const enoughData = sample >= MIN_SAMPLE && recommended.length > 0;
  return {
    recommended_position: enoughData ? recommended[0] : DEFAULT_RECOMMENDED_POSITION,
    pct_unchanged_overall: pctUnchanged,
    sample_size: sample,
    by_position: rows.map((row) => ({
      slot_position: Number(row.slot_position),
      accepted: Number(row.accepted),
      accepted_unchanged: Number(row.accepted_unchanged),
    })),
  };
}

module.exports = {loadQuery, buildSlotInsight, DEFAULT_RECOMMENDED_POSITION, MIN_SAMPLE};
