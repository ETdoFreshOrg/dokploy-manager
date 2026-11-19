import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../dist/http.js';
import { OAuthStore } from '../oauth/oauth-store.mjs';
import { signIn } from './oauth-client.mjs';

const composeId = 'fixture-browserless-compose';
const project = 'dokploy-browserless-chrome-fixture';
const mcp = { containerId: '111111111111', name: project + '-mcp-1', state: 'exited' };
const desktop = { containerId: '222222222222', name: project + '-desktop-1', state: 'running' };
const other = { containerId: '333333333333', name: project + '-mcp-proxy-1', state: 'running' };
const replica = { ...mcp, containerId: '444444444444', name: project + '-mcp-2' };
const custom = { containerId: '555555555555', name: 'fixture-custom-name', state: 'running' };
const timestamp = '2026-11-18T09:05:02.074563212Z';
const runtimeInput = { compose_id: composeId, kind: 'runtime', service: 'mcp' };
const syntheticApiKey = 'fixture-api-key-should-be-redacted';
const startupLogs = [
  `${timestamp} starting browserless-mcp`,
  `${timestamp} ${JSON.stringify({
    level: 'error', message: 'Chrome CDP startup check failed: ECONNREFUSED desktop:9222',
    requestId: 'fixture-req-7', correlation_id: 'fixture-corr-9',
    auth: { apiKey: 'structured-fixture-secret', token: { value: 'nested-fixture-secret' } },
  })}`,
  `${timestamp} \x1b[31mstartup failed\x1b[0m password="quoted fixture secret" request_id=fixture-req-8`,
  `${timestamp} transport=postgres://fixture-user:fixture-pass@database/example token=${syntheticApiKey}`,
  `${timestamp} Authorization: Bearer header-fixture-secret`,
  `${timestamp} -----BEGIN PRIVATE KEY-----`,
  `${timestamp} key-fixture-secret`,
  `${timestamp} -----END PRIVATE KEY-----`,
].join('\n') + '\n';

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function localServer(t, listener) {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'dokploy-log-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = join(scratch, 'deployment.log');
  await writeFile(file, 'build step complete PRIVATE_KEY=fixture-build-secret\n');
  const docker = join(scratch, 'docker');
  await writeFile(docker, [
    '#!/bin/sh',
    "case \"$*\" in",
    `  'ps -a --format {{json .}}') printf '%s\\n' '{"ID":"aaaaaaaaaaaa","Names":"fixture-existing-app"}' ;;`,
    `  'logs --tail 20 aaaaaaaaaaaa') printf '%s\\n' 'app runtime started TOKEN=fixture-app-secret' ;;`,
    "  'logs --tail 21 aaaaaaaaaaaa') printf '%s\\n' 'untrusted-fixture-stderr' >&2; exit 1 ;;",
    '  *) exit 99 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });

  const state = { rows: [mcp, desktop, other, custom], raw: startupLogs, calls: [], composeType: 'docker-compose' };
  const base = await localServer(t, (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const procedure = url.pathname.split('/').pop();
    const input = JSON.parse(url.searchParams.get('input') || '{}').json;
    state.calls.push({ procedure, method: req.method, input });
    if (req.method !== 'GET' || req.headers['x-api-key'] !== syntheticApiKey)
      return json(res, { error: 'fixture only accepts authenticated reads' }, 401);
    if (state.failure?.procedure === procedure)
      return json(res, { error: 'upstream-fixture-secret' }, state.failure.status);
    switch (procedure) {
      case 'compose.one':
        if (input.composeId !== composeId) return json(res, { error: 'unknown' }, 404);
        return json(res, { result: { data: { json: {
          composeId, appName: project, composeType: state.composeType, serverId: 'fixture-remote-server',
          env: 'TOKEN=compose-metadata-fixture-secret',
        } } } });
      case 'docker.getContainersByAppNameMatch':
        return json(res, { result: { data: { json: state.rows } } });
      case 'compose.readLogs':
        if (state.raw === 'stalled-response') return;
        if (state.raw === 'oversized-response') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"result":{"data":{"json":"');
          return res.end('x'.repeat(2 * 1024 * 1024));
        }
        return json(res, { result: { data: { json: input.containerId === desktop.containerId ?
          `${timestamp} Chrome DevTools ready\n` : state.raw } } });
      case 'application.one':
        if (input.applicationId !== 'fixture-app') return json(res, { error: 'unknown' }, 404);
        return json(res, { result: { data: { json: { appName: 'fixture-existing-app' } } } });
      case 'deployment.all':
        return json(res, { result: { data: { json: [{ deploymentId: 'fixture-build', status: 'done', logPath: file }] } } });
      default:
        return json(res, { error: 'No such fixture' }, 404);
    }
  });
  const environment = { DOKPLOY_URL: base, DOKPLOY_TOKEN: syntheticApiKey, PATH: scratch + ':' + process.env.PATH,
    DOKPLOY_MANAGER_TOKEN: 'fixture-manager-api-key' };
  for (const [name, value] of Object.entries(environment)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => previous === undefined ? delete process.env[name] : process.env[name] = previous);
  }
  const origin = 'https://dokploy-manager.fixture.invalid';
  const ownerKey = 'fixture-owner-only';
  const oauthStore = new OAuthStore();
  t.after(() => oauthStore.close());
  const app = createHttpApp({ origin, ownerKey, oauthStore });
  const manager = await localServer(t, (req, res) => {
    if (state.forwardingFailure && req.url === '/mcp') {
      return json(res, { error: 'synthetic Manager forwarding failure' }, 503);
    }
    app(req, res);
  });
  const { tokens } = await signIn({ base: manager, origin, ownerKey, name: 'dokploy', scope: 'dokploy.manage' });
  return { state, manager, scratch, accessToken: tokens.access_token };
}

async function connect(t, base, accessToken) {
  const client = new Client({ name: 'fixture-log-reader', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
    requestInit: { headers: accessToken ? { Authorization: 'Bearer ' + accessToken } : {} },
  });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 5000 });
  return client;
}

