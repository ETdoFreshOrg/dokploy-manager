# dokploy-manager

Unified Dokploy manager service.

## What it does

- Read Dokploy projects, services, applications, deployments, domains, servers
- Trigger write actions like deploy, redeploy, start, stop, env updates, and domain creation
- Provide lightweight monitoring and log endpoints
- Serve a simple web UI for inspection
- Expose raw tRPC passthrough for uncovered Dokploy procedures

## Environment

- `DOKPLOY_MANAGER_TOKEN` - preferred bearer token for this service
- `DOKPLOY_EDITOR_TOKEN` - legacy fallback token
- `DOKPLOY_VIEWER_TOKEN` - legacy fallback token
- `DOKPLOY_URL` - Dokploy base URL
- `DOKPLOY_TOKEN` - Dokploy API token
- `PORT` - port to listen on (default: `3000`)

## Development

```bash
npm install
npm run build
npm test
npm run dev
```
# MCP

`https://dokploy-manager.etdofresh.com/mcp` provides authenticated stateless
Streamable HTTP. Use `Authorization: Bearer <OAuth access token>` after
authorizing with this MCP's owner key.
`PUBLIC_ORIGIN` may override the browser-origin allowlist.

Tools: `dokploy_list_services`, `dokploy_query`, `dokploy_mutate`, and
`dokploy_logs`. Queries and mutations use explicit procedure allowlists;
application/project/database deletion is excluded. Reads redact environment
values and credential fields. Mutations should only execute changes requested
by the user. The existing REST API and UI continue to work.

## MCP owner-key OAuth

Dokploy MCP requires `MCP_OWNER_KEY`, independently of the existing Manager API token.
Mount `/data` persistently for hashed grants and tokens in `/data/oauth.db`;
`OAUTH_DB` can override the path. Use client ID `dokploy-claude` and scope
`dokploy.manage` when configuring a fleet header helper. The Manager API token
is no longer accepted at `/mcp`; the regular Manager API remains unchanged.

The owner key authorizes consent; clients receive 15-minute OAuth access tokens
and rotating refresh tokens. Grants last 30 days and survive restarts. Refresh
reuse or explicit revocation invalidates the consent. Only token hashes are stored.
Discover OAuth at `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp`. Consent and token endpoints are under
`/mcp/oauth`. Claude and ChatGPT metadata clients are supported.
