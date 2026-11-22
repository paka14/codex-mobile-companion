'use strict';
let workspaceData={projects:[],assignments:{}},modelCatalog=[],settingsThread=null,settingsKind=null,settingsBusy=false;
const composerSettings=new Map(),draftAttachments=new Map();let uploading=0,restoringChat=false;
async function mobileApi(path,body){const response=await fetch('/mobile-api/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});const result=await readJsonResponse(response);if(!response.ok)throw Error(result.error||'操作失败（HTTP '+response.status+'）');return result}
function desktopRpc(method,params){if(remoteConnectionHealth&&!remoteChatReady())return Promise.reject(Error(remoteConnectionHealth.message));return mobileApi('desktop-rpc',{method,params})}
function rememberChat(id){const url=new URL(location.href);url.searchParams.set('thread',id);history.replaceState(null,'',url);sessionStorage.setItem('codex-mobile-chat',id);selectGoalBarThread(id)}
function forgetChat(){const url=new URL(location.href);url.searchParams.delete('thread');history.replaceState(null,'',url);sessionStorage.removeItem('codex-mobile-chat');$('addMenu').hidden=true;closeSlashCommands();selectGoalBarThread(null)}
function projectFor(t){const assigned=workspaceData.assignments[t.id]?.projectId;if(assigned)return assigned;const cwd=(t.cwd||'').toLowerCase().replaceAll('/','\\');let best=null,length=-1;for(const p of workspaceData.projects)for(const root of p.roots){const value=root.toLowerCase().replaceAll('/','\\').replace(/\\$/,'');if((cwd===value||cwd.startsWith(value+'\\'))&&value.length>length){best=p.id;length=value.length}}return best}
function renderWorkspaces(){const container=$('workspaces');if(!container||deferThreadListRender())return;const opened=new Set([...container.querySelectorAll('details[open]')].map(x=>x.dataset.id));container.replaceChildren();for(const p of workspaceData.projects){const group=document.createElement('details');group.className='workspace';group.dataset.id=p.id;group.dataset.orderScope='workspace:'+p.id;group.open=opened.has(p.id);const summary=document.createElement('summary');summary.textContent=p.name;group.append(summary);const rows=orderedThreadRows('workspace:'+p.id,recentThreads(threadRows.filter(t=>!desktopThreadPins.has(t.id)&&projectFor(t)===p.id))).slice(0,5);for(const t of rows){group.append(makeThreadRow(t))}const path=document.createElement('div');path.className='workspace-path';path.textContent=p.roots[0]||'';group.append(path);if(p.roots[0]){const add=button('＋ 新建会话',()=>{$('cwd').value=p.roots[0];return create()});add.className='workspace-new';group.append(add)}container.append(group)}if(!workspaceData.projects.length)container.textContent='暂时没有工作区';refreshOperationControls()}
async function loadWorkspaces(){workspaceData=await mobileApi('workspaces');renderWorkspaces()}
function permissionMode(settings){const policy=settings?.sandboxPolicy||settings?.sandbox;if(policy?.type==='dangerFullAccess'&&settings?.approvalPolicy==='never')return 'full-access';if(policy?.type==='readOnly')return 'read-only';if(policy?.type==='workspaceWrite')return 'default';return null}
const permissionNames={'default':'默认权限','read-only':'只读','full-access':'完全访问'};
function refreshComposer(){const id=selected?.id,s=composerSettings.get(id);$('modelButton').textContent=s?.model||selected?.model||'模型';$('permissionsButton').textContent=permissionNames[permissionMode(s)]||'权限';renderAttachments();$('addMenu').hidden=true;$('addAttachment').setAttribute('aria-expanded','false');closeSlashCommands()}
async function settingsRpc(method,params){return desktopRpc(method,params)}
function populateEfforts(value){const model=modelCatalog.find(m=>(m.model||m.id)===$('modelSelect').value);$('effortSelect').replaceChildren();for(const e of model?.supportedReasoningEfforts||[]){const labels={none:'关闭',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'Ultra'};$('effortSelect').add(new Option(labels[e.reasoningEffort]||e.reasoningEffort,e.reasoningEffort))}const chosen=value||model?.defaultReasoningEffort;if([...$('effortSelect').options].some(o=>o.value===chosen))$('effortSelect').value=chosen;$('effortSelect').disabled=!$('effortSelect').options.length}
function describePermission(){const descriptions={'default':'可修改当前工作区内的文件；需要更多权限时向你请求审批。','read-only':'可读取文件；修改文件或执行受限操作时需要请求权限。','full-access':'允许访问工作区外的文件和网络，执行命令时不再请求常规审批。'};$('permissionDescription').textContent=descriptions[$('permissionSelect').value]||'当前会话使用自定义权限。选择模式后可替换。'}
async function openSettings(kind){if(!selected||settingsBusy)return;settingsThread=selected.id;settingsKind=kind;settingsBusy=true;$('settingsDialog').showModal();$('settingsTitle').textContent=kind==='model'?'选择模型':'切换权限';$('modelFields').hidden=kind!=='model';$('permissionFields').hidden=kind!=='permissions';$('settingsState').textContent='正在读取当前会话设置…';$('settingsSave').disabled=true;try{const id=settingsThread;const [settings,models]=await Promise.all([settingsRpc('thread/settings/read',{threadId:id}),kind==='model'?(modelCatalog.length?modelCatalog:desktopRpc('model/list',{limit:100,includeHidden:false}).then(r=>r.data||[])):modelCatalog]);if(selected?.id!==id){$('settingsDialog').close();return}composerSettings.set(id,settings);modelCatalog=models;refreshComposer();if(kind==='model'){$('modelSelect').replaceChildren();for(const model of modelCatalog)$('modelSelect').add(new Option(model.displayName||model.model,model.model||model.id));if(settings.model&&!modelCatalog.some(m=>(m.model||m.id)===settings.model))$('modelSelect').add(new Option(settings.model,settings.model));$('modelSelect').value=settings.model||modelCatalog.find(m=>m.isDefault)?.model||modelCatalog[0]?.model;populateEfforts(settings.reasoningEffort)}else{const custom=$('permissionSelect').querySelector('[value=custom]');custom?.remove();const mode=permissionMode(settings);if(!mode)$('permissionSelect').add(new Option('自定义（保持现状）','custom'));$('permissionSelect').value=mode||'custom';describePermission()}$('settingsState').textContent='应用后用于当前会话的后续请求。';$('settingsSave').disabled=false}catch(e){$('settingsState').textContent=e.message||String(e)}finally{settingsBusy=false}}
async function saveSettings(){if(settingsBusy||selected?.id!==settingsThread)return;settingsBusy=true;$('settingsSave').disabled=true;$('settingsState').textContent='正在应用…';const previous=composerSettings.get(settingsThread)||{};try{let changes;if(settingsKind==='model'){changes={model:$('modelSelect').value};if(!$('effortSelect').disabled)changes.effort=$('effortSelect').value}else{const mode=$('permissionSelect').value;if(mode==='custom'){$('settingsDialog').close();return}const sandboxPolicy=mode==='full-access'?{type:'dangerFullAccess'}:mode==='read-only'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:previous.runtimeWorkspaceRoots||[selected.cwd].filter(Boolean),networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false};changes={approvalPolicy:mode==='full-access'?'never':'on-request',approvalsReviewer:'user',sandboxPolicy}}const confirmed=await settingsRpc('thread/settings/update',{threadId:settingsThread,...changes});if(changes.sandboxPolicy&&(confirmed?.sandboxPolicy?.type!==changes.sandboxPolicy.type||confirmed?.approvalPolicy!==changes.approvalPolicy))throw Error('权限尚未同步，请重新读取后重试');if(changes.model&&confirmed?.model!==changes.model)throw Error('模型尚未同步，请重新读取后重试');composerSettings.set(settingsThread,confirmed);refreshComposer();$('settingsDialog').close()}catch(e){$('settingsState').textContent=e.message||String(e)}finally{settingsBusy=false;$('settingsSave').disabled=false}}
function attachmentsFor(id=selected?.id){return draftAttachments.get(id)||[]}
function renderAttachments(){const list=$('attachments');list.replaceChildren();const id=selected?.id;for(const file of attachmentsFor(id)){const chip=document.createElement('div');chip.className='attachment';const name=document.createElement('span');name.textContent=file.name;const remove=button('×',()=>{draftAttachments.set(id,attachmentsFor(id).filter(f=>f!==file));renderAttachments()});remove.setAttribute('aria-label','移除 '+file.name);chip.append(name,remove);list.append(chip)}if(uploading){const pending=document.createElement('span');pending.className='attachment';pending.textContent='正在上传附件…';list.append(pending)}list.hidden=!list.childElementCount;$('prompt').required=!attachmentsFor(id).length;$('addAttachment').disabled=uploading>0}
async function uploadFiles(files){if(!selected)return;$('addMenu').hidden=true;$('addAttachment').setAttribute('aria-expanded','false');const id=selected.id;uploading++;renderAttachments();try{for(const file of files){if(file.size>20*1024*1024)throw Error(file.name+' 超过 20 MB');const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('无法读取文件'));reader.readAsDataURL(file)});const attachment=await mobileApi('upload',{name:file.name,mime:file.type,base64});draftAttachments.set(id,[...attachmentsFor(id),attachment])}}catch(e){error(e)}finally{uploading--;renderAttachments();$('imagePicker').value='';$('filePicker').value=''}}
function attachmentPrompt(text){if(uploading){error(Error('附件仍在上传，请稍后发送'));return ''}const files=attachmentsFor();if(!files.length)return text;return (text||'请查看这些附件。')+'\n\n附件（已上传到电脑，请读取对应文件）：\n'+files.map(f=>f.name+'\n'+f.path).join('\n')}
function clearAttachments(id){draftAttachments.delete(id);if(selected?.id===id)renderAttachments()}
$('addAttachment').onclick=()=>{$('addMenu').hidden=!$('addMenu').hidden;$('addAttachment').setAttribute('aria-expanded',String(!$('addMenu').hidden))};$('addImage').onclick=()=>{$('addMenu').hidden=true;$('imagePicker').click()};$('addFile').onclick=()=>{$('addMenu').hidden=true;$('filePicker').click()};$('imagePicker').onchange=e=>uploadFiles([...e.target.files]);$('filePicker').onchange=e=>uploadFiles([...e.target.files]);$('modelButton').onclick=()=>openSettings('model');$('permissionsButton').onclick=()=>openSettings('permissions');$('modelSelect').onchange=()=>populateEfforts();$('permissionSelect').onchange=describePermission;$('settingsSave').onclick=saveSettings;$('settingsClose').onclick=()=>{if(!settingsBusy)$('settingsDialog').close()};
function rememberThreadSettings(response){composerSettings.set(response.thread.id,response.settings||response)}
window.addEventListener('pagehide',()=>{if(selected)sessionStorage.setItem('codex-mobile-scroll',JSON.stringify({id:selected.id,y:window.scrollY}))});
async function restoreChat(){const id=new URL(location.href).searchParams.get('thread')||sessionStorage.getItem('codex-mobile-chat');if(!/^[0-9a-f-]{36}$/i.test(id||'')||restoringChat)return;restoringChat=true;try{await openThread(id);let scroll;try{scroll=JSON.parse(sessionStorage.getItem('codex-mobile-scroll'))}catch{}if(scroll?.id===id)requestAnimationFrame(()=>requestAnimationFrame(()=>{window.scrollTo(0,scroll.y);updateLatestButton()}))}finally{restoringChat=false}}
let taskControlBusy=false;
function taskControlState(){
 const latest=selected?.turns?.at(-1),live=liveActivity.get(selected?.id);
 const finished=live?.running===false&&(!live.turnId||live.turnId===latest?.id||latest?.status!=='inProgress');
 const running=!finished&&(live?.running===true||latest?.status==='inProgress'||selected?.status?.type==='active');
 const status=finished&&live.turnId&&live.turnId!==latest?.id?live.turnStatus:(finished&&live.turnStatus)||latest?.status;
 return {running,canContinue:!running&&status==='interrupted'};
}
function updateTaskControls(){
 const {running,canContinue}=taskControlState(),primary=$('send');
 const disabled=taskControlBusy||sending||opening||!remoteChatReady();
 $('stop').hidden=!running;$('stop').disabled=disabled;
 primary.type=canContinue?'button':'submit';primary.disabled=disabled;
 primary.textContent=sending?'确认中…':canContinue?(taskControlBusy?'继续中…':'继续'):'发送';
}
async function pauseTask(){
 if(!selected||$('stop').disabled||!taskControlState().running)return;
 const id=selected.id,activeId=liveActivity.get(id)?.turnId||turnId;
 if(!activeId){error(Error('尚未取得当前任务编号，请稍后重试'));return}
 taskControlBusy=true;clearError();updateTaskControls();$('stop').textContent='暂停中…';
 let interrupted=false;
 try{await desktopRpc('turn/interrupt',{threadId:id,turnId:activeId});interrupted=true}
 catch(e){if(!/no active turn to interrupt/i.test(e.message)){error(e);return}}
 finally{
  taskControlBusy=false;$('stop').textContent='暂停';
  if(selected?.id===id){
   const live=liveActivity.get(id),latest=selected.turns?.at(-1);
   if(interrupted){
    if((!live?.turnId||live.turnId===activeId)&&!['completed','failed'].includes(live?.turnStatus)){
     liveActivity.set(id,{running:false,turnId:activeId,turnStatus:'interrupted'});
     if(latest?.id===activeId)latest.status='interrupted';
     selected.status={type:'idle'};turnId=null;
     $('turnState').textContent='已暂停，可点击继续接着处理';
    }
   }else if(!live?.turnId||live.turnId===activeId){
    liveActivity.set(id,{running:false,turnId:activeId,turnStatus:live?.turnStatus});
    selected.status={type:'idle'};turnId=null;
   }
   updateActivity();scheduleRead();
  }
  updateTaskControls();
 }
}
async function continueTask(){
 if(!selected||$('send').disabled||!taskControlState().canContinue)return;
 const id=selected.id;
 taskControlBusy=true;clearError();updateTaskControls();
 const text='请继续当前会话中尚未完成的任务，从刚才暂停或中断的位置接着处理。先检查已有进度，避免重复已完成的操作；如果任务已经完成，请说明结果。';
 try{await sendToDesktop(id,text);if(selected?.id===id)$('turnState').textContent='已请求继续任务'}
 catch(e){if(!e.pendingOperation)error(e)}
 finally{taskControlBusy=false;refreshOperationControls()}
}
$('send').onclick=event=>{
 if($('send').type==='button'){event.preventDefault();continueTask()}
};

