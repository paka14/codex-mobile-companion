'use strict';
// Relays structured application messages to the locally installed Codex renderer.
const resolveDesktopSend=require('./desktop-send-adapter.cjs');
const {DesktopTransport}=require('./desktop-transport.cjs');
const binding='__codexMobileCompanionRelay';
// The native preload dispatches synthetic message events; frame postMessage events are not native IPC.
function installRelay(){
 if(location.protocol!=='app:'||location.hostname!=='-'||location.pathname!=='/index.html'||
    typeof window.electronBridge?.sendMessageFromView!=='function')return false;
 if(window.__codexMobileCompanionListener)window.removeEventListener('message',window.__codexMobileCompanionListener);
 const activity=['serverRequest/resolved','turn/started','turn/completed','item/started','item/completed','item/agentMessage/delta','thread/status/changed'];
 window.__codexMobileCompanionListener=event=>{
  if(event.source!=null)return;
  const message=event.data;
  if(message?.type==='mcp-request'&&message.request){
   window.__codexMobileCompanionPending??=new Map();
   window.__codexMobileCompanionPending.set(String(message.request.id),{request:message.request,hostId:message.hostId||'local'});
  }else if(message?.type==='mcp-notification'&&activity.includes(message.method)){
   if(message.method==='serverRequest/resolved')window.__codexMobileCompanionPending?.delete(String(message.params.requestId));
  }else return;
  window.__codexMobileCompanionRelay?.(JSON.stringify(message));
 };
 window.addEventListener('message',window.__codexMobileCompanionListener);
 return true;
}
class DesktopBridge extends DesktopTransport {
 constructor(onRequest,onResolved,options={}){
  super(options);
  this.onRequest=onRequest;
  this.onResolved=onResolved;
  this.onActivity=options.onActivity??(()=>{});
 }
 async initialize(){
  const {frameTree}=await this.call('Page.getFrameTree');
  this.frameId=frameTree?.frame?.id;
  if(!this.frameId)throw Error('Codex desktop frame unavailable');
  await this.call('Runtime.enable');
  if(!this.contextId)throw Error('Codex desktop context unavailable');
  await this.call('Runtime.addBinding',{name:binding,executionContextId:this.contextId});
  const reply=await this.call('Runtime.evaluate',{
   expression:'('+installRelay.toString()+')()',contextId:this.contextId,returnByValue:true,
  });
  if(reply.exceptionDetails||reply.result?.value!==true)throw Error('Codex desktop bridge unavailable');
 }
 onReady(){this.syncPending().catch(()=>{});}
 onDisconnect(){this.snapshotObserved=false;this.frameId=undefined;this.contextId=undefined;this.onResolved(null);}
 call(method,params={}){
  if(method==='Runtime.evaluate'){
   if(!this.contextId)return Promise.reject(Error('Codex desktop context unavailable'));
   params={...params,contextId:this.contextId};
  }
  return super.call(method,params);
 }
 onEvent(event){
  if(event.method==='Runtime.executionContextDestroyed'&&event.params?.executionContextId===this.contextId){
   this.disconnect(this.socket);
   return;
  }
  if(event.method==='Runtime.executionContextCreated'){
   const context=event.params?.context;
   if(!this.contextId&&this.frameId&&context?.auxData?.frameId===this.frameId&&context.auxData.isDefault===true)this.contextId=context.id;
   return;
  }
  if(!this.ready||event.method!=='Runtime.bindingCalled'||event.params?.name!==binding||
     event.params.executionContextId!==this.contextId)return;
  const message=JSON.parse(event.params.payload);
  if(message.hostId&&message.hostId!=='local')return;
  if(message.type==='mcp-request'&&message.request&&/requestApproval|requestUserInput|elicitation\/request/.test(message.request.method)){
   this.onRequest({...message.request,id:'desktop:'+message.request.id,__desktopId:message.request.id,__hostId:message.hostId||'local'});
  }
  if(message.type==='mcp-notification'){
   if(message.method==='serverRequest/resolved')this.onResolved('desktop:'+message.params.requestId);
   this.onActivity(message);
  }
 }
 async respond(request,result){if(!this.ready)throw Error('电脑审批桥接未连接，请启用消息桥接后重试');const message={type:'mcp-response',hostId:request.__hostId,response:{id:request.__desktopId,result},threadId:request.params?.threadId,requestMethod:request.method};const reply=await this.call('Runtime.evaluate',{expression:'window.electronBridge.sendMessageFromView('+JSON.stringify(message)+')',awaitPromise:true,returnByValue:true});if(reply.exceptionDetails)throw Error(reply.exceptionDetails.text||'审批响应失败')}
}
DesktopBridge.prototype.request=async function(method,params={}){
 if(!this.ready)throw Error('电脑消息桥接未连接');
 const request={id:'phone-rpc-'+require('crypto').randomUUID(),method,params};
 const expression=`new Promise(resolve=>{const request=${JSON.stringify(request)};const timer=setTimeout(()=>{window.removeEventListener('message',listen);resolve({error:{message:'电脑请求超时'}})},12000);function listen(e){const m=e.data;if(m?.type==='mcp-response'&&m.message?.id===request.id){clearTimeout(timer);window.removeEventListener('message',listen);resolve(m.message)}}window.addEventListener('message',listen);try{window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',request})}catch(e){clearTimeout(timer);window.removeEventListener('message',listen);resolve({error:{message:e.message}})}})`;
 const reply=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 if(reply.exceptionDetails)throw Error(reply.exceptionDetails.text||'电脑请求失败');
 const value=reply.result?.value;if(!value)throw Error('电脑未返回响应');if(value.error)throw Error(value.error.message||'电脑请求失败');return value.result;
};