async function call(client, args, name = 'dokploy_logs') {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 12000 });
  return { failed: result.isError === true, data: JSON.parse(result.content[0].text) };
}

function assertStartup({ failed, data }) {
  assert.equal(failed, false);
  assert.equal(data.composeId, composeId);
  assert.equal(data.service, 'mcp');
  assert.deepEqual(data.container, { id: mcp.containerId, name: mcp.name, service: 'mcp', state: 'exited' });
  assert.equal(data.source, 'dokploy-compose-runtime');
  assert.match(data.logs, /2026-11-18T09:05:02\.074563212Z/);
  assert.match(data.logs, /Chrome CDP startup check failed: ECONNREFUSED desktop:9222/);
  assert.match(data.logs, /fixture-req-7.*fixture-corr-9/);
  assert.match(data.logs, /request_id=fixture-req-8/);
  assert.match(data.logs, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(data), /fixture-secret|quoted fixture secret|fixture-user|fixture-pass|should-be-redacted|\\u001b/);
  assert.equal(data.truncated, false);
}

function expectError(result, stage, code) {
  assert.equal(result.failed, true);
  assert.equal(result.data.stage, stage);
  assert.equal(result.data.code, code);
  assert.doesNotMatch(JSON.stringify(result.data), /upstream-fixture-secret|untrusted-fixture-stderr/);
}

