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

export class EventBatcher {
    private buffer: BufferedEvent[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;

    constructor(
        private readonly runId: number,
        private readonly runUlid: string,
    ) {}

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
            await api.storeRunEventBatch(this.runId, events);
        } catch {
            // Fire-and-forget — don't block the process on failed event delivery
        }
    }

    async destroy(): Promise<void> {
        this.destroyed = true;
        await this.flush();
    }
}
