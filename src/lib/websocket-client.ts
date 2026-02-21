/**
 * WebSocket client for persistent daemon-to-server communication.
 * Handles connection lifecycle, authentication, reconnection with backoff,
 * message queuing during disconnects, and HTTP fallback.
 */

import WebSocket from 'ws';
import type { PendingRun } from '../types.js';
import { getApiUrl, loadCredentials } from './config.js';

export interface WsClientOptions {
    name: string;
    fingerprint: string;
    capabilities?: Record<string, unknown>;
    onPendingRuns?: (runs: PendingRun[]) => void;
    onRunInput?: (runUlid: string, message: string) => void;
    onRunCancel?: (runUlid: string) => void;
    log?: (message: string) => void;
}

interface QueuedMessage {
    data: Record<string, unknown>;
    resolve?: () => void;
}

type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'closed';

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS_BEFORE_FALLBACK = 10;
const HEARTBEAT_INTERVAL_MS = 30_000;

export class DaemonWebSocketClient {
    private ws: WebSocket | null = null;
    private state: ConnectionState = 'disconnected';
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private messageQueue: QueuedMessage[] = [];
    private machineId: number | null = null;
    private machineUlid: string | null = null;
    private options: WsClientOptions;
    private httpFallback = false;

    constructor(options: WsClientOptions) {
        this.options = options;
    }

    get isConnected(): boolean {
        return this.state === 'ready';
    }

    get isUsingHttpFallback(): boolean {
        return this.httpFallback;
    }

    getMachineId(): number | null {
        return this.machineId;
    }

    connect(): void {
        if (this.state === 'closed') {
            return;
        }

        const wsUrl = this.getWsUrl();
        if (!wsUrl) {
            this.log('No WebSocket URL available, using HTTP fallback');
            this.httpFallback = true;
            return;
        }

        this.state = 'connecting';
        this.log(`Connecting to ${wsUrl}`);

        try {
            this.ws = new WebSocket(wsUrl);
        } catch {
            this.log('Failed to create WebSocket connection');
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            this.state = 'authenticating';
            this.log('Connected, authenticating...');
            this.sendAuth();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            this.handleMessage(data.toString());
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
            const reasonStr = reason.toString();
            this.log(`Connection closed: ${code} ${reasonStr}`);
            this.cleanup();

            if (this.state !== 'closed') {
                this.scheduleReconnect();
            }
        });