DesktopBridge.prototype.syncPending=async function(){
 if(!this.ready)return;
 const reply=await this.call('Runtime.evaluate',{expression:'('+async function(resolveFunction){
  const pending=new Map(window.__codexMobileCompanionPending||[]),seen=new Set(),queue=[];let scope=window.__mobileCompanionScope;const stores=window.__mobileCompanionApprovalStores||[];for(const store of stores)if(store.hostId==='local')for(const conversation of store.map.values())for(const request of conversation?.requests||[])if(request?.method&&request.params)pending.set(String(request.id),{request,hostId:store.hostId});if(stores.length&&window.__mobileCompanionManager)return {requests:[...pending.values()],observed:true};
  for(const node of document.querySelectorAll('body,body *')){
   for(const key of Object.keys(node))if(key.startsWith('__reactFiber$')||key.startsWith('__reactContainer$'))queue.push([node[key],0]);
   if(queue.length>30)break;
  }
  let observed=false;
  for(let n=0;n<queue.length&&n<60000;n++){
   const [value,depth]=queue[n];if(!value||typeof value!=='object'||seen.has(value)||depth>24||value instanceof Node)continue;seen.add(value);if(!scope&&value.node&&typeof value.get==='function'&&typeof value.watch==='function')scope=value;
   if(value.conversations instanceof Map&&(!value.hostId||value.hostId==='local')){
    observed=true;
    const cached=window.__mobileCompanionApprovalStores??=[];
    if(!cached.some(store=>store.map===value.conversations))cached.push({map:value.conversations,hostId:'local'});
    for(const conversation of value.conversations.values())for(const request of conversation?.requests||[])if(request?.method&&request.params)pending.set(String(request.id),{request,hostId:'local'});
   }
   if(value instanceof Map){for(const v of value.values())queue.push([v,depth+1]);continue}
   for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(['items','turns','transcript','children','stateNode','return','alternate','_debugOwner'].includes(key))continue;
    if('value'in descriptor&&descriptor.value&&typeof descriptor.value==='object')queue.push([descriptor.value,depth+1]);
   }
  }
  if(scope){
   if(!window.__mobileCompanionManager){
    const factory=await resolveFunction('manager');
    if(factory){window.__mobileCompanionManager=factory(scope,'local');window.__mobileCompanionScope=scope}
   }
   const manager=window.__mobileCompanionManager;
   if(manager){const snapshot=await manager.getCachedThreadSearchSnapshot();for(const c of snapshot.conversations||[]){const conversation=await manager.getConversation(c.summary.conversationId);for(const request of conversation?.requests||[])if(request?.method&&request.params)pending.set(String(request.id),{request,hostId:'local'})}observed=true}
  }
  return {requests:[...pending.values()],observed};
 }.toString()+')('+resolveDesktopSend.toString()+')',awaitPromise:true,returnByValue:true});
 if(reply.exceptionDetails)throw Error(reply.exceptionDetails.text);
 this.snapshotObserved=reply.result?.value?.observed===true;
 const requests=[];
 for(const entry of reply.result?.value?.requests||[]){const r=entry.request;if(/requestApproval|requestUserInput|elicitation\/request/.test(r.method))requests.push({...r,id:'desktop:'+r.id,__desktopId:r.id,__hostId:entry.hostId||'local'})}
 return {observed:this.snapshotObserved,requests};
};

