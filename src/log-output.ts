import { stripVTControlCharacters } from "node:util";

const sensitiveKey = String.raw`[\w.-]*(?:password|passwd|secret|token|api[-_.]?key|owner[-_.]?key|private[-_.]?key|ssh[-_.]?key|connection[-_.]?string|database[-_.]?url|credential|authorization|cookie)[\w.-]*`;
const assignment = new RegExp(
  String.raw`(?<![\w.-])(\b${sensitiveKey}["']?[ \t]*[:=][ \t]*)(?:\[redacted\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&}\]]+)`,
  "gi",
);
const sensitiveField = new RegExp(`^${sensitiveKey}$`, "i");
const controlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const controlPlaneCredentials = [
  "DOKPLOY_MANAGER_TOKEN", "DOKPLOY_EDITOR_TOKEN", "DOKPLOY_VIEWER_TOKEN", "DOKPLOY_TOKEN", "MCP_OWNER_KEY",
];

function stripControls(text: string) {
  return stripVTControlCharacters(text).replace(controlCharacters, "");
}

function redactText(text: string): string {
  text = stripControls(text);
  for (const name of controlPlaneCredentials) {
    const value = process.env[name];
    if (value) text = text.split(value).join("[redacted]");
  }
  return text
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)([ \t]*[:=][ \t]*)[^\r\n]+/gi, "$1$2[redacted]")
    .replace(/\b(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+\/=-]+/gi, "[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(assignment, "$1[redacted]");
}

function redactJson(value: unknown, depth = 0): unknown {
  if (depth >= 32) return "[redacted]";
  if (Array.isArray(value)) return value.map(item => redactJson(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactText(key), sensitiveField.test(key) ? "[redacted]" : redactJson(item, depth + 1),
    ]));
  }
  return typeof value === "string" ? redactText(value) : value;
}

function redactLine(line: string): string {
  // Docker prefixes each JSON log record with its original RFC3339 timestamp.
  const [, prefix, record] = /^(\s*(?:\d{4}-\d{2}-\d{2}T\S+[ \t]+)?)(.*)$/.exec(line) ?? [];
  if (record?.startsWith("{") || record?.startsWith("[")) {
    try {
      return redactText(prefix) + JSON.stringify(redactJson(JSON.parse(record)));
    } catch {
      // Plain or malformed log messages still get credential-pattern redaction.
    }
  }
  return redactText(line);
}

export function boundedLogOutput(raw: string, tail = Infinity) {
  const clean = stripControls(raw.replace(/\r\n/g, "\n"))
    // Docker can add a timestamp to every line of a private key.
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[redacted]");
  const terminalNewline = clean.endsWith("\n");
  const lines = (terminalNewline ? clean.slice(0, -1) : clean).split("\n");
  const retained: string[] = [];
  const byteLimit = 24 * 1024;
  let bytes = terminalNewline ? 1 : 0;
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - tail); index--) {
    if (Buffer.byteLength(lines[index]) > byteLimit) continue;
    const line = redactLine(lines[index]);
    const lineBytes = Buffer.byteLength(line) + (retained.length ? 1 : 0);
    if (bytes + lineBytes > byteLimit) break;
    retained.push(line);
    bytes += lineBytes;
  }
  return {
    logs: retained.reverse().join("\n") + (terminalNewline && retained.length ? "\n" : ""),
    truncated: retained.length < lines.length,
  };
}
