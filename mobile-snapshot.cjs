'use strict';
const crypto=require('crypto');
function mobileItem(item){
 const keys={userMessage:['content','input'],steeringUserMessage:['content','input'],agentMessage:['text','questions','phase','completedAtMs'],commandExecution:['command','aggregatedOutput'],fileChange:['changes'],mcpToolCall:['server','tool'],functionCallOutput:['namespace','name','output']}[item.type];
 if(!keys)return null;
 const result={id:item.id,type:item.type,status:item.status};
 for(const key of keys)if(item[key]!==undefined)result[key]=item[key];
 if(item.type==='commandExecution'&&typeof result.aggregatedOutput==='string'&&result.aggregatedOutput.length>4000)result.aggregatedOutput='[较早执行输出已省略]\n'+result.aggregatedOutput.slice(-4000);
 if(item.type==='fileChange')result.changes=(item.changes||[]).map(c=>({path:c.path,kind:c.kind}));
 if(item.type==='functionCallOutput'&&(item.namespace!=='codex_app'||item.name!=='send_message_to_thread'))return null;
 return result;
}
function projectThread(thread,turns){
 const result={};for(const key of ['id','name','preview','cwd','status','model','recencyAt','updatedAt','createdAt'])if(thread[key]!==undefined)result[key]=thread[key];
 result.turns=turns.map(t=>({id:t.id,status:t.status,startedAt:t.startedAt,completedAt:t.completedAt,durationMs:t.durationMs,items:(t.items||[]).map(mobileItem).filter(Boolean)}));return result;
}
class MobileSnapshots {
 constructor(read){this.read=read;this.cache=new Map()}
 async get(params){
  const key=JSON.stringify([params.threadId,params.cursor||null]);let cached=this.cache.get(key);
  if(!cached||!cached.inFlight&&Date.now()-cached.at>1500){
   if(this.cache.size>100)this.cache.delete(this.cache.keys().next().value);
   cached={at:Date.now(),inFlight:true};this.cache.set(key,cached);
   cached.promise=this.load(params).then(value=>{cached.at=Date.now();return value}).catch(e=>{if(this.cache.get(key)===cached)this.cache.delete(key);throw e}).finally(()=>{cached.inFlight=false});
  }
  const value=await cached.promise;
  return params.revision===value.revision?{unchanged:true,revision:value.revision}:value;
 }
 async load(params){
  // Content can still refresh if the optional metadata read fails.
  // A batch of full turns can exceed the desktop bridge deadline on long histories.
  const [metadata,recent]=await Promise.allSettled([this.read('thread/read',{threadId:params.threadId,includeTurns:false}),this.read('thread/turns/list',{threadId:params.threadId,limit:1,itemsView:'full',...(params.cursor?{cursor:params.cursor}:{})})]);
  if(recent.status==='rejected'&&(params.cursor||recent.reason?.message!==`thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`))throw recent.reason;
  const page=recent.status==='fulfilled'?recent.value:{data:[]};
  const thread=projectThread(metadata.status==='fulfilled'?metadata.value.thread:{id:params.threadId},(page.data||[]).slice().reverse());
  const value={thread,nextCursor:page.nextCursor||null};
  value.revision=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);return value;
 }
}
module.exports={MobileSnapshots,projectThread};
