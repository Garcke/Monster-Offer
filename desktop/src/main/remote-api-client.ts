export type RemoteFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type ConnectionTestStatus = 'connected' | 'unauthorized' | 'unreachable';

export interface RemoteApiClientOptions {
    baseUrl: string;
    adminToken: string;
    fetch: RemoteFetch;
}

export interface ChatRequest {
    requestId: string;
    content: string;
    signal?: AbortSignal;
}

export interface ChatStreamEvent {
    requestId: string;
    type: 'chunk' | 'done' | 'error';
    text?: string;
}

export type ChatEventSink = (event: ChatStreamEvent) => void | Promise<void>;
export type ModelProfileInput = Record<string, unknown>;

interface ParsedSseEvent {
    type: 'chunk' | 'done' | 'error';
    text?: string;
}

export class RemoteApiError extends Error {
    public constructor(message: string, public readonly status?: number) {
        super(message);
        this.name = 'RemoteApiError';
    }
}

export class RemoteApiClient {
    private readonly baseUrl: URL;
    private readonly secrets: string[];

    public constructor(private readonly options: RemoteApiClientOptions) {
        this.baseUrl = new URL(options.baseUrl);
        this.baseUrl.search = '';
        this.baseUrl.hash = '';
        if (!this.baseUrl.pathname.endsWith('/')) this.baseUrl.pathname += '/';
        this.secrets = [options.adminToken];
    }

    public listModels(): Promise<unknown> {
        return this.requestJson('models/', {method: 'GET'}, true);
    }

    public createModel(profile: ModelProfileInput): Promise<unknown> {
        return this.requestJson('models/', this.jsonRequest('POST', profile), true, profile);
    }

    public updateModel(profileId: string, profile: ModelProfileInput): Promise<unknown> {
        return this.requestJson(`models/${encodeURIComponent(profileId)}`, this.jsonRequest('PUT', profile), true, profile);
    }

    public async deleteModel(profileId: string): Promise<void> {
        await this.requestJson(`models/${encodeURIComponent(profileId)}`, {method: 'DELETE'}, true);
    }

    public activateModel(profileId: string): Promise<unknown> {
        return this.requestJson(`models/${encodeURIComponent(profileId)}/activate`, {method: 'POST'}, true);
    }

    public testModel(profile: ModelProfileInput): Promise<unknown> {
        return this.requestJson('models/test', this.jsonRequest('POST', profile), true, profile);
    }

    public async testConnection(): Promise<{status: ConnectionTestStatus; adminAuthorized: boolean}> {
        let connectivity: Response;
        try {
            connectivity = await this.options.fetch(this.apiUrl('model-config/'), {method: 'GET'});
        } catch {
            return {status: 'unreachable', adminAuthorized: false};
        }
        if (!connectivity.ok) {
            return {status: connectivity.status === 401 || connectivity.status === 403 ? 'unauthorized' : 'unreachable', adminAuthorized: false};
        }
        try {
            const management = await this.options.fetch(this.apiUrl('models/'), {
                method: 'GET', headers: this.managementHeaders(),
            });
            if (management.ok) return {status: 'connected', adminAuthorized: true};
            if (management.status === 401 || management.status === 403) {
                return {status: 'unauthorized', adminAuthorized: false};
            }
            return {status: 'unreachable', adminAuthorized: false};
        } catch {
            return {status: 'unreachable', adminAuthorized: false};
        }
    }

    public async *streamChat(request: ChatRequest, sink?: ChatEventSink): AsyncGenerator<ChatStreamEvent> {
        if (!request.requestId.trim() || !request.content.trim() || request.signal?.aborted) return;
        const response = await this.fetchResponse('chat/', {
            ...this.jsonRequest('POST', {content: request.content.trim()}),
            signal: request.signal,
        }, false);
        if (!response.body) throw new RemoteApiError('Remote chat stream is unavailable', response.status);
        for await (const parsed of parseSseChunks(readResponseBody(response.body), request.signal)) {
            if (request.signal?.aborted) return;
            const event: ChatStreamEvent = {
                requestId: request.requestId,
                type: parsed.type,
                ...(parsed.text ? {text: redactText(parsed.text, this.secrets)} : {}),
            };
            yield event;
            await sink?.(event);
            if (request.signal?.aborted || event.type === 'done') return;
        }
    }

    private jsonRequest(method: string, body: unknown): RequestInit {
        return {
            method,
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(body),
        };
    }

