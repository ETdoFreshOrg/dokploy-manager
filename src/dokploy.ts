/**
 * Dokploy tRPC client helpers.
 */

export type JsonMap = Record<string, unknown>;

function getDokployUrl(): string {
  return process.env.DOKPLOY_URL || "";
}

function getDokployToken(): string {
  return process.env.DOKPLOY_TOKEN || "";
}

function requireDokployConfig() {
  const url = getDokployUrl();
  const token = getDokployToken();
  if (!url) throw new Error("DOKPLOY_URL not configured");
  if (!token) throw new Error("DOKPLOY_TOKEN not configured");
  return { url, token };
}

function fetchQuery(procedure: string, input: JsonMap, signal?: AbortSignal) {
  const { url: dokployUrl, token } = requireDokployConfig();
  const wrapped = Object.keys(input).length > 0 ? { json: input } : input;
  const url = `${dokployUrl.replace(/\/$/, "")}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(wrapped))}`;
  return fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-api-key": token,
    },
    ...(signal ? { signal, redirect: "error" } : {}),
  });
}

export async function dokployQuery(procedure: string, input: JsonMap = {}): Promise<any> {
  const res = await fetchQuery(procedure, input);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dokploy ${procedure} failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  const data = json?.result?.data;
  return data?.json ?? data ?? json;
}

type LogProcedure =
  | "compose.one" | "docker.getContainersByAppNameMatch" | "compose.readLogs"
  | "application.one" | "deployment.all";

export class LogQueryError extends Error {
  constructor(readonly reason: "http" | "size" | "invalid", readonly status?: number) {
    super("Dokploy log query failed");
  }
}

// Keep upstream log and metadata reads bounded, even for chunked or compressed responses.
export async function dokployLogQuery(procedure: LogProcedure, input: JsonMap, signal: AbortSignal): Promise<unknown> {
  const response = await fetchQuery(procedure, input, signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new LogQueryError("http", response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new LogQueryError("invalid");
  const limit = 2 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new LogQueryError("size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const result = JSON.parse(Buffer.concat(chunks, size).toString("utf8"))?.result;
    if (!result || !Object.prototype.hasOwnProperty.call(result, "data")) throw new LogQueryError("invalid");
    const data = result.data;
    return data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "json") ? data.json : data;
  } catch {
    throw new LogQueryError("invalid");
  }
}

export async function dokployMutate(procedure: string, input: JsonMap = {}): Promise<any> {
  const { url: dokployUrl, token } = requireDokployConfig();
  const url = `${dokployUrl}/api/trpc/${procedure}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-api-key": token,
    },
    body: JSON.stringify({ json: input }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dokploy ${procedure} failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  const data = json?.result?.data;
  return data?.json ?? data ?? json;
}

export const getProjects = () => dokployQuery("project.all", {});
export const getApplication = (applicationId: string) =>
  dokployQuery("application.one", { applicationId });
export const getApplicationDeployments = (applicationId: string) =>
  dokployQuery("deployment.all", { applicationId });
export const getServers = () => dokployQuery("server.all", {});
export const getApplicationDomains = (applicationId: string) =>
  dokployQuery("domain.byApplicationId", { applicationId });
