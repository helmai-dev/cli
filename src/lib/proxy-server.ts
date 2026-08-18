import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as os from "node:os";
import { hasLinkedAccount } from "./account-link.js";
import {
  fetchLiveFingerprintOthers,
  sendUsageEvents,
  sendWorkFingerprints,
  type LiveOverlapPerson,
} from "./api-web.js";
import { usageCostUsd } from "./claude-scan.js";
import { loadCredentials, loadMachineIdentity } from "./config.js";
import {
  buildWorkFingerprint,
  projectHintFromCwd,
  type WorkFingerprintsBody,
} from "./fingerprints.js";
import {
  appendInterceptNote,
  buildLiveUsageRecord,
  DEFAULT_PROXY_HOST,
  DEFAULT_PROXY_PORT,
  extractJsonModel,
  formatTeammateNote,
  isLoopbackBind,
  pathFactsFromRequestBody,
  routeProxiedProvider,
  usageFromProviderPayload,
  usageFromSseStream,
  usageProviderFor,
  type LiveUsageRecord,
  type ProxiedProvider,
} from "./proxy-inspect.js";
import { reportProxiedRequest } from "./proxy-report.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const RESPONSE_STRIP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

export interface ProxyHooks {
  anthropicUpstream?: string;
  openaiUpstream?: string;
  cwd?: string;
  homeDir?: string;
  now?: () => Date;
  linked?: boolean;
  deviceUlid?: string | null;
  fetchLiveOthers?: (query: {
    project_hint: string;
    path_hint: string | null;
  }) => Promise<LiveOverlapPerson[]>;
  sendUsage?: typeof sendUsageEvents;
  sendFingerprints?: typeof sendWorkFingerprints;
  log?: (line: string) => void;
}

