const MAX_BUFFERED_BYTES = 1024 * 1024;
const STOP_TIMEOUT_MS = 5000;
const NORMAL_CLOSE_CODE = 1000;

export type AsrState = 'idle' | 'connecting' | 'recording' | 'stopping' | 'error';

export interface AsrStatus {
    state: AsrState;
    message?: string;
}

export interface AsrResultEvent {
    type: 'partial' | 'final' | 'error';
    text: string;
}

export interface WebSocketLike {
    readonly readyState: number;
    readonly bufferedAmount: number;
    addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event) => void): void;
    removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event) => void): void;
    send(data: string | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
}

export interface RemoteAsrClientOptions {
    production: boolean;
    createWebSocket(url: string): WebSocketLike;
    onStatus(status: AsrStatus): void;
    onResult(event: AsrResultEvent): void;
    setTimer(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
    clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export function deriveAsrWebSocketUrl(baseUrl: string, production: boolean): string {
    let url: URL;
    try {
        url = new URL(baseUrl.trim());
    } catch {
        throw new Error('ASR server URL must be an absolute HTTP(S) URL');
    }
    if (url.username || url.password) throw new Error('ASR server URL must not include credentials');
    if (url.search) throw new Error('ASR server URL must not include query data');
    if (url.hash) throw new Error('ASR server URL must not include fragment data');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('ASR server must use HTTPS or HTTP');
    if (production && url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw new Error('Production ASR servers must use HTTPS');
    }
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return new URL('ws/asr', url).href;
}

export class RemoteAsrClient {
    private status: AsrStatus = {state: 'idle'};
    private socket: WebSocketLike | null = null;
    private stopTimer: ReturnType<typeof setTimeout> | null = null;
    private startResolve: ((status: AsrStatus) => void) | null = null;
    private startReject: ((error: Error) => void) | null = null;
    private stopResolve: ((status: AsrStatus) => void) | null = null;
    private stopReject: ((error: Error) => void) | null = null;
    private serverStopped = false;

    public constructor(private readonly options: RemoteAsrClientOptions) {}

    public getStatus(): AsrStatus {
        return {...this.status};
    }

    public async start(baseUrl: string, sampleRate: number): Promise<AsrStatus> {
        if (this.status.state === 'connecting' || this.status.state === 'recording' || this.status.state === 'stopping') {
            throw new Error('ASR is already active');
        }
        if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
            throw new TypeError('ASR sample rate must be an integer from 8000 through 192000');
        }

        const url = deriveAsrWebSocketUrl(baseUrl, this.options.production);
        this.setStatus({state: 'connecting'});
        let socket: WebSocketLike;
        try {
            socket = this.options.createWebSocket(url);
        } catch {
            this.fail('Remote ASR connection failed', false);
            throw new Error('Remote ASR connection failed');
        }
        this.socket = socket;
        this.serverStopped = false;
        socket.addEventListener('open', this.onOpen);
        socket.addEventListener('message', this.onMessage);
        socket.addEventListener('error', this.onError);
        socket.addEventListener('close', this.onClose);

        return new Promise<AsrStatus>((resolve, reject) => {
            this.startResolve = resolve;
            this.startReject = reject;
            this.sampleRate = sampleRate;
        });
    }

    public writePcm(buffer: ArrayBuffer): void {
        if (this.status.state !== 'recording') throw new Error('ASR is not recording');
        if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength % 2 !== 0) {
            throw new TypeError('ASR PCM must be a non-empty Int16 buffer');
        }
        if (!this.socket) throw new Error('ASR is not recording');
        if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            this.fail('Remote ASR network is slow');
            throw new Error('Remote ASR network is slow');
        }
        this.socket.send(buffer);
    }

    public async stop(): Promise<AsrStatus> {
        if (this.status.state !== 'recording') return this.getStatus();
        const socket = this.socket;
        if (!socket) return this.getStatus();

        this.setStatus({state: 'stopping'});
        return new Promise<AsrStatus>((resolve, reject) => {
            this.stopResolve = resolve;
            this.stopReject = reject;
            this.stopTimer = this.options.setTimer(() => {
                this.fail('Remote ASR stop timed out', true, 'ASR stop timeout');
            }, STOP_TIMEOUT_MS);
            try {
                socket.send('stop');
            } catch {
                this.fail('Remote ASR connection failed');
            }
        });
    }

    public dispose(): void {
        const socket = this.socket;
        this.detachSocket();
        this.clearStopTimer();
        this.rejectPending(new Error('ASR session was disposed'));
        if (socket) socket.close(NORMAL_CLOSE_CODE, 'ASR disposed');
        this.setStatus({state: 'idle'});
    }

    private sampleRate = 0;

    private readonly onOpen = (): void => {
        if (!this.socket || this.status.state !== 'connecting') return;
        try {
            this.socket.send(JSON.stringify({type: 'audio_config', sample_rate: this.sampleRate}));
            this.setStatus({state: 'recording'});
            this.resolveStart();
        } catch {
            this.fail('Remote ASR connection failed');
        }
    };

    private readonly onMessage = (event: Event): void => {
        if (!this.socket) return;
        const data = (event as MessageEvent<unknown>).data;
        if (data === 'asr stopped') {
            if (this.status.state !== 'stopping') return;
            this.serverStopped = true;
            this.clearStopTimer();
            this.socket.close(NORMAL_CLOSE_CODE, 'ASR stopped');
            return;
        }
        if (typeof data !== 'string') {
            this.fail('Remote ASR returned an invalid message');
            return;
        }

        let payload: unknown;
        try {
            payload = JSON.parse(data);
        } catch {
            this.fail('Remote ASR returned an invalid message');
            return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            this.fail('Remote ASR returned an invalid message');
            return;
        }
        const message = payload as Record<string, unknown>;
        if (typeof message.text === 'string' && typeof message.is_end === 'boolean') {
            this.options.onResult({type: message.is_end ? 'final' : 'partial', text: message.text});
            return;
        }
        if (message.event === 'error' && typeof message.message === 'string') {
            this.fail('Remote ASR failed');
            return;
        }
        this.fail('Remote ASR returned an invalid message');
    };

    private readonly onError = (): void => {
        if (this.socket) this.fail('Remote ASR connection failed');
    };

    private readonly onClose = (event: Event): void => {
        if (!this.socket) return;
        const closeEvent = event as CloseEvent;
        if (this.status.state === 'stopping' && this.serverStopped && closeEvent.code === NORMAL_CLOSE_CODE) {
            this.detachSocket();
            this.clearStopTimer();
            this.setStatus({state: 'idle'});
            this.resolveStop();
            return;
        }
        this.detachSocket();
        this.clearStopTimer();
        this.publishError('Remote ASR connection failed');
        this.rejectPending(new Error('Remote ASR connection failed'));
    };

    private fail(message: string, closeSocket = true, closeReason = 'ASR failed'): void {
        const socket = this.socket;
        this.detachSocket();
        this.clearStopTimer();
        if (closeSocket && socket) socket.close(NORMAL_CLOSE_CODE, closeReason);
        this.publishError(message);
        this.rejectPending(new Error(message));
    }

    private publishError(message: string): void {
        this.options.onResult({type: 'error', text: message});
        this.setStatus({state: 'error', message});
    }

    private setStatus(status: AsrStatus): void {
        this.status = status;
        this.options.onStatus(this.getStatus());
    }

    private detachSocket(): void {
        if (!this.socket) return;
        this.socket.removeEventListener('open', this.onOpen);
        this.socket.removeEventListener('message', this.onMessage);
        this.socket.removeEventListener('error', this.onError);
        this.socket.removeEventListener('close', this.onClose);
        this.socket = null;
    }

    private clearStopTimer(): void {
        if (!this.stopTimer) return;
        this.options.clearTimer(this.stopTimer);
        this.stopTimer = null;
    }

    private resolveStart(): void {
        const resolve = this.startResolve;
        this.startResolve = null;
        this.startReject = null;
        resolve?.(this.getStatus());
    }

    private resolveStop(): void {
        const resolve = this.stopResolve;
        this.stopResolve = null;
        this.stopReject = null;
        resolve?.(this.getStatus());
    }

    private rejectPending(error: Error): void {
        const rejectStart = this.startReject;
        const rejectStop = this.stopReject;
        this.startResolve = null;
        this.startReject = null;
        this.stopResolve = null;
        this.stopReject = null;
        rejectStart?.(error);
        rejectStop?.(error);
    }
}
