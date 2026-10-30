// Read organization aggregates; never reconstruct business metrics in the browser.
export function createActivityQuestions({reminderLabel}) {
  return [
    {
      id: 'bq2', owner: 'Gabriel Pinto', type: 'Type 1 · Reliability', doc: 'bq2_creation_reliability',
      question: 'What percentage of activity creation attempts fail or time out?',
      hasData: d => d.attempts > 0,
      empty: 'No uploaded attempts in the last 30 days. An empty denominator has no rate.',
      render: d => ({
        number: `${d.failure_or_timeout_pct}%`, detail: `${d.failure + d.timeout} failures/timeouts out of ${d.attempts} attempts`,
        metrics: `Success: ${d.success} · Failure: ${d.failure} · Timeout: ${d.timeout} · Unresolved: ${d.unresolved}\nOutcome coverage: ${d.coverage_pct}% · p95: ${d.p95_duration_ms ?? '—'} ms\nLogical publications: ${d.logical_publications} · Timeout followed by success: ${d.reconciled_success}\nClient deadline: 8 s. A later server success does not erase the observed timeout.\nScope: uploaded Flutter network observations. Local validation/offline blocks, undelivered observations and legacy Java are excluded.`,
        chart: {labels: ['Success', 'Failure', 'Timeout', 'Unresolved'], datasets: [{label: 'Attempts', data: [d.success,d.failure,d.timeout,d.unresolved], backgroundColor: ['#10B981','#DC2626','#D97706','#64748B']}]},
      }),
    },
    {
      id: 'bq3', owner: 'Gabriel Pinto · shared BQ3 integration', type: 'Type 2 · Experience', doc: 'bq3_slot_acceptance',
      question: 'What percentage of presented recommendations are accepted without changes?',
      hasData: d => d.sample_size > 0,
      empty: 'No presented recommendations in the current window. The base ranking remains active.',
      render: d => ({
        number: `${d.pct_unchanged_overall}%`, detail: `${d.accepted_recommendations_unchanged} unchanged / ${d.sample_size} presented`,
        metrics: `Modified: ${d.modified ?? '—'} · Not selected: ${d.not_selected ?? '—'} · Undecided: ${d.undecided ?? '—'}\nAll unique presented candidates belong in the denominator, including those never selected. Retries do not add exposures. Acceptance does not mean activity confirmation.`,
        chart: {labels: d.by_position.map(r => `Position ${r.slot_position + 1}`), datasets: [
          {label: 'Presented', data: d.by_position.map(r=>r.presented), backgroundColor:'#93C5FD'},
          {label:'Accepted unchanged',data:d.by_position.map(r=>r.accepted_unchanged),backgroundColor:'#003D9B'},
        ]},
      }),
    },
    {
      id:'bq13',owner:'Gabriel Pinto · attribution and integration',type:'Type 5 · Confirmation',doc:'bq13_recommendation_confirmation',
      question:'Which recommended time slots have higher confirmation rates for similar groups?',
      hasData:d=>d.opportunities>0,
      empty:'No presented recommendations in the last 30 days. The base ranking remains active.',
      render:d=>({
        number:d.confirmation_rate == null ? '—' : `${d.confirmation_rate}%`,
        detail:`${d.confirmed} attributable confirmations / ${d.mature_opportunities} mature opportunities`,
        metrics:`Observation window: 24 h after first batch exposure. Pending: ${d.pending} · History without attribution: ${d.unknown} · Coverage: ${d.coverage_pct}%\nOnly the selected unchanged suggestion can receive the first confirmation. Acceptance is not confirmation.\nHistorical ranking requires 20 opportunities per segment and an aggregate newer than 48 h; otherwise the base ranking applies.\nConfirmation means activity state CONFIRMED, not unanimous attendance.`,
        table:{headers:['Group / category','Day / time band','Sample','Confirmation'],rows:d.by_segment.map(r=>[`${r.size} · ${r.category}`,`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][r.weekday]} · ${r.bucket}`,r.opportunities,`${r.confirmation_rate}%`])},
        chart:{labels:d.by_segment.map(r=>`${r.size} · ${r.bucket} · day ${r.weekday}`),datasets:[{label:'Confirmation %',data:d.by_segment.map(r=>r.confirmation_rate),backgroundColor:'#003D9B'}]},
      }),
    },
    {
      id:'bq14',owner:'Gabriel Pinto',type:'Type 5 · Reminder strategy',doc:'bq14_reminder_effectiveness',
      question:'Which reminder strategy confirms activities sooner with fewer reminders, by group size?',
      hasData:d=>d.total>0,
      empty:'No instrumented activities to compare. No winning strategy has been demonstrated.',
      render:d=>({
        number:`${d.mature_activities}`,detail:'mature comparable activities',
        metrics:`Channel: in-app. Observation: 24 h after invitation. Pending: ${d.pending} · Unknown projection: ${d.unknown}.\nOnly cohorts with a recorded RSVP reminder policy are included. Uninstrumented history is excluded.\nActivity confirmation is not attendance consensus. This comparison is observational, not causal.\n${d.decisions.map(r=>`${r.size}: ${r.strategy ? reminderLabel(r.strategy) : 'insufficient evidence / no joint improvement'}`).join('\n')}`,
        table:{headers:['Size / strategy','n / confirmation','Median / p95 min','Reminders / activity'],rows:d.by_strategy_size.map(r=>[`${r.size} · ${reminderLabel(r.strategy)}`,`${r.activities} / ${r.confirmation_rate}%`,`${r.median_minutes ?? '—'} / ${r.p95_minutes ?? '—'}`,r.notifications_per_activity.toFixed(2)])},
        chart:{labels:d.by_strategy_size.map(r=>`${r.size} · ${reminderLabel(r.strategy)}`),datasets:[{label:'Confirmation %',data:d.by_strategy_size.map(r=>r.confirmation_rate),backgroundColor:'#10B981'}]},
      }),
    },
  ];
}
