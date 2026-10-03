const fs = require("fs");
const path = require("path");

/* Table name used in the SQL files; replaced with the real Analytics export dataset at run time. */
const TABLE_PLACEHOLDER = "`parchapp.analytics_PROPERTY_ID.events_*`";

/* Same default as InsightsRepository.DEFAULT_RECOMMENDED_POSITION in the Android app: the top-ranked slot. */
const DEFAULT_RECOMMENDED_POSITION = 0;

/* Minimum presented slots before the result replaces the default. */
const MIN_SAMPLE = 20;

function loadQuery(fileName, projectId, dataset) {
  const sql = fs.readFileSync(path.join(__dirname, "..", "sql", fileName), "utf8");
  if (!sql.includes(TABLE_PLACEHOLDER)) {
    throw new Error(`${fileName} no longer contains ${TABLE_PLACEHOLDER}`);
  }
  return sql.split(TABLE_PLACEHOLDER).join(`\`${projectId}.${dataset}.events_*\``);
}

/* Turns presentation/decision counts into the existing insight document.
   Compare unchanged acceptance rates; the lowest position wins ties.
 */
function buildSlotInsight(rows) {
  const sample = rows.reduce((sum, row) => sum + Number(row.presented), 0);
  const unchanged = rows.reduce((sum, row) => sum + Number(row.accepted_unchanged), 0);
  const recommended = rows.filter((row) => Number(row.presented) > 0).sort((a, b) =>
    Number(b.accepted_unchanged) / Number(b.presented) - Number(a.accepted_unchanged) / Number(a.presented) ||
    Number(a.slot_position) - Number(b.slot_position));
  const enoughData = sample >= MIN_SAMPLE && unchanged > 0 && recommended.length > 0;
  return {
    recommended_position: enoughData ? Number(recommended[0].slot_position) : DEFAULT_RECOMMENDED_POSITION,
    pct_unchanged_overall: sample ? Math.round(1000 * unchanged / sample) / 10 : null,
    sample_size: sample,
    recommendations_presented: sample,
    accepted_recommendations_unchanged: unchanged,
    by_position: rows.map((row) => ({
      slot_position: Number(row.slot_position),
      presented: Number(row.presented),
      accepted: Number(row.accepted),
      accepted_unchanged: Number(row.accepted_unchanged),
    })),
  };
}

function buildRecommendationInsight(records) {
  const positions = new Map();
  for (const record of records) {
    if (!record.presentedAt) continue;
    const row = positions.get(record.position) ?? {
      slot_position: record.position, presented: 0, accepted: 0, accepted_unchanged: 0,
    };
    row.presented++;
    if (["ACCEPTED_UNCHANGED", "MODIFIED"].includes(record.outcome)) row.accepted++;
    if (record.outcome === "ACCEPTED_UNCHANGED") row.accepted_unchanged++;
    positions.set(record.position, row);
  }
  return buildSlotInsight([...positions.values()].sort((a, b) => a.slot_position - b.slot_position));
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
  buildRecommendationInsight,
  buildResponseTimeInsight,
  DEFAULT_RECOMMENDED_POSITION,
  MIN_SAMPLE,
  MIN_COMPLETED,
  MIN_RESPONSES,
};
