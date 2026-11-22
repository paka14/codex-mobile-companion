'use strict';
// Runs inside the desktop renderer. Read the same resolved selection as its composer.
async function desktopCreationPermissions(cwd,resolveFunction){
 const isEntry=script=>{
  if(!script.src)return false;
  const url=new URL(script.src);
  return url.protocol==='app:'&&url.host==='-'&&!url.username&&!url.password&&url.pathname.startsWith('/assets/index-');
 };
 const scope=window.__mobileCompanionScope;if(!scope)throw Error('桌面权限设置尚未就绪');
 if(!window.__mobileCompanionCreationPermissionAtom&&resolveFunction&&![...document.scripts].some(isEntry)){
  await resolveFunction('creationPermissionAtom');
  if(!window.__mobileCompanionCreationPermissionAtom)throw Error('当前桌面版本的权限继承接口不兼容，未创建会话');
 }
 if(!window.__mobileCompanionCreationPermissionAtom){
  const entry=[...document.scripts].find(isEntry)?.src;
  if(!entry)throw Error('无法定位桌面权限接口');
  const bundle=await(await fetch(entry,{redirect:'error'})).text();
  for(const file of new Set(bundle.match(/app-initial-[\w-]+\.js/g)||[])){
   const url=new URL(file,entry).href,source=await(await fetch(url,{redirect:'error'})).text();
   const marker=source.indexOf('enabled===!1?{availablePermissionSelections:null');
   if(marker<0)continue;
   const assignment=source.lastIndexOf('=wc(',marker),symbol=source.slice(0,assignment).match(/[\w$]+$/)?.[0];
   if(!symbol)continue;
   const exports=source.slice(source.lastIndexOf('export{'));
   const escaped=symbol.replace(/[$]/g,'\\$');
   const alias=exports.match(new RegExp('(?:[,\\{])'+escaped+' as ([\\w$]+)(?=[,}])'))?.[1];
   if(!alias)continue;
   const module=await import(url);window.__mobileCompanionCreationPermissionAtom=module[alias];
   if(window.__mobileCompanionCreationPermissionAtom)break;
  }
 }
 const atom=window.__mobileCompanionCreationPermissionAtom;if(!atom)throw Error('当前桌面版本的权限继承接口不兼容，未创建会话');
 let dispose,timer;
 try{return await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('读取桌面权限超时，未创建会话')),10000);
  dispose=scope.watch(({get})=>{
   try{
    const state=get(atom,{cwd,hostId:'local',model:null,workspaceKind:'project'});
    if(state.isLoading)return;
    if(state.isError||!state.permissionSelection)throw Error('无法确认桌面权限，未创建会话');
    resolve(structuredClone(state.permissionSelection));
   }catch(error){reject(error)}
  });
 })}finally{clearTimeout(timer);dispose?.()}
}
module.exports={desktopCreationPermissions};
