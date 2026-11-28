// BQ7 explorer: at which step of the New Activity form do users abandon.
// Filters: period (7, 14, 30, 90 days or own dates), group by day or week, entry point and data kind (real, test, all).
// The page only draws; the numbers come from the callable getCreationFunnel. Chart.js is already loaded in the page.
const STEP_NAMES = {opened: "Opened", details: "Details", group: "Group", duration: "Duration",
  date_time: "Date and time", place: "Place", review: "Review"};
const ENTRY_NAMES = {dashboard: "Home", group_details: "Group details", groups: "Groups", compare_availability: "Compare availability"};
const stepName = (name) => STEP_NAMES[name] || name;
const entryName = (name) => ENTRY_NAMES[name] || name;
const pct = (value) => value == null ? "n/a" : `${value}%`;
// "Details", or "Details and Group (tie)" when several steps stop the same number of attempts
const topSteps = (row) => {
  const names = (row.most_abandoned_steps && row.most_abandoned_steps.length ? row.most_abandoned_steps : [row.most_abandoned_step])
    .filter(Boolean).map(stepName);
  if (names.length === 0) return "n/a";
  const text = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return names.length > 1 ? `${text} (tie)` : text;
};

const DAY = 86400000;
// "today" and the dates of the presets in Bogota time, like the server, so both sides count the same days
const bogotaToday = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const daysBefore = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);

const FORM = `
  <div class="card" style="margin-top:20px">
    <div class="top"><span class="badge">BQ7</span><span class="badge type">Type 3 · Feature Analysis</span></div>
    <h2>At which step of the New Activity form do users abandon the creation most often?</h2>
    <form class="bq7-filters" style="display:flex;flex-wrap:wrap;gap:12px;align-items:end">
      <label>Period<br><select name="period">
        <option value="7">Last 7 days</option><option value="14">Last 14 days</option>
        <option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option>
        <option value="custom">Own dates</option></select></label>
      <label class="bq7-own" hidden>From<br><input type="date" name="from"></label>
      <label class="bq7-own" hidden>To<br><input type="date" name="to"></label>
      <label>Group by<br><select name="granularity"><option value="day">Day</option><option value="week">Week</option></select></label>
      <label>Opened from<br><select name="entry"><option value="all">All</option></select></label>
      <label>Data<br><select name="data"><option value="real">Real</option><option value="test">Test</option><option value="all">All</option></select></label>
      <button class="primary" type="submit">Apply</button>
      <button class="secondary bq7-csv" type="button" disabled>Export CSV</button>
    </form>
    <p class="status bq7-status" role="status">Choose the filters and press Apply.</p>
    <div class="stat-grid bq7-stats" hidden></div>
    <div class="chart" hidden><canvas></canvas></div>
    <table class="segments bq7-table" hidden></table>
    <p class="insight-note bq7-note" hidden></p>
  </div>`;