// VisualViewport covers iOS/Android browsers whose keyboard overlays the layout viewport.
let viewportFrame=0,followKeyboardToLatest=false;
function syncKeyboardViewport(){cancelAnimationFrame(viewportFrame);viewportFrame=requestAnimationFrame(()=>{const viewport=window.visualViewport;const unzoomed=!viewport||Math.abs(viewport.scale-1)<.05;const inset=viewport&&unzoomed?Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop):0;const root=document.documentElement;root.style.setProperty('--keyboard-inset',inset+'px');root.style.setProperty('--visible-height',(viewport?.height||window.innerHeight)+'px');root.dataset.keyboardOpen=String(inset>100||document.activeElement===$('prompt')&&window.innerHeight<keyboardBaselineHeight-100);if(selected&&followKeyboardToLatest&&document.activeElement===$('prompt'))requestAnimationFrame(goLatest);updateLatestButton()})}
let keyboardBaselineHeight=window.innerHeight;
window.visualViewport?.addEventListener('resize',syncKeyboardViewport);window.visualViewport?.addEventListener('scroll',syncKeyboardViewport);window.addEventListener('resize',()=>{if(document.activeElement!==$('prompt'))keyboardBaselineHeight=window.innerHeight;syncKeyboardViewport()});
$('prompt').addEventListener('focus',()=>{followKeyboardToLatest=atLatest();syncKeyboardViewport()});$('prompt').addEventListener('blur',()=>{followKeyboardToLatest=false;syncKeyboardViewport()});window.addEventListener('orientationchange',()=>{keyboardBaselineHeight=window.innerHeight;syncKeyboardViewport()});syncKeyboardViewport();

