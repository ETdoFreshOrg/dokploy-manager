import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../dist/app.js';

test('MCP authenticates, redacts credentials, limits procedures and forwards mutations',async()=>{
  process.env.DOKPLOY_MANAGER_TOKEN='mcp-test-secret';
  const writes=[];
  const app=createApp({dokploy:{getProjects:async()=>[{name:'Test',environments:[{name:'production',applications:[{applicationId:'app-1',name:'App',env:'PASSWORD=secret'}]}]}],dokployQuery:async()=>({name:'App',env:'TOKEN=never-return\nPORT=3000',password:'secret',nested:{apiKey:'secret'}}),dokployMutate:async(p,i)=>{writes.push([p,i]);return true;},getRuntimeLogs:async(id,tail)=>({id,tail,logs:'hello'})}});
  async function rpc(method,params={},auth='Bearer mcp-test-secret'){
    const r=await app.request('http://localhost/mcp',{method:'POST',headers:{Authorization:auth,Accept:'application/json, text/event-stream','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return {status:r.status,body:await r.json()};
  }
  try {
    assert.equal((await rpc('tools/list',{},'bad')).status,401);
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
  } finally {delete process.env.DOKPLOY_MANAGER_TOKEN;}
});
