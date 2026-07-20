export type RemoteFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type ConnectionTestStatus = 'connected' | 'unauthorized' | 'unreachable';

export interface RemoteApiClientOptions {
    baseUrl: string;
    adminToken?: string;
    fetch: RemoteFetch;
}

export interface ModelSelectionInput {
    profile_id: string;
    api_key?: string;
    max_tokens?: number;
    temperature?: number | null;
}

export interface ChatRequest {
    requestId: string;
    content: string;
    modelSelection?: ModelSelectionInput;
    signal?: AbortSignal;
}

export interface ChatStreamEvent {
    requestId: string;
    type: 'chunk' | 'done' | 'error';
    text?: string;
}

export type ChatEventSink = (event: ChatStreamEvent) => void | Promise<void>;
export type ModelProfileInput = Record<string, unknown>;

export interface PublicModelProfile {
    id: string;
    label: string;
    protocol: 'openai' | 'anthropic';
    base_url: string;
    model: string;
    api_key_required: boolean;
    has_api_key: boolean;
    max_tokens: number;
    temperature: number | null;
    active: boolean;
}

export interface SelectableModelProfile {
    id: string;
    label: string;
    protocol: 'openai' | 'anthropic';
    model: string;
    api_key_required: boolean;
    has_api_key: boolean;
    max_tokens: number;
    temperature: number | null;
    active: boolean;
}

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
    private readonly secrets: Set<string>;

    public constructor(private readonly options: RemoteApiClientOptions) {
        this.baseUrl = new URL(options.baseUrl);
        this.baseUrl.search = '';
        this.baseUrl.hash = '';
        if (!this.baseUrl.pathname.endsWith('/')) this.baseUrl.pathname += '/';
        this.secrets = new Set(options.adminToken ? [options.adminToken] : []);
    }

    public listSelectableModels(): Promise<{active_profile: string; profiles: SelectableModelProfile[]}> {
        return this.requestJson('model-options/', {method: 'GET'}, false, undefined, parseSelectableModelList);
    }

    public testSelectedModel(selection: ModelSelectionInput): Promise<{ok: boolean; latency_ms: number; model: string}> {
        const validated = validateModelSelectionInput(selection);
        return this.requestJson('model-test/', this.jsonRequest('POST', validated), false, validated, parseModelTest);
    }

    public listModels(): Promise<{active_profile: string; profiles: PublicModelProfile[]}> {
        return this.requestJson('models/', {method: 'GET'}, true, undefined, parseModelList);
    }

    public createModel(profile: ModelProfileInput): Promise<PublicModelProfile> {
        const validated = validateModelProfileInput(profile);
        return this.requestJson('models/', this.jsonRequest('POST', validated), true, validated, parsePublicModelProfile);
    }

    public updateModel(profileId: string, profile: ModelProfileInput): Promise<PublicModelProfile> {
        const validated = validateModelProfileInput(profile);
        return this.requestJson(`models/${encodeURIComponent(profileId)}`, this.jsonRequest('PUT', validated), true, validated, parsePublicModelProfile);
    }

    public async deleteModel(profileId: string): Promise<void> {
        await this.requestJson(`models/${encodeURIComponent(profileId)}`, {method: 'DELETE'}, true, undefined, parseNoContent);
    }

    public activateModel(profileId: string): Promise<{active_profile: string; profile: PublicModelProfile}> {
        return this.requestJson(`models/${encodeURIComponent(profileId)}/activate`, {method: 'POST'}, true, undefined, parseActivation);
    }

    public testModel(profile: ModelProfileInput): Promise<{ok: boolean; latency_ms: number; model: string}> {
        const validated = validateModelProfileInput(profile);
        return this.requestJson('models/test', this.jsonRequest('POST', validated), true, validated, parseModelTest);
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
        const body = {
            content: request.content.trim(),
            ...(request.modelSelection ? validateModelSelectionInput(request.modelSelection) : {}),
        };
        const response = await this.fetchResponse('chat/', {
            ...this.jsonRequest('POST', body),
            signal: request.signal,
        }, false, body);
        if (!response.body) throw new RemoteApiError('Remote chat stream is unavailable', response.status);
        for await (const parsed of parseSseChunks(readResponseBody(response.body), request.signal)) {
            if (request.signal?.aborted) return;
            const event: ChatStreamEvent = {
                requestId: request.requestId,
                type: parsed.type,
                ...(parsed.text ? {text: redactSensitiveText(parsed.text, this.secrets)} : {}),
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

    private async requestJson<T>(
        path: string,
        init: RequestInit,
        management: boolean,
        secretBody: unknown,
        parse: (payload: unknown) => T,
    ): Promise<T> {
        const response = await this.fetchResponse(path, init, management, secretBody);
        if (response.status === 204) return parse(undefined);
        try {
            return parse(await response.json());
        } catch {
            throw new RemoteApiError('Remote server returned an invalid management response', response.status);
        }
    }

    private async fetchResponse(path: string, init: RequestInit, management: boolean, secretBody?: unknown): Promise<Response> {
        const headers = new Headers(init.headers);
        for (const secret of collectStringValues(secretBody)) this.secrets.add(secret);
        if (management) {
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
        const suffix = detail ? `: ${redactSensitiveText(detail, this.secrets)}` : '';
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

export function collectStringValues(value: unknown): string[] {
    const strings = new Set<string>();
    const visited = new Set<object>();
    const visit = (candidate: unknown): void => {
        if (typeof candidate === 'string') {
            strings.add(candidate);
        } else if (candidate && typeof candidate === 'object' && !visited.has(candidate)) {
            visited.add(candidate);
            for (const item of Array.isArray(candidate) ? candidate : Object.values(candidate)) visit(item);
        }
    };
    visit(value);
    return [...strings];
}

export function redactSensitiveText(value: string, secrets: Iterable<string>): string {
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

const MODEL_INPUT_FIELDS = new Set([
    'id', 'label', 'protocol', 'base_url', 'model', 'api_key', 'api_key_required', 'max_tokens', 'temperature',
]);

export function validateModelProfileInput(value: unknown): ModelProfileInput {
    const input = requireObject(value, 'Model profile input');
    for (const key of Object.keys(input)) {
        if (!MODEL_INPUT_FIELDS.has(key)) throw new TypeError(`Model profile field is unsupported: ${key}`);
    }
    for (const key of ['id', 'label', 'protocol', 'base_url', 'model']) {
        if (typeof input[key] !== 'string' || !input[key].trim()) throw new TypeError(`Model profile field is invalid: ${key}`);
    }
    if (input.protocol !== 'openai' && input.protocol !== 'anthropic') throw new TypeError('Model profile field is invalid: protocol');
    if ('api_key' in input && typeof input.api_key !== 'string') throw new TypeError('Model profile field is invalid: api_key');
    if (typeof input.api_key_required !== 'boolean') throw new TypeError('Model profile field is invalid: api_key_required');
    if (!Number.isInteger(input.max_tokens) || (input.max_tokens as number) <= 0) throw new TypeError('Model profile field is invalid: max_tokens');
    if (input.temperature !== null && (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature))) {
        throw new TypeError('Model profile field is invalid: temperature');
    }
    return Object.fromEntries(Object.entries(input).filter(([key]) => MODEL_INPUT_FIELDS.has(key)));
}

export function validateModelSelectionInput(value: unknown): ModelSelectionInput {
    const input = requireObject(value, 'Model selection input');
    const allowed = new Set(['profile_id', 'api_key', 'max_tokens', 'temperature']);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw new TypeError(`Model selection field is unsupported: ${key}`);
    }
    if (typeof input.profile_id !== 'string' || !input.profile_id.trim()) {
        throw new TypeError('Model selection field is invalid: profile_id');
    }
    if ('api_key' in input && typeof input.api_key !== 'string') {
        throw new TypeError('Model selection field is invalid: api_key');
    }
    if ('max_tokens' in input && (!Number.isInteger(input.max_tokens) || (input.max_tokens as number) <= 0)) {
        throw new TypeError('Model selection field is invalid: max_tokens');
    }
    if ('temperature' in input && input.temperature !== null
        && (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature))) {
        throw new TypeError('Model selection field is invalid: temperature');
    }
    return Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined)) as unknown as ModelSelectionInput;
}

function parseModelList(value: unknown): {active_profile: string; profiles: PublicModelProfile[]} {
    const payload = requireObject(value, 'Model list response');
    if (typeof payload.active_profile !== 'string') throw new TypeError('Model list response is invalid');
    if (!Array.isArray(payload.profiles)) throw new TypeError('Model list response is invalid');
    return {active_profile: payload.active_profile, profiles: payload.profiles.map(parsePublicModelProfile)};
}

function parseSelectableModelList(value: unknown): {active_profile: string; profiles: SelectableModelProfile[]} {
    const payload = requireObject(value, 'Model options response');
    if (typeof payload.active_profile !== 'string' || !Array.isArray(payload.profiles)) {
        throw new TypeError('Model options response is invalid');
    }
    return {active_profile: payload.active_profile, profiles: payload.profiles.map(parseSelectableModelProfile)};
}

function parseActivation(value: unknown): {active_profile: string; profile: PublicModelProfile} {
    const payload = requireObject(value, 'Model activation response');
    if (typeof payload.active_profile !== 'string') throw new TypeError('Model activation response is invalid');
    return {active_profile: payload.active_profile, profile: parsePublicModelProfile(payload.profile)};
}

function parseModelTest(value: unknown): {ok: boolean; latency_ms: number; model: string} {
    const payload = requireObject(value, 'Model test response');
    if (typeof payload.ok !== 'boolean' || !Number.isInteger(payload.latency_ms) || (payload.latency_ms as number) < 0 || typeof payload.model !== 'string') {
        throw new TypeError('Model test response is invalid');
    }
    return {ok: payload.ok, latency_ms: payload.latency_ms as number, model: payload.model};
}

function parseNoContent(value: unknown): void {
    if (value !== undefined) throw new TypeError('Model delete response is invalid');
}

function parsePublicModelProfile(value: unknown): PublicModelProfile {
    const payload = requireObject(value, 'Model profile response');
    if (
        typeof payload.id !== 'string' || typeof payload.label !== 'string'
        || (payload.protocol !== 'openai' && payload.protocol !== 'anthropic')
        || typeof payload.base_url !== 'string' || typeof payload.model !== 'string'
        || typeof payload.api_key_required !== 'boolean' || typeof payload.has_api_key !== 'boolean'
        || !Number.isInteger(payload.max_tokens) || (payload.max_tokens as number) <= 0
        || (payload.temperature !== null && (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature)))
        || typeof payload.active !== 'boolean'
    ) throw new TypeError('Model profile response is invalid');
    return {
        id: payload.id, label: payload.label, protocol: payload.protocol, base_url: payload.base_url, model: payload.model,
        api_key_required: payload.api_key_required, has_api_key: payload.has_api_key, max_tokens: payload.max_tokens as number,
        temperature: payload.temperature as number | null, active: payload.active,
    };
}

function parseSelectableModelProfile(value: unknown): SelectableModelProfile {
    const payload = requireObject(value, 'Selectable model profile response');
    if (
        typeof payload.id !== 'string' || typeof payload.label !== 'string'
        || (payload.protocol !== 'openai' && payload.protocol !== 'anthropic')
        || typeof payload.model !== 'string' || typeof payload.api_key_required !== 'boolean'
        || typeof payload.has_api_key !== 'boolean' || !Number.isInteger(payload.max_tokens)
        || (payload.temperature !== null && (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature)))
        || typeof payload.active !== 'boolean'
    ) throw new TypeError('Selectable model profile response is invalid');
    return {
        id: payload.id,
        label: payload.label,
        protocol: payload.protocol,
        model: payload.model,
        api_key_required: payload.api_key_required,
        has_api_key: payload.has_api_key,
        max_tokens: payload.max_tokens as number,
        temperature: payload.temperature as number | null,
        active: payload.active,
    };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
    return value as Record<string, unknown>;
}
