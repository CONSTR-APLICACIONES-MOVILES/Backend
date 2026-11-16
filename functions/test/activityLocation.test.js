const test=require('node:test');
const assert=require('node:assert/strict');
const {validateActivityLocation,readActivityLocation}=require('../src/activityLocation');
const point={latitude:4.6,longitude:-74.07,label:'Library',placeId:'google-place'};
test('valid map coordinates survive serialization and text-only legacy activities remain supported',()=>{
  assert.deepEqual(validateActivityLocation(point,'Library'),point);
  assert.deepEqual(readActivityLocation({location:'Library',locationDetails:point}),point);
  assert.equal(readActivityLocation({location:'Manual address'}),null);
  assert.equal(readActivityLocation({location:'Changed by Java',locationDetails:point}),null);
});
test('invalid coordinates, spoofed metadata, or a mismatched label are rejected',()=>{
  for(const bad of [{...point,latitude:91},{...point,longitude:Infinity},{...point,latitude:'4.6'},
    {...point,label:'Different'},{...point,arbitrary:'field'},{...point,placeId:'x'.repeat(301)}]) {
    assert.throws(()=>validateActivityLocation(bad,'Library'),{code:'invalid-argument'});
  }
});
