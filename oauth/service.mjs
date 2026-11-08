// Service adapter for ET's shared single-owner OAuth implementation.
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { mcpAuthRouter, mcpAuthMetadataRouter, createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { installOAuth, defaultConsentPage, claudeRedirects, escape } from './oauth.mjs';
import { OAuthStore } from './oauth-store.mjs';

const deps = { express, rateLimit, mcpAuthRouter, mcpAuthMetadataRouter, createOAuthMetadata,
  handlers: { authorizationHandler, tokenHandler, revocationHandler },
  errors: { InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } };

// ET Bot (etbot.etdofresh.com) names itself by its client metadata URL. It is pre-registered with its
// one exact callback, so the document is never fetched and no other ET Bot callback is accepted.
export const ETBOT_CLIENT = { client_id: 'https://etbot.etdofresh.com/oauth/client-metadata.json', client_name: 'ET Bot',
  redirect_uris: ['https://etbot.etdofresh.com/api/connectors/oauth/callback'] };

export function installMcpOAuth(app, { name, origin, ownerKey, scope, description, store = new OAuthStore(), ...options }) {
  if (new URL(origin).origin !== origin) throw new Error('MCP public origin must be a bare origin');
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`;
  app.use(['/mcp', '/.well-known', '/authorize', '/token', '/revoke', '/consent'], (_req, res, next) => {
    res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); next();
  });
  if (!ownerKey) {
    const disabled = (_req, res) => res.status(503).json({ error: 'MCP owner-key OAuth is not configured' });
    app.use(['/mcp/oauth', '/.well-known', '/authorize', '/token', '/revoke', '/consent'], disabled);
    return Object.assign(disabled, { enabled: false, challenge, verifyAccessToken: async () => { throw new InvalidTokenError('OAuth is not configured'); } });
  }
  const oauth = installOAuth(app, { deps, ownerKey, origin, oauthPath: '/mcp/oauth',
    scopes: [scope], defaultScopes: [scope], resourceName: name, claude: true, chatgpt: true,
    clients: [{"client_id":"1mcp-dokploy","client_name":"ET 1MCP","redirect_uris":["https://1mcp.etdofresh.com/oauth/callback/dokploy"]},{ client_id: name + '-claude', client_name: 'Claude / Codex', redirect_uris: claudeRedirects }, ETBOT_CLIENT],
    renderConsent: defaultConsentPage({ title: 'Authorize ' + name,
      describe: () => `<p>${escape(description)}</p><p>Permission: <strong>${escape(scope)}</strong>.</p>`,
      ownerKeyLabel: name + ' MCP owner key', ownerKeyNote: 'The owner key stays on this authorization page. The connecting application receives revocable OAuth tokens.',
      allowLabel: () => 'Authorize access' }), cookieName: name.replace(/-/g, '_') + '_oauth_csrf', store, ...options });
  const verifyAccessToken = async token => {
    const auth = await oauth.verifyAccessToken(token);
    if (!auth.scopes.includes(scope)) throw new InvalidScopeError('Required scope is missing');
    return auth;
  };
  const middleware = (req, res, next) => {
    if (req.get('origin') && req.get('origin') !== origin) return res.status(403).json({ error: 'Origin not allowed' });
    return oauth(req, res, error => {
      if (error) return next(error);
      if (!req.auth?.scopes?.includes(scope)) return res.status(403).set('WWW-Authenticate', challenge + ', error="insufficient_scope"').json({ error: 'insufficient_scope' });
      next();
    });
  };
  return Object.assign(middleware, { enabled: true, challenge, verifyAccessToken, grantOf: oauth.grantOf, grantScopes: oauth.grantScopes });
}