const slashPrompt=$('prompt'),slashCommands=document.createElement('div');
slashCommands.id='slashCommands';
slashCommands.setAttribute('role','group');
slashCommands.setAttribute('aria-label','斜杠指令');
slashCommands.hidden=true;
slashPrompt.after(slashCommands);
slashPrompt.setAttribute('aria-controls',slashCommands.id);
let slashIndex=-1,slashComposing=false;

let goalThread=null,goalBusy=false,goalBarThread=null,goalBarRead=null;
const goalLabels={active:'进行中',paused:'已暂停',complete:'已完成',blocked:'遇到阻塞',stalled:'进度停滞',budgetLimited:'已达预算上限',usageLimited:'已达用量上限'};
const goalBar=document.createElement('button'),goalBarLabel=document.createElement('span'),goalBarText=document.createElement('span');
const svgNs='http://www.w3.org/2000/svg',goalBarIcon=document.createElementNS(svgNs,'svg');
goalBarIcon.setAttribute('class','goal-bar-icon');
goalBarIcon.setAttribute('viewBox','0 0 24 24');
goalBarIcon.setAttribute('aria-hidden','true');
for(const radius of [10,6,2]){
 const circle=document.createElementNS(svgNs,'circle');
 circle.setAttribute('cx','12');
 circle.setAttribute('cy','12');
 circle.setAttribute('r',radius);
 goalBarIcon.append(circle);
}
goalBar.id='goalBar';
goalBar.type='button';
goalBar.hidden=true;
goalBar.setAttribute('aria-haspopup','dialog');
goalBar.setAttribute('aria-controls','goalDialog');
goalBarLabel.className='goal-bar-label';
goalBarText.className='goal-bar-text';
goalBar.append(goalBarIcon,goalBarLabel,goalBarText);
$('form').prepend(goalBar);
goalBar.onclick=()=>openGoal();

