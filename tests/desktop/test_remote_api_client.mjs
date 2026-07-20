import test from 'node:test';
import assert from 'node:assert/strict';

const CLIENT_MODULE = '../../desktop/dist/main/remote-api-client.js';
const encoder = new TextEncoder();

async function loadClientModule() {
    return import(CLIENT_MODULE);
}

function sseResponse(chunks, {status = 200, headers = {'content-type': 'text/event-stream'}} = {}) {
    let index = 0;
    return new Response(new ReadableStream({
        pull(controller) {
            if (index === chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[index++]));
        },
    }), {status, headers});
}

function header(headers, name) {
    return headers instanceof Headers ? headers.get(name) : headers?.[name];
}

const publicProfile = {
    id: 'demo', label: 'Demo', protocol: 'openai', base_url: 'https://provider.example.com/v1',
    model: 'demo-model', api_key_required: true, has_api_key: true, max_tokens: 2048,
    temperature: 0.2, active: true,
};

const selectableProfile = {
    id: 'demo', label: 'Demo', protocol: 'openai', model: 'demo-model',
    api_key_required: true, has_api_key: true, max_tokens: 2048, temperature: 0.2, active: true,
};

test('model selection uses the public backend catalog and sends only a profile id for chat', async () => {
    const {RemoteApiClient} = await loadClientModule();
    const calls = [];
    const client = new RemoteApiClient({
        baseUrl: 'http://127.0.0.1:9000',
        fetch: async (url, options = {}) => {
            calls.push({url: String(url), options});
            if (String(url).endsWith('/api/model-options/')) {
                return new Response(JSON.stringify({active_profile: 'demo', profiles: [selectableProfile]}), {status: 200});
            }
            return sseResponse(['event: done\ndata: {}\n\n']);
        },
    });

    assert.deepEqual(await client.listSelectableModels(), {active_profile: 'demo', profiles: [selectableProfile]});
    for await (const _event of client.streamChat({
        requestId: 'request-1', content: 'Question',
        modelSelection: {profile_id: 'demo'},
    })) {}

    assert.equal(header(calls[0].options.headers, 'Authorization'), null);
    assert.equal(calls[1].options.body, JSON.stringify({content: 'Question', profile_id: 'demo'}));
});

const modelInput = {
    id: 'demo', label: 'Demo', protocol: 'openai', base_url: 'https://provider.example.com/v1',
    model: 'demo-model', api_key: 'provider-secret', api_key_required: true, max_tokens: 2048, temperature: 0.2,
};

test('management CRUD uses safe API paths, methods, JSON bodies, and bearer authorization', async () => {
    const {RemoteApiClient} = await loadClientModule();
    const calls = [];
    let responseIndex = 0;
    const responses = [
        {active_profile: 'demo', profiles: [publicProfile]}, publicProfile, publicProfile, null,
        {active_profile: 'demo', profile: publicProfile}, {ok: true, latency_ms: 5, model: 'demo-model'},
    ];
    const fetch = async (url, options = {}) => {
        calls.push({url: String(url), options});
        const payload = responses[responseIndex++];
        return payload === null
            ? new Response(null, {status: 204})
            : new Response(JSON.stringify(payload), {status: 200});
    };
    const client = new RemoteApiClient({
        baseUrl: 'https://server.example.com/root/',
        adminToken: 'desktop-admin-token',
        fetch,
    });
    const profile = {...modelInput, id: 'demo/id'};

    await client.listModels();
    await client.createModel(profile);
    await client.updateModel(profile.id, profile);
    await client.deleteModel(profile.id);
    await client.activateModel(profile.id);
    await client.testModel(profile);

    assert.deepEqual(calls.map(({url, options}) => ({url, method: options.method, authorization: header(options.headers, 'Authorization')})), [
        {url: 'https://server.example.com/root/api/models/', method: 'GET', authorization: 'Bearer desktop-admin-token'},
        {url: 'https://server.example.com/root/api/models/', method: 'POST', authorization: 'Bearer desktop-admin-token'},
        {url: 'https://server.example.com/root/api/models/demo%2Fid', method: 'PUT', authorization: 'Bearer desktop-admin-token'},
        {url: 'https://server.example.com/root/api/models/demo%2Fid', method: 'DELETE', authorization: 'Bearer desktop-admin-token'},
        {url: 'https://server.example.com/root/api/models/demo%2Fid/activate', method: 'POST', authorization: 'Bearer desktop-admin-token'},
        {url: 'https://server.example.com/root/api/models/test', method: 'POST', authorization: 'Bearer desktop-admin-token'},
    ]);
    assert.equal(header(calls[1].options.headers, 'content-type'), 'application/json');
    assert.equal(calls[1].options.body, JSON.stringify(profile));
});

