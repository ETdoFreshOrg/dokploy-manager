import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dokployLogQuery } from "./dokploy.js";
import { boundedLogOutput } from "./log-output.js";

const execFileAsync = promisify(execFile);

type AnyRecord = Record<string, unknown>;

type RuntimeContainer = {
  id: string;
  name: string;
  image?: string;
  status?: string;
};

type DockerInspection = {
  available: boolean;
  reason?: string;
  containers: RuntimeContainer[];
};

function asRecord(value: unknown): AnyRecord {
  return typeof value === "object" && value !== null ? (value as AnyRecord) : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function pickStrings(record: AnyRecord, keys: string[]): string[] {
  return keys
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseTail(rawTail: string | undefined, fallback = 100): number {
  const parsed = Number.parseInt(rawTail || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 10000);
}

async function readTextFileIfPresent(path: string | null) {
  if (!path) return null;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) return null;
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const truncated = bytesRead < info.size;
      const raw = buffer.subarray(0, bytesRead).toString("utf8");
      const output = boundedLogOutput(truncated ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw);
      return { ...output, truncated: truncated || output.truncated };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

const dockerLimits = { timeout: 8_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" as const };

async function inspectDockerContainers(): Promise<DockerInspection> {
  try {
    const { stdout } = await execFileAsync("docker", ["ps", "-a", "--format", "{{json .}}"], dockerLimits);
    const containers = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>)
      .map((row) => ({
        id: row.ID || "",
        name: row.Names || "",
        image: row.Image || undefined,
        status: row.Status || undefined,
      }))
      .filter((container) => /^(?:[a-f0-9]{12}|[a-f0-9]{64})$/.test(container.id) && container.name);
    return {
      available: true,
      containers,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = detail.includes("ENOENT")
      ? "docker-cli-missing"
      : detail.includes("permission denied")
        ? "docker-cli-permission-denied"
        : detail.includes("Cannot connect to the Docker daemon")
          ? "docker-daemon-unreachable"
          : "docker-cli-unavailable";
    return {
      available: false,
      reason,
      containers: [],
    };
  }
}

function extractContainerCandidates(application: AnyRecord, deployment: AnyRecord | undefined): string[] {
  const applicationCandidates = pickStrings(application, [
    "containerId",
    "containerName",
    "serviceName",
    "appName",
    "name",
    "slug",
  ]);

  const deploymentCandidates = deployment
    ? pickStrings(deployment, ["containerId", "containerName", "serviceName", "appName", "name"])
    : [];

  return uniqueStrings([...applicationCandidates, ...deploymentCandidates]);
}

function findMatchingContainer(containers: RuntimeContainer[], candidates: string[]): RuntimeContainer | null {
  for (const candidate of candidates) {
    const direct = containers.find(
      (container) =>
        container.id === candidate ||
        container.id.startsWith(candidate) ||
        container.name === candidate,
    );
    if (direct) return direct;
  }

  for (const candidate of candidates) {
    const fuzzy = containers.find((container) => container.name.includes(candidate));
    if (fuzzy) return fuzzy;
  }

  return null;
}

export async function getDeployLogs(applicationId: string) {
  const deployments = asArray(await dokployLogQuery("deployment.all", { applicationId }, AbortSignal.timeout(10_000)));
  if (!deployments.length) {
    return {
      applicationId,
      deploymentId: null,
      status: "unknown",
      createdAt: null,
      logPath: null,
      logs: "No deployments found",
      source: "none",
    };
  }

  const latest = asRecord(deployments[0]);
  const logPath = typeof latest.logPath === "string" ? latest.logPath : null;
  const output = await readTextFileIfPresent(logPath);

  return {
    applicationId,
    deploymentId: latest.deploymentId ?? null,
    status: latest.status ?? null,
    createdAt: latest.createdAt ?? null,
    logPath,
    logs: output?.logs || (logPath && !output ? "Could not read deployment log file" : "No log content available"),
    source: output ? "filesystem" : "none",
    ...(output?.truncated ? { truncated: true } : {}),
  };
}

export async function getRuntimeLogs(applicationId: string, rawTail?: string) {
  const tail = parseTail(rawTail, 100);
  const signal = AbortSignal.timeout(10_000);
  const application = asRecord(await dokployLogQuery("application.one", { applicationId }, signal));
  const deployments = asArray(await dokployLogQuery("deployment.all", { applicationId }, signal));
  const latestDeployment = deployments.length ? asRecord(deployments[0]) : undefined;
  const candidates = extractContainerCandidates(application, latestDeployment);
  const docker = await inspectDockerContainers();
  const matchedContainer = findMatchingContainer(docker.containers, candidates);

  if (!matchedContainer) {
    const unavailableMessage = docker.available
      ? "Runtime logs unavailable. No matching local Docker container was found for this application."
      : docker.reason === "docker-cli-missing"
        ? "Runtime logs unavailable because the Docker CLI is not installed in the dokploy-manager container."
        : docker.reason === "docker-daemon-unreachable"
          ? "Runtime logs unavailable because the Docker daemon is not reachable from the dokploy-manager container."
          : docker.reason === "docker-cli-permission-denied"
            ? "Runtime logs unavailable because the dokploy-manager container does not have permission to talk to Docker."
            : "Runtime logs unavailable because Docker inspection is not available in the dokploy-manager container.";
    return {
      applicationId,
      tail,
      source: docker.available ? "docker-cli-no-match" : (docker.reason || "docker-cli-unavailable"),
      logs: unavailableMessage,
      candidates,
      container: null,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", "--tail", String(tail), matchedContainer.id], dockerLimits);
    const output = boundedLogOutput(stdout || stderr, tail);
    return {
      applicationId,
      tail,
      source: "docker-cli",
      logs: output.logs || (output.truncated ? "" : "No runtime log output available"),
      ...(output.truncated ? { truncated: true } : {}),
      candidates,
      container: matchedContainer,
    };
  } catch (error) {
    return {
      applicationId,
      tail,
      source: "docker-cli-error",
      logs: "Runtime logs unavailable. Docker could not read the container within the time and size limits.",
      candidates,
      container: matchedContainer,
    };
  }
}

export async function listRuntimeContainers(serverId?: string) {
  const docker = await inspectDockerContainers();
  return {
    source: docker.available ? "docker-cli" : (docker.reason || "docker-cli-unavailable"),
    serverId: serverId || null,
    containers: docker.containers,
  };
}
