/**
 * EventBatcher — buffers run events and flushes them in batches
 * to reduce HTTP request volume by 10-100x.
 *
 * Auto-flushes when buffer reaches 50 events or 500ms since first buffered event.
 */

import * as api from './api.js';

const MAX_BUFFER_SIZE = 50;
const FLUSH_INTERVAL_MS = 500;

interface BufferedEvent {
    event_type: string;
    payload?: Record<string, unknown>;
}

interface EventBatcherOptions {
    flushEvents?: (
        runId: number,
        events: Array<{ event_type: string; payload?: Record<string, unknown> }>,
        sessionId?: string | null,
    ) => Promise<unknown>;
    log?: (message: string) => void;
}

export class EventBatcher {
    private buffer: BufferedEvent[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    private sessionId: string | null = null;
    private readonly flushEvents: (
        runId: number,
        events: Array<{ event_type: string; payload?: Record<string, unknown> }>,
        sessionId?: string | null,
    ) => Promise<unknown>;
    private readonly log: (message: string) => void;

    constructor(
        private readonly runId: number,
        private readonly runUlid: string,
        options: EventBatcherOptions = {},
    ) {
        this.flushEvents = options.flushEvents ?? api.storeRunEventBatch;
        this.log = options.log ?? (() => {});
    }

    setSessionId(sessionId: string | null): void {
        this.sessionId = sessionId;
    }

    pushImmediate(eventType: string, payload?: Record<string, unknown>): void {
        this.push(eventType, payload);
        this.flush().catch(() => {});
    }

    push(eventType: string, payload?: Record<string, unknown>): void {
        if (this.destroyed) {
            return;
        }

        this.buffer.push({
            event_type: eventType,
            ...(payload !== undefined ? { payload } : {}),
        });

        if (this.buffer.length >= MAX_BUFFER_SIZE) {
            this.flush().catch(() => {});
            return;
        }

        // Start timer on first buffered event
        if (this.flushTimer === null) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flush().catch(() => {});
            }, FLUSH_INTERVAL_MS);
        }
    }

    async flush(): Promise<void> {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.buffer.length === 0) {
            return;
        }

        const events = this.buffer.splice(0);

        try {
            await this.flushEvents(this.runId, events, this.sessionId);
        } catch (error) {
            this.buffer.unshift(...events);
            this.log(
                `Failed to flush ${events.length} run event(s) for ${this.runUlid}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
        await this.flush();
    }
}
