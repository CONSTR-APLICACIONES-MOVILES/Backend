const number=(n,suffix='')=>n==null||!Number.isFinite(Number(n))?'—':`${Number(n).toLocaleString('en-US',{maximumFractionDigits:2})}${suffix}`;
const ratio=(n,d)=>d?100*n/d:null;
const position=n=>n>=0?`Position ${n+1}`:'Unknown position';
const delay=s=>s==='single_after_30_min'?'30 min':'60 min';
export const METRICS={bq2:[['rate','Failure / timeout %'],['volume','Attempt outcomes'],['latency','p95 duration (ms)']],
  bq3:[['rate','Accepted unchanged %'],['volume','Presented vs unchanged']],
  bq14:[['speed','Median confirmation time (min)'],['rate','Confirmation %'],['alerts','Alerts per plan'],['volume','Mature vs pending plans']]};

export function explorerView(data,metric=METRICS[data.question][0][0]) {
  const s=data.summary,t=data.timeline;
  let stats,headers,rows,breakdown,chart;
  const line=(label,values,color)=>({label,data:values,borderColor:color,backgroundColor:color,tension:.2,spanGaps:false});
  if(data.question==='bq2') {
    stats=[['Failure / timeout',number(s.failure_or_timeout_pct,'%')],['Uploaded attempts',number(s.attempts)],['Outcome coverage',number(s.coverage_pct,'%')],['Late successes',number(s.reconciled_success)]];
    headers=['Cohort date','Attempts','Success','Failure','Timeout','Unresolved','Failure / timeout %','p95 ms'];
    rows=t.map(r=>[r.date,r.attempts,r.success,r.failure,r.timeout,r.unresolved,r.failure_or_timeout_pct,r.p95_duration_ms]);
    breakdown={headers:['Failure family','Attempts'],rows:Object.entries(s.failure_categories||{})};
    chart={labels:t.map(r=>r.date),datasets:metric==='volume'?[
      line('Success',t.map(r=>r.success),'#059669'),line('Failure',t.map(r=>r.failure),'#dc2626'),
      line('Timeout',t.map(r=>r.timeout),'#d97706'),line('Unresolved',t.map(r=>r.unresolved),'#64748b')]:[
      line(metric==='latency'?'p95 ms':'Failure / timeout %',t.map(r=>metric==='latency'?r.p95_duration_ms:r.failure_or_timeout_pct),'#2563eb')]};
  } else if(data.question==='bq3') {
    stats=[['Unchanged acceptance',number(s.pct_unchanged_overall,'%')],['Presented candidates',number(s.sample_size)],['Modified',number(s.modified)],['Undecided',number(s.undecided)]];
    headers=['Exposure date','Presented','Unchanged','Modified','Not selected','Undecided','Unchanged %'];
    rows=t.map(r=>[r.date,r.sample_size,r.accepted_recommendations_unchanged,r.modified,r.not_selected,r.undecided,r.pct_unchanged_overall]);
    breakdown={headers:['Position','Presented','Unchanged','Modified','Unchanged %'],rows:(s.by_position||[]).map(r=>[
      position(r.slot_position),r.presented,r.accepted_unchanged,r.accepted-r.accepted_unchanged,ratio(r.accepted_unchanged,r.presented)])};
    chart={labels:t.map(r=>r.date),datasets:metric==='volume'?[
      line('Presented',t.map(r=>r.sample_size),'#64748b'),line('Accepted unchanged',t.map(r=>r.accepted_recommendations_unchanged),'#2563eb')]:[
      line('Accepted unchanged %',t.map(r=>r.pct_unchanged_overall),'#2563eb')]};
  } else {
    stats=[['Mature plans',number(s.mature_activities)],['Median time',number(s.median_minutes,' min')],['Alerts per plan',number(s.notifications_per_activity)],['Pending / unknown',`${number(s.pending)} / ${number(s.unknown)}`]];
    headers=['Invitation date','Total','Mature','Confirmed','Pending','Unknown','Confirmation %','Median min','p95 min','Alerts / plan'];
    rows=t.map(r=>[r.date,r.total,r.mature_activities,r.confirmed_activities,r.pending,r.unknown,r.confirmation_rate,r.median_minutes,r.p95_minutes,r.notifications_per_activity]);
    breakdown={headers:['Group size','Strategy','Mature n','Confirmed','Confirmation %','Median min','p95 min','Alerts / plan'],rows:(s.by_strategy_size||[]).map(r=>[
      r.size,delay(r.strategy),r.activities,r.confirmed,r.confirmation_rate,r.median_minutes,r.p95_minutes,r.notifications_per_activity])};
    const field={speed:'median_minutes',rate:'confirmation_rate',alerts:'notifications_per_activity'}[metric];
    chart={labels:t.map(r=>r.date),datasets:metric==='volume'?[
      line('Mature',t.map(r=>r.mature_activities),'#2563eb'),line('Pending',t.map(r=>r.pending),'#d97706')]:
      ['single_after_30_min','single_after_60_min'].filter(strategy=>data.filters.strategy==='all'||data.filters.strategy===strategy)
        .map((strategy,i)=>line(delay(strategy),t.map(r=>r.strategies?.[strategy]?.[field]??null),['#2563eb','#7c3aed'][i]))};
  }
  return {stats,headers,rows,breakdown,chart};
}

