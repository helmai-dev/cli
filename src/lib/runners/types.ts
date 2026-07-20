/**
 * Shared interface for agent runners (CLI spawn, Claude SDK, Codex SDK).
 */

import type { EventBatcher } from "../event-batcher.js";

export interface AgentRunner {
  start(): Promise<void>;
  interrupt(): void;
  terminate(signal: NodeJS.Signals): void;
  writeInput(message: string): void;
  readonly sessionId: string | null;
  readonly batcher: EventBatcher;
}
