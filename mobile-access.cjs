'use strict';
function installedAppOrigin(config){
 if(config?.appOrigin===undefined)return undefined;
 const url=new URL(config.appOrigin);
 if(url.protocol!=='https:'||url.origin!==config.appOrigin||url.port||url.host===new URL(config.origin).hostname)
  throw Error('Codex appOrigin must be a separate HTTPS hostname on its default port');
 return url.origin;
}
// Tailscale Serve supplies identity on the loopback-only proxy connection.
// The owner identity, HTTPS host and browser origin must all match.
function trustedTailscale(req,config){
 if(config?.mode!=='tailscale-owner'||!config.ownerLogin||!config.origin)return false;
 const address=req.socket?.remoteAddress;
 if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address))return false;
 const headers=req.headers||{};
 let origin;try{
  origin=[config.origin,installedAppOrigin(config)].filter(Boolean).map(value=>new URL(value))
   .find(url=>url.protocol==='https:'&&url.host===headers.host);
 }catch{return false}
 if(!origin)return false;
 if(headers['x-forwarded-proto']!=='https')return false;
 if(headers['tailscale-user-login']!==config.ownerLogin)return false;
 if(headers.origin&&headers.origin!==origin.origin)return false;
 if(headers['sec-fetch-site']==='cross-site')return false;
 return true;
}
function authorize(req,config,token,{query=false}={}){
 if(trustedTailscale(req,config))return true;
 if(!token)return false;
 return query?new URL(req.url,'http://localhost').searchParams.get('token')===token:req.headers.authorization==='Bearer '+token;
}
function backendHeaders(req,token){
 const headers={...req.headers,authorization:'Bearer '+token};
 delete headers['tailscale-user-login'];delete headers['tailscale-user-name'];delete headers['tailscale-user-profile-pic'];
 return headers;
}
function renderMobile(html,version,trusted){
 return html.replace('<html lang="zh-CN"','<html lang="zh-CN" data-ui-version="'+version+'"'+(trusted?' data-mobile-auth="tailscale"':''));
}
module.exports={installedAppOrigin,trustedTailscale,authorize,backendHeaders,renderMobile};
