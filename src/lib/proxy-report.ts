import type {
  UsageEventsBody,
  UsageEventUpload,
  UsageExcerptUploadBody,
  UsageReuseUpload,
  UsageReusesBody,
} from "./api-web.js";
import type { WorkFingerprintsBody } from "./fingerprints.js";
import { liveUsageToUpload, type LiveUsageRecord } from "./proxy-inspect.js";
import type { WorkRecord, WorkReuse } from "./proxy-work-cache.js";

export interface ProxyReportDeps {
  linked: boolean;
  deviceUlid: string | null;
  usage: LiveUsageRecord | null;
  fingerprints: WorkFingerprintsBody | null;
  reuses?: readonly UsageReuseUpload[];
  excerpt?: UsageExcerptUploadBody | null;
  sendUsage: (body: UsageEventsBody) => Promise<{ accepted: number }>;
  sendFingerprints: (body: WorkFingerprintsBody) => Promise<unknown>;
  sendReuses?: (body: UsageReusesBody) => Promise<{ accepted: number }>;
  sendExcerpt?: (body: UsageExcerptUploadBody) => Promise<unknown>;
}

export function usageReuseFromStored(input: {
  reuse: WorkReuse;
  record: Pick<
    WorkRecord,
    "model" | "input_tokens" | "output_tokens" | "cache_write_tokens" | "cache_read_tokens"
  >;
  sessionKey: string | null;
  environment: string;
}): UsageReuseUpload {
  const record = input.record;
  return {
    project_hint: input.reuse.project_hint,
    path_hints: [...input.reuse.path_hints],
    tool_names: [...input.reuse.tool_names],
    session_key: input.sessionKey !== null && input.sessionKey !== "" ? input.sessionKey : null,
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

export async function reportProxiedRequest(input: ProxyReportDeps): Promise<void> {
  if (!input.linked) {
    return;
  }
  if (input.usage) {
    try {
      const events: UsageEventUpload[] = [liveUsageToUpload(input.usage)];
      await input.sendUsage({
        source: "live",
        device_ulid: input.deviceUlid,
        events,
      });
    } catch {
    }
  }
  if (input.fingerprints) {
    try {
      await input.sendFingerprints(input.fingerprints);
    } catch {
    }
  }
  const firstReuse = input.reuses?.[0];
  const sendReuses = input.sendReuses;
  if (firstReuse !== undefined && sendReuses) {
    try {
      await sendReuses({
        device_ulid: input.deviceUlid,
        reuses: [firstReuse, ...(input.reuses ?? []).slice(1)],
      });
    } catch {
    }
  }
  if (input.excerpt && input.sendExcerpt) {
    try {
      await input.sendExcerpt(input.excerpt);
    } catch {
    }
  }
}