test('successful management responses only return public allowlisted DTO fields', async () => {
    const {RemoteApiClient} = await loadClientModule();
    const reflected = {
        ...publicProfile,
        api_key: 'provider-secret', encrypted_api_key: 'ciphertext', api_key_env: 'PROVIDER_API_KEY',
        Authorization: 'Bearer desktop-admin-token', nested: {token: 'nested-secret'},
    };
    const responses = [
        {active_profile: 'demo', profiles: [reflected], admin_token: 'desktop-admin-token'},
        reflected,
        reflected,
        {active_profile: 'demo', profile: reflected, authorization: 'Bearer desktop-admin-token'},
        {ok: true, latency_ms: 7, model: 'demo-model', api_key: 'provider-secret'},
    ];
    let index = 0;
    const client = new RemoteApiClient({
        baseUrl: 'https://server.example.com', adminToken: 'desktop-admin-token',
        fetch: async () => new Response(JSON.stringify(responses[index++]), {status: 200}),
    });

    const results = [
        await client.listModels(),
        await client.createModel(modelInput),
        await client.updateModel('demo', modelInput),
        await client.activateModel('demo'),
        await client.testModel(modelInput),
    ];

    assert.deepEqual(results, [
        {active_profile: 'demo', profiles: [publicProfile]}, publicProfile, publicProfile,
        {active_profile: 'demo', profile: publicProfile}, {ok: true, latency_ms: 7, model: 'demo-model'},
    ]);
    assert.doesNotMatch(JSON.stringify(results), /provider-secret|desktop-admin-token|encrypted_api_key|api_key_env|authorization|nested/i);
});

test('model inputs reject unknown fields and recursively redact nested reflected values', async () => {
    const {RemoteApiClient, collectStringValues, redactSensitiveText} = await loadClientModule();
    const client = new RemoteApiClient({
        baseUrl: 'https://server.example.com', adminToken: 'desktop-admin-token',
        fetch: async () => new Response('{}', {status: 200}),
    });
    assert.throws(
        () => client.createModel({...modelInput, extra_body: {api_key: 'nested-provider-secret'}}),
        /unsupported/i,
    );

    const reflected = redactSensitiveText(
        'provider failed with nested-provider-secret and Bearer nested-admin-token',
        collectStringValues({profile: {api_key: 'nested-provider-secret', credentials: ['nested-admin-token']}}),
    );
    assert.doesNotMatch(reflected, /nested-provider-secret|nested-admin-token/);
});

test('connection tests distinguish reachable, unauthorized, and unreachable states without credentials', async () => {
    const {RemoteApiClient} = await loadClientModule();
    const reachableCalls = [];
    const reachable = new RemoteApiClient({
        baseUrl: 'https://server.example.com',
        adminToken: 'desktop-admin-token',
        fetch: async (url, options = {}) => {
            reachableCalls.push({url: String(url), options});
            return new Response('{}', {status: 200});
        },
    });
    assert.deepEqual(await reachable.testConnection(), {status: 'connected', adminAuthorized: true});
    assert.equal(reachableCalls[0].url, 'https://server.example.com/api/model-config/');
    assert.equal(header(reachableCalls[0].options.headers, 'Authorization'), undefined);
    assert.equal(reachableCalls[1].url, 'https://server.example.com/api/models/');
    assert.equal(header(reachableCalls[1].options.headers, 'Authorization'), 'Bearer desktop-admin-token');

    const unauthorized = new RemoteApiClient({
        baseUrl: 'https://server.example.com', adminToken: 'desktop-admin-token',
        fetch: async (_url, options = {}) => new Response('{}', {status: header(options.headers, 'Authorization') ? 403 : 200}),
    });
    assert.deepEqual(await unauthorized.testConnection(), {status: 'unauthorized', adminAuthorized: false});

    const unreachable = new RemoteApiClient({
        baseUrl: 'https://server.example.com', adminToken: 'desktop-admin-token',
        fetch: async () => { throw new Error('fetch https://server.example.com?token=desktop-admin-token failed'); },
    });
    assert.deepEqual(await unreachable.testConnection(), {status: 'unreachable', adminAuthorized: false});
});