    private async requestJson(path: string, init: RequestInit, management: boolean, secretBody?: unknown): Promise<unknown> {
        const response = await this.fetchResponse(path, init, management, secretBody);
        if (response.status === 204) return undefined;
        try {
            return await response.json();
        } catch {
            throw new RemoteApiError('Remote server returned invalid JSON', response.status);
        }
    }

    private async fetchResponse(path: string, init: RequestInit, management: boolean, secretBody?: unknown): Promise<Response> {
        const headers = new Headers(init.headers);
        if (management) {
            for (const secret of extractKnownSecrets(secretBody)) this.secrets.push(secret);
            headers.set('Authorization', `Bearer ${this.options.adminToken}`);
        }
        let response: Response;
        try {
            response = await this.options.fetch(this.apiUrl(path), {...init, headers});
        } catch (error) {
            if (isAbort(error)) throw error;
            throw new RemoteApiError('Remote request is unreachable');
        }
        if (response.ok) return response;
        throw new RemoteApiError(await this.httpError(response), response.status);
    }

    private async httpError(response: Response): Promise<string> {
        let detail = '';
        try {
            const payload: unknown = await response.json();
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                const candidate = payload as Record<string, unknown>;
                if (typeof candidate.detail === 'string') detail = candidate.detail;
                else if (typeof candidate.message === 'string') detail = candidate.message;
            }
        } catch {
            // Server error bodies are optional and must never be surfaced raw.
        }
        const suffix = detail ? `: ${redactText(detail, this.secrets)}` : '';
        return `Remote request failed (${response.status})${suffix}`;
    }

    private managementHeaders(): Headers {
        return new Headers({Authorization: `Bearer ${this.options.adminToken}`});
    }

    private apiUrl(endpoint: string): string {
        return new URL(`api/${endpoint.replace(/^\/+/, '')}`, this.baseUrl).href;
    }
}

export async function* parseSseChunks(
    chunks: AsyncIterable<Uint8Array | string>,
    signal?: AbortSignal,
): AsyncGenerator<ParsedSseEvent> {
    const decoder = new TextDecoder();
    let buffered = '';
    let eventName = 'message';
    let dataLines: string[] = [];

    const dispatch = (): ParsedSseEvent | undefined => {
        if (!dataLines.length) return undefined;
        const data = dataLines.join('\n');
        const currentEvent = eventName;
        eventName = 'message';
        dataLines = [];
        if (currentEvent === 'done') return {type: 'done'};
        if (currentEvent === 'chunk') {
            const payload = parseSseJson(data);
            const text = payload && typeof payload.response === 'string' ? payload.response : undefined;
            return text ? {type: 'chunk', text} : undefined;
        }
        if (currentEvent === 'error') {
            const payload = parseSseJson(data);
            const text = payload && typeof payload.detail === 'string'
                ? payload.detail
                : payload && typeof payload.message === 'string'
                    ? payload.message
                    : 'Remote stream failed';
            return {type: 'error', text};
        }
        return undefined;
    };

    for await (const chunk of chunks) {
        if (signal?.aborted) return;
        buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true});
        while (true) {
            const newline = buffered.indexOf('\n');
            if (newline < 0) break;
            const line = buffered.slice(0, newline).replace(/\r$/, '');
            buffered = buffered.slice(newline + 1);
            if (!line) {
                const event = dispatch();
                if (event) yield event;
                continue;
            }
            if (line.startsWith(':')) continue;
            const separator = line.indexOf(':');
            const field = separator < 0 ? line : line.slice(0, separator);
            const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
            if (field === 'event') eventName = value;
            else if (field === 'data') dataLines.push(value);
        }
    }
}

async function* readResponseBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) return;
            if (value) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

function parseSseJson(value: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
        return undefined;
    }
}

function extractKnownSecrets(body: unknown): string[] {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    const profile = body as Record<string, unknown>;
    return ['api_key', 'adminToken', 'token'].flatMap((key) => typeof profile[key] === 'string' ? [profile[key] as string] : []);
}

function redactText(value: string, secrets: readonly string[]): string {
    let safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
    for (const secret of secrets) {
        if (secret) safe = safe.split(secret).join('[redacted]');
    }
    safe = safe
        .replace(/\b(?:authorization|api[_-]?key|token|password|secret|encryptedConnection)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi, '[redacted]')
        .replace(/\bBearer\s+[^\s,}\]]+/gi, 'Bearer [redacted]')
        .replace(/\b[\w-]*(?:api[_-]?key|token|secret)[\w-]*\b/gi, '[redacted]')
        .replace(/[?&](?:authorization|api[_-]?key|token|password|secret)=[^&\s]+/gi, '?[redacted]');
    return safe.slice(0, 512) || 'Remote server reported an error';
}

function isAbort(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}
