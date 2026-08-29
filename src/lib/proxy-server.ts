import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { hasLinkedAccount } from "./account-link.js";
import {
  fetchLiveFingerprintOthers,
  sendPromptFacts,
  sendUsageEvents,
  sendUsageExcerpt,
  sendUsageReuses,
  sendWorkFingerprints,
  type LiveOverlapPerson,
  type PromptFactsBody,
  type UsageExcerptUploadBody,
  type UsageReuseUpload,
} from "./api-web.js";
import { usageCostUsd } from "./claude-scan.js";
import { getActiveEnvironment, loadCredentials, loadMachineIdentity } from "./config.js";
import {
  buildWorkFingerprint,
  mintProxySessionKey,
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
  HELM_WRAP_LINE,
  helmReuseLine,
  isLoopbackBind,
  mintWrapToken,
  normalizeWrapToken,
  pathFactsFromRequestBody,
  requestWrapBound,
  routeProxiedProvider,
  stripWrapBindPath,
  toolResultsFromRequestBody,
  usageFromProviderPayload,
  usageFromSseStream,
  usageProviderFor,
  WRAP_BIND_HEADER,
  type LiveUsageRecord,
  type ProxiedProvider,
} from "./proxy-inspect.js";
import {
  promptFactsUploadFromMeasurement,
  reportProxiedRequest,
  usageReuseFromStored,
} from "./proxy-report.js";
import {
  defaultPromptFactsPath,
  observePromptFacts,
  readPromptFacts,
  writePromptFacts,
} from "./prompt-facts.js";
import {
  excerptUploadFromParts,
  lastUserPromptFromRequestBody,
} from "./proxy-excerpt.js";
import {
  defaultWorkCachePath,
  hashWorkloadRequest,
  lookupWork,
  payloadFromToolResults,
  readWorkCache,
  recordReuse,
  replayResponseBody,
  storeWork,
  workKeyFromFacts,
  writeWorkCache,
  type WorkKey,
} from "./proxy-work-cache.js";

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

const MAX_REPLAY_RESPONSE_BYTES = 256_000;

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
  sendReuses?: typeof sendUsageReuses;
  sendExcerpt?: typeof sendUsageExcerpt;
  sendPromptFacts?: typeof sendPromptFacts;
  /**
   * Slice-6 team store: excerpt POSTs after 2xx. Opt-in so library consumers
   * and tests stay fully offline; the `helm proxy` command turns this on.
   */
  enableTeamStore?: boolean;
  environment?: string;
  log?: (line: string) => void;
  workCachePath?: string;
  promptFactsPath?: string;
  wrapToken?: string | null;
}

