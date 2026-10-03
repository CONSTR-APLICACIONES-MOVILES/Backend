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

const MIN_COMPLETED = 3;

const MIN_RESPONSES = 5;

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function buildResponseTimeInsight(rows) {
  const bySize = rows.map((row) => {
    const completed = Number(row.completed);
    const responses = Number(row.responses);
    const allResponded = numberOrNull(row.avg_minutes_all_responded);
    const perResponse = numberOrNull(row.avg_minutes_per_response);

    let estimateMinutes = null;
    let estimateKind = null;
    if (completed >= MIN_COMPLETED && allResponded !== null) {
      estimateMinutes = allResponded;
      estimateKind = "all_responded";
    } else if (responses >= MIN_RESPONSES && perResponse !== null) {
      estimateMinutes = perResponse;
      estimateKind = "per_response";
    }

    return {
      group_size: Number(row.group_size),
      invitations: Number(row.invitations),
      completed,
      pct_completed: numberOrNull(row.pct_completed),
      avg_minutes_all_responded: allResponded,
      median_minutes_all_responded: numberOrNull(row.median_minutes_all_responded),
      responses,
      avg_minutes_per_response: perResponse,
      estimate_minutes: estimateMinutes,
      estimate_kind: estimateKind,
    };
  });

  return {
    by_group_size: bySize,
    invitations: bySize.reduce((sum, row) => sum + row.invitations, 0),
    completed: bySize.reduce((sum, row) => sum + row.completed, 0),
    min_completed: MIN_COMPLETED,
    min_responses: MIN_RESPONSES,
  };
}

module.exports = {
  loadQuery,
  buildSlotInsight,
  buildResponseTimeInsight,
  DEFAULT_RECOMMENDED_POSITION,
  MIN_SAMPLE,
  MIN_COMPLETED,
  MIN_RESPONSES,
};