function renderGoalBar(id,goal){
 if(goalBarThread!==id)return;
 goalBar.hidden=!goal?.objective;
 const status=goal?(goalLabels[goal.status]||'已设定'):'',objective=goal?.objective||'';
 goalBar.dataset.status=goal?.status||'';
 goalBarLabel.textContent=status;
 goalBarText.textContent=objective;
 goalBar.title=objective;
 goalBar.setAttribute('aria-label',objective?`会话目标，${status}：${objective}`:'会话目标');
}
function selectGoalBarThread(id){
 if(id!==goalBarThread){
  goalBarThread=id;
  goalBarRead=null;
  renderGoalBar(id,null);
 }
 refreshGoalBar();
}
async function refreshGoalBar(){
 const id=goalBarThread;
 if(!id||goalBarRead||goalBusy||document.hidden||!remoteChatReady())return;
 const read=goalBarRead={};
 try{
  const result=await desktopRpc('thread/goal/get',{threadId:id});
  if(goalBarRead===read&&Object.hasOwn(result||{},'goal'))renderGoalBar(id,result.goal);
 }catch{} // Keep the last confirmed state during a transient disconnect.
 finally{if(goalBarRead===read)goalBarRead=null}
}
setInterval(refreshGoalBar,5000);
document.addEventListener('visibilitychange',refreshGoalBar);

function renderGoal(goal){
 $('goalState').textContent=goal?(goalLabels[goal.status]||'目标已设定'):'暂无目标';
 $('goalObjective').textContent=goal?.objective||'';
 $('goalObjective').hidden=!goal;
 $('goalForm').hidden=!!goal;
 $('goalActions').hidden=!goal;
 const toggle=$('goalStatus');
 toggle.hidden=!['active','paused'].includes(goal?.status);
 toggle.textContent=goal?.status==='active'?'暂停目标':'继续目标';
 toggle.dataset.status=goal?.status==='active'?'paused':'active';
}
function setGoalBusy(busy){
 goalBusy=busy;
 if(busy)goalBarRead=null;
 for(const id of ['goalInput','goalCreate','goalStatus','goalClear','goalClose'])$(id).disabled=busy;
}
async function openGoal(){
 if(!selected||goalBusy||$('goalDialog').open)return;
 if(goalThread!==selected.id)$('goalInput').value='';
 goalThread=selected.id;
 $('goalObjective').hidden=$('goalForm').hidden=$('goalActions').hidden=true;
 $('goalState').textContent='正在读取目标…';
 $('goalDialog').showModal();
 setGoalBusy(true);
 try{
  const {goal}=await desktopRpc('thread/goal/get',{threadId:goalThread});
  renderGoal(goal);
  renderGoalBar(goalThread,goal);
 }
 catch(e){$('goalState').textContent=e.message||String(e)}
 finally{setGoalBusy(false)}
}
async function changeGoal(method,params){
 if(goalBusy||selected?.id!==goalThread||!$('goalDialog').open)return;
 setGoalBusy(true);
 $('goalState').textContent='正在更新目标…';
 try{
  const result=await desktopRpc(method,{threadId:goalThread,...params});
  if(method==='thread/goal/clear'){
   if(typeof result?.cleared!=='boolean')throw Error('桌面未确认目标已清除');
   renderGoal(null);
   renderGoalBar(goalThread,null);
  }else{
   if(!result?.goal)throw Error('桌面未返回更新后的目标');
   renderGoal(result.goal);
   renderGoalBar(goalThread,result.goal);
  }
  $('goalInput').value='';
 }catch(e){
  $('goalForm').hidden=$('goalActions').hidden=true;
  $('goalState').textContent=(e.message||String(e))+'。请重新打开面板核对目标状态。';
 }
 finally{setGoalBusy(false)}
}
$('goalClose').onclick=()=>$('goalDialog').close();
$('goalDialog').addEventListener('cancel',e=>{if(goalBusy)e.preventDefault()});
$('goalForm').onsubmit=e=>{
 e.preventDefault();
 const objective=$('goalInput').value.trim();
 if([...objective].length>4000){$('goalState').textContent='目标不能超过 4000 字';return}
 if(objective)changeGoal('thread/goal/set',{objective});
};
$('goalStatus').onclick=()=>changeGoal('thread/goal/set',{status:$('goalStatus').dataset.status});
$('goalClear').onclick=()=>{if(window.confirm('清除当前会话的目标？'))changeGoal('thread/goal/clear',{})};

function mobileSlashActions(){
 const thread=selected;
 return [
  ['goal','查看或管理当前会话目标',openGoal],
  ['model','选择模型和推理强度',()=>$('modelButton').click()],
  ['reasoning','调整推理强度',()=>$('modelButton').click()],
  ['new','在当前目录新建聊天',()=>{
   if(!thread.cwd)throw Error('当前会话没有可用的项目目录，请从主页新建');
   $('cwd').value=thread.cwd;
   return create();
  }],
  ['fork','复制上下文到新聊天',()=>$('resumeCopy').click()],
  ['rename','重命名当前聊天',()=>openThreadRename(thread)],
  ['pin',desktopThreadPins.has(thread.id)?'取消置顶当前聊天':'置顶当前聊天',()=>toggleThreadPin(thread)]
 ];
}

function openTypedGoal(draft){
 if(!/^[/／]goal$/i.test(draft))return false;
 slashPrompt.value='';saveChatDraft();
 closeSlashCommands();slashPrompt.blur();
 openGoal();
 return true;
}

