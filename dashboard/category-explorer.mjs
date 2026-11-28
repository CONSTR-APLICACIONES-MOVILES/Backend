// BQ10 explorer: which activity categories are used most and least, and what percentage of each reaches CONFIRMED.
// Filters: period (7, 14, 30, 90 days or own dates), group by day or week, group size and category.
// The page only draws; the numbers come from the callable getCategoryConfirmation. Chart.js is already loaded in the page.
const CATEGORY_NAMES = {study: "Study", sports: "Sports", social: "Social", other: "Other", unknown: "No category"};
const name = (category) => CATEGORY_NAMES[category] || category;
const pct = (value) => value == null ? "n/a" : `${value}%`;
const activitiesText = (count) => `${count} ${count === 1 ? "activity" : "activities"}`;

const DAY = 86400000;
// "today" and the dates of the presets in Bogota time, like the server, so both sides count the same days
const bogotaToday = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
const daysBefore = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);

const FORM = `
  <div class="card" style="margin-top:20px">
    <div class="top"><span class="badge">BQ10</span><span class="badge type">Type 3 · Feature Analysis</span></div>
    <h2>Which activity categories are selected most and least, and what percentage of each reaches Confirmed?</h2>
    <form class="bq10-filters" style="display:flex;flex-wrap:wrap;gap:12px;align-items:end">
      <label>Period<br><select name="period">
        <option value="7">Last 7 days</option><option value="14">Last 14 days</option>
        <option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option>
        <option value="custom">Own dates</option></select></label>
      <label class="bq10-own" hidden>From<br><input type="date" name="from"></label>
      <label class="bq10-own" hidden>To<br><input type="date" name="to"></label>
      <label>Group by<br><select name="granularity"><option value="day">Day</option><option value="week">Week</option></select></label>
      <label>Group size<br><select name="size"><option value="all">All</option><option value="solo">Solo</option>
        <option value="2-3">2-3</option><option value="4-6">4-6</option><option value="7+">7+</option></select></label>
      <label>Category<br><select name="category"><option value="all">All</option><option value="study">Study</option>
        <option value="sports">Sports</option><option value="social">Social</option><option value="other">Other</option></select></label>
      <button class="primary" type="submit">Apply</button>
      <button class="secondary bq10-csv" type="button" disabled>Export CSV</button>
    </form>
    <p class="status bq10-status" role="status">Choose the filters and press Apply.</p>
    <div class="stat-grid bq10-stats" hidden></div>
    <div class="chart" hidden><canvas></canvas></div>
    <table class="segments bq10-cat-table" hidden></table>
    <table class="segments bq10-table" hidden></table>
    <p class="insight-note bq10-note" hidden></p>
  </div>`;