export function aggregateCsv(headers,rows) {
  const cell=value=>{
    let text=value==null?'':String(value);
    if(/^[=+@-]/.test(text))text=`'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  return '\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
}
const today=()=>{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
};
const shift=(day,days)=>new Date(Date.parse(`${day}T12:00:00Z`)+days*86400000).toISOString().slice(0,10);

export function mountActivityExplorer({root,query,Chart}) {
  root.innerHTML=`<div class="lab-heading"><div><p class="eyebrow">ACTIVITY ANALYTICS</p><h2>Explore beyond the headline</h2><p>Follow trends, narrow a cohort and inspect the numbers behind BQ2, BQ3 and BQ14.</p></div><span class="badge">Bogotá · GMT−5</span></div>
  <form class="lab-filters">
    <label>Question<select name="question"><option value="bq2">BQ2 · Creation reliability</option><option value="bq3">BQ3 · Suggested time acceptance</option><option value="bq14">BQ14 · Reminder effectiveness</option></select></label>
    <label>Period<select name="period"><option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Custom dates</option></select></label>
    <label>From<input name="from" type="date" required></label><label>Through<input name="to" type="date" required></label>
    <label>Group by<select name="granularity"><option value="day">Day</option><option value="week">Week · Monday</option></select></label>
    <label data-size hidden>Group size<select name="size"><option value="all">All sizes</option><option value="solo">Solo</option><option value="2-3">2–3 people</option><option value="4-6">4–6 people</option><option value="7+">7+ people</option><option value="unknown">Unknown size</option></select></label>
    <label data-category hidden>Category<select name="category"><option value="all">All categories</option><option>study</option><option>sports</option><option>social</option><option>other</option><option value="unknown">Unknown category</option></select></label>
    <label data-position hidden>Position<select name="position"><option value="all">All positions</option>${Array.from({length:10},(_,i)=>`<option value="${i}">Position ${i+1}</option>`).join('')}</select></label>
    <label data-strategy hidden>Reminder<select name="strategy"><option value="all">Both strategies</option><option value="single_after_30_min">After 30 min</option><option value="single_after_60_min">After 60 min</option></select></label>
    <label data-initial hidden class="lab-check"><input name="excludeInitial" type="checkbox" checked>Exclude plans already confirmed at invitation</label>
    <div class="lab-actions"><button class="primary" type="submit">Apply filters</button><button class="secondary" type="button" data-reset>Reset</button></div>
  </form>
  <p class="lab-status" role="status" aria-live="polite">Sign in to explore.</p>
  <div class="lab-results" hidden><div class="stat-grid" data-count="4" data-stats></div>
    <div class="lab-chart-heading"><label>Chart metric<select data-metric></select></label><button class="secondary" data-export>Export daily table · CSV</button></div>
    <p class="metrics" data-scope></p><div class="lab-chart"><canvas></canvas></div>
    <p class="metrics">Click a chart point to inspect that day or week. A gap means no measured rate, not zero.</p>
    <h3>Compare segments</h3><div class="lab-table-wrap" data-breakdown></div><p class="insight-note" data-evidence hidden></p>
    <details><summary>Inspect cohort table</summary><div class="lab-table-wrap" data-table></div></details>
    <p class="method" data-method></p></div>`;
  const form=root.querySelector('form'),field=name=>form.elements.namedItem(name),status=root.querySelector('.lab-status');
  const results=root.querySelector('.lab-results'),metric=root.querySelector('[data-metric]'),exportButton=root.querySelector('[data-export]');
  let user=null,generation=0,chart=null,data=null,view=null,dirty=false;
  function period(days=30){field('to').value=today();field('from').value=shift(today(),1-days);field('to').max=today();field('from').max=today();}
  period();
  function configure(){
    const q=field('question').value;
    for(const name of ['size','category','position','strategy','initial'])root.querySelector(`[data-${name}]`).hidden=
      name==='size'?q==='bq2':['category','position'].includes(name)?q!=='bq3':q!=='bq14';
    metric.replaceChildren(...METRICS[q].map(([value,label])=>new Option(label,value)));
  }
  configure();
  function table(target,headers,rows){
    target.replaceChildren();const table=document.createElement('table');table.className='segments';
    const head=table.createTHead().insertRow();for(const title of headers){const th=document.createElement('th');th.scope='col';th.textContent=title;head.append(th);}
    const body=table.createTBody();
    for(const values of rows){const tr=body.insertRow();for(const value of values){const td=tr.insertCell();td.textContent=typeof value==='number'?number(value):value??'—';}}
    if(!rows.length){const td=body.insertRow().insertCell();td.colSpan=headers.length;td.textContent='No comparable records in this selection.';}
    target.append(table);
  }
  function render(){
    if(!data)return;
    view=explorerView(data,metric.value);results.hidden=false;
    const stats=root.querySelector('[data-stats]');stats.replaceChildren();
    for(const [label,value]of view.stats){const tile=document.createElement('div');tile.className='stat';const strong=document.createElement('strong');strong.textContent=value;const span=document.createElement('span');span.textContent=label;tile.append(strong,span);stats.append(tile);}
    table(root.querySelector('[data-table]'),view.headers,view.rows);
    table(root.querySelector('[data-breakdown]'),view.breakdown.headers,view.breakdown.rows);
    const f=data.filters;
    root.querySelector('[data-scope]').textContent=`${f.from} through ${f.to} · ${f.granularity==='day'?'daily':'weekly'} cohorts · ${data.matched} matching / ${data.available} available · ${data.excludedByFilters} excluded by filters · ${data.environment}`;
    root.querySelector('[data-method]').textContent=`${data.explanation} ${f.granularity==='week'?'Boundary weeks may be partial. ':''}Historical records without size/category labels are shown only in All or Unknown filters. Exploration does not change the app’s operational recommendation policy.`;
    const evidence=root.querySelector('[data-evidence]');evidence.hidden=data.question!=='bq14';
    if(data.question==='bq14')evidence.textContent=data.filters.strategy!=='all'?'Showing one strategy. Select Both strategies to compare; a single arm cannot establish a winner.':
      (data.summary.decisions||[]).filter(r=>data.filters.size==='all'||r.size===data.filters.size)
        .map(r=>`${r.size} people: ${r.strategy?`${delay(r.strategy)} · observed joint improvement`:r.reason}.`).join(' ')+' Minimum: 20 mature plans and 5 confirmations per strategy, without initial-confirmation contamination. No causal claim.';
    chart?.destroy();chart=null;
    if(Chart)chart=new Chart(root.querySelector('canvas'),{type:'line',data:view.chart,options:{responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},plugins:{legend:{display:true}},scales:{y:{beginAtZero:true,max:metric.value==='rate'?100:undefined}},
      onClick:(_,elements)=>{if(!elements.length)return;const day=data.timeline[elements[0].index].date;field('from').value=day<data.filters.from?data.filters.from:day;
        field('to').value=data.filters.granularity==='week'?[shift(day,6),data.filters.to].sort()[0]:day;field('period').value='custom';load();}}});
    else status.textContent+=' · Chart library unavailable; inspect/export tables instead.';
    exportButton.textContent=`Export ${f.granularity==='day'?'daily':'weekly'} table · CSV`;exportButton.disabled=dirty;
  }
  async function load(){
    if(!user)return;
    if(!form.reportValidity())return;
    if(field('from').value>field('to').value){status.textContent='From must be on or before Through.';return;}
    const q=field('question').value,input={question:q,from:field('from').value,to:field('to').value,granularity:field('granularity').value};
    if(q!=='bq2')input.size=field('size').value;
    if(q==='bq3'){input.category=field('category').value;input.position=field('position').value==='all'?'all':Number(field('position').value);}
    if(q==='bq14'){input.strategy=field('strategy').value;input.excludeInitial=field('excludeInitial').checked;}
    const token=++generation;data=null;results.hidden=true;chart?.destroy();chart=null;status.textContent='Loading filtered server measurements…';
    form.querySelector('[type=submit]').disabled=true;
    try{const response=await query(input);if(token!==generation||!user)return;data=response;dirty=false;
      status.textContent=response.matched?`Updated ${new Date(response.updatedAt).toLocaleTimeString()} · ${response.environment==='test'?'TEST DATA · ':''}aggregated server records only`:
        'No measurements match these filters. Broaden the dates or segments; no rate can be inferred.';render();
    }catch(error){if(token!==generation)return;
      status.textContent=/invalid-argument|resource-exhausted/.test(error.code||'')
        ? `${error.message} Change the filters and apply again.`
        : `Could not explore: ${error.message||'request failed'}. The getActivityAnalytics backend must be deployed and reachable. Summary cards remain available below.`;}
    finally{if(token===generation)form.querySelector('[type=submit]').disabled=false;}
  }
  form.addEventListener('submit',event=>{event.preventDefault();load();});
  form.addEventListener('change',event=>{
    generation++;data=null;results.hidden=true;chart?.destroy();chart=null;
    form.querySelector('[type=submit]').disabled=false;
    if(event.target.name==='question'){configure();load();return;}
    if(event.target.name==='period'&&event.target.value!=='custom')period(Number(event.target.value));
    if(['from','to'].includes(event.target.name))field('period').value='custom';
    dirty=true;exportButton.disabled=true;status.textContent='Filters changed. Apply filters to update the result.';
  });
  metric.addEventListener('change',()=>render());
  root.querySelector('[data-reset]').addEventListener('click',()=>{form.reset();period();configure();load();});
  exportButton.addEventListener('click',()=>{
    if(!data||dirty)return;const blob=new Blob([aggregateCsv(view.headers,view.rows)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`${data.question}-${data.filters.from}-${data.filters.to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  return {load,setUser(uid){if(user===uid)return;user=uid;generation++;data=null;results.hidden=true;chart?.destroy();chart=null;
    form.querySelector('[type=submit]').disabled=false;status.textContent=uid?'Choose a question and apply filters.':'Sign in to explore.';}};
}
