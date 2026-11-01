import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

// Native HTTP preserves the fixture's explicit Host header (Node fetch replaces it).
function send(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      const chunks=[];res.on('data', chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{const body=Buffer.concat(chunks);resolve(new Response(body.length?body:null,{status:res.statusCode,headers:res.headers}));});
    });
    req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('OAuth fixture timeout')));
    req.end(options.body?.toString());
  });
}

export const redirect = 'https://claude.ai/api/mcp/auth_callback';
export const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
export const form = (base, path, data, headers = {}) => send(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data) });

export async function begin({ base, origin, name, scope, prefix = '/mcp/oauth', headers = {}, ...overrides }) {
  const proof = pkce();
  const params = { response_type: 'code', client_id: name + '-claude', redirect_uri: redirect, resource: origin + '/mcp', scope,
    code_challenge: proof.challenge, code_challenge_method: 'S256', state: 'test-state', ...overrides };
  const page = await send(base + prefix + '/authorize?' + new URLSearchParams(params), { headers });
  const html = await page.text();
  return { ...proof, page, html, params, requestId: /name="request" value="([^"]+)"/.exec(html)?.[1], cookie: page.headers.get('set-cookie')?.split(';')[0] };
}

export async function signIn(options) {
  const { base, origin, name, ownerKey, prefix = '/mcp/oauth', headers = {} } = options;
  const started = await begin(options);
  assert.equal(started.page.status, 200, started.html);
  const consent = await form(base, prefix + '/consent', { request: started.requestId, owner_key: ownerKey, decision: 'allow' }, { ...headers, Origin: origin, Cookie: started.cookie });
  assert.equal(consent.status, 302, await consent.clone().text());
  const callback = new URL(consent.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'test-state');
  assert.equal(callback.searchParams.get('iss'), origin + '/');
  const exchange = { grant_type: 'authorization_code', client_id: name + '-claude', code: callback.searchParams.get('code'),
    code_verifier: started.verifier, redirect_uri: redirect, resource: origin + '/mcp' };
  const response = await form(base, prefix + '/token', exchange, headers);
  const tokens = await response.json();
  assert.equal(response.status, 200, JSON.stringify(tokens));
  assert.ok(tokens.access_token && tokens.refresh_token);
  return { ...started, tokens, exchange };
}
