/**
 * `helm relay` (hidden) — accept agent activity from a local harness and
 * publish it to helm-web on that harness's behalf.
 *
 * This is the seam that keeps helm-cli the single point of contact with
 * helm-web. A harness (Helm's T3Code fork today; anything else tomorrow)
 * spawns `helm relay` once and pipes newline-delimited JSON into it, instead
 * of holding its own token and writing its own HTTP client. Everything that
 * makes publishing correct — credential loading, base-URL and environment
 * resolution, auth-failure detection — stays here, in one place.
 *
 * Protocol: one JSON object per line on stdin, discriminated by `t`:
 *
 *   {"t":"chunk",  "session_id":…, "provider":…, "kind":…, "content":…}
 *   {"t":"result", "session_id":…, "subtype":…, "message":…, "is_error":…}
 *   {"t":"usage",  "session_id":…, "provider":…, "total_tokens":…}
 *
 * Events are published strictly in order — a transcript whose result lands
 * before its final chunk reads wrong — so each line is awaited before the
 * next is read. Node's pipe backpressure then throttles the harness, which
 * is the behaviour we want: slow network, slower producer, never a reorder.
 *
 * Failures of a single event are reported on stdout and the stream continues;
 * losing one chunk must not tear down a running agent's publishing. An auth
 * failure is different — every subsequent event would fail too — so we report
 * and exit non-zero, letting the caller re-auth and respawn.
 */

import { createInterface } from "node:readline";

import { accountRequiredRelayError, hasLinkedAccount } from "../lib/account-link.js";
import { isAuthError, sendSessionChunk, sendSessionResult, sendSessionUsage } from "../lib/api-web.js";
import { getApiUrl, loadCredentials } from "../lib/config.js";
import type { SessionChunk, SessionResultBody, SessionUsageBody } from "../lib/web-chunks.js";

type RelayEvent =
  | ({ t: "chunk" } & SessionChunk)
  | ({ t: "result" } & SessionResultBody)
  | ({ t: "usage" } & SessionUsageBody);

/** Pure validation, exported for tests. Returns an error string or null. */
export function validateRelayEvent(input: unknown): string | null {
  const event = input as Partial<RelayEvent> | null;
  if (event == null || typeof event !== "object") {
    return "event must be a JSON object";
  }
  if (typeof (event as { session_id?: unknown }).session_id !== "string") {
    return "session_id missing";
  }
  switch (event.t) {
    case "chunk": {
      const chunk = event as Partial<SessionChunk>;
      if (typeof chunk.kind !== "string") return "chunk.kind missing";
      if (typeof chunk.provider !== "string") return "chunk.provider missing";
      if (typeof chunk.content !== "string") return "chunk.content missing";
      return null;
    }
    case "result": {
      const result = event as Partial<SessionResultBody>;
      if (result.subtype !== "success" && result.subtype !== "error") {
        return "result.subtype must be success or error";
      }
      return null;
    }
    case "usage": {
      const usage = event as Partial<SessionUsageBody>;
      if (typeof usage.total_tokens !== "number") return "usage.total_tokens missing";
      if (typeof usage.provider !== "string") return "usage.provider missing";
      return null;
    }
    default:
      return `unknown event type ${JSON.stringify(event.t)}`;
  }
}

async function publish(event: RelayEvent): Promise<void> {
  switch (event.t) {
    case "chunk": {
      const { t: _t, ...chunk } = event;
      await sendSessionChunk(chunk);
      return;
    }
    case "result": {
      const { t: _t, ...result } = event;
      await sendSessionResult(result);
      return;
    }
    case "usage": {
      const { t: _t, ...usage } = event;
      await sendSessionUsage(usage);
      return;
    }
  }
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export async function relayCommand(): Promise<void> {
  if (!hasLinkedAccount(loadCredentials())) {
    emit({ ok: false, error: accountRequiredRelayError(getApiUrl()) });
    process.exitCode = 1;
    return;
  }

  let sent = 0;
  let failed = 0;
  let line = 0;

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const raw of input) {
    line += 1;
    const text = raw.trim();
    if (text === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      failed += 1;
      emit({ ok: false, line, error: "line was not valid JSON" });
      continue;
    }

    const invalid = validateRelayEvent(parsed);
    if (invalid) {
      failed += 1;
      emit({ ok: false, line, error: invalid });
      continue;
    }

    try {
      await publish(parsed as RelayEvent);
      sent += 1;
    } catch (error) {
      if (isAuthError(error)) {
        emit({ ok: false, line, error: "authentication rejected; run `helm connect`", fatal: true });
        process.exitCode = 1;
        return;
      }
      failed += 1;
      emit({ ok: false, line, error: error instanceof Error ? error.message : String(error) });
    }
  }

  emit({ ok: true, sent, failed });
}
