'use strict';
// Serialized into the desktop renderer. Discovery never invokes the send function.
async function resolveDesktopSend(kind='send'){
 const cache={manager:'__mobileCompanionManagerFactory',send:'__mobileCompanionSendFollowUp',create:'__mobileCompanionStartConversation',title:'__mobileCompanionGenerateTitle',creationPermissions:'__mobileCompanionCreationPermissionReader',creationPermissionAtom:'__mobileCompanionCreationPermissionAtom'}[kind];
 if(!cache)throw Error('未知桌面接口类型');
 const discovery=cache+'Discovery';
 if(typeof window[cache]==='function'||kind==='creationPermissionAtom'&&window[cache])return window[cache];
 if(window[discovery])return window[discovery];
 const pending=(async()=>{
  const find=(module,rspack=false)=>Object.values(module||{}).find(v=>{
   if(typeof v!=='function')return false;
   let source;try{source=v.toString()}catch{return false}
   if(typeof source!=='string')return false;
   if(kind==='create')return source.includes('preparePrimaryRuntimeForFirstTurn')&&source.includes('.startConversation(');
   if(kind==='title')return ['getPastedTextExcerpts','expectedProvisionalTitle','getCachedConversationMetadata','generateTitle','setThreadTitle'].every(key=>source.includes(key));
   if(kind==='creationPermissions')return source.includes('Could not load permissions for the destination project')&&source.includes('permissionSelection')&&source.includes('workspaceKind');
   return kind==='manager'
    ?source.includes('AppServerManager RPC is unavailable for hostId')&&(!rspack||source.includes('.forHost(')&&!source.startsWith('class '))
    :source.includes('Cannot send an empty follow-up message.')&&source.includes('.sendFollowUpMessage(');
  });
  const appAsset=src=>{
   if(!src)return false;
   const url=new URL(src);
   return url.protocol==='app:'&&url.host==='-'&&url.pathname.startsWith('/assets/')&&!url.username&&!url.password;
  };
  const entry=[...document.scripts].find(s=>appAsset(s.src)&&/\/assets\/index-.*\.js/.test(s.src))?.src;
  if(!entry){
   // Rspack exposes its live module cache from the renderer's runtime script.
   // Inspect only already initialized exports; never execute module factories.
   const candidates=new Set();
   for(const script of document.scripts){
    if(script.type!=='module'||!appAsset(script.src)||!/\/assets\/[^/]+\.js(?:\?|$)/.test(script.src))continue;
    let runtime;try{runtime=await import(script.src)}catch{continue}
    const modules=runtime.__webpack_require__?.c;
    if(kind==='creationPermissionAtom'){
     // Follow the native destination-permissions reader's existing import.
     // The reader itself can return null behind a feature gate; the composer
     // still uses this atom to resolve its selected permissions.
     for(const [id,module] of Object.entries(modules||{})){
      let source;try{source=runtime.__webpack_require__.m[id].toString()}catch{continue}
      if(!source.includes('Could not load permissions for the destination project'))continue;
      const ref=source.match(/\.when\([\s\S]*?\.get\(([\w$]+)\.([\w$]+),/);
      if(!ref)continue;
      const escaped=ref[1].replace(/[$]/g,'\\$');
      const imported=source.match(new RegExp('(?:[,; ])'+escaped+'=[\\w$]+\\("([^"]+)"\\)'));
      const atom=imported&&modules[imported[1]]?.exports?.[ref[2]];
      if(atom&&typeof atom.read==='function')candidates.add(atom);
     }
     continue;
    }
    for(const module of Object.values(modules||{})){
     let values;try{values=Object.values(module.exports||{})}catch{continue}
     for(const value of values)if(find({value},true))candidates.add(value);
    }
   }
   if(candidates.size!==1)return null;
   const value=[...candidates][0];window[cache]=value;return value;
  }
  const source=await(await fetch(entry,{redirect:'error'})).text();
  const initialFiles=[...new Set(source.match(/app-initial-[\w-]+\.js/g)||[])];
  for(const file of initialFiles){
   const url=new URL(file,entry).href;
   const module=await import(url);
   let send=find(module);
   if(!send&&kind==='send'){
    // New desktop builds export the composer helper from a separate lazy chunk.
    const initialSource=await(await fetch(url,{redirect:'error'})).text();
    for(const chunk of new Set(initialSource.match(/send-follow-up-message-[\w-]+\.js/g)||[])){
     send=find(await import(new URL(chunk,url).href));
     if(send)break;
    }
   }
   if(send){window[cache]=send;return send}
  }
  return null;
 })();
 window[discovery]=pending;
 try{return await pending}finally{if(window[discovery]===pending)delete window[discovery]}
}
module.exports=resolveDesktopSend;