// container: the empty section of the page; call: httpsCallable(functions, "getCreationFunnel")
// returns {run}, so the page can read once the user is signed in
export function mountCreationExplorer(container, call) {
  container.innerHTML = FORM;
  const $ = (selector) => container.querySelector(selector);
  const form = $(".bq7-filters");
  const status = $(".bq7-status");
  let chart = null;
  let last = null;
  let requestNumber = 0;

  form.period.addEventListener("change", () => {
    container.querySelectorAll(".bq7-own").forEach((label) => { label.hidden = form.period.value !== "custom"; });
  });

  const filters = () => {
    const base = {granularity: form.granularity.value, entry: form.entry.value, data: form.data.value};
    if (form.period.value === "custom") return {...base, from: form.from.value, to: form.to.value};
    const to = bogotaToday();
    return {...base, from: daysBefore(to, Number(form.period.value) - 1), to};
  };

  // the selector lists the entry points that exist in the data; the chosen one stays chosen
  function fillEntryPoints(points, chosen) {
    const options = ["all", ...points];
    if (chosen !== "all" && !options.includes(chosen)) options.push(chosen);
    form.entry.replaceChildren(...options.map((value) => new Option(value === "all" ? "All" : entryName(value), value)));
    form.entry.value = chosen;
  }

  // the same checks as the server, with the same messages, so a bad range never reaches it
  function rangeError(f) {
    if (!f.from || !f.to) return "Choose a start and an end date.";
    if (f.from > f.to) return "The start date must be before the end date.";
    if ((Date.parse(`${f.to}T00:00:00Z`) - Date.parse(`${f.from}T00:00:00Z`)) / DAY + 1 > 90) return "The range can be at most 90 days.";
    return null;
  }

  // takes away everything of the last answer: numbers, chart, table and the CSV
  function clear() {
    last = null;
    if (chart) { chart.destroy(); chart = null; }
    $(".bq7-stats").hidden = true;
    $(".bq7-stats").innerHTML = "";
    $(".chart").hidden = true;
    $(".bq7-table").hidden = true;
    $(".bq7-table").innerHTML = "";
    $(".bq7-note").hidden = true;
    $(".bq7-csv").disabled = true;
  }

  function draw(data) {
    const s = data.summary;
    fillEntryPoints(data.entry_points, data.filters.entry);
    if (s.total_flows === 0) { // nothing to show: no zeros, no empty CSV
      clear();
      status.textContent = "No attempts with these filters.";
      return;
    }
    last = data;
    const stats = $(".bq7-stats");
    stats.hidden = false;
    stats.dataset.count = "4";
    stats.innerHTML = [
      [topSteps(s), "Step with most abandons", s.most_abandoned_steps && s.most_abandoned_steps.length > 1 ? "font-size:18px" : ""],
      [pct(s.total_flows ? s.abandon_rate : null), "Abandoned"],
      [s.total_flows, s.total_flows === 1 ? "Attempt" : "Attempts"],
      [pct(s.total_flows ? Math.round(1000 * s.total_finished / s.total_flows) / 10 : null), "Finished"],
    ].map(([value, label, style = ""]) => `<div class="stat"><strong style="${style}">${value}</strong><span>${label}</span></div>`).join("");

    const steps = [...s.steps].sort((a, b) => a.index - b.index);
    $(".chart").hidden = s.total_flows === 0;
    if (chart) chart.destroy();
    if (s.total_flows) {
      chart = new Chart($(".chart canvas"), {
        type: "bar",
        data: {
          labels: steps.map((step) => stepName(step.name)),
          datasets: [{label: "% of attempts abandoned here", data: steps.map((step) => step.percent),
            backgroundColor: steps.map((step) => step.name === s.most_abandoned_step ? "#E11D48" : "#FDA4AF")}],
        },
        options: {responsive: true, maintainAspectRatio: false, scales: {y: {beginAtZero: true, title: {display: true, text: "% of attempts"}}}},
      });
    }

    const table = $(".bq7-table");
    table.hidden = data.timeline.length === 0;
    const head = `<tr><th>${data.filters.granularity === "week" ? "Week of" : "Day"}</th><th>Attempts</th><th>Finished</th><th>Abandoned</th><th>Step with most abandons</th></tr>`;
    const rows = data.timeline.map((r) =>
      `<tr><td>${r.period}</td><td>${r.total_flows}</td><td>${r.total_finished}</td><td>${pct(r.abandon_rate)}</td><td>${topSteps(r)}</td></tr>`);
    table.innerHTML = head + rows.join("");

    const note = $(".bq7-note");
    note.hidden = false;
    note.textContent = data.explanation + (data.truncated ? " Only the first 20000 events were read: narrow the period." : "");
    status.textContent = `${s.total_flows} ${s.total_flows === 1 ? "attempt" : "attempts"} from ${data.filters.from} to ${data.filters.to}`;
    $(".bq7-csv").disabled = false;
  }

  async function run() {
    const mine = ++requestNumber; // only the last answer is drawn
    clear(); // the answer of before must not stay on the screen while the new one comes, or after an error
    const f = filters();
    const problem = rangeError(f);
    if (problem) { status.textContent = problem; return; }
    status.textContent = "Reading the attempts…";
    try {
      const result = await call(f);
      if (mine === requestNumber) draw(result.data);
    } catch (error) {
      if (mine !== requestNumber) return;
      clear();
      // organization accounts only: a normal account sees a clear message and the rest of the dashboard keeps working
      status.textContent = error.code === "functions/permission-denied"
        ? "BQ7 needs an organization account (orgAnalytics)." : `Could not read BQ7: ${error.message}`;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run();
  });

  // the timeline of the current answer as a CSV file
  $(".bq7-csv").addEventListener("click", () => {
    if (!last) return;
    const f = last.filters;
    const lines = [["period", "attempts", "finished", "abandon_rate", "most_abandoned_step"]];
    for (const r of last.timeline) lines.push([r.period, r.total_flows, r.total_finished, r.abandon_rate ?? "", r.most_abandoned_step ?? ""]);
    const csv = lines.map((line) => line.join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
    link.download = `bq7_${f.from}_${f.to}_${f.granularity}_${f.entry}_${f.data}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  return {run};
}
