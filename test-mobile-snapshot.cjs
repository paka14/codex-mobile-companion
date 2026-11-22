'use strict';
const assert=require('node:assert/strict');
const {MobileSnapshots}=require('./mobile-snapshot.cjs');
const id='12345678-1234-1234-1234-123456789abc';
const empty=new Error(`thread ${id} is not materialized yet; thread/turns/list is unavailable before first user message`);

(async()=>{
 const requests=[];
 let problem=empty;
 const read=async(method,params)=>{
  requests.push({method,params});
  if(method==='thread/read')return {thread:{id,status:{type:'active'}}};
  if(problem)throw problem;
  return {data:[{id:params.cursor?'older':'latest',status:params.cursor?'completed':'inProgress',items:[]}],nextCursor:params.cursor?null:'older-cursor'};
 };
 const snapshots=new MobileSnapshots(read);
 const draft=await snapshots.load({threadId:id});
 assert.deepEqual(draft.thread.turns,[]);
 assert.equal(draft.nextCursor,null);
 await assert.rejects(snapshots.load({threadId:id,cursor:'older-cursor'}),e=>e===empty);
 await assert.rejects(snapshots.load({threadId:'different-thread'}),e=>e===empty);
 problem=new Error('desktop timed out');
 await assert.rejects(snapshots.load({threadId:id}),e=>e===problem);
 problem=null;
 const latest=await snapshots.get({threadId:id,limit:6});
 assert.equal(latest.thread.turns[0].id,'latest');
 assert.equal(latest.thread.turns[0].status,'inProgress');
 assert.equal(latest.nextCursor,'older-cursor');
 assert.notEqual(latest.revision,draft.revision);
 assert.deepEqual(await snapshots.get({threadId:id,revision:latest.revision}),{unchanged:true,revision:latest.revision});
 const older=await snapshots.get({threadId:id,cursor:latest.nextCursor});
 assert.equal(older.thread.turns[0].id,'older');
 assert.equal(older.nextCursor,null);
 assert(requests.filter(r=>r.method==='thread/turns/list').every(r=>r.params.limit===1&&r.params.itemsView==='full'));
 console.log('Empty draft, first turn, active state, bounded pages, revision cache, and real errors passed');
})().catch(e=>{console.error(e);process.exitCode=1});
