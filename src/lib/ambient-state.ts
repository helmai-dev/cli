import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getEnvironmentDir } from "./config.js";

export interface ToolObservation {
  toolName: string;
  inputHash: string;
  outputHash: string;
  inputExcerpt: string | null;
  outputExcerpt: string | null;
  capturedAt: string;
}

export interface AmbientTurnState {
  sessionId: string;
  projectId: string;
  cwd: string;
  prompt: string;
  provider: string;
  startedAt: string;
  observations: ToolObservation[];
  lastUploadedHash?: string;
}

const MAX_OBSERVATIONS = 80;

function statePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getEnvironmentDir(), "ambient-sessions", `${safe}.json`);
}

export function hashValue(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export function readAmbientTurn(sessionId: string): AmbientTurnState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), "utf-8")) as AmbientTurnState;
  } catch {
    return null;
  }
}

function writeAmbientTurn(state: AmbientTurnState): void {
  const file = statePath(state.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

export function rememberPrompt(input: {
  sessionId: string;
  projectId: string;
  cwd: string;
  prompt: string;
  provider: string;
}): void {
  try {
    const previous = readAmbientTurn(input.sessionId);
    writeAmbientTurn({
      ...input,
      startedAt: new Date().toISOString(),
      observations: previous?.prompt === input.prompt ? previous.observations : [],
      lastUploadedHash: previous?.lastUploadedHash,
    });
  } catch {
    // Turn capture is best-effort and must never interrupt an agent.
  }
}

export function appendToolObservation(sessionId: string, observation: ToolObservation): void {
  try {
    const state = readAmbientTurn(sessionId);
    if (!state) {
      return;
    }
    state.observations.push(observation);
    state.observations = state.observations.slice(-MAX_OBSERVATIONS);
    writeAmbientTurn(state);
  } catch {
    // Tool observation is best-effort and local-only until a turn completes.
  }
}

export function markTurnUploaded(sessionId: string, uploadedHash: string): void {
  try {
    const state = readAmbientTurn(sessionId);
    if (!state) {
      return;
    }
    state.lastUploadedHash = uploadedHash;
    writeAmbientTurn(state);
  } catch {
    // A missed marker only causes an idempotent retry against the Web API.
  }
}
