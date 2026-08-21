import type {
  UsageEventsBody,
  UsageEventUpload,
  UsageReuseUpload,
  UsageReusesBody,
} from "./api-web.js";
import type { WorkFingerprintsBody } from "./fingerprints.js";
import { liveUsageToUpload, type LiveUsageRecord } from "./proxy-inspect.js";
import type { WorkReuse } from "./proxy-work-cache.js";

export interface ProxyReportDeps {
  linked: boolean;
  deviceUlid: string | null;
  usage: LiveUsageRecord | null;
  fingerprints: WorkFingerprintsBody | null;
  reuses?: readonly UsageReuseUpload[];
  sendUsage: (body: UsageEventsBody) => Promise<{ accepted: number }>;
  sendFingerprints: (body: WorkFingerprintsBody) => Promise<unknown>;
  sendReuses?: (body: UsageReusesBody) => Promise<{ accepted: number }>;
}

export function usageReuseFromStored(input: {
  reuse: WorkReuse;
  sessionKey: string | null;
  environment: string;
}): UsageReuseUpload {
  return {
    project_hint: input.reuse.project_hint,
    path_hints: [...input.reuse.path_hints],
    tool_names: [...input.reuse.tool_names],
    session_key: input.sessionKey !== null && input.sessionKey !== "" ? input.sessionKey : null,
    avoided_usd: input.reuse.avoided_usd,
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
}
