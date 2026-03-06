import type { PendingRun } from "../types.js";
import * as api from "./api.js";
import {
  getAdmiralMachineStreamUrl,
  loadCredentials,
  loadMachineIdentity,
} from "./config.js";

const RECONNECT_DELAY_MS = 1_000;

interface DaemonSocketOptions {
  log: (message: string) => void;
  onPendingRuns: (pendingRuns: PendingRun[]) => Promise<void>;
  onRunnerCommands: (commands: RunnerCommand[]) => Promise<string[]>;
}

export interface RunnerCommand {
  id: string;
  type: string;
  run_id: number;
  run_ulid: string;
  payload: Record<string, unknown>;
  issued_at: string;
}

interface SseEvent {
  event: string;
  data: string;
}

export class DaemonSocket {
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streamPromise: Promise<void> | null = null;
  private manuallyClosed = false;
  private connected = false;
  private lastError: string | null = null;

  public constructor(private readonly options: DaemonSocketOptions) {}

  public connect(): void {
    if (this.manuallyClosed || this.streamPromise !== null) {
      return;
    }

    const machine = loadMachineIdentity();
    const credentials = loadCredentials();

    if (!machine || !credentials?.api_key) {
      return;
    }

    this.streamPromise = this.openStream(
      machine.id,
      credentials.api_key,
    ).finally(() => {
      this.streamPromise = null;

      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    });
  }

  public disconnect(): void {
    this.manuallyClosed = true;
    this.connected = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.controller?.abort();
    this.controller = null;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public getUrl(): string | null {
    const machine = loadMachineIdentity();

    return machine ? getAdmiralMachineStreamUrl(machine.id) : null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manuallyClosed) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private async openStream(machineId: number, apiKey: string): Promise<void> {
    const controller = new AbortController();
    const streamUrl = getAdmiralMachineStreamUrl(machineId);

    this.controller = controller;

    try {
      const response = await fetch(streamUrl, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const message = `Stream request failed: ${response.status}`;

        this.lastError = message;
        this.options.log(message);

        return;
      }

      this.connected = true;
      this.lastError = null;
      this.options.log(`Daemon stream connected: ${streamUrl}`);

      await this.consume(response.body);
    } catch (error) {
      if (!this.manuallyClosed) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.options.log(`Daemon stream error: ${this.lastError}`);
      }
    } finally {
      this.connected = false;
      this.controller = null;
    }
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const event = this.parseEvent(rawEvent);

        if (event !== null) {
          await this.handleEvent(event);
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  private parseEvent(rawEvent: string): SseEvent | null {
    const lines = rawEvent.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) {
      return null;
    }

    return {
      event,
      data: dataLines.join("\n"),
    };
  }

  private async handleEvent(event: SseEvent): Promise<void> {
    if (event.event === "keepalive") {
      return;
    }

    if (event.event === "runner_commands") {
      try {
        const machine = loadMachineIdentity();
        const payload = JSON.parse(event.data) as {
          commands?: RunnerCommand[];
        };
        const commandIds = await this.options.onRunnerCommands(
          payload.commands ?? [],
        );

        if (machine && commandIds.length > 0) {
          await api.acknowledgeMachineCommands(machine.id, commandIds);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.options.log(
          `Failed to process daemon runner commands: ${this.lastError}`,
        );
      }

      return;
    }

    if (event.event !== "pending_runs") {
      return;
    }

    try {
      const payload = JSON.parse(event.data) as { runs?: PendingRun[] };
      await this.options.onPendingRuns(payload.runs ?? []);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.log(
        `Failed to parse daemon stream event: ${this.lastError}`,
      );
    }
  }
}
