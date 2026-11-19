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

## Runtime logs through 1MCP

Use `dokploy_1mcp_dokploy_logs` with an existing Application ID or a Docker
Compose ID. For example, the following arguments select the Browserless MCP
service when it has a single container with a standard Compose name.

```json
{"compose_id":"<compose ID from dokploy_list_services>","kind":"runtime","service":"mcp","tail":100}
```

Use `container` with the exact listed container name or Docker ID for replicas
or custom container names. With both selectors, the container must match the
service inferred from its standard Compose name. With neither, a single
container must be present. For the Chrome desktop, select `desktop` when it
uses a standard Compose name. The response gives the selected container's ID,
name and state, plus its service when inferable. Log text retains Docker
timestamps and request or correlation IDs already present in the output.

The Manager resolves the deployment server with `compose.one`, lists
project-scoped containers with `docker.getContainersByAppNameMatch`, and reads
the selected container with `compose.readLogs`. Dokploy checks container
ownership again when reading the logs. These are GET requests with the existing
Dokploy API key. Swarm task logs require a different endpoint. The deployment
log option and Application runtime option still use `application_id`.

Compose reads have a 10-second deadline and a 2 MiB limit per upstream
response. The tool accepts a tail of 1–1,000 lines and limits returned log text
to 24 KiB. The `truncated` flag marks output clipped by the Manager. The reader
redacts recognized credentials and strips terminal controls. Treat rendered logs
as sensitive and untrusted because applications can print arbitrary text.

A structured tool error with `stage: "target"` identifies a selection issue,
such as `container_not_found` or `container_ambiguous`. An empty Dokploy
inventory can also mean the target server could not list its containers.
`stage: "dokploy"` identifies a backend failure, with a procedure and HTTP
status when available. A 1MCP protocol or transport error before the Manager
returns a tool result indicates a forwarding failure. In the isolated 1MCP
v0.40.0 test, a Manager HTTP 503 appears as JSON-RPC error `-32603`.

Run `npm test` for local regressions. Set `ONE_MCP_TEST_BIN` to the absolute
path of a local 1MCP v0.40.0 executable to include the loopback gateway test.
It uses a synthetic OAuth grant, a Dokploy API fixture, a Docker CLI fixture,
and a temporary deployment log.
