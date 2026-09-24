/**
 * The team-context control group. On a small, stable share of work Helm
 * looks up the teammate context it would inject, records which sources it
 * would have used, and withholds them. Helm Web compares those sessions with
 * the ones that got context (turns, tokens, time) to measure whether team
 * context actually makes agents faster.
 *
 * The draw is per device, project, and UTC day, so the hook and the wrap agree
 * and one working session never flips between groups mid-task.
 */

import { createHash } from "node:crypto";

export const CONTEXT_HOLDOUT_RATE = 0.1;
const MAX_RATE = 0.5;

/** HELM_CONTEXT_HOLDOUT=0 opts out; a fraction (e.g. 0.2) overrides the rate. */
export function contextHoldoutRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HELM_CONTEXT_HOLDOUT?.trim();
  if (raw === undefined || raw === "") {
    return CONTEXT_HOLDOUT_RATE;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_RATE, value);
}

export function isContextHoldout(input: {
  deviceUlid: string | null | undefined;
  projectHint: string | null | undefined;
  now: Date;
  rate?: number;
}): boolean {
  const rate = input.rate ?? contextHoldoutRate();
  if (rate <= 0 || !input.deviceUlid || !input.projectHint) {
    return false;
  }
  const day = input.now.toISOString().slice(0, 10);
  const digest = createHash("sha256")
    .update(`helm.context-holdout.v1|${input.deviceUlid}|${input.projectHint}|${day}`)
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < rate;
}
