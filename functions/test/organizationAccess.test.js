const test=require('node:test'),assert=require('node:assert/strict');
const {requireOrganizationAnalytics}=require('../src/organizationAccess');
const {createMobileCallables}=require('../src/mobileCallables');
test('organization analytics require a trusted boolean claim, not merely a session or request field',()=>{
  assert.throws(()=>requireOrganizationAnalytics({}),{code:'unauthenticated'});
  for(const token of [{},{orgAnalytics:false},{orgAnalytics:'true'}]) {
    assert.throws(()=>requireOrganizationAnalytics({auth:{uid:'user',token},data:{orgAnalytics:true}}),{code:'permission-denied'});
  }
  assert.doesNotThrow(()=>requireOrganizationAnalytics({auth:{uid:'analyst',token:{orgAnalytics:true}}}));
});
test('coordination aggregate is forbidden to normal app accounts before service execution',async()=>{
  let calls=0;
  const api=createMobileCallables({getCoordinationInsight:async()=>{calls++;return {insight:null};}});
  await assert.rejects(api.getCoordinationInsight.run({auth:{uid:'user',token:{}},data:{}}),{code:'permission-denied'});
  assert.equal(calls,0);
  await api.getCoordinationInsight.run({auth:{uid:'analyst',token:{orgAnalytics:true}},data:{}});
  assert.equal(calls,1);
});