// container: the empty section of the page; call: httpsCallable(functions, "getCategoryConfirmation")
// returns {run}, so the page can read once the user is signed in
export function mountCategoryExplorer(container, call) {
  container.innerHTML = FORM;
  const $ = (selector) => container.querySelector(selector);
  const form = $(".bq10-filters");
  const status = $(".bq10-status");
  let chart = null;
  let last = null;
  let requestNumber = 0;

  form.period.addEventListener("change", () => {
    container.querySelectorAll(".bq10-own").forEach((label) => { label.hidden = form.period.value !== "custom"; });
  });

  const filters = () => {
    if (form.period.value === "custom") {
      return {from: form.from.value, to: form.to.value, granularity: form.granularity.value,
        size: form.size.value, category: form.category.value};
    }
    const to = bogotaToday();
    return {from: daysBefore(to, Number(form.period.value) - 1), to, granularity: form.granularity.value,
      size: form.size.value, category: form.category.value};
  };

  // the same checks as the server, with the same messages, so a bad range never reaches it
  function rangeError(f) {
    if (!f.from || !f.to) return "Choose a start and an end date.";
    if (f.from > f.to) return "The start date must be before the end date.";
    if ((Date.parse(`${f.to}T00:00:00Z`) - Date.parse(`${f.from}T00:00:00Z`)) / DAY + 1 > 90) return "The range can be at most 90 days.";
    return null;
  }

  // takes away everything of the last answer: numbers, chart, tables and the CSV
  function clear() {
    last = null;
    if (chart) { chart.destroy(); chart = null; }
    $(".bq10-stats").hidden = true;
    $(".bq10-stats").innerHTML = "";
    $(".chart").hidden = true;
    $(".bq10-cat-table").hidden = true;
    $(".bq10-cat-table").innerHTML = "";
    $(".bq10-table").hidden = true;
    $(".bq10-table").innerHTML = "";
    $(".bq10-note").hidden = true;
    $(".bq10-csv").disabled = true;
  }

  function draw(data) {
    const s = data.summary;
    if (s.total === 0) { // nothing to show: no zeros, no empty CSV
      clear();
      status.textContent = "No activities with these filters.";
      return;
    }
    last = data;
    const stats = $(".bq10-stats");
    stats.hidden = false;
    stats.dataset.count = "4";
    const oneCategory = s.by_category.length === 1;
    stats.innerHTML = [
      [s.most_used ? name(s.most_used) : "n/a", "Most used"],
      oneCategory ? ["Only one category in this range", "Least used", "font-size:14px"] : [s.least_used ? name(s.least_used) : "n/a", "Least used"],
      [s.total, s.total === 1 ? "Activity" : "Activities"],
      [pct(s.confirmation_pct), "Reach Confirmed"],
    ].map(([value, label, style = ""]) => `<div class="stat"><strong style="${style}">${value}</strong><span>${label}</span></div>`).join("");

    const categoryTable = $(".bq10-cat-table");
    categoryTable.hidden = s.by_category.length === 0;
    categoryTable.innerHTML = `<tr><th>Category</th><th>Activities</th><th>Confirmed</th><th>% Confirmed</th></tr>` +
      s.by_category.map((r) => `<tr><td>${name(r.category)}</td><td>${r.activities}</td><td>${r.confirmed}</td><td>${pct(r.confirmation_pct)}</td></tr>`).join("");

    $(".chart").hidden = s.by_category.length === 0;
    if (chart) chart.destroy();
    if (s.by_category.length) {
      chart = new Chart($(".chart canvas"), {
        type: "bar",
        data: {
          labels: s.by_category.map((r) => name(r.category)),
          datasets: [
            {label: "Activities", data: s.by_category.map((r) => r.activities), backgroundColor: "#BFDBFE", yAxisID: "y"},
            {label: "% Confirmed", data: s.by_category.map((r) => r.confirmation_pct), backgroundColor: "#10B981", yAxisID: "y1"},
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {y: {beginAtZero: true, ticks: {precision: 0}, title: {display: true, text: "Activities"}},
            y1: {position: "right", min: 0, max: 100, grid: {drawOnChartArea: false}, title: {display: true, text: "% Confirmed"}}},
        },
      });
    }

    const table = $(".bq10-table");
    table.hidden = data.timeline.length === 0;
    const head = `<tr><th>${data.filters.granularity === "week" ? "Week of" : "Day"}</th><th>Activities</th><th>Confirmed</th><th>%</th><th>Most used</th></tr>`;
    const rows = data.timeline.map((r) =>
      `<tr><td>${r.period}</td><td>${r.total}</td><td>${r.confirmed}</td><td>${pct(r.confirmation_pct)}</td><td>${r.most_used ? name(r.most_used) : "n/a"}</td></tr>`);
    table.innerHTML = head + rows.join("");

    const note = $(".bq10-note");
    note.hidden = false;
    note.textContent = data.explanation + (data.truncated ? " Only the first 10000 activities were read: narrow the period." : "");
    status.textContent = s.total ? `${activitiesText(s.total)} from ${data.filters.from} to ${data.filters.to}` : "No activities with these filters.";
    $(".bq10-csv").disabled = false;
  }

  async function run() {
    const mine = ++requestNumber; // only the last answer is drawn
    clear(); // the answer of before must not stay on the screen while the new one comes, or after an error
    const f = filters();
    const problem = rangeError(f);
    if (problem) { status.textContent = problem; return; }
    status.textContent = "Reading the activities…";
    try {
      const result = await call(f);
      if (mine === requestNumber) draw(result.data);
    } catch (error) {
      if (mine !== requestNumber) return;
      clear();
      // organization accounts only: a normal account sees a clear message and the rest of the dashboard keeps working
      status.textContent = error.code === "functions/permission-denied"
        ? "BQ10 needs an organization account (orgAnalytics)." : `Could not read BQ10: ${error.message}`;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run();
  });

  // the timeline of the current answer as a CSV file
  $(".bq10-csv").addEventListener("click", () => {
    if (!last) return;
    const f = last.filters;
    const lines = [["period", "activities", "confirmed", "confirmation_pct", "most_used", "least_used"]];
    for (const r of last.timeline) lines.push([r.period, r.total, r.confirmed, r.confirmation_pct ?? "", r.most_used ?? "", r.least_used ?? ""]);
    const csv = lines.map((line) => line.join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
    link.download = `bq10_${f.from}_${f.to}_${f.granularity}_${f.size}_${f.category}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  return {run};
}
