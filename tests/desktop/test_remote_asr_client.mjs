import test from 'node:test';
import assert from 'node:assert/strict';

const CLIENT_MODULE = '../../desktop/dist/main/remote-asr-client.js';

class FakeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
        super();
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.bufferedAmount = 0;
        this.sent = [];
        this.closeCalls = [];
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.dispatchEvent(new Event('open'));
    }

    receive(data) {
        this.dispatchEvent(new MessageEvent('message', {data}));
    }

    send(data) {
        this.sent.push(data);
    }

    close(code, reason) {
        this.closeCalls.push({code, reason});
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close', {code, reason}));
    }
}

async function loadClientModule() {
    return import(CLIENT_MODULE);
}

function createHarness({production = true} = {}) {
    const sockets = [];
    const statuses = [];
    const results = [];
    const timers = [];
    return {
        sockets,
        statuses,
        results,
        timers,
        options: {
            production,
            createWebSocket: (url) => {
                const socket = new FakeWebSocket(url);
                sockets.push(socket);
                return socket;
            },
            onStatus: (status) => statuses.push(status),
            onResult: (event) => results.push(event),
            setTimer: (callback, milliseconds) => {
                const timer = {callback, milliseconds, cleared: false};
                timers.push(timer);
                return timer;
            },
            clearTimer: (timer) => {
                timer.cleared = true;
            },
        },
    };
}

async function startRecording(Client, harness, sampleRate = 16000) {
    const client = new Client(harness.options);
    const pending = client.start('https://example.com/base/', sampleRate);
    const socket = harness.sockets[0];
    socket.open();
    await pending;
    return {client, socket};
}

test('derives only permitted remote ASR WebSocket URLs', async () => {
    const {deriveAsrWebSocketUrl} = await loadClientModule();

    assert.equal(deriveAsrWebSocketUrl('https://example.com/', true), 'wss://example.com/ws/asr');
    assert.equal(deriveAsrWebSocketUrl('https://example.com/base/', true), 'wss://example.com/base/ws/asr');
    assert.equal(deriveAsrWebSocketUrl('http://localhost:9000', true), 'ws://localhost:9000/ws/asr');
    assert.equal(deriveAsrWebSocketUrl('http://127.0.0.1:9000', true), 'ws://127.0.0.1:9000/ws/asr');
    assert.throws(() => deriveAsrWebSocketUrl('http://example.com', true), /HTTPS/);
    assert.throws(() => deriveAsrWebSocketUrl('https://user:pass@example.com', true), /credentials/);
    assert.throws(() => deriveAsrWebSocketUrl('https://example.com?a=1', true), /query/);
    assert.throws(() => deriveAsrWebSocketUrl('https://example.com/#x', true), /fragment/);
});

test('opens with audio configuration before PCM and preserves PCM bytes', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client, socket} = await startRecording(RemoteAsrClient, harness, 48000);
    const pcm = new Int16Array([17, -18, 19]);

    assert.equal(socket.sent[0], JSON.stringify({type: 'audio_config', sample_rate: 48000}));
    client.writePcm(pcm.buffer);
    assert.deepEqual(new Uint8Array(socket.sent[1]), new Uint8Array(pcm.buffer));
    assert.deepEqual(client.getStatus(), {state: 'recording'});
});

test('emits partial and final ASR result events', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {socket} = await startRecording(RemoteAsrClient, harness);

    socket.receive(JSON.stringify({text: 'hel', is_end: false}));
    socket.receive(JSON.stringify({text: 'hello', is_end: true}));

    assert.deepEqual(harness.results, [
        {type: 'partial', text: 'hel'},
        {type: 'final', text: 'hello'},
    ]);
});

test('server errors are sanitized and terminate the active session', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client, socket} = await startRecording(RemoteAsrClient, harness);

    socket.receive(JSON.stringify({event: 'error', message: 'token=private-secret'}));

    assert.deepEqual(client.getStatus(), {state: 'error', message: 'Remote ASR failed'});
    assert.deepEqual(harness.results.at(-1), {type: 'error', text: 'Remote ASR failed'});
    assert.doesNotMatch(JSON.stringify(harness.results), /private-secret/);
    assert.equal(socket.closeCalls.length, 1);
});

test('literal asr stopped completes an active stop', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client, socket} = await startRecording(RemoteAsrClient, harness);

    const stopped = client.stop();
    assert.equal(socket.sent.at(-1), 'stop');
    assert.equal(harness.timers[0].milliseconds, 5000);
    socket.receive('asr stopped');

    assert.deepEqual(await stopped, {state: 'idle'});
    assert.deepEqual(client.getStatus(), {state: 'idle'});
    assert.deepEqual(socket.closeCalls[0], {code: 1000, reason: 'ASR stopped'});
});

test('invalid server messages terminate with a protocol error', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client, socket} = await startRecording(RemoteAsrClient, harness);

    socket.receive('{not json');

    assert.deepEqual(client.getStatus(), {state: 'error', message: 'Remote ASR returned an invalid message'});
    assert.deepEqual(harness.results.at(-1), {type: 'error', text: 'Remote ASR returned an invalid message'});
});

test('rejects a second start while a session is active', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client} = await startRecording(RemoteAsrClient, harness);

    await assert.rejects(client.start('https://example.com', 16000), /ASR is already active/);
    assert.equal(harness.sockets.length, 1);
});

test('backpressure terminates the session without sending more PCM', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client, socket} = await startRecording(RemoteAsrClient, harness);
    socket.bufferedAmount = 1048577;

    assert.throws(() => client.writePcm(new Int16Array([1]).buffer), /network is slow/i);
    assert.deepEqual(client.getStatus(), {state: 'error', message: 'Remote ASR network is slow'});
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.closeCalls.length, 1);
});

test('stop timeout closes after 5000ms and reports a sanitized error', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client, socket} = await startRecording(RemoteAsrClient, harness);

    const stopped = client.stop();
    harness.timers[0].callback();

    await assert.rejects(stopped, /Remote ASR stop timed out/);
    assert.deepEqual(client.getStatus(), {state: 'error', message: 'Remote ASR stop timed out'});
    assert.deepEqual(socket.closeCalls[0], {code: 1000, reason: 'ASR stop timeout'});
});

test('unexpected close reports a generic network error and never reconnects', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client, socket} = await startRecording(RemoteAsrClient, harness);

    socket.close(1006, 'network failure');

    assert.deepEqual(client.getStatus(), {state: 'error', message: 'Remote ASR connection failed'});
    assert.deepEqual(harness.results.at(-1), {type: 'error', text: 'Remote ASR connection failed'});
    assert.equal(harness.sockets.length, 1);
});

test('dispose closes once and ignores later WebSocket callbacks', async () => {
    const {RemoteAsrClient} = await loadClientModule();
    const harness = createHarness();
    const {client, socket} = await startRecording(RemoteAsrClient, harness);

    client.dispose();
    socket.receive(JSON.stringify({text: 'ignored', is_end: false}));
    socket.dispatchEvent(new Event('error'));

    assert.deepEqual(client.getStatus(), {state: 'idle'});
    assert.equal(socket.closeCalls.length, 1);
    assert.deepEqual(harness.results, []);
});