export interface RunningProxy {
  server: Server;
  host: string;
  port: number;
  url: string;
  reported: Promise<void>;
  close: () => Promise<void>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerNames(req: IncomingMessage): string[] {
  return Object.keys(req.headers);
}

function forwardRequestHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function forwardResponseHeaders(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  headers.forEach((value, key) => {
    if (RESPONSE_STRIP.has(key.toLowerCase())) {
      return;
    }
    out[key] = value;
  });
  return out;
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function dayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function lastPathHint(
  facts: ReturnType<typeof pathFactsFromRequestBody>,
  cwd: string,
  homeDir: string,
): string | null {
  for (let i = facts.length - 1; i >= 0; i -= 1) {
    const fact = facts[i];
    if (!fact) {
      continue;
    }
    const fingerprint = buildWorkFingerprint(
      { provider: "claude-compatible", cwd },
      { toolName: fact.toolName, pathCandidate: fact.pathCandidate, occurredAt: new Date().toISOString() },
      homeDir,
    );
    if (fingerprint?.path_hint) {
      return fingerprint.path_hint;
    }
  }
  return null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function defaultLinked(): boolean {
  return hasLinkedAccount(loadCredentials());
}

async function defaultLiveOthers(query: {
  project_hint: string;
  path_hint: string | null;
}): Promise<LiveOverlapPerson[]> {
  return fetchLiveFingerprintOthers({
    project_hint: query.project_hint,
    path_hints: query.path_hint ? [query.path_hint] : [],
  });
}

async function writeUpstreamBody(input: {
  res: ServerResponse;
  status: number;
  headers: Record<string, string | string[]>;
  body: ReadableStream<Uint8Array> | null;
  fallback: () => Promise<ArrayBuffer>;
  stream: boolean;
}): Promise<Buffer> {
  if (!input.stream || input.body === null) {
    const responseBytes = Buffer.from(await input.fallback());
    input.res.writeHead(input.status, input.headers);
    input.res.end(responseBytes);
    return responseBytes;
  }
  input.res.writeHead(input.status, input.headers);
  const reader = input.body.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      const buf = Buffer.from(value);
      chunks.push(buf);
      input.res.write(buf);
    }
  }
  input.res.end();
  return Buffer.concat(chunks);
}

function writeHealth(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "helm-proxy" }));
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  hooks: ProxyHooks,
  track: { report: Promise<void> },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    writeHealth(res);
    return;
  }

  const raw = await readRequestBody(req);
  const parsed = parseJsonBody(raw);
  const provider = routeProxiedProvider({
    pathname: url.pathname,
    headerNames: headerNames(req),
  });
  if (provider === null) {
    writeJson(res, 404, { error: { type: "not_found", message: "no provider route for this path" } });
    return;
  }

  const cwd = hooks.cwd ?? process.cwd();
  const homeDir = hooks.homeDir ?? os.homedir();
  const now = hooks.now ? hooks.now() : new Date();
  const projectHint = projectHintFromCwd(cwd, homeDir) ?? "";
  const facts = pathFactsFromRequestBody(parsed);
  const pathHint = lastPathHint(facts, cwd, homeDir);

  let outbound: Buffer = raw;
  const others = await resolveOthers(hooks, { project_hint: projectHint, path_hint: pathHint });
  const note = formatTeammateNote(others, now);
  if (note && parsed !== null) {
    outbound = Buffer.from(JSON.stringify(appendInterceptNote(provider, parsed, note)), "utf8");
  }

  const upstreamBase =
    provider === "anthropic"
      ? (hooks.anthropicUpstream ?? "https://api.anthropic.com")
      : (hooks.openaiUpstream ?? "https://api.openai.com");
  const target = new URL(url.pathname + url.search, upstreamBase.endsWith("/") ? upstreamBase : `${upstreamBase}/`);

  let upstream: Response;
  try {
    const method = req.method ?? "POST";
    const init: RequestInit = {
      method,
      headers: forwardRequestHeaders(req.headers),
      redirect: "manual",
    };
    if (method !== "GET" && method !== "HEAD") {
      init.body = outbound;
    }
    upstream = await fetch(target, init);
  } catch {
    writeJson(res, 502, { error: { type: "proxy_error", message: "upstream request failed" } });
    return;
  }

  const responseHeaders = forwardResponseHeaders(upstream.headers);
  const contentType = upstream.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");
  const responseBytes = await writeUpstreamBody({
    res,
    status: upstream.status,
    headers: responseHeaders,
    body: upstream.body,
    fallback: () => upstream.arrayBuffer(),
    stream: isEventStream,
  });
  const usage = isEventStream
    ? usageFromSseStream(provider, responseBytes.toString("utf8"))
    : usageFromProviderPayload(provider, parseJsonBody(responseBytes));
  const model = extractJsonModel(parsed !== null ? parsed : parseJsonBody(responseBytes));
  logLine(hooks, provider, model, projectHint, pathHint, usage);
  track.report = reportAfterResponse({
    hooks,
    provider,
    model,
    projectHint,
    pathHint,
    facts,
    cwd,
    homeDir,
    now,
    usage,
    upstreamStatus: upstream.status,
  });
}

async function resolveOthers(
  hooks: ProxyHooks,
  query: { project_hint: string; path_hint: string | null },
): Promise<LiveOverlapPerson[]> {
  if (query.project_hint === "") {
    return [];
  }
  const fetchOthers = hooks.fetchLiveOthers ?? defaultLiveOthers;
  try {
    return await withTimeout(fetchOthers(query), 400);
  } catch {
    return [];
  }
}

function logLine(
  hooks: ProxyHooks,
  provider: ProxiedProvider,
  model: string,
  projectHint: string,
  pathHint: string | null,
  usage: ReturnType<typeof usageFromProviderPayload>,
): void {
  const tokens = usage
    ? `in=${usage.input_tokens} out=${usage.output_tokens}`
    : "in=? out=?";
  const line = [
    "helm proxy",
    usageProviderFor(provider),
    model,
    projectHint || "-",
    pathHint ?? "-",
    tokens,
  ].join("  ");
  (hooks.log ?? console.log)(line);
}

