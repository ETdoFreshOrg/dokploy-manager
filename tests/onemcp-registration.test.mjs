import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { installMcpOAuth } from '../oauth/service.mjs';
for (const name of ["dokploy-manager"]) test('1MCP exact callback for ' + name, async () => {
 const origin='https://registration.test', scope=name+'.manage', app=express();
 const auth=installMcpOAuth(app,{name,origin,scope,ownerKey:'synthetic-owner-key',description:'Synthetic'});
 app.post('/mcp',auth,(_req,res)=>res.json({ok:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const source='dokploy';
 const callback='https://1mcp.etdofresh.com/oauth/callback/'+source;
 const q=new URLSearchParams({client_id:'1mcp-'+source,redirect_uri:callback,response_type:'code',resource:origin+'/mcp',scope,code_challenge:'a'.repeat(43),code_challenge_method:'S256',state:'synthetic'});
 try {
  const page=await fetch(base+'/mcp/oauth/authorize?'+q);assert.equal(page.status,200);assert.match(await page.text(),/owner_key/);
  q.set('redirect_uri',callback+'/altered');assert.equal((await fetch(base+'/mcp/oauth/authorize?'+q)).status,400);
  assert.equal((await fetch(base+'/mcp',{method:'POST'})).status,401);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