function closeSlashCommands(){
 slashCommands.hidden=true;slashIndex=-1;
}
function updateSlashCommands(){
 // Only match a standalone command, not a file path, URL, or draft containing text.
 const match=selected&&!slashComposing&&document.activeElement===slashPrompt&&
  slashPrompt.selectionStart===slashPrompt.value.length&&slashPrompt.selectionEnd===slashPrompt.value.length&&
  /^[/／]([a-z-]*)$/i.exec(slashPrompt.value);
 if(!match){closeSlashCommands();return}
 const prefix=match[1].toLowerCase();
 slashCommands.replaceChildren();
 for(const [name,label,run] of mobileSlashActions()){
  if(!name.startsWith(prefix))continue;
  const choice=document.createElement('button'),command=document.createElement('strong'),description=document.createElement('span');
  choice.type='button';
  command.textContent='/'+name;description.textContent=label;choice.append(command,description);
  choice.onclick=()=>{
   if(slashCommands.hidden||!selected)return;
   closeSlashCommands();
   slashPrompt.value='';saveChatDraft();
   slashPrompt.blur();choice.blur();
   Promise.resolve().then(run).catch(error);
  };
  slashCommands.append(choice);
 }
 slashIndex=-1;slashCommands.scrollTop=0;slashCommands.hidden=!slashCommands.childElementCount;
}
slashPrompt.addEventListener('input',updateSlashCommands);
slashPrompt.addEventListener('focus',updateSlashCommands);
slashPrompt.addEventListener('compositionstart',()=>{slashComposing=true;closeSlashCommands()});
slashPrompt.addEventListener('compositionend',()=>{slashComposing=false;updateSlashCommands()});
slashPrompt.addEventListener('keydown',e=>{
 if(e.isComposing||slashComposing||slashCommands.hidden)return;
 const choices=slashCommands.children;
 if(e.key==='Escape'){e.preventDefault();closeSlashCommands();return}
 if(e.key==='Enter'&&slashIndex>=0&&!e.shiftKey&&!e.ctrlKey&&!e.altKey&&!e.metaKey){e.preventDefault();choices[slashIndex].click();return}
 if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;
 e.preventDefault();
 choices[slashIndex]?.removeAttribute('data-current');
 slashIndex=slashIndex<0?(e.key==='ArrowDown'?0:choices.length-1):
  (slashIndex+(e.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
 choices[slashIndex].dataset.current='true';
 choices[slashIndex].scrollIntoView({block:'nearest'});
});
slashCommands.addEventListener('keydown',e=>{
 if(e.key==='Escape'){e.preventDefault();slashPrompt.focus();closeSlashCommands()}
});
$('form').addEventListener('focusout',e=>{
 if(e.relatedTarget!==slashPrompt&&!slashCommands.contains(e.relatedTarget))closeSlashCommands();
});
slashCommands.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')e.preventDefault()});
document.addEventListener('pointerdown',e=>{
 if(e.target!==slashPrompt&&!slashCommands.contains(e.target))closeSlashCommands();
});

// Share desktop unread state and activity across recent and workspace lists.
const desktopThreadPins=new Set();
const desktopThreadRows=new Map(),pinChanges=new Set();
let pinRevision=0;
let desktopThreadStates=new Map(),unreadThreadIds=new Set(),threadStateReading=false,renameThreadId=null;
function listedThread(id){const recent=threadRows.find(t=>t.id===id),desktop=desktopThreadRows.get(id);return recent||desktop}
function renderPinnedThreads(){
 const container=$('pinnedThreads');container.replaceChildren();
 const rows=orderedThreadRows(container.id,[...desktopThreadPins].map(listedThread).filter(Boolean));
 for(const t of rows)container.append(makeThreadRow(t));
 if(!container.childElementCount){const hint=document.createElement('div');hint.className='thread-list-empty';hint.textContent='暂无置顶会话，可点会话右侧 ⋯ → 置顶。';container.append(hint)}
}
async function toggleThreadPin(t){
 if(pinChanges.has(t.id))return;
 const pinned=desktopThreadPins.has(t.id);pinChanges.add(t.id);pinRevision++;
 document.querySelectorAll('.thread-row').forEach(row=>{if(row.dataset.threadId===t.id)row.querySelector('[data-action=pin]').disabled=true});
 try{await desktopRpc('thread/pin',{threadId:t.id,pinned:!pinned});if(pinned){desktopThreadPins.delete(t.id);if(!threadRows.some(row=>row.id===t.id))threadRows.push(t)}else desktopThreadPins.add(t.id)}
 finally{pinChanges.delete(t.id);pinRevision++;renderList()}
}
async function listThreads(params){return desktopRpc('thread/list',params)}
function threadRowStatus(t){
 const cached=threadCache.get(t.id),live=liveActivity.get(t.id),status=desktopThreadStates.get(t.id)||live?.status||t.status||cached?.status;
 if([...pendingApprovals.values()].some(e=>e.request.params?.threadId===t.id)||(status?.activeFlags||[]).some(f=>/waiting/i.test(f)))return 'waiting';
 if(status?.type==='active'||!desktopThreadStates.has(t.id)&&(live?.running===true||live?.running!==false&&cached?.turns?.at(-1)?.status==='inProgress'))return 'running';
 return unreadThreadIds.has(t.id)?'unread':'idle';
}
let threadAutomations={};
function renderAutomationIcon(icon,id){
 const {active=0,paused=0}=threadAutomations[id?.toLowerCase()]||{};
 icon.hidden=!active&&!paused;
 icon.setAttribute('aria-label','自动任务：已启用 '+active+' 项，已暂停 '+paused+' 项');
}
function refreshThreadIndicators(){
 for(const row of document.querySelectorAll('.thread-row')){
  const t=listedThread(row.dataset.threadId);if(!t)continue;
  const status=threadRowStatus(t),node=row.querySelector('.thread-status'),label={waiting:'待审批',running:'运行中',unread:'未读',idle:'已读'}[status];
  node.dataset.status=status;node.setAttribute('aria-label',label);node.title=label;
  renderAutomationIcon(row.querySelector('.thread-automation'),t.id);
 }
}
function closeThreadMenus(){document.querySelectorAll('.thread-menu').forEach(m=>m.hidden=true);document.querySelectorAll('.thread-more').forEach(b=>b.setAttribute('aria-expanded','false'))}
const threadOrderKey='codex-mobile-thread-order',threadOrders=new Map();
try{
 for(const [scope,ids] of Object.entries(JSON.parse(localStorage.getItem(threadOrderKey)||'{}')))
  if(Array.isArray(ids))threadOrders.set(scope,[...new Set(ids.filter(id=>typeof id==='string'))]);
}catch{}
function orderedThreadRows(scope,rows){
 const order=threadOrders.get(scope);
 if(!order?.length)return rows;
 const byId=new Map(rows.map(row=>[row.id,row]));
 const ordered=order.map(id=>byId.get(id)).filter(Boolean),known=new Set(ordered.map(row=>row.id));
 // Unseen sessions keep their default slots; the saved IDs fill the other slots.
 let index=0;
 return rows.map(row=>known.has(row.id)?ordered[index++]:row);
}
let threadPress=null,threadRenderPending=false,skipThreadClickUntil=0;
function deferThreadListRender(){
 if(!threadPress)return false;
 threadRenderPending=true;return true;
}
const threadSiblings=list=>[...list.children].filter(el=>el.matches('.thread-row'));
function persistThreadOrder(scope,ids){
 const shown=new Set(ids),previous=threadOrders.get(scope)||[];
 const merged=[...previous,...ids.filter(id=>!previous.includes(id))];
 let index=0;
 threadOrders.set(scope,merged.map(id=>shown.has(id)?ids[index++]:id));
 try{localStorage.setItem(threadOrderKey,JSON.stringify(Object.fromEntries(threadOrders)))}catch{}
}
function repositionThread(drag){
 const rows=threadSiblings(drag.list),current=rows.indexOf(drag.row),siblings=rows.filter(row=>row!==drag.row);
 const target=siblings.findIndex(row=>{const rect=row.getBoundingClientRect();return drag.y-drag.offset+drag.height/2<rect.top+rect.height/2});
 const slot=target<0?siblings.length:target;
 // Reflow the neighbors without detaching the browser's active touch target.
 if(slot>current)for(const row of siblings.slice(current,slot))drag.list.insertBefore(row,drag.row);
 if(slot<current){
  const after=drag.row.nextElementSibling;
  for(const row of siblings.slice(slot,current))drag.list.insertBefore(row,after);
 }
 const rect=drag.row.getBoundingClientRect(),shift=drag.y-drag.offset-rect.top+drag.shift;
 drag.shift=shift;drag.row.style.transform='translateY('+shift+'px)';
}
function scrollThreadDrag(){
 const drag=threadPress;
 if(!drag?.active)return;
 const top=document.querySelector('header').getBoundingClientRect().bottom,bottom=$('homeFooter').getBoundingClientRect().top;
 const speed=drag.y<top+44?-Math.min(16,(top+44-drag.y)/3):drag.y>bottom-44?Math.min(16,(drag.y-bottom+44)/3):0;
 if(drag.moved&&speed){const before=scrollY;window.scrollBy(0,speed);if(scrollY!==before)repositionThread(drag)}
 drag.frame=requestAnimationFrame(scrollThreadDrag);
}
function beginThreadPress(row,x,y,input,id){
 if(threadPress||selected||row.querySelector('.thread-menu:not([hidden])'))return;
 const list=row.parentElement,scope=list.dataset.orderScope||list.id,rows=threadSiblings(list);
 if(!scope||rows.length<2)return;
 skipThreadClickUntil=0;
 const drag={row,list,scope,input,id,x,startY:y,y,rows,shift:0};
 threadPress=drag;
 drag.timer=setTimeout(()=>{
  if(threadPress!==drag||!row.isConnected||selected){finishThreadPress(false);return}
  const rect=row.getBoundingClientRect();
  drag.active=true;drag.offset=y-rect.top;drag.height=rect.height;
  row.classList.add('thread-dragging');$('home').classList.add('thread-sorting');
  drag.frame=requestAnimationFrame(scrollThreadDrag);
 },420);
}
function moveThreadPress(x,y,event){
 const drag=threadPress;
 if(!drag.active){if(Math.hypot(x-drag.x,y-drag.startY)>9)finishThreadPress(false);return}
 if(event.cancelable)event.preventDefault();
 drag.moved=true;drag.y=y;repositionThread(drag);
}
function finishThreadPress(save){
 const drag=threadPress;
 if(!drag)return;
 threadPress=null;clearTimeout(drag.timer);
 if(drag.active){
  cancelAnimationFrame(drag.frame);
  // A long press must never fall through to opening the chat.
  skipThreadClickUntil=performance.now()+650;
  drag.row.classList.remove('thread-dragging');drag.row.style.transform='';
  $('home').classList.remove('thread-sorting');
  const rows=threadSiblings(drag.list);
  if(save&&rows.some((row,i)=>row!==drag.rows[i]))persistThreadOrder(drag.scope,rows.map(row=>row.dataset.threadId));
  if(!save)threadRenderPending=true;
 }
 if(threadRenderPending){threadRenderPending=false;renderList()}
}
document.addEventListener('pointerdown',event=>{
 skipThreadClickUntil=0;
 const row=event.target.closest('.thread-row>.thread')?.parentElement;
 if(row&&event.pointerType!=='touch'&&event.button===0)beginThreadPress(row,event.clientX,event.clientY,'pointer',event.pointerId);
});
document.addEventListener('pointermove',event=>{
 if(threadPress?.input==='pointer'&&threadPress.id===event.pointerId)moveThreadPress(event.clientX,event.clientY,event);
});
for(const type of ['pointerup','pointercancel'])document.addEventListener(type,event=>{
 if(threadPress?.input==='pointer'&&threadPress.id===event.pointerId)finishThreadPress(type==='pointerup');
});
document.addEventListener('touchstart',event=>{
 if(event.touches.length!==1){finishThreadPress(false);return}
 const row=event.target.closest('.thread-row>.thread')?.parentElement,touch=event.changedTouches[0];
 if(row)beginThreadPress(row,touch.clientX,touch.clientY,'touch',touch.identifier);
},{passive:true});
document.addEventListener('touchmove',event=>{
 if(threadPress?.input!=='touch')return;
 const touch=[...event.changedTouches].find(t=>t.identifier===threadPress.id);
 if(touch)moveThreadPress(touch.clientX,touch.clientY,event);
},{passive:false});
for(const type of ['touchend','touchcancel'])document.addEventListener(type,event=>{
 if(threadPress?.input==='touch'&&[...event.changedTouches].some(t=>t.identifier===threadPress.id)){
  if(threadPress.active&&event.cancelable)event.preventDefault();
  finishThreadPress(type==='touchend');
 }
},{passive:false});
document.addEventListener('contextmenu',event=>{
 if(threadPress?.input==='touch'&&threadPress.row.contains(event.target))event.preventDefault();
});
document.addEventListener('click',event=>{
 if(skipThreadClickUntil>performance.now()&&event.target.closest('.thread-row')){event.preventDefault();event.stopImmediatePropagation()}
},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&threadPress)finishThreadPress(false)});
window.addEventListener('blur',()=>finishThreadPress(false));
function openThreadRename(t){
 renameThreadId=t.id;
 $('renameInput').value=threadDisplayTitle(t,'');
 $('renameError').textContent='';
 $('threadRename').showModal();
 $('renameInput').focus();
}
function makeThreadRow(t){
 const row=document.createElement('div');row.className='thread-row';row.dataset.threadId=t.id;
 const open=button('',()=>openThread(t.id));open.className='thread';
 const indicator=document.createElement('span');indicator.className='thread-status';indicator.setAttribute('role','img');
 const content=document.createElement('span');content.className='thread-content';
 const title=document.createElement('strong');title.textContent=threadDisplayTitle(t,'未命名聊天');
 const time=document.createElement('small');time.textContent=new Date(threadActivityTime(t)*1000).toLocaleString();content.append(title,time);
 const automation=document.createElement('span');automation.className='thread-automation';automation.setAttribute('role','img');
 // Same clock-light-16 glyph as the desktop sidebar.
 automation.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8.00037 4.14209C8.29009 4.14235 8.52478 4.37769 8.52478 4.66748V7.86279C8.52464 8.0901 8.43446 8.30843 8.2738 8.46924L6.70447 10.0386C6.49954 10.2433 6.16728 10.2432 5.96228 10.0386C5.75731 9.8336 5.75742 9.50142 5.96228 9.29639L7.47498 7.78369V4.66748C7.47498 4.37753 7.71042 4.14209 8.00037 4.14209Z"/><path fill-rule="evenodd" d="M8.00037 1.4751C11.604 1.4751 14.5258 4.39683 14.5258 8.00049C14.5258 11.6041 11.604 14.5259 8.00037 14.5259C4.39671 14.5259 1.47498 11.6041 1.47498 8.00049C1.47498 4.39683 4.39671 1.4751 8.00037 1.4751ZM8.00037 2.52588C4.97661 2.52588 2.52576 4.97673 2.52576 8.00049C2.52576 11.0242 4.97661 13.4751 8.00037 13.4751C11.0241 13.4751 13.475 11.0242 13.475 8.00049C13.475 4.97673 11.0241 2.52588 8.00037 2.52588Z"/></svg>';
 renderAutomationIcon(automation,t.id);open.append(indicator,content,automation);
 const more=button('⋯',()=>{const show=menu.hidden;closeThreadMenus();menu.hidden=!show;more.setAttribute('aria-expanded',String(show))});more.className='thread-more';more.setAttribute('aria-label','更多选项：'+title.textContent);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');
 const menu=document.createElement('div');menu.className='thread-menu';menu.hidden=true;menu.setAttribute('role','menu');
 const action=(label,fn)=>{const b=button(label,async()=>{closeThreadMenus();b.disabled=true;try{await fn()}finally{b.disabled=false}});b.setAttribute('role','menuitem');menu.append(b);return b};
 const pin=action(desktopThreadPins.has(t.id)?'取消置顶':'置顶',()=>toggleThreadPin(t));pin.dataset.action='pin';pin.disabled=pinChanges.has(t.id);
 action('重命名',()=>openThreadRename(t));
 action('标记为已读',()=>setThreadUnread(t.id,false));
 action('标记为未读',()=>setThreadUnread(t.id,true));
 action('复制会话链接',()=>{const url=new URL(location.href);url.searchParams.delete('token');url.searchParams.set('thread',t.id);return navigator.clipboard.writeText(url.href)});
 if(t.cwd)action('复制工作目录',()=>navigator.clipboard.writeText(t.cwd));
 action('归档',async()=>{await desktopRpc('thread/archive',{threadId:t.id});threadRows=threadRows.filter(x=>x.id!==t.id);desktopThreadPins.delete(t.id);desktopThreadRows.delete(t.id);pinRevision++;threadCache.delete(t.id);liveActivity.delete(t.id);unreadThreadIds.delete(t.id);renderList();refreshThreadIndicators()});
 row.append(open,more,menu);
 queueMicrotask(refreshThreadIndicators);return row;
}
function applyDesktopState(state,revision=pinRevision){
 const pinTitles=()=>JSON.stringify([...desktopThreadPins].map(id=>[id,threadDisplayTitle(listedThread(id),'')]));
 const before=pinTitles();
 if(state.threads){desktopThreadRows.clear();for(const t of state.threads){const seconds=value=>Number(value)>1e11?Number(value)/1000:Number(value)||0;desktopThreadRows.set(t.id,{...t,name:t.title||t.name,updatedAt:seconds(t.updatedAt),recencyAt:seconds(t.recencyAt??t.updatedAt),status:{type:t.status}})}desktopThreadStates=new Map(state.threads.map(t=>[t.id,{type:t.status}]))}
 if(state.pinnedIds&&revision===pinRevision&&!pinChanges.size){desktopThreadPins.clear();state.pinnedIds.forEach(id=>desktopThreadPins.add(id))}
 unreadThreadIds=new Set(state.unreadIds||[]);
 threadAutomations=state.threadAutomations||{};
 if(before!==pinTitles())renderList();
}
async function syncThreadState(){if(threadStateReading||document.hidden)return;threadStateReading=true;const revision=pinRevision;try{const state=await mobileApi('thread-state');applyDesktopState(state,revision);refreshThreadIndicators()}finally{threadStateReading=false}}
async function setThreadUnread(threadId,unread){const revision=pinRevision;const state=await mobileApi('thread-state',{threadId,unread});applyDesktopState(state,revision);refreshThreadIndicators()}
async function markThreadRead(id){if(unreadThreadIds.has(id))await setThreadUnread(id,false)}
document.addEventListener('click',e=>{if(!e.target.closest('.thread-more,.thread-menu'))closeThreadMenus()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeThreadMenus()});
$('renameCancel').onclick=()=>$('threadRename').close();
$('renameForm').onsubmit=async e=>{e.preventDefault();const name=$('renameInput').value.trim();if(!name)return;const id=renameThreadId;$('renameSave').disabled=true;try{await desktopRpc('thread/name/set',{threadId:id,name});for(const t of threadRows)if(t.id===id)t.name=name;const desktop=desktopThreadRows.get(id);if(desktop)desktop.name=name;const cached=threadCache.get(id);if(cached)cached.name=name;if(selected?.id===id){selected.name=name;setChatTitle(selected)}renderList();$('threadRename').close()}catch(e){$('renameError').textContent=e.message}finally{$('renameSave').disabled=false}};
syncThreadState().catch(()=>{});
setInterval(()=>{if(!document.hidden){syncThreadState().catch(()=>{});if(selected)readCurrent().catch(error);if(!selected&&!document.querySelector('.thread-menu:not([hidden])')&&!$('threadRename').open)list().catch(error)}},5000);

