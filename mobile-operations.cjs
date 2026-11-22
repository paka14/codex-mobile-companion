'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Journal only operation identity and receipts, never message text or credentials.
class MobileOperations {
 constructor(file,bridge,log=()=>{}){
  this.file=file;this.bridge=bridge;this.log=log;this.running=new Map();this.records=new Map();
  if(fs.existsSync(file)){
   const rows=JSON.parse(fs.readFileSync(file,'utf8'));
   if(!Array.isArray(rows))throw Error('操作回执文件损坏，请在电脑检查，暂不接受新操作');
   for(const row of rows)this.records.set(row.id,row);
  }
 }
 save(){const tmp=this.file+'.tmp';fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(tmp,JSON.stringify([...this.records.values()]));fs.renameSync(tmp,this.file)}
 view(row){const {fingerprint,...receipt}=row;return receipt}
 ownsCreatedThread(threadId){return [...this.records.values()].some(row=>row.kind==='create'&&row.status==='succeeded'&&row.result?.thread?.id===threadId)}
 validate({id,kind,params}){
  if(!uuid.test(id||'')||!['send','create'].includes(kind))throw Error('操作参数无效，请刷新手机页面');
  if(kind==='send'&&(!uuid.test(params?.threadId||'')||typeof params.text!=='string'||!params.text.trim()||params.text.length>100000))throw Error('消息参数无效');
  if(kind==='create'&&(typeof params?.cwd!=='string'||!params.cwd.trim()||params.cwd.length>4096))throw Error('项目目录无效');
 }
 submit(input){
  this.validate(input);const {id,kind,params}=input;
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(kind==='send'?{kind,threadId:params.threadId,text:params.text}:{kind,cwd:params.cwd})).digest('hex');
  const old=this.records.get(id);if(old){if(old.fingerprint!==fingerprint)throw Error('操作编号已用于其他内容，不能重复使用');return this.view(old)}
  if(this.records.size>=10000)throw Error('操作回执存储已满，请在电脑维护后再试');
  const row={id,kind,fingerprint,status:'pending',createdAt:new Date().toISOString(),...(kind==='send'?{threadId:params.threadId}:{})};
  this.records.set(id,row);try{this.save()}catch(e){this.records.delete(id);throw e}
  const started=Date.now();this.log({stage:'operation',id,kind,status:'pending'});
  // Persist before dispatch. Retrying a POST only returns the original receipt.
  const job=Promise.resolve().then(()=>kind==='send'?this.bridge.send(params.threadId,params.text,id,this.ownsCreatedThread(params.threadId)):this.bridge.lifecycle('thread/start',params,id))
   .then(value=>this.update(row,value)).catch(e=>this.update(row,{status:e.definitive?'failed':'unknown',error:(e.definitive?'电脑未接受操作：':'操作结果待确认：')+e.message}))
   .finally(()=>{this.running.delete(id);this.log({stage:'operation',id,kind,status:row.status,durationMs:Date.now()-started})})
   .catch(()=>{row.status='unknown';row.error='操作回执暂时无法保存，请先核对电脑会话，勿重复提交';this.log({stage:'operation-journal-unavailable',id,kind})});
  this.running.set(id,job);return this.view(row);
 }
 update(row,value){
  if(!value||!['pending','succeeded','failed','unknown'].includes(value.status))value={status:'unknown',error:'操作结果待确认，请勿重复提交'};
  Object.assign(row,{status:value.status,updatedAt:new Date().toISOString()});
  if(value.result!==undefined)row.result=value.result;
  if(value.error)row.error=value.error;else delete row.error;
  this.save();return this.view(row);
 }
 async get(id){
  if(!uuid.test(id||''))throw Error('操作编号无效');const row=this.records.get(id);if(!row)return null;
  if(['pending','unknown'].includes(row.status)&&!this.running.has(id)){
   try{const state=await this.bridge.operationStatus(id);if(state)this.update(row,state);else if(row.status==='pending')this.update(row,{status:'unknown',error:'电脑未保留此操作回执，请先核对会话，勿重复提交'})}catch{}
  }
  return this.view(row);
 }
}
module.exports={MobileOperations};