test('Compose reads timestamped startup logs and resolves only exact project-scoped targets', { timeout: 20000 }, async t => {
  const { state, manager, accessToken } = await fixture(t);
  const client = await connect(t, manager, accessToken);
  assertStartup(await call(client, runtimeInput));
  assert.deepEqual(state.calls, [
    { procedure: 'compose.one', method: 'GET', input: { composeId } },
    { procedure: 'docker.getContainersByAppNameMatch', method: 'GET',
      input: { appName: project, appType: 'docker-compose', serverId: 'fixture-remote-server' } },
    { procedure: 'compose.readLogs', method: 'GET', input: { composeId, containerId: mcp.containerId, tail: 100 } },
  ]);

  const desktopResult = await call(client, { ...runtimeInput, service: 'desktop', container: desktop.name });
  assert.equal(desktopResult.data.container.id, desktop.containerId);
  assert.match(desktopResult.data.logs, /Chrome DevTools ready/);

  const customResult = await call(client, { ...runtimeInput, service: undefined, container: custom.name });
  assert.equal(customResult.data.container.id, custom.containerId);
  assert.equal(customResult.data.service, null);

  state.rows.push(replica);
  const ambiguous = await call(client, runtimeInput);
  expectError(ambiguous, 'target', 'container_ambiguous');
  assert.deepEqual(ambiguous.data.candidates.map(row => row.id), [mcp.containerId, replica.containerId]);
  const explicit = await call(client, { ...runtimeInput, container: replica.containerId });
  assert.equal(explicit.data.container.id, replica.containerId);

  for (const args of [
    { ...runtimeInput, container: desktop.name },
    { ...runtimeInput, container: replica.containerId.slice(0, 8) },
    { ...runtimeInput, service: 'mp' },
  ]) {
    const start = state.calls.length;
    expectError(await call(client, args), 'target', 'container_not_found');
    assert.deepEqual(state.calls.slice(start).map(call => call.procedure), ['compose.one', 'docker.getContainersByAppNameMatch']);
  }

  expectError(await call(client, { compose_id: 'missing', kind: 'runtime' }), 'target', 'compose_not_found');
  state.rows = [];
  expectError(await call(client, runtimeInput), 'target', 'container_not_found');
  state.rows = [mcp];
  assert.equal((await call(client, { compose_id: composeId, kind: 'runtime' })).data.container.id, mcp.containerId);
  state.rows = [null];
  expectError(await call(client, runtimeInput), 'dokploy', 'invalid_container_inventory');
  state.composeType = 'stack';
  expectError(await call(client, runtimeInput), 'target', 'unsupported_compose_type');
});

test('log requests enforce bounds and return sanitized backend errors', { timeout: 20000 }, async t => {
  const { state, manager, accessToken } = await fixture(t);
  const client = await connect(t, manager, accessToken);
  for (const args of [
    { ...runtimeInput, tail: 1001 }, { ...runtimeInput, tail: 0 }, { ...runtimeInput, tail: 1.5 },
    { ...runtimeInput, application_id: 'fixture-app' }, { ...runtimeInput, kind: 'deploy' },
    { ...runtimeInput, container: '--help' }, { ...runtimeInput, since: 'all' },
  ]) expectError(await call(client, args), 'target', 'invalid_arguments');
  assert.equal(state.calls.length, 0);

  state.raw = 'old line\nnew line\n';
  const tailed = await call(client, { ...runtimeInput, tail: 1 });
  assert.equal(tailed.data.logs, 'new line\n');
  assert.equal(tailed.data.truncated, true);
  assert.equal(state.calls.at(-1).input.tail, 1);

  state.raw = 'é'.repeat(15000) + '\nlatest\n';
  const bounded = await call(client, runtimeInput);
  assert.equal(bounded.data.logs, 'latest\n');
  assert.equal(bounded.data.truncated, true);

  state.raw = '';
  const empty = await call(client, runtimeInput);
  assert.equal(empty.failed, false);
  assert.equal(empty.data.logs, '');
  assert.equal(empty.data.truncated, false);

  state.raw = 'oversized-response';
  expectError(await call(client, runtimeInput), 'dokploy', 'backend_response_too_large');

  for (const [status, code] of [[401, 'backend_access_denied'], [403, 'backend_access_denied'],
    [404, 'compose_logs_unavailable'], [500, 'backend_log_unavailable']]) {
    state.failure = { procedure: 'compose.readLogs', status };
    const result = await call(client, runtimeInput);
    expectError(result, 'dokploy', code);
    assert.equal(result.data.status, status);
    assert.equal(result.data.procedure, 'compose.readLogs');
  }
});

test('Compose backend reads time out without returning partial output', { timeout: 16000 }, async t => {
  const { state, manager, accessToken } = await fixture(t);
  const client = await connect(t, manager, accessToken);
  state.raw = 'stalled-response';
  const result = await call(client, runtimeInput);
  expectError(result, 'dokploy', 'backend_timeout');
  assert.equal(result.data.procedure, 'compose.readLogs');
});

