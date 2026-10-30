// Card presentation only; measurements come from shared server aggregates.
const value = (n, suffix = '') => n == null ? '—' : `${n}${suffix}`;
export const compareQuestionIds = (a, b) => Number(a.id.replace(/^bq/, '')) - Number(b.id.replace(/^bq/, ''));

export function createActivityQuestions({reminderLabel}) {
  return [
    {
      id:'bq2',type:'Type 1 · Reliability',doc:'bq2_creation_reliability',
      question:'How often does activity creation fail or time out?',
      hasData:d=>d.attempts>0,
      empty:'No uploaded attempts yet. A rate needs a sample.',
      render:d=>({
        number:value(d.failure_or_timeout_pct,'%'),detail:`${d.failure+d.timeout} failures/timeouts out of ${d.attempts} attempts`,
        stats:[{label:'Successful',value:value(d.success)},{label:'Failed',value:value(d.failure)},{label:'Timed out',value:value(d.timeout)},{label:'Unresolved',value:value(d.unresolved)}],
        metrics:'8 s deadline · Uploaded Flutter attempts',
        method:`Outcome coverage: ${value(d.coverage_pct,'%')} · p95: ${value(d.p95_duration_ms,' ms')} · Late successes: ${value(d.reconciled_success)}. A later success does not erase a timeout. Local blocks, undelivered observations and legacy Java are excluded.`,
        chart:{labels:['Success','Failure','Timeout','Unresolved'],datasets:[{label:'Attempts',data:[d.success,d.failure,d.timeout,d.unresolved],backgroundColor:['#10B981','#DC2626','#F59E0B','#94A3B8']}]},
      }),
    },
    {
      id:'bq3',type:'Type 2 · Experience',doc:'bq3_slot_acceptance',
      question:'How often are suggested times accepted unchanged?',
      hasData:d=>d.sample_size>0,
      empty:'No presented suggestions yet. The base ranking remains active.',
      render:d=>({
        number:value(d.pct_unchanged_overall,'%'),detail:`${d.accepted_recommendations_unchanged} unchanged / ${d.sample_size} presented`,
        stats:[{label:'Modified',value:value(d.modified)},{label:'Not selected',value:value(d.not_selected)},{label:'Undecided',value:value(d.undecided)}],
        metrics:'Acceptance is not activity confirmation.',
        method:'All unique presented suggestions enter the denominator, including unselected ones. Retries do not add exposures.',
        chart:{labels:d.by_position.map(r=>`Position ${r.slot_position+1}`),datasets:[{label:'Presented',data:d.by_position.map(r=>r.presented),backgroundColor:'#BFDBFE'},{label:'Accepted unchanged',data:d.by_position.map(r=>r.accepted_unchanged),backgroundColor:'#2563EB'}]},
      }),
    },
    {
      id:'bq13',type:'Type 5 · Confirmation',doc:'bq13_recommendation_confirmation',
      question:'Which suggested times lead to confirmed activities?',
      hasData:d=>d.opportunities>0,
      empty:'No presented suggestions yet. The base ranking remains active.',
      render:d=>({
        number:value(d.confirmation_rate,'%'),detail:`${d.confirmed} confirmations / ${d.mature_opportunities} mature opportunities`,
        stats:[{label:'Mature',value:value(d.mature_opportunities)},{label:'Pending',value:value(d.pending)},{label:'Unattributed',value:value(d.unknown)}],
        note:d.mature_opportunities>0?'Comparable groups · first confirmation':'Waiting for attributable, mature observations',
        tone:d.mature_opportunities>0?'neutral':'warning',
        metrics:'24 h observation · Similar group segments',
        method:`Coverage: ${value(d.coverage_pct,'%')}. Acceptance is not confirmation. Only the selected unchanged suggestion receives attribution; historical ranking needs 20 opportunities per segment and an aggregate newer than 48 h.`,
        table:{headers:['Group / category','Day / time','Sample','Confirmed'],rows:d.by_segment.map(r=>[`${r.size} · ${r.category}`,`${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][r.weekday]} · ${r.bucket}`,r.opportunities,value(r.confirmation_rate,'%')])},
        chart:{labels:d.by_segment.map(r=>`${r.size} · ${r.bucket} · day ${r.weekday}`),datasets:[{label:'Confirmation %',data:d.by_segment.map(r=>r.confirmation_rate),backgroundColor:'#2563EB'}]},
      }),
    },
    {
      id:'bq14',type:'Type 5 · Reminders',doc:'bq14_reminder_effectiveness',
      question:'Which reminders confirm plans faster with fewer alerts?',
      hasData:d=>d.total>0,
      empty:'No instrumented activities yet. No strategy can be compared.',
      render:d=>({
        number:value(d.mature_activities),detail:'mature activities available for comparison',
        stats:[{label:'Activities',value:value(d.total)},{label:'Pending',value:value(d.pending)},{label:'Unclassified',value:value(d.unknown)}],
        note:d.decisions.some(r=>r.strategy)?d.decisions.filter(r=>r.strategy).map(r=>`${r.size} people: ${reminderLabel(r.strategy)}`).join(' · '):'No winner yet — insufficient evidence or no joint improvement',
        tone:d.decisions.some(r=>r.strategy)?'positive':'warning',
        metrics:'30 vs 60 min · In-app reminders · 24 h observation',
        method:'Compare confirmation speed, rate and alerts per activity by group size. At least 20 activities and 5 confirmations per strategy are needed. Observational, not causal; uninstrumented history is excluded.',
        table:{headers:['Size / delay','n / confirmed','Median / p95 min','Alerts / plan'],rows:d.by_strategy_size.map(r=>[`${r.size} · ${reminderLabel(r.strategy)}`,`${r.activities} / ${value(r.confirmation_rate,'%')}`,`${value(r.median_minutes)} / ${value(r.p95_minutes)}`,r.notifications_per_activity.toFixed(2)])},
        chart:{labels:d.by_strategy_size.map(r=>`${r.size} · ${reminderLabel(r.strategy)}`),datasets:[{label:'Confirmation %',data:d.by_strategy_size.map(r=>r.confirmation_rate),backgroundColor:'#10B981'}]},
      }),
    },
  ];
}
