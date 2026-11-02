import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../dist/http.js';
import { begin, signIn } from './oauth-client.mjs';
import { ETBOT_CLIENT } from '../oauth/service.mjs';

test('MCP authenticates, redacts credentials, limits procedures and forwards mutations',async()=>{
  process.env.DOKPLOY_MANAGER_TOKEN='mcp-test-secret';
  const writes=[];
  const app=createHttpApp({ownerKey:'owner-test-key',origin:'https://dokploy-manager.etdofresh.com',dokploy:{getProjects:async()=>[{name:'Test',environments:[{name:'production',applications:[{applicationId:'app-1',name:'App',env:'PASSWORD=secret'}]}]}],dokployQuery:async()=>({name:'App',env:'TOKEN=never-return\nPORT=3000',password:'secret',nested:{apiKey:'secret'}}),dokployMutate:async(p,i)=>{writes.push([p,i]);return true;},getRuntimeLogs:async(id,tail)=>({id,tail,logs:'hello'})}});
  const server=app.listen(0,'0.0.0.0');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const {tokens}=await signIn({base,origin:'https://dokploy-manager.etdofresh.com',name:'dokploy',scope:'dokploy.manage',ownerKey:'owner-test-key'});
  async function rpc(method,params={},auth='Bearer '+tokens.access_token){
    const r=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:auth,Accept:'application/json, text/event-stream','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return {status:r.status,body:await r.json()};
  }
  try {
    assert.equal((await rpc('tools/list',{},'bad')).status,401);
    assert.equal((await rpc('tools/list',{},'Bearer mcp-test-secret')).status,401);
    assert.equal((await rpc('tools/list')).body.result.tools.length,4);
    const result=await rpc('tools/call',{name:'dokploy_query',arguments:{procedure:'application.one',input:{applicationId:'app-1'}}});
    const text=result.body.result.content[0].text;
    assert.ok(!text.includes('never-return'));assert.ok(!text.includes('secret'));assert.deepEqual(JSON.parse(text).env,['TOKEN','PORT']);
    const invalid=await rpc('tools/call',{name:'dokploy_mutate',arguments:{procedure:'application.delete',input:{applicationId:'app-1'}}});
    assert.equal(invalid.body.result.isError,true);assert.equal(writes.length,0);
    const mutation=await rpc('tools/call',{name:'dokploy_mutate',arguments:{procedure:'application.deploy',input:{applicationId:'app-1'}}});
    assert.ok(!mutation.body.result.isError);assert.deepEqual(writes,[['application.deploy',{applicationId:'app-1'}]]);
    const logs=await rpc('tools/call',{name:'dokploy_logs',arguments:{application_id:'app-1',kind:'runtime',tail:20}});
    assert.deepEqual(JSON.parse(logs.body.result.content[0].text),{id:'app-1',tail:'20',logs:'hello'});
  } finally {delete process.env.DOKPLOY_MANAGER_TOKEN;server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('ET Bot reaches owner consent at its one registered callback only',async()=>{
  const origin='https://dokploy-manager.etdofresh.com';
  const app=createHttpApp({ownerKey:'owner-test-key',origin,dokploy:{}});
  const server=app.listen(0,'0.0.0.0');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`,etbot={base,origin,name:'dokploy',scope:'dokploy.manage',client_id:ETBOT_CLIENT.client_id};
  try {
    const page=await begin({...etbot,redirect_uri:ETBOT_CLIENT.redirect_uris[0]});
    assert.equal(page.page.status,200);assert.match(page.html,/Authorize ET Bot/);
    for(const redirect_uri of ['https://etbot.etdofresh.com/api/connectors/oauth/other','https://evil.test/api/connectors/oauth/callback'])
      assert.equal((await begin({...etbot,redirect_uri})).page.status,400,redirect_uri);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