test('Application IDs still read runtime and deployment logs through the existing routes', { timeout: 20000 }, async t => {
  const { manager, accessToken, scratch } = await fixture(t);
  const client = await connect(t, manager, accessToken);
  const args = { application_id: 'fixture-app', kind: 'runtime', tail: 20 };
  const runtime = await call(client, args);
  assert.equal(runtime.failed, false);
  assert.equal(runtime.data.source, 'docker-cli');
  assert.equal(runtime.data.logs, 'app runtime started TOKEN=[redacted]\n');
  const deploy = await call(client, { application_id: 'fixture-app', kind: 'deploy' });
  assert.equal(deploy.failed, false);
  assert.equal(deploy.data.source, 'filesystem');
  assert.equal(deploy.data.logs, 'build step complete PRIVATE_KEY=[redacted]\n');
  assert.equal(deploy.data.deploymentId, 'fixture-build');

  const rest = await fetch(manager + '/api/applications/fixture-app/logs/runtime?tail=20', {
    headers: { Authorization: 'Bearer fixture-manager-api-key' }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(rest.status, 200);
  assert.equal((await rest.json()).logs, runtime.data.logs);
  expectError(await call(client, { ...args, tail: 21 }), 'dokploy', 'application_runtime_unavailable');
  await rm(join(scratch, 'deployment.log'));
  expectError(await call(client, { application_id: 'fixture-app', kind: 'deploy' }), 'dokploy', 'deployment_log_unavailable');
});

const gatewayBin = process.env.ONE_MCP_TEST_BIN;
test('real isolated 1MCP forwards Browserless Compose and Application calls and preserves failure layers',
  { skip: !gatewayBin, timeout: 30000 }, async t => {
    const { manager, accessToken, state, scratch } = await fixture(t);
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const config = join(scratch, '1mcp.json');
    await writeFile(config, JSON.stringify({
      mcpServers: { dokploy: { type: 'http', url: manager + '/mcp', headers: { Authorization: 'Bearer ' + accessToken } } },
    }), { mode: 0o600 });
    const child = spawn(gatewayBin, [
      'serve', '--config', config, '--config-dir', scratch, '--host', '127.0.0.1', '--port', String(port),
      '--enable-session-persistence=false', '--enable-config-reload=false', '--enable-async-loading=false',
    ], { cwd: scratch, env: { PATH: process.env.PATH, CI: '1', ONE_MCP_PRODUCT_TELEMETRY: 'false', XDG_CONFIG_HOME: scratch,
      XDG_DATA_HOME: scratch, XDG_STATE_HOME: scratch, XDG_CACHE_HOME: scratch }, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(0, 2500); });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    });
    const gateway = `http://127.0.0.1:${port}`;
    let ready = false;
    const deadline = Date.now() + 10000;
    while (!ready && child.exitCode === null && Date.now() < deadline) {
      try { ready = (await fetch(gateway + '/health', { signal: AbortSignal.timeout(500) })).ok; }
      catch {}
      if (!ready) await delay(100);
    }
    assert.ok(ready, diagnostics.replaceAll(accessToken, '[redacted]'));
    const client = await connect(t, gateway);
    const name = 'dokploy_1mcp_dokploy_logs';
    const tool = (await client.listTools()).tools.find(tool => tool.name === name);
    assert.equal(tool?.annotations.readOnlyHint, true);
    assert.ok(tool.inputSchema.properties.compose_id);
    assertStartup(await call(client, runtimeInput, name));
    const desktopResult = await call(client, { ...runtimeInput, service: 'desktop' }, name);
    assert.equal(desktopResult.data.container.id, desktop.containerId);
    const application = await call(client, { application_id: 'fixture-app', kind: 'runtime', tail: 20 }, name);
    assert.equal(application.data.logs, 'app runtime started TOKEN=[redacted]\n');
    const deploy = await call(client, { application_id: 'fixture-app', kind: 'deploy' }, name);
    assert.equal(deploy.data.source, 'filesystem');

    state.failure = { procedure: 'compose.readLogs', status: 403 };
    expectError(await call(client, runtimeInput, name), 'dokploy', 'backend_access_denied');
    state.rows.push(replica);
    expectError(await call(client, runtimeInput, name), 'target', 'container_ambiguous');
    expectError(await call(client, { ...runtimeInput, service: 'missing' }, name), 'target', 'container_not_found');

    const before = state.calls.length;
    state.forwardingFailure = true;
    await assert.rejects(client.callTool({ name, arguments: runtimeInput }, undefined, { timeout: 12000 }),
      { code: -32603, message: /Error calling tool/ });
    assert.equal(state.calls.length, before);
  });