function saveChatDraft(id=selected?.id){if(id)sessionStorage.setItem('codex-draft:'+id,$('prompt').value)}
function restoreChatDraft(id){$('prompt').value=sessionStorage.getItem('codex-draft:'+id)||''}
$('prompt').addEventListener('input',()=>saveChatDraft());

document.addEventListener('visibilitychange',()=>{if(!document.hidden){syncThreadState().catch(()=>{});if(selected)readCurrent().catch(error);syncApprovals().catch(error)}});


const submittedQuestionAnswers=new Map();
function questionAnswers(t){const answers=new Map(submittedQuestionAnswers.get(t.id)||[]);for(const turn of t.turns||[])for(const item of turn.items||[]){if(item.type!=='userMessage'&&!(item.type==='steeringUserMessage'&&item.status==='accepted'))continue;const content=item.content||item.input||[];if(content.length!==1||content[0].type!=='text')continue;for(const answer of parseQuestionReply(content[0].text)||[])answers.set(answer.questionItemId,answer.answer)}return answers}
function renderAsyncQuestion(node,t,item){
 const answers=questionAnswers(t),questions=item.questions.map((q,index)=>({...q,key:JSON.stringify(['request_user_input_async',item.id,index])}));
 const signature=JSON.stringify(questions.map(q=>[q.key,q.title,q.options,answers.get(q.key)]));if(node._questionSignature===signature){const submit=node._body.querySelector('button[type=submit]');if(submit)submit.disabled=!!pendingSend(t.id);return;}node._questionSignature=signature;
 const form=document.createElement('form');form.className='async-question';const fields=[];
 for(const q of questions){const field=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent=q.title;field.append(legend);form.append(field);
  if(answers.has(q.key)){const done=document.createElement('p');done.className='question-answer';done.textContent='已回答：'+answers.get(q.key);field.append(done);continue}
  const input=document.createElement('textarea');input.placeholder=q.options?.length?'也可以填写其他回答':'请输入你的回答';input.setAttribute('aria-label',q.title);input.value=sessionStorage.getItem('codex-question:'+t.id+':'+q.key)||'';
  const save=()=>sessionStorage.setItem('codex-question:'+t.id+':'+q.key,input.value);
  for(const option of q.options||[]){const label=document.createElement('label');label.className='question-option';const radio=document.createElement('input');radio.type='radio';radio.name=q.key;radio.value=option;radio.checked=input.value===option;radio.onchange=()=>{input.value=option;save()};const text=document.createElement('span');text.textContent=option;label.append(radio,text);field.append(label)}
  input.oninput=()=>{field.querySelectorAll('input[type=radio]').forEach(r=>r.checked=r.value===input.value);save()};field.append(input);fields.push({question:q,input});
 }
 if(fields.length){const submit=document.createElement('button');submit.type='submit';submit.className='primary';submit.textContent='提交回答';submit.disabled=!!pendingSend(t.id);const feedback=document.createElement('p');feedback.className='question-feedback';feedback.setAttribute('role','status');form.append(submit,feedback);form.onsubmit=async e=>{e.preventDefault();const rows=fields.map(({question:q,input})=>({questionItemId:q.key,question:q.title,answer:input.value.trim()}));const missing=rows.findIndex(r=>!r.answer);if(missing>=0){feedback.textContent='请回答所有问题后提交';fields[missing].input.focus();return}submit.disabled=true;feedback.textContent='正在提交回答…';try{await sendToDesktop(t.id,'<send_user_message_question_reply>\n'+JSON.stringify(rows)+'\n</send_user_message_question_reply>');const submitted=submittedQuestionAnswers.get(t.id)||new Map();for(const row of rows){submitted.set(row.questionItemId,row.answer);sessionStorage.removeItem('codex-question:'+t.id+':'+row.questionItemId)}submittedQuestionAnswers.set(t.id,submitted);if(selected?.id===t.id)renderThread(selected);scheduleRead()}catch(e){feedback.textContent=e.pendingOperation?e.message:'提交失败，回答已保留：'+(e.message||String(e));submit.disabled=!!pendingSend(t.id)}}}
 node._body.replaceChildren(form);
}

refreshOperationControls();checkPendingOperations();

// Restore only after shared list state and question helpers have initialized.
loadWorkspaces().catch(error);restoreChat().catch(error);
