const {createHash,randomUUID}=require('node:crypto');
const {documentId,requireThat,integer}=require('./errors');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const pair=(a,b)=>hash([a,b].sort());
function username(value){
  requireThat(typeof value==='string','invalid-argument','Supply a username.');
  const normalized=value.trim().replace(/^@/,'').toLowerCase();
  requireThat(/^[a-z0-9._]{3,24}$/.test(normalized),'invalid-argument','Use 3–24 letters, numbers, dots or underscores.');
  return normalized;
}
const person=(id,p)=>({id,name:p.name,username:p.username});
const relation=(r,uid)=>!r?{state:'none',version:'none'}:{state:r.state,version:r.version,
  direction:r.requesterId===uid?'outgoing':'incoming'};
class SocialService {
  constructor(db,{clock=()=>new Date(),userLookup}={}){this.db=db;this.clock=clock;this.userLookup=userLookup;}
  async setUsername(uid,input){
    const name=username(input.username),user=await this.userLookup(uid);
    await this.db.runTransaction(async tx=>{
      const profileRef=this.db.doc(`profiles/${uid}`),claimRef=this.db.doc(`usernames/${name}`);
      const profile=(await tx.get(profileRef)).data()||{},claim=(await tx.get(claimRef)).data();
      requireThat(!claim || claim.uid===uid,'already-exists','This username is already taken.');
      const old=profile.username && profile.username!==name ? this.db.doc(`usernames/${profile.username}`):null;
      const oldClaim=old?(await tx.get(old)).data():null;
      if(oldClaim?.uid===uid)tx.delete(old);
      tx.set(claimRef,{uid});
      tx.set(profileRef,{username:name,updatedAt:this.clock()},{merge:true});
      tx.set(this.db.doc(`publicPeople/${uid}`),{username:name,name:profile.name||user.displayName||'ParchApp user',updatedAt:this.clock()});
    });
    return {username:name};
  }
  async searchPeople(uid,input){
    requireThat(typeof input.query==='string','invalid-argument','Supply a username prefix.');
    const query=input.query.trim().replace(/^@/,'').toLowerCase();
    requireThat(/^[a-z0-9._]{2,24}$/.test(query),'invalid-argument','Enter at least two username characters.');
    const limit=integer(input.limit??20,1,30,'limit');
    let cursor;
    if(input.cursor){
      try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch(_){}
      requireThat(cursor?.uid===uid && cursor.query===query && typeof cursor.after==='string' && /^[a-z0-9._]{3,24}$/.test(cursor.after),
        'invalid-argument','Invalid search cursor.');
    }
    let search=this.db.collection('publicPeople').orderBy('username').where('username','>=',query).where('username','<=',query+'\uf8ff');
    if(cursor)search=search.startAfter(cursor.after);
    const docs=(await search.limit(limit+1).get()).docs,visible=docs.slice(0,limit);
    return {people:visible.filter(d=>d.id!==uid).map(d=>person(d.id,d.data())),
      cursor:docs.length>limit?Buffer.from(JSON.stringify({uid,query,after:visible.at(-1).data().username})).toString('base64url'):null};
  }
  async getPublicPerson(uid,input){
    documentId(input.userId,'userId');
    const [p,r]=await Promise.all([this.db.doc(`publicPeople/${input.userId}`).get(),this.db.doc(`friendships/${pair(uid,input.userId)}`).get()]);
    requireThat(p.exists,'not-found','This account has no public username yet.');
    return {...person(input.userId,p.data()),friendship:relation(r.data(),uid),self:uid===input.userId};
  }
  async getFriends(uid,input={}){
    const limit=integer(input.limit??50,1,50,'limit');
    let query=this.db.collection('friendships').where('memberIds','array-contains',uid).orderBy('__name__');
    if(input.cursor){documentId(input.cursor,'cursor');query=query.startAfter(input.cursor);}
    const all=(await query.limit(limit+1).get()).docs,docs=all.slice(0,limit);
    const ids=docs.map(d=>d.data().memberIds.find(id=>id!==uid));
    const profiles=ids.length?await this.db.getAll(...ids.map(id=>this.db.doc(`publicPeople/${id}`))):[];
    return {relationships:docs.flatMap((d,i)=>{
      const r=d.data();if(!['pending','accepted'].includes(r.state))return [];
      return [{person:profiles[i].exists?person(ids[i],profiles[i].data()):{id:ids[i],name:'ParchApp user',username:null},...relation(r,uid)}];
    }),cursor:all.length>limit?docs.at(-1).id:null};
  }
  async changeFriendship(uid,input){
    documentId(input.userId,'userId');requireThat(uid!==input.userId,'invalid-argument','You cannot add yourself.');
    requireThat(['request','accept','decline','remove','cancel'].includes(input.action),'invalid-argument','Invalid friendship action.');
    requireThat(typeof input.expectedVersion==='string' && input.expectedVersion.length<=128,'invalid-argument','Reload this friendship first.');
    const ref=this.db.doc(`friendships/${pair(uid,input.userId)}`),command=hash([uid,input.action,input.expectedVersion]);
    return this.db.runTransaction(async tx=>{
      const r=(await tx.get(ref)).data();
      if(r?.lastCommand===command)return relation(r,uid);
      requireThat((r?.version||'none')===input.expectedVersion,'aborted','Friendship changed. Refresh before retrying.');
      let state;
      if(input.action==='request'){
        const profiles=await tx.getAll(this.db.doc(`publicPeople/${uid}`),this.db.doc(`publicPeople/${input.userId}`));
        requireThat(profiles.every(d=>d.exists),'failed-precondition','Both accounts need a username before requesting friendship.');
        requireThat(!r || ['removed','declined'].includes(r.state),'failed-precondition','A request or friendship already exists.');
        state='pending';
      }else{
        requireThat(r && r.memberIds.includes(uid),'not-found','Friendship not found.');
        if(['accept','decline'].includes(input.action))requireThat(r.state==='pending'&&r.recipientId===uid,'permission-denied','Only the recipient can respond.');
        if(input.action==='cancel')requireThat(r.state==='pending'&&r.requesterId===uid,'permission-denied','Only the sender can cancel.');
        if(input.action==='remove')requireThat(r.state==='accepted','failed-precondition','This friendship is not accepted.');
        state=input.action==='accept'?'accepted':input.action==='decline'?'declined':'removed';
      }
      const next={memberIds:[uid,input.userId].sort(),requesterId:input.action==='request'?uid:r.requesterId,
        recipientId:input.action==='request'?input.userId:r.recipientId,state,version:randomUUID(),
        createdAt:r?.createdAt||this.clock(),updatedAt:this.clock(),lastCommand:command};
      tx.set(ref,next);return relation(next,uid);
    });
  }
}
module.exports={SocialService,username,pair};
