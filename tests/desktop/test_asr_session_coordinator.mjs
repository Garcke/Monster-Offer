import test from 'node:test';
import assert from 'node:assert/strict';

const COORDINATOR_MODULE = '../../desktop/dist/main/asr-session-coordinator.js';

async function loadCoordinatorModule() {
    return import(COORDINATOR_MODULE);
}

class FakePort {
    constructor(actions) {
        this.actions = actions;
        this.closed = false;
        this.listener = null;
    }

    on(event, listener) {
        assert.equal(event, 'message');
        this.listener = listener;
    }

    start() {
        this.actions.push('port:start');
    }

    close() {
        this.closed = true;
        this.actions.push('port:close');
    }

    receive(data) {
        this.listener({data});
    }
}

function createHarness({loadConnection, writePcm} = {}) {
    const actions = [];
    const ports = [];
    const portErrors = [];
    const remoteStarts = [];
    const senders = [];
    return {
        actions,
        ports,
        portErrors,
        remoteStarts,
        senders,
        loadConnection: loadConnection ?? (async () => ({baseUrl: 'https://example.com'})),
        writePcm: writePcm ?? (() => undefined),
        createSender(name) {
            const sender = {
                name,
                live: true,
                postMessage(channel, _message, transferred) {
                    actions.push(`post:${channel}`);
                    assert.equal(transferred.length, 1);
                },
            };
            senders.push(sender);
            return sender;
        },
        async build() {
            const {AsrSessionCoordinator} = await loadCoordinatorModule();
            return new AsrSessionCoordinator({
                isAuthorizedSender: (sender) => sender.live,
                loadConnection: this.loadConnection,
                createPort: () => {
                    actions.push('port:create');
                    const input = new FakePort(actions);
                    ports.push(input);
                    return {input, output: {id: ports.length}};
                },
                startRemote: async (baseUrl, sampleRate) => {
                    actions.push('remote:start');
                    remoteStarts.push({baseUrl, sampleRate});
                    return {state: 'recording'};
                },
                writePcm: this.writePcm,
                onPortError: (sender) => portErrors.push(sender),
                portChannel: 'asr:port',
            });
        },
    };
}

test('close during connection loading leaves no owner or port and permits a later start', async () => {
    let resolveConnection;
    let firstLoad = true;
    const harness = createHarness({
        loadConnection: () => firstLoad
            ? new Promise((resolve) => {
                firstLoad = false;
                resolveConnection = resolve;
            })
            : Promise.resolve({baseUrl: 'https://example.com'}),
    });
    const coordinator = await harness.build();
    const closingSender = harness.createSender('closing');

    const firstStart = coordinator.start(closingSender, 16000);
    closingSender.live = false;
    resolveConnection({baseUrl: 'https://example.com'});

    await assert.rejects(firstStart, /Unauthorized ASR request/);
    assert.equal(harness.ports.length, 0);
    assert.equal(coordinator.isActive(), false);

    const nextSender = harness.createSender('next');
    assert.deepEqual(await coordinator.start(nextSender, 16000), {state: 'recording'});
    assert.equal(coordinator.isActive(), true);
    coordinator.endSession();
    assert.equal(coordinator.isActive(), false);
});

test('delivers the port before starting remote ASR', async () => {
    const harness = createHarness();
    const coordinator = await harness.build();
    const sender = harness.createSender('main');

    await coordinator.start(sender, 48000);

    assert.deepEqual(harness.actions.slice(0, 3), ['port:create', 'port:start', 'post:asr:port']);
    assert.equal(harness.actions[3], 'remote:start');
    assert.deepEqual(harness.remoteStarts, [{baseUrl: 'https://example.com', sampleRate: 48000}]);
});

test('remote terminal events release the owner and port for the next session', async () => {
    const harness = createHarness();
    const coordinator = await harness.build();
    const first = harness.createSender('first');

    await coordinator.start(first, 16000);
    coordinator.endSession();

    assert.equal(harness.ports[0].closed, true);
    assert.equal(coordinator.isActive(), false);
    await coordinator.start(harness.createSender('second'), 16000);
    coordinator.endSession();
    assert.equal(harness.ports[1].closed, true);
});

test('a PCM write failure closes the port, releases ownership, and reports a generic port failure', async () => {
    const harness = createHarness({writePcm: () => { throw new Error('private PCM detail'); }});
    const coordinator = await harness.build();
    const sender = harness.createSender('main');

    await coordinator.start(sender, 16000);
    harness.ports[0].receive(new ArrayBuffer(2));

    assert.equal(harness.ports[0].closed, true);
    assert.equal(coordinator.isActive(), false);
    assert.deepEqual(harness.portErrors, [sender]);
    await coordinator.start(harness.createSender('next'), 16000);
});