// Use the desktop manager so its composer and subsequent turns share the update.
DesktopBridge.prototype.settings=async function(threadId,changes){
 if(!this.ready)throw Error('电脑消息桥接未连接');
 await this.syncPending();
 const expression='('+async function(id,changes){
  const manager=window.__mobileCompanionManager;
  if(!manager)throw Error('桌面会话管理器尚未就绪');
  let conversation=await manager.getConversation(id);
  if(!conversation)throw Error('请先在桌面端打开此会话，再修改会话设置');
  if(changes){
   const {threadId,...settings}=changes;
   if(settings.sandboxPolicy)await manager.updateThreadPermissions(id,settings);
   else await manager.updateThreadSettingsForNextTurn(id,settings);
   conversation=await manager.getConversation(id);
  }
  const latest=conversation.latestThreadSettings||{},turn=conversation.turns?.at(-1)?.params||{},current=conversation.currentPermissions||{};
  const settings={model:latest.model??conversation.latestModel,reasoningEffort:latest.effort??conversation.latestReasoningEffort,cwd:latest.cwd??conversation.cwd,runtimeWorkspaceRoots:conversation.environments?.flatMap(e=>e.runtimeWorkspaceRoots||[])||[],approvalPolicy:latest.approvalPolicy??turn.approvalPolicy??current.approvalPolicy,approvalsReviewer:latest.approvalsReviewer??turn.approvalsReviewer??current.approvalsReviewer,sandboxPolicy:latest.sandboxPolicy??turn.sandboxPolicy??current.sandboxPolicy};
  if(changes){
   for(const key of ['approvalPolicy','model'])if(changes[key]!==undefined&&settings[key]!==changes[key])throw Error('桌面端未确认设置变更，请重试');
   if(changes.sandboxPolicy&&settings.sandboxPolicy?.type!==changes.sandboxPolicy.type)throw Error('桌面端未确认权限变更，请重试');
  }
  return settings;
 }.toString()+')('+JSON.stringify(threadId)+','+JSON.stringify(changes||null)+')';
 const reply=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text);
 return reply.result?.value;
};
DesktopBridge.prototype.goalMutation=async function(threadId,action,value){
 await this.syncPending();
 const expression='('+async function(id,action,value){
  const manager=window.__mobileCompanionManager;
  try{
   if(!manager)throw Error('桌面会话管理器尚未就绪');
   if((action==='create'||action==='edit')&&typeof manager.setThreadGoal==='function'){
    const current=await manager.sendRequest('thread/goal/get',{threadId:id});
    if(action==='edit'){
     if(current?.goal?.objective!==value.previousObjective||current.goal.status!==value.previousStatus)return {conflict:true};
     return {goal:await manager.setThreadGoal(id,{objective:value.objective,appendTranscriptItem:false})};
    }
    if(current.goal)throw Error('当前会话已有目标，请重新打开目标面板');
    return {goal:await manager.setThreadGoal(id,{objective:value})};
   }
   if(action==='status'&&typeof manager.setThreadGoalStatus==='function')return {goal:await manager.setThreadGoalStatus(id,{status:value})};
   if(action==='clear'&&typeof manager.clearThreadGoal==='function')return await manager.clearThreadGoal(id);
   throw Error('当前桌面版本不支持此目标操作');
  }catch(error){return {error:error?.message||String(error)}}
 }.toString()+')('+[threadId,action,value??null].map(v=>JSON.stringify(v)).join(',')+')';
 const reply=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 const result=reply.result?.value;
 if(!result||reply.exceptionDetails)throw Error('未取得桌面目标操作的结果，请重新打开目标面板核对状态');
 if(result.conflict)throw Object.assign(Error('桌面目标已变化，请重新打开目标面板'),{code:'GOAL_CONFLICT'});
 if(result.error)throw Error(result.error);
 return result;
};
DesktopBridge.prototype.lifecycle=async function(method,params,operationId){
 try{await this.syncPending()}catch(error){error.definitive=true;throw error}
 const expression='('+async function(method,params,desktopCreationPermissions,resolveFunction){
  const manager=window.__mobileCompanionManager;if(!manager)throw Error('桌面会话管理器尚未就绪');
  let id=params.threadId;
  if(method==='thread/start'){
   let permissionSelection;
   try{
    if(!window.__mobileCompanionStartConversation)await resolveFunction('create');
    if(!window.__mobileCompanionStartConversation)throw Error('桌面端新建会话接口不兼容');
    permissionSelection=await desktopCreationPermissions(params.cwd,resolveFunction);
   }catch(error){error.definitive=true;throw error}
   const created=await window.__mobileCompanionStartConversation(window.__mobileCompanionScope,'local',{input:[],cwd:params.cwd,workspaceRoots:[params.cwd],threadStartKind:'default',permissionSelection,usePermissionSelection:true});
   id=created.conversationId;if(created.status!=='created'||!id)throw Error('桌面端未创建会话');
  }else if(method==='thread/fork'){
   const options={sourceConversationId:id,workspaceRoots:[params.cwd||'/'],cwd:params.cwd};
   let created;
   if(params.turnId!==undefined){
    if(typeof params.turnId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.turnId))throw Error('回答轮次无效');
    if(typeof manager.forkConversationFromTurn!=='function')throw Error('当前桌面版本不支持从指定回答分支');
    created=await manager.forkConversationFromTurn({...options,targetTurnId:params.turnId});
   }else created=await manager.forkConversationFromLatest(options);
   id=created.conversationId;if(!id)throw Error('桌面端未创建会话副本');
   if(params.turnId!==undefined&&created.synchronization?.status==='failed')throw Error('桌面已创建分支，但未能确认上下文同步。请先查看聊天列表，不要重复创建。');
  }else if(method==='thread/resume'){
   const result=await manager.resumeConversation({conversationId:id,model:null,reasoningEffort:null,serviceTier:null,workspaceRoots:[params.cwd||'/'],collaborationMode:null});
   if(result.status!=='ready')throw Error('桌面端尚未取得会话控制权');
  }
  // Creating a thread is already committed; an optional metadata read must not
  // turn that success into a failed create receipt.
  if(method==='thread/start'||method==='thread/fork'){
   const result={thread:{id,cwd:params.cwd,turns:[],status:{type:'idle'}}};
   try{const conversation=await manager.getConversation(id),current=conversation.currentPermissions||{},latest=conversation.latestThreadSettings||{};result.settings={...current,...latest,model:latest.model??conversation.latestModel,cwd:conversation.cwd}}catch{}
   return result;
  }
  return await manager.sendRequest('thread/read',{threadId:id,includeTurns:false});
 }.toString()+')('+JSON.stringify(method)+','+JSON.stringify(params)+','+require('./desktop-create-permissions.cjs').desktopCreationPermissions.toString()+','+resolveDesktopSend.toString()+')';
 if(operationId)return this.startOperation(operationId,expression);
 const reply=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text);
 return reply.result?.value;
};
// Submit as the desktop composer does, without a second app-server or tool pipe.
DesktopBridge.prototype.send=async function(threadId,prompt,operationId,mobileCreated=false,idleOnly=false){
 if(!/^[0-9a-f-]{36}$/i.test(threadId)||typeof prompt!=='string'||!prompt.trim()||prompt.length>100000)throw Error('消息参数无效');
 try{await this.syncPending()}catch(error){error.definitive=true;throw error}
 const expression='('+async function(id,prompt,mobileCreated,idleOnly,resolveSend){
  const manager=window.__mobileCompanionManager;if(!manager)throw Error('桌面会话管理器尚未就绪');
  const conversation=await manager.getConversation(id);
  if(!conversation||conversation.resumeState!=='resumed'){
   const result=await manager.resumeConversation({conversationId:id,model:null,reasoningEffort:null,serviceTier:null,workspaceRoots:[conversation?.cwd||'/'],collaborationMode:null});
   if(result.status!=='ready')throw Error('桌面端尚未取得会话控制权');
  }
  await resolveSend();
  if(!window.__mobileCompanionSendFollowUp)throw Error('桌面端发送接口不兼容');
  let titleCwd;
  const claimed=window.__mobileCompanionTitleClaims??=new Set();
  if(mobileCreated&&!claimed.has(id)){
   try{
    const {thread}=await manager.sendRequest('thread/read',{threadId:id,includeTurns:false});
    if(thread?.preview===''&&!thread.name&&!claimed.has(id)&&typeof thread.cwd==='string'&&thread.cwd){claimed.add(id);titleCwd=thread.cwd}
   }catch{}
  }
  if(idleOnly){
   const {thread}=await manager.sendRequest('thread/read',{threadId:id,includeTurns:false});
   if(thread?.id!==id||thread.status?.type!=='idle'||thread.archived===true){
    throw Object.assign(Error('Reception no longer idle'),{definitive:true});
   }
  }
  try{await window.__mobileCompanionSendFollowUp(window.__mobileCompanionScope,'local',id,{prompt})}
  catch(error){if(titleCwd)claimed.delete(id);throw error}
  // An optional native title must never change the send receipt or replay a send.
  if(titleCwd)void Promise.resolve().then(async()=>{
   const generate=await resolveSend('title');
   if(generate)await generate(window.__mobileCompanionScope,manager,{conversationId:id,cwd:titleCwd,input:[{type:'text',text:prompt,text_elements:[]}]});
  }).catch(()=>{});
  return {threadId:id};
 }.toString()+')('+JSON.stringify(threadId)+','+JSON.stringify(prompt)+','+JSON.stringify(mobileCreated)+','+JSON.stringify(idleOnly)+','+resolveDesktopSend.toString()+')';
 if(operationId)return this.startOperation(operationId,expression);
 const reply=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text);
 return reply.result?.value;
};
// Keep execution and its receipt in the desktop renderer. The short CDP response
// only acknowledges tracking; it never waits for the actual send/create Promise.
DesktopBridge.prototype.startOperation=async function(id,expression){
 const wrapped=`(()=>{const id=${JSON.stringify(id)};const operations=window.__mobileCompanionOperations??=new Map();if(operations.has(id))return {...operations.get(id)};const receipt={id,status:'pending'};operations.set(id,receipt);Promise.resolve().then(()=>(${expression})).then(result=>{receipt.status='succeeded';receipt.result=result},error=>{receipt.status=error?.definitive?'failed':'unknown';receipt.error=(error?.definitive?'电脑未接受操作：':'操作结果待确认：')+(error?.message||String(error))});return {...receipt}})()`;
 const reply=await this.call('Runtime.evaluate',{expression:wrapped,returnByValue:true});
 if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text);
 return reply.result?.value;
};
DesktopBridge.prototype.operationStatus=async function(id){
 const reply=await this.call('Runtime.evaluate',{expression:`(()=>{const receipt=window.__mobileCompanionOperations?.get(${JSON.stringify(id)});return receipt?{...receipt}:null})()`,returnByValue:true});
 if(reply.exceptionDetails)throw Error(reply.exceptionDetails.text);
 return reply.result?.value;
};
// A single initialization/snapshot request at a time, shared by polling and readiness.
const syncPendingSnapshot=DesktopBridge.prototype.syncPending;
DesktopBridge.prototype.syncPending=function(){
 if(!this.syncInFlight)this.syncInFlight=syncPendingSnapshot.call(this).finally(()=>{this.syncInFlight=null});
 return this.syncInFlight;
};
DesktopBridge.prototype.healthCheck=async function(){
 if(!this.ready)return {read:false,send:false,approvals:false};
 await this.syncPending();
 const reply=await this.call('Runtime.evaluate',{expression:'('+async function(resolveSend){
  const manager=window.__mobileCompanionManager;
  if(!manager||!window.__mobileCompanionScope)return {read:false,send:false,approvals:false};
  await resolveSend();
  let read=false;
  try{const result=await manager.sendRequest('thread/list',{limit:1});read=Array.isArray(result?.data)}catch{}
  return {read,send:typeof window.__mobileCompanionSendFollowUp==='function'&&typeof manager.getConversation==='function',approvals:typeof window.electronBridge?.sendMessageFromView==='function'};
 }.toString()+')('+resolveDesktopSend.toString()+')',awaitPromise:true,returnByValue:true});
 if(reply.exceptionDetails)throw Error('桌面接口能力检查失败');
 const capabilities=reply.result?.value||{};
 return {...capabilities,approvals:!!capabilities.approvals&&this.snapshotObserved===true};
};
module.exports=DesktopBridge;
