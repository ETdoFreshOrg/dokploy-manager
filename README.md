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
Streamable HTTP. Use `Authorization: Bearer <DOKPLOY_MANAGER_TOKEN>`.
`PUBLIC_ORIGIN` may override the browser-origin allowlist.

Tools: `dokploy_list_services`, `dokploy_query`, `dokploy_mutate`, and
`dokploy_logs`. Queries and mutations use explicit procedure allowlists;
application/project/database deletion is excluded. Reads redact environment
values and credential fields. Mutations should only execute changes requested
by the user. The existing REST API and UI continue to work.
