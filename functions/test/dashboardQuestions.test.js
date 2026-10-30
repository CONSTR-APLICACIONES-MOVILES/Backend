const test=require('node:test'),assert=require('node:assert/strict');
const {buildCreationInsight}=require('../src/activityInsights');
const {buildReminderInsight}=require('../src/reminderInsights');
const questions=async()=> (await import('../../dashboard/activity-questions.mjs')).createActivityQuestions({reminderLabel:s=>s==='single_after_30_min'?'30 min':'60 min'});
test('BQ2 card answers the server metric and preserves unresolved and reconciled timeouts',async()=>{
  const now=new Date('2026-10-30T15:00:00Z');
  const records=Array.from({length:10},(_,i)=>({uid:'private-person',attemptId:`a${i}`,requestId:`r${i}`,startedAt:now,environment:'production',outcome:i<2?'failure':i===2?'timeout':i===9?null:'success',durationMs:1000}));
  records[2].remoteOutcome='success';
  const data=buildCreationInsight(records,now),q=(await questions()).find(q=>q.id==='bq2'),v=q.render(data);
  assert.equal(v.number,'30%');assert.match(v.detail,/3 failures\/timeouts out of 10/);
  assert.deepEqual(v.chart.datasets[0].data,[6,2,1,1]);assert.match(v.metrics,/Timeout followed by success: 1/);
  assert.ok(!JSON.stringify(v).includes('private-person'));assert.equal(q.hasData(buildCreationInsight([],now)),false);
});
test('BQ14 card shows a mature observed result without inventing a winner from a tiny sample',async()=>{
  const now=new Date('2026-10-30T15:00:00Z'),invited=new Date(+now-2*86400000);
  const data=buildReminderInsight([{activityId:'a',environment:'production',strategy:'single_after_30_min',groupSize:3,invitedAt:invited}],new Map([['a',{firstConfirmedAt:new Date(+invited+45*60000)}]]),[{activityId:'a',recipientId:'p',environment:'production',purpose:'rsvp',strategy:'single_after_30_min',sequence:1,sentAt:new Date(+invited+30*60000)}],now);
  const q=(await questions()).find(q=>q.id==='bq14'),v=q.render(data);
  assert.equal(v.number,'1');assert.match(v.metrics,/insufficient evidence/);assert.match(v.metrics,/not causal/);
  assert.equal(v.table.rows[0][2],'45 / 45');assert.equal(v.table.rows[0][3],'1.00');
});
test('all owned cards have unique shared aggregate IDs, attribution and explicit empty states',async()=>{
  const qs=await questions();assert.deepEqual(qs.map(q=>q.id),['bq2','bq3','bq13','bq14']);
  assert.equal(new Set(qs.map(q=>q.doc)).size,4);
  for(const q of qs){assert.match(q.owner,/Gabriel Pinto/);assert.ok(q.empty.length>20);}
  const q=qs.find(q=>q.id==='bq13');
  const view=q.render({confirmation_rate:null,confirmed:0,mature_opportunities:0,pending:3,unknown:0,coverage_pct:100,by_segment:[]});
  assert.equal(view.number,'—');assert.match(view.metrics,/Acceptance is not confirmation/);
});
