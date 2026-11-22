'use strict';
const assert=require('assert/strict');
const {installedAppOrigin,trustedTailscale,authorize,backendHeaders,renderMobile}=require('./mobile-access.cjs');
const config={mode:'tailscale-owner',origin:'https://owner.test:9443',ownerLogin:'owner@example.test'};
const request=()=>({url:'/mobile',socket:{remoteAddress:'127.0.0.1'},headers:{host:'owner.test:9443','x-forwarded-proto':'https','tailscale-user-login':config.ownerLogin}});
for(const token of [undefined,'old','different']){const req=request();if(token)req.headers.authorization='Bearer '+token;assert.equal(authorize(req,config,'fixed'),true)}
for(const url of ['/mobile','/mobile?token=old','/mobile-api/events?token=null','/web/_bridge?token=old']){const req=request();req.url=url;assert.equal(authorize(req,config,'fixed',{query:true}),true)}
for(const changes of [{host:'evil.test:9443'},{'x-forwarded-proto':'http'},{'tailscale-user-login':'other@example.test'},{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'}]){const req=request();Object.assign(req.headers,changes);assert.equal(trustedTailscale(req,config),false)}
for(const address of ['192.168.1.2','100.64.0.1',undefined]){const req=request();req.socket.remoteAddress=address;assert.equal(trustedTailscale(req,config),false)}
for(const missing of ['tailscale-user-login','x-forwarded-proto','host']){const req=request();delete req.headers[missing];assert.equal(trustedTailscale(req,config),false)}
assert.equal(trustedTailscale(request(),{}),false);
const dual={...config,appOrigin:'https://codex.owner.test'};
const appRequest=request();appRequest.headers.host='codex.owner.test';appRequest.headers.origin=dual.appOrigin;
assert.equal(trustedTailscale(appRequest,config),false);
assert.equal(trustedTailscale(appRequest,dual),true);
assert.equal(trustedTailscale(request(),dual),true);
for(const changes of [{origin:config.origin},{host:'codex.owner.test:9443'},{'tailscale-user-login':'other@example.test'},{'x-forwarded-proto':'http'},{'sec-fetch-site':'cross-site'}]){
 const req={...appRequest,headers:{...appRequest.headers,...changes}};
 assert.equal(trustedTailscale(req,dual),false);
}
for(const appOrigin of ['https://owner.test','https://codex.owner.test:9443','https://codex.owner.test/mobile','http://codex.owner.test','https://name@codex.owner.test']){
 assert.throws(()=>installedAppOrigin({...config,appOrigin}),/separate HTTPS hostname/);
}
const local={url:'/web/_bridge?token=fixed',socket:{remoteAddress:'127.0.0.1'},headers:{authorization:'Bearer fixed'}};
assert.equal(authorize(local,config,'fixed'),true);assert.equal(authorize(local,config,'fixed',{query:true}),true);assert.equal(authorize(local,config,'other'),false);
const req=request();req.headers.authorization='Bearer old';const headers=backendHeaders(req,'backend-current');assert.equal(headers.authorization,'Bearer backend-current');assert.equal(headers['tailscale-user-login'],undefined);assert.equal(req.headers.authorization,'Bearer old');
assert.match(renderMobile('<html lang="zh-CN">','version',true),/data-mobile-auth="tailscale"/);assert.doesNotMatch(renderMobile('<html lang="zh-CN">','version',false),/data-mobile-auth/);
console.log('PASS: owner Tailscale access without/with stale tokens, HTTP/SSE/WebSocket authorization, untrusted owner/host/protocol/address/origin denial, legacy token compatibility, backend header translation, secret-free HTML.');