        this.ws.on('error', (err: Error) => {
            this.log(`Connection error: ${err.message}`);
        });
    }

    close(): void {
        this.state = 'closed';
        this.cleanup();
        if (this.ws) {
            this.ws.close(1000, 'Client shutting down');
            this.ws = null;
        }
    }

    /**
     * Send a message over WebSocket. If not connected, queues for later delivery.
     * Returns true if sent immediately, false if queued.
     */
    send(data: Record<string, unknown>): boolean {
        if (this.httpFallback) {
            return false;
        }

        if (this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
            return true;
        }

        // Queue for delivery once connected
        this.messageQueue.push({ data });
        return false;
    }

    /**
     * Send a run event via WebSocket. Falls back to returning false if WS unavailable.
     */
    sendRunEvent(runUlid: string, eventType: string, payload?: Record<string, unknown>): boolean {
        return this.send({
            type: 'run.event.direct',
            run_ulid: runUlid,
            event_type: eventType,
            payload: payload ?? null,
        });
    }

    /**
     * Send a run status update via WebSocket.
     */
    sendRunStatus(runUlid: string, status: string, failureReason?: string, payload?: Record<string, unknown>): boolean {
        return this.send({
            type: 'run.status',
            run_ulid: runUlid,
            status,
            ...(failureReason ? { failure_reason: failureReason } : {}),
            ...(payload ? { payload } : {}),
        });
    }

    /**
     * Send a run claim via WebSocket.
     */
    sendRunClaim(runUlid: string): boolean {
        return this.send({
            type: 'run.claim',
            run_ulid: runUlid,
        });
    }

    /**
     * Send a heartbeat with optional local projects.
     */
    sendHeartbeat(localProjects?: Array<{ slug: string; local_path?: string | null }>): boolean {
        return this.send({
            type: 'heartbeat',
            ...(localProjects ? { local_projects: localProjects } : {}),
        });
    }

    private getWsUrl(): string | null {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
            return null;
        }

        // Derive WS URL from API URL: https://example.com -> ws://example.com:8081
        try {
            const url = new URL(apiUrl);
            const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsPort = url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? 8081 : 8081;
            return `${protocol}//${url.hostname}:${wsPort}`;
        } catch {
            return null;
        }
    }

    private sendAuth(): void {
        const credentials = loadCredentials();
        if (!credentials?.api_key) {
            this.log('No credentials for auth');
            this.ws?.close(4001, 'No credentials');
            return;
        }

        const payload = JSON.stringify({
            type: 'auth',
            api_key: credentials.api_key,
            name: this.options.name,
            fingerprint: this.options.fingerprint,
            capabilities: this.options.capabilities ?? null,
        });

        this.ws?.send(payload);
    }

    private handleMessage(raw: string): void {
        let data: Record<string, unknown>;
        try {
            data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            this.log(`Invalid JSON from server: ${raw.slice(0, 100)}`);
            return;
        }

        const type = data.type as string;

        switch (type) {
            case 'auth.ok':
                this.state = 'ready';
                this.machineId = data.machine_id as number;
                this.machineUlid = data.machine_ulid as string;
                this.reconnectAttempts = 0;
                this.httpFallback = false;
                this.log(`Authenticated: machine_id=${this.machineId}`);
                this.startHeartbeat();
                this.flushQueue();
                break;

            case 'pending_runs':
                if (Array.isArray(data.runs)) {
                    this.options.onPendingRuns?.(data.runs as PendingRun[]);
                }
                break;

            case 'run.input':
                if (typeof data.run_ulid === 'string' && typeof data.message === 'string') {
                    this.options.onRunInput?.(data.run_ulid, data.message);
                }
                break;

            case 'run.cancel':
                if (typeof data.run_ulid === 'string') {
                    this.options.onRunCancel?.(data.run_ulid);
                }
                break;

            case 'event.ack':
            case 'run.status.ack':
            case 'run.claim.ack':
            case 'heartbeat.ack':
                // Acknowledgments — no action needed
                break;

            case 'error':
                this.log(`Server error: ${data.message as string} (ref: ${(data.ref_type as string) ?? 'none'})`);
                break;

            case 'ping': {
                // Server-sent ping (application-level)
                this.ws?.send(JSON.stringify({ type: 'pong' }));
                break;
            }

            default:
                this.log(`Unknown message type: ${type}`);
        }
    }

    private flushQueue(): void {
        if (this.messageQueue.length === 0) {
            return;
        }

        this.log(`Flushing ${this.messageQueue.length} queued message(s)`);
        const queue = [...this.messageQueue];
        this.messageQueue = [];

        for (const msg of queue) {
            this.send(msg.data);
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.state === 'ready') {
                this.send({ type: 'heartbeat' });
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.state === 'closed') {
            return;
        }

        this.reconnectAttempts++;
        this.state = 'disconnected';

        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS_BEFORE_FALLBACK) {
            this.log(`${this.reconnectAttempts} reconnect attempts failed, switching to HTTP fallback`);
            this.httpFallback = true;
            this.messageQueue = []; // Clear stale queued messages
            return;
        }

        const delay = Math.min(
            INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
            MAX_RECONNECT_DELAY_MS,
        );

        this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private cleanup(): void {
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.state !== 'closed') {
            this.state = 'disconnected';
        }
    }

    private log(message: string): void {
        this.options.log?.(`[ws] ${message}`);
    }
}
