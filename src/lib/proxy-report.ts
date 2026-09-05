import type {
  PromptFactsBody,
  PromptFactsUpload,
  UsageEventsBody,
  UsageEventUpload,
  UsageExcerptUploadBody,
  UsageReuseUpload,
  UsageReusesBody,
} from "./api-web.js";
import type { WorkFingerprintsBody } from "./fingerprints.js";
import { liveUsageToUpload, type LiveUsageRecord } from "./proxy-inspect.js";
import {
  PROMPT_FACTS_MEASUREMENT,
  type PromptFactsMeasurement,
} from "./prompt-facts.js";
import type { WorkRecord, WorkReuse } from "./proxy-work-cache.js";

export interface ProxyReportDeps {
  linked: boolean;
  deviceUlid: string | null;
  usage: LiveUsageRecord | null;
  fingerprints: WorkFingerprintsBody | null;
  reuses?: readonly UsageReuseUpload[];
  excerpt?: UsageExcerptUploadBody | null;
  promptFacts?: PromptFactsBody | null;
  sendUsage: (body: UsageEventsBody) => Promise<{ accepted: number }>;
  sendFingerprints: (body: WorkFingerprintsBody) => Promise<unknown>;
  sendReuses?: (body: UsageReusesBody) => Promise<{ accepted: number }>;
  sendExcerpt?: (body: UsageExcerptUploadBody) => Promise<unknown>;
  sendPromptFacts?: (body: PromptFactsBody) => Promise<unknown>;
}

/** Map a local measurement to the wire. Tokens and counts only: the CLI never
 * submits a dollar, so Helm Web prices the measured tokens at its own rates. */
export function promptFactsUploadFromMeasurement(input: {
  measurement: PromptFactsMeasurement;
  projectHint: string;
  sessionKey: string;
  provider: string;
  model: string | null;
  occurredAt: Date;
  environment: string | null;
}): PromptFactsUpload {
  const m = input.measurement;
  return {
    measurement: PROMPT_FACTS_MEASUREMENT,
    project_hint: input.projectHint,
    session_key: input.sessionKey,
    turn_index: m.turn_index,
    provider: input.provider,
    model:
      input.model !== null && input.model !== "unknown" ? input.model : null,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
    cache_write_tokens: m.cache_write_tokens,
    cache_read_tokens: m.cache_read_tokens,
    repeated_prefix_tokens_apportioned: m.repeated_prefix_tokens_apportioned,
    repeated_rebilled_tokens_apportioned:
      m.repeated_rebilled_tokens_apportioned,
    duplicate_attachment_tokens_apportioned:
      m.duplicate_attachment_tokens_apportioned,
    duplicate_attachment_count: m.duplicate_attachment_count,
    occurred_at: input.occurredAt.toISOString(),
    environment: input.environment,
  };
}

export function usageReuseFromStored(input: {
  reuse: WorkReuse;
  record: Pick<
    WorkRecord,
    | "model"
    | "input_tokens"
    | "output_tokens"
    | "cache_write_tokens"
    | "cache_read_tokens"
  >;
  sessionKey: string | null;
  environment: string;
}): UsageReuseUpload {
  const record = input.record;
  return {
    project_hint: input.reuse.project_hint,
    path_hints: [...input.reuse.path_hints],
    tool_names: [...input.reuse.tool_names],
    session_key:
      input.sessionKey !== null && input.sessionKey !== ""
        ? input.sessionKey
        : null,
    model: record.model,
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    cache_write_tokens: record.cache_write_tokens,
    cache_read_tokens: record.cache_read_tokens,
    occurred_at: input.reuse.reused_at,
    original_occurred_at: input.reuse.original_occurred_at,
    environment: input.environment,
  };
}

export async function reportProxiedRequest(
  input: ProxyReportDeps,
): Promise<void> {
  if (!input.linked) {
    return;
  }
  if (input.excerpt && input.sendExcerpt) {
    try {
      await input.sendExcerpt(input.excerpt);
    } catch {
      process.stderr.write(
        "[helm] Excerpt delivery could not be recorded. Run helm doctor.\n",
      );
    }
  }
  if (input.usage) {
    try {
      const events: UsageEventUpload[] = [liveUsageToUpload(input.usage)];
      await input.sendUsage({
        source: "live",
        device_ulid: input.deviceUlid,
        events,
      });
    } catch {}
  }
  if (input.fingerprints) {
    try {
      await input.sendFingerprints(input.fingerprints);
    } catch {}
  }
  const firstReuse = input.reuses?.[0];
  const sendReuses = input.sendReuses;
  if (firstReuse !== undefined && sendReuses) {
    try {
      await sendReuses({
        device_ulid: input.deviceUlid,
        reuses: [firstReuse, ...(input.reuses ?? []).slice(1)],
      });
    } catch {}
  }
  // A 404 from a Helm Web that predates the detector route, or a 422 from an
  // older contract, is expected and silent. The measurement is already stored
  // locally, so nothing is lost and the provider call is untouched.
  if (input.promptFacts && input.sendPromptFacts) {
    try {
      await input.sendPromptFacts(input.promptFacts);
    } catch {}
  }
}