async function reportAfterResponse(input: {
  hooks: ProxyHooks;
  provider: ProxiedProvider;
  model: string;
  projectHint: string;
  pathHint: string | null;
  facts: ReturnType<typeof pathFactsFromRequestBody>;
  cwd: string;
  homeDir: string;
  now: Date;
  usage: ReturnType<typeof usageFromProviderPayload>;
  upstreamStatus: number;
}): Promise<void> {
  if (input.upstreamStatus < 200 || input.upstreamStatus >= 300) {
    return;
  }
  const linked = input.hooks.linked ?? defaultLinked();
  let usageRecord: LiveUsageRecord | null = null;
  if (input.usage && input.projectHint !== "") {
    usageRecord = buildLiveUsageRecord({
      provider: usageProviderFor(input.provider),
      model: input.model,
      projectHint: input.projectHint,
      usage: input.usage,
      day: dayUtc(input.now),
      costUsd: usageCostUsd(input.model, {
        input: input.usage.input_tokens,
        output: input.usage.output_tokens,
        cacheW: input.usage.cache_write_tokens,
        cacheR: input.usage.cache_read_tokens,
      }),
    });
  }

  const fingerprintProvider = usageProviderFor(input.provider) === "claude" ? "claude-compatible" : "codex";
  const fingerprints: WorkFingerprintsBody | null = (() => {
    const built = [];
    for (const fact of input.facts) {
      const fingerprint = buildWorkFingerprint(
        { provider: fingerprintProvider, cwd: input.cwd },
        { toolName: fact.toolName, pathCandidate: fact.pathCandidate, occurredAt: input.now.toISOString() },
        input.homeDir,
      );
      if (fingerprint) {
        built.push(fingerprint);
      }
    }
    const first = built[0];
    if (first === undefined) {
      return null;
    }
    return { fingerprints: [first, ...built.slice(1)] };
  })();

  await reportProxiedRequest({
    linked,
    deviceUlid: input.hooks.deviceUlid ?? loadMachineIdentity()?.ulid ?? null,
    usage: usageRecord,
    fingerprints,
    sendUsage: input.hooks.sendUsage ?? sendUsageEvents,
    sendFingerprints: input.hooks.sendFingerprints ?? sendWorkFingerprints,
  });
}

export function createProxyServer(hooks: ProxyHooks = {}, track?: { report: Promise<void> }): Server {
  const reportTrack = track ?? { report: Promise.resolve() };
  return createServer((req, res) => {
    void handleProxyRequest(req, res, hooks, reportTrack).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: { type: "proxy_error", message: "proxy failed" } });
      } else {
        res.end();
      }
    });
  });
}

function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
        return;
      }
      reject(new Error("proxy listen failed"));
    });
  });
}

function isAddrInUse(error: unknown): boolean {
  return isPlainRecord(error) && error.code === "EADDRINUSE";
}

export async function listenProxy(
  options: { host?: string; port?: number } = {},
  hooks: ProxyHooks = {},
): Promise<RunningProxy> {
  const host = options.host ?? DEFAULT_PROXY_HOST;
  if (!isLoopbackBind(host)) {
    throw new Error("helm proxy only binds loopback (127.0.0.1, ::1, localhost).");
  }
  const preferred = options.port ?? DEFAULT_PROXY_PORT;
  const track = { report: Promise.resolve() };
  const server = createProxyServer(hooks, track);
  let port: number;
  try {
    port = await listenOn(server, host, preferred);
  } catch (error) {
    if (!isAddrInUse(error) || preferred === 0) {
      throw error;
    }
    port = await listenOn(server, host, 0);
  }
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    get reported() {
      return track.report;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function runProxyProcess(options: {
  host?: string;
  port?: number;
  onListening?: (info: { host: string; port: number; url: string }) => void;
}): Promise<RunningProxy> {
  const running = await listenProxy({
    host: options.host ?? process.env.HELM_PROXY_HOST ?? DEFAULT_PROXY_HOST,
    port: options.port ?? (process.env.HELM_PROXY_PORT ? Number(process.env.HELM_PROXY_PORT) : DEFAULT_PROXY_PORT),
  });
  options.onListening?.({ host: running.host, port: running.port, url: running.url });
  return running;
}

export async function isProxyHealthy(url: string, timeoutMs = 400): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      return false;
    }
    const body: unknown = await response.json();
    return isPlainRecord(body) && body.ok === true && body.service === "helm-proxy";
  } catch {
    return false;
  }
}