export interface RunningProxy {
  server: Server;
  host: string;
  port: number;
  url: string;
  wrapToken: string;
  reported: Promise<void>;
  close: () => Promise<void>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Both files are proxy state for the same environment, so prompt facts follow
 * the work cache wherever it points. A caller that redirects one (a test, a
 * throwaway environment) gets the other redirected too, and never writes to the
 * real state directory by accident.
 */
function promptFactsPathFor(hooks: ProxyHooks): string {
  if (hooks.promptFactsPath !== undefined) {
    return hooks.promptFactsPath;
  }
  if (hooks.workCachePath !== undefined) {
    return path.join(path.dirname(hooks.workCachePath), "proxy-prompt-facts.json");
  }
  return defaultPromptFactsPath();
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

function headerWrapToken(req: IncomingMessage): string | null {
  const raw = req.headers[WRAP_BIND_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return normalizeWrapToken(value);
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
  const bindPath = stripWrapBindPath(url.pathname);
  const provider = routeProxiedProvider({
    pathname: bindPath.pathname,
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
  const model = extractJsonModel(parsed !== null ? parsed : null);
  const cachePath = hooks.workCachePath ?? defaultWorkCachePath();
  const workKey = workKeyFromFacts({
    facts,
    cwd,
    homeDir,
    occurredAt: now.toISOString(),
  });
  logHarness(hooks, HELM_WRAP_LINE);
  const wrapBound = requestWrapBound({
    expected: hooks.wrapToken,
    pathname: url.pathname,
    headerToken: headerWrapToken(req),
  });

  let outbound: Buffer = raw;
  const others = await resolveOthers(hooks, { project_hint: projectHint, path_hint: pathHint });
  const note = formatTeammateNote(others, now);
  if (parsed !== null) {
    let next = appendInterceptNote(provider, parsed, HELM_WRAP_LINE);
    if (note) {
      next = appendInterceptNote(provider, next, note);
    }
    outbound = Buffer.from(JSON.stringify(next), "utf8");
  }

  // Identity covers the exact bytes the provider would receive, including
  // Helm's current intercept and teammate context, plus route and checkout.
  const requestHash = hashWorkloadRequest(
    outbound,
    `${provider}\0${bindPath.pathname}${url.search}\0${cwd}`,
  );
  const lookup = lookupWork({
    cache: readWorkCache(cachePath),
    key: workKey,
    requestHash,
    now,
  });
  if (lookup.kind === "reuse" && wrapBound) {
    const louder = helmReuseLine(lookup.record.cost_usd);
    const body = replayResponseBody({
      provider,
      response: lookup.record.response,
      notice: `${HELM_WRAP_LINE}\n${louder}`,
    });
    if (body !== null) {
      logHarness(hooks, louder);
      writeJson(res, 200, body);
      let reuses: readonly UsageReuseUpload[] | undefined;
      try {
        const next = recordReuse({ cache: readWorkCache(cachePath), record: lookup.record, now });
        writeWorkCache(cachePath, next);
        const storedReuse = next.reuses[0];
        if (storedReuse) {
          reuses = [
            usageReuseFromStored({
              reuse: storedReuse,
              record: lookup.record,
              sessionKey: lookup.record.session_key,
              environment: hooks.environment ?? getActiveEnvironment(),
            }),
          ];
        }
      } catch {
      }
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
        usage: null,
        upstreamStatus: 200,
        storeCache: false,
        workKey,
        reuses,
      });
      return;
    }
  }

  const upstreamBase =
    provider === "anthropic"
      ? (hooks.anthropicUpstream ?? "https://api.anthropic.com")
      : (hooks.openaiUpstream ?? "https://api.openai.com");
  const target = new URL(
    bindPath.pathname + url.search,
    upstreamBase.endsWith("/") ? upstreamBase : `${upstreamBase}/`,
  );

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
  const resolvedModel = model !== "unknown" ? model : extractJsonModel(parseJsonBody(responseBytes));
  logLine(hooks, provider, resolvedModel, projectHint, pathHint, usage);
  track.report = reportAfterResponse({
    hooks,
    provider,
    model: resolvedModel,
    projectHint,
    pathHint,
    facts,
    cwd,
    homeDir,
    now,
    usage,
    upstreamStatus: upstream.status,
    storeCache: true,
    workKey,
    requestHash,
    responseBody:
      !isEventStream && responseBytes.length <= MAX_REPLAY_RESPONSE_BYTES
        ? parseJsonBody(responseBytes)
        : null,
    parsed,
    cachePath,
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

function logHarness(hooks: ProxyHooks, line: string): void {
  (hooks.log ?? console.error)(line);
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
  storeCache: boolean;
  workKey: WorkKey | null;
  requestHash?: string;
  responseBody?: unknown;
  parsed?: unknown;
  cachePath?: string;
  reuses?: readonly UsageReuseUpload[];
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
  const sessionKey = mintProxySessionKey();
  let excerpt: UsageExcerptUploadBody | null = null;
  if (input.storeCache && input.workKey && input.cachePath) {
    try {
      const payload = payloadFromToolResults({
        results: toolResultsFromRequestBody(input.parsed),
        cwd: input.cwd,
        homeDir: input.homeDir,
        occurredAt: input.now.toISOString(),
      });
      writeWorkCache(
        input.cachePath,
        storeWork({
          cache: readWorkCache(input.cachePath),
          record: {
            project_hint: input.workKey.project_hint,
            path_hints: input.workKey.path_hints,
            tool_names: input.workKey.tool_names,
            session_key: sessionKey,
            model: input.model !== "unknown" ? input.model : null,
            cost_usd: usageRecord ? usageRecord.cost_usd : null,
            input_tokens: input.usage ? input.usage.input_tokens : null,
            output_tokens: input.usage ? input.usage.output_tokens : null,
            cache_write_tokens: input.usage ? input.usage.cache_write_tokens : null,
            cache_read_tokens: input.usage ? input.usage.cache_read_tokens : null,
            occurred_at: input.now.toISOString(),
            payload,
            request_hash: input.requestHash ?? null,
            response: isPlainRecord(input.responseBody) ? input.responseBody : null,
          },
        }),
      );
      // Bounded excerpt for the team store. Prompt is the last user ask only;
      // tool bytes are the same entries already cached locally.
      if (
        input.hooks.enableTeamStore === true &&
        (input.hooks.linked ?? hasLinkedAccount(loadCredentials()))
      ) {
        excerpt = {
          device_ulid: input.hooks.deviceUlid ?? loadMachineIdentity()?.ulid ?? null,
          excerpt: excerptUploadFromParts({
            workKey: input.workKey,
            sessionKey,
            prompt: lastUserPromptFromRequestBody(input.parsed),
            payload,
            costUsd: null,
            model: input.model !== "unknown" ? input.model : null,
            inputTokens: input.usage ? input.usage.input_tokens : null,
            outputTokens: input.usage ? input.usage.output_tokens : null,
            cacheWriteTokens: input.usage ? input.usage.cache_write_tokens : null,
            cacheReadTokens: input.usage ? input.usage.cache_read_tokens : null,
            occurredAt: input.now,
            environment: input.hooks.environment ?? getActiveEnvironment(),
          }),
        };
      }
    } catch {
    }
  }
  // Prompt-inefficiency measurement. Runs after the client already has its
  // response, so it can never slow or fail the user's provider call. Stored
  // locally even when unlinked, so `helm scan` and `helm audit` still work for
  // CLI-only users. Only hashes, byte lengths, and counts are persisted.
  let promptFacts: PromptFactsBody | null = null;
  if (input.storeCache && input.usage) {
    try {
      const factsPath = promptFactsPathFor(input.hooks);
      const observed = observePromptFacts({
        file: readPromptFacts(factsPath),
        parsed: input.parsed,
        usage: input.usage,
        projectHint: input.projectHint,
        model: input.model,
        now: input.now,
      });
      if (observed !== null) {
        writePromptFacts(factsPath, observed.file);
        promptFacts = {
          device_ulid: input.hooks.deviceUlid ?? loadMachineIdentity()?.ulid ?? null,
          facts: [
            promptFactsUploadFromMeasurement({
              measurement: observed.measurement,
              projectHint: input.projectHint,
              sessionKey: observed.session.session_key,
              provider: usageProviderFor(input.provider),
              model: input.model,
              occurredAt: input.now,
              environment: input.hooks.environment ?? getActiveEnvironment(),
            }),
          ],
        };
      }
    } catch {
    }
  }

  const fingerprints: WorkFingerprintsBody | null = (() => {
    const built = [];
    for (const fact of input.facts) {
      const fingerprint = buildWorkFingerprint(
        { provider: fingerprintProvider, cwd: input.cwd },
        {
          toolName: fact.toolName,
          pathCandidate: fact.pathCandidate,
          occurredAt: input.now.toISOString(),
          sessionKey,
        },
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
    reuses: input.reuses,
    excerpt,
    promptFacts,
    sendUsage: input.hooks.sendUsage ?? sendUsageEvents,
    sendFingerprints: input.hooks.sendFingerprints ?? sendWorkFingerprints,
    sendReuses: input.hooks.sendReuses ?? sendUsageReuses,
    sendExcerpt: input.hooks.sendExcerpt ?? sendUsageExcerpt,
    sendPromptFacts: input.hooks.sendPromptFacts ?? sendPromptFacts,
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
  options: { host?: string; port?: number; enableTeamStore?: boolean } = {},
  hooks: ProxyHooks = {},
): Promise<RunningProxy> {
  const host = options.host ?? DEFAULT_PROXY_HOST;
  if (!isLoopbackBind(host)) {
    throw new Error("helm proxy only binds loopback (127.0.0.1, ::1, localhost).");
  }
  const preferred = options.port ?? DEFAULT_PROXY_PORT;
  const track = { report: Promise.resolve() };
  const wrapToken = normalizeWrapToken(hooks.wrapToken) ?? mintWrapToken();
  const server = createProxyServer(
    { ...hooks, wrapToken, enableTeamStore: options.enableTeamStore ?? hooks.enableTeamStore },
    track,
  );
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
    wrapToken,
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
  onListening?: (info: { host: string; port: number; url: string; wrapToken: string }) => void;
}): Promise<RunningProxy> {
  const running = await listenProxy(
    {
      host: options.host ?? process.env.HELM_PROXY_HOST ?? DEFAULT_PROXY_HOST,
      port: options.port ?? (process.env.HELM_PROXY_PORT ? Number(process.env.HELM_PROXY_PORT) : DEFAULT_PROXY_PORT),
      // The real proxy daemon opts into bounded receipt uploads after 2xx.
      // Upload failures never break the provider path.
      enableTeamStore: true,
    },
  );
  options.onListening?.({
    host: running.host,
    port: running.port,
    url: running.url,
    wrapToken: running.wrapToken,
  });
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
