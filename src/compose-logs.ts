import { dokployLogQuery, LogQueryError } from "./dokploy.js";
import { boundedLogOutput } from "./log-output.js";

type Target = {
  composeId: string;
  service?: string;
  container?: string;
  tail: number;
};

export class LogReadError extends Error {
  constructor(
    readonly stage: "dokploy" | "target",
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const dockerName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
const dockerId = /^(?:[a-f0-9]{12}|[a-f0-9]{64})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function listedContainer(row: unknown, project: string) {
  if (!isRecord(row) || typeof row.name !== "string" || !dockerName.test(row.name) ||
      typeof row.containerId !== "string" || !dockerId.test(row.containerId)) return null;

  // Dokploy returns project-scoped names and IDs, without the Compose service label.
  // Compose v2 generates project-service-replica names. Require an exact name/ID
  // when the name overrides that convention.
  const prefix = project + "-";
  const service = row.name.startsWith(prefix)
    ? /^([a-zA-Z0-9][a-zA-Z0-9._-]*)-[1-9]\d*$/.exec(row.name.slice(prefix.length))?.[1] ?? null
    : null;
  return {
    id: row.containerId,
    name: row.name,
    service,
    state: typeof row.state === "string" && /^[a-z]{1,20}$/.test(row.state) ? row.state : null,
  };
}

export async function getComposeRuntimeLogs({ composeId, service, container, tail }: Target) {
  const signal = AbortSignal.timeout(10_000);
  async function read(procedure: Parameters<typeof dokployLogQuery>[0], input: Record<string, unknown>) {
    try {
      return await dokployLogQuery(procedure, input, signal);
    } catch (error) {
      const details = { procedure, ...(error instanceof LogQueryError && error.status ? { status: error.status } : {}) };
      if (signal.aborted)
        throw new LogReadError("dokploy", "backend_timeout", "Dokploy did not finish the log request within 10 seconds.", details);
      if (error instanceof LogQueryError) {
        if (error.reason === "size")
          throw new LogReadError("dokploy", "backend_response_too_large", "Dokploy exceeded the response size limit. For logs, retry with a smaller tail.", details);
        if (error.status === 401 || error.status === 403)
          throw new LogReadError("dokploy", "backend_access_denied", "Dokploy denied access. Check the existing API key's service read access and container availability.", details);
        if (error.status === 404 && procedure === "compose.readLogs")
          throw new LogReadError("dokploy", "compose_logs_unavailable", "Dokploy could not find the Compose runtime log endpoint or target. Check that the instance supports compose.readLogs and the container still exists.", details);
        if (error.status === 404 && procedure === "compose.one")
          throw new LogReadError("target", "compose_not_found", "Dokploy did not find that Compose ID.", details);
      }
      throw new LogReadError("dokploy", "backend_log_unavailable", "Dokploy could not complete the read. Check the instance and the container's runtime log access.", details);
    }
  }

  const compose = await read("compose.one", { composeId });
  if (!isRecord(compose) || compose.composeId !== composeId ||
      typeof compose.appName !== "string" || !dockerName.test(compose.appName) ||
      (compose.composeType !== "docker-compose" && compose.composeType !== "stack") ||
      (compose.serverId !== null && compose.serverId !== undefined &&
        (typeof compose.serverId !== "string" || !dockerName.test(compose.serverId)))) {
    throw new LogReadError("dokploy", "invalid_compose_metadata", "Dokploy did not return valid Compose target metadata.");
  }
  if (compose.composeType !== "docker-compose") {
    throw new LogReadError("target", "unsupported_compose_type", "The Dokploy container log endpoint supports Docker Compose containers. Swarm task logs require a different endpoint.");
  }

  const appName = compose.appName;
  const rows = await read("docker.getContainersByAppNameMatch", {
    appName, appType: "docker-compose", ...(compose.serverId ? { serverId: compose.serverId } : {}),
  });
  if (!Array.isArray(rows)) {
    throw new LogReadError("dokploy", "invalid_container_inventory", "Dokploy did not return a valid container inventory.");
  }
  const candidates = rows.map(row => listedContainer(row, appName));
  if (candidates.some(row => row === null)) {
    throw new LogReadError("dokploy", "invalid_container_inventory", "Dokploy returned a container without a valid ID or name.");
  }
  const listed = candidates.filter(row => row !== null);
  const matches = listed.filter(row => (!service || row.service === service) &&
    (!container || row.id === container || row.name === container));
  const details = {
    candidates: (matches.length ? matches : listed).slice(0, 20),
    candidatesTruncated: (matches.length || listed.length) > 20,
  };
  if (!matches.length) {
    throw new LogReadError("target", "container_not_found",
      "Dokploy listed no matching container. Verify the exact service or container name and that Dokploy can list containers on the target server.", details);
  }
  if (matches.length > 1) {
    throw new LogReadError("target", "container_ambiguous",
      "Multiple containers match. Choose an exact container name or ID from the candidates.", details);
  }

  const selected = matches[0];
  const raw = await read("compose.readLogs", { composeId, containerId: selected.id, tail });
  if (typeof raw !== "string") {
    throw new LogReadError("dokploy", "invalid_log_response", "Dokploy did not return runtime log text.");
  }
  return {
    composeId, appName, service: selected.service, container: selected, tail,
    source: "dokploy-compose-runtime",
    ...boundedLogOutput(raw, tail),
  };
}
