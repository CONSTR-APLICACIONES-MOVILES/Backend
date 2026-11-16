const test=require('node:test'),assert=require('node:assert/strict');
const {chooseReminderPolicy,buildReminderInsight}=require('../src/reminderInsights');
const now=new Date('2026-10-30T13:00:00Z'),invited=new Date(+now-2*86400000);
test('policy assignment is stable and low/stale evidence cannot claim a winner',()=>{
  const a=chooseReminderPolicy('a',3,now,null);
  assert.deepEqual(a,chooseReminderPolicy('a',3,now,null));
  assert.ok([30,60].includes(a.delayMinutes));assert.equal(a.assignment,'balanced-hash');
  const insight={environment:'production',updated_at:now,decisions:[{size:'2-3',sufficient:true,strategy:'single_after_30_min'}]};
  assert.equal(chooseReminderPolicy('a',3,now,insight).delayMinutes,30);
  assert.equal(chooseReminderPolicy('a',3,now,{...insight,environment:'test'}).assignment,'balanced-hash');
});
test('BQ14 aggregates activities including zero reminders, excludes personal alerts and duplicate deliveries',()=>{
  const records=['a','b','c'].map(activityId=>({activityId,groupSize:3,strategy:'single_after_30_min',invitedAt:invited,environment:'test'}));
  const m=new Map([['a',{firstConfirmedAt:new Date(+invited+20*60000)}],['b',{firstConfirmedAt:new Date(+invited+40*60000)}],['c',{firstConfirmedAt:null}]]);
  const delivery={activityId:'b',recipientId:'peer',strategy:'single_after_30_min',sequence:1,purpose:'rsvp',sentAt:new Date(+invited+30*60000),environment:'test'};
  const r=buildReminderInsight(records,m,[delivery,delivery,{...delivery,purpose:'activity',recipientId:'owner'}],now,'test');
  const row=r.by_strategy_size[0];assert.equal(row.activities,3);assert.equal(row.confirmed,2);
  assert.equal(row.notifications,1);assert.equal(row.median_minutes,20);assert.equal(row.p95_minutes,40);
  assert.equal(row.confirmation_rate,66.67);assert.equal(row.notifications_per_activity,1/3);
  assert.ok(r.decisions.every(d=>!d.sufficient));
});
test('BQ14 immature, missing projection, test environments and empty cohorts do not invent estimates',()=>{
  const base={activityId:'a',groupSize:3,strategy:'single_after_60_min',invitedAt:invited,environment:'test'};
  const r=buildReminderInsight([base,{...base,activityId:'young',invitedAt:now}],new Map(),[],now,'test');
  assert.equal(r.pending,1);assert.equal(r.unknown,1);assert.equal(r.by_strategy_size.length,0);
  assert.equal(buildReminderInsight([base],new Map(),[],now,'production').total,0);
});
test('a well-covered joint improvement can select a policy; initial confirmations prevent that automatic decision',()=>{
  const records=[],measurements=new Map(),deliveries=[];
  for(const delay of [30,60])for(let i=0;i<20;i++){
    const activityId=`${delay}-${i}`,strategy=`single_after_${delay}_min`;
    records.push({activityId,groupSize:3,strategy,invitedAt:invited,environment:'test'});
    measurements.set(activityId,{firstConfirmedAt:new Date(+invited+(delay===30?45:90)*60000)});
    deliveries.push({activityId,recipientId:'peer',strategy,sequence:1,purpose:'rsvp',environment:'test',sentAt:new Date(+invited+delay*60000)});
  }
  const insight=buildReminderInsight(records,measurements,deliveries,now,'test');
  assert.equal(insight.decisions.find(d=>d.size==='2-3').strategy,'single_after_30_min');
  assert.equal(chooseReminderPolicy('new',3,now,insight,'test').assignment,'observed-dominance');
  records[0].initiallyConfirmed=true;
  assert.equal(buildReminderInsight(records,measurements,deliveries,now,'test').decisions.find(d=>d.size==='2-3').strategy,null);
});
