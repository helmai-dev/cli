import type { UsageEventsBody, UsageEventUpload } from "./api-web.js";
import type { WorkFingerprintsBody } from "./fingerprints.js";
import { liveUsageToUpload, type LiveUsageRecord } from "./proxy-inspect.js";

export interface ProxyReportDeps {
  linked: boolean;
  deviceUlid: string | null;
  usage: LiveUsageRecord | null;
  fingerprints: WorkFingerprintsBody | null;
  sendUsage: (body: UsageEventsBody) => Promise<{ accepted: number }>;
  sendFingerprints: (body: WorkFingerprintsBody) => Promise<unknown>;
}

export async function reportProxiedRequest(input: ProxyReportDeps): Promise<void> {
  try {
    if (!input.linked) {
      return;
    }
    if (input.usage) {
      const events: UsageEventUpload[] = [liveUsageToUpload(input.usage)];
      await input.sendUsage({
        source: "live",
        device_ulid: input.deviceUlid,
        events,
      });
    }
    if (input.fingerprints) {
      await input.sendFingerprints(input.fingerprints);
    }
  } catch {
  }
}