test('streamChat parses fragmented CRLF SSE chunks and never sends management authorization to chat', async () => {
    const {RemoteApiClient} = await loadClientModule();
    let seenOptions;
    const client = new RemoteApiClient({
        baseUrl: 'https://server.example.com',
        adminToken: 'desktop-admin-token',
        fetch: async (_url, options = {}) => {
            seenOptions = options;
            return sseResponse([
                ': keepalive\r\n\r\nevent: chunk\r\ndata: {"response":"Hel',
                'lo"}\r\n\r\nevent: chunk\r\ndata: {"response":" world"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n',
            ]);
        },
    });
    const callbackEvents = [];
    const streamed = [];
    for await (const event of client.streamChat(
        {requestId: 'request-1', content: 'What is private?'},
        async (event) => callbackEvents.push(event),
    )) {
        streamed.push(event);
    }

    assert.deepEqual(streamed, [
        {requestId: 'request-1', type: 'chunk', text: 'Hello'},
        {requestId: 'request-1', type: 'chunk', text: ' world'},
        {requestId: 'request-1', type: 'done'},
    ]);
    assert.deepEqual(callbackEvents, streamed);
    assert.equal(header(seenOptions.headers, 'Authorization'), null);
    assert.equal(seenOptions.body, JSON.stringify({content: 'What is private?'}));
});

test('streamChat forwards sanitized SSE errors and stops on AbortSignal cancellation', async () => {
    const {RemoteApiClient} = await loadClientModule();
    const controller = new AbortController();
    let seenSignal;
    const client = new RemoteApiClient({
        baseUrl: 'https://server.example.com',
        adminToken: 'desktop-admin-token',
        fetch: async (_url, options = {}) => {
            seenSignal = options.signal;
            return sseResponse([
                'event: chunk\ndata: {"response":"first"}\n\n',
                'event: error\ndata: {"detail":"provider-secret rejected api_key=provider-secret"}\n\n',
                'event: done\ndata: {}\n\n',
            ]);
        },
    });
    const events = [];
    for await (const event of client.streamChat({
        requestId: 'request-2', content: 'Question', signal: controller.signal,
    }, (event) => {
        if (event.type === 'chunk') controller.abort();
    })) {
        events.push(event);
    }
    assert.deepEqual(events, [{requestId: 'request-2', type: 'chunk', text: 'first'}]);
    assert.equal(seenSignal, controller.signal);

    const errorEvents = [];
    for await (const event of client.streamChat({requestId: 'request-3', content: 'Question'})) {
        errorEvents.push(event);
    }
    assert.deepEqual(errorEvents.map((event) => event.type), ['chunk', 'error', 'done']);
    assert.doesNotMatch(errorEvents[1].text, /provider-secret|api_key/i);
});

test('HTTP errors redact known and structured secrets from errors', async () => {
    const {RemoteApiClient} = await loadClientModule();
    const client = new RemoteApiClient({
        baseUrl: 'https://server.example.com',
        adminToken: 'desktop-admin-token',
        fetch: async () => new Response(JSON.stringify({
            detail: 'Bearer desktop-admin-token rejected api_key=provider-secret',
        }), {status: 403}),
    });

    await assert.rejects(client.createModel(modelInput), (error) => {
        assert.doesNotMatch(String(error.message), /desktop-admin-token|provider-secret|authorization|api_key/i);
        assert.match(String(error.message), /request failed/i);
        return true;
    });
});
