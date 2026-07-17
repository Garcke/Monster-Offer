import test from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const preloadPath = path.join(projectRoot, 'desktop', 'dist', 'preload', 'index.js');

class FakePort {
    constructor() {
        this.closed = false;
        this.messages = [];
    }

    postMessage(data, transfer) {
        this.messages.push({data, transfer});
    }

    close() {
        this.closed = true;
    }
}

function loadPreload() {
    const listeners = new Map();
    const invocations = [];
    let invoke = async () => ({state: 'recording'});
    let exposed;
    const ipcRenderer = {
        on(channel, listener) {
            listeners.set(channel, listener);
            return this;
        },
        removeListener() {
            return this;
        },
        invoke(...args) {
            invocations.push(args);
            return invoke(...args);
        },
    };
    const originalLoad = Module._load;
    Module._load = (request, parent, isMain) => request === 'electron'
        ? {contextBridge: {exposeInMainWorld: (_name, api) => { exposed = api; }}, ipcRenderer}
        : originalLoad(request, parent, isMain);
    try {
        delete require.cache[preloadPath];
        require(preloadPath);
    } finally {
        Module._load = originalLoad;
    }
    return {
        api: exposed,
        invocations,
        setInvoke(handler) { invoke = handler; },
        deliver(port) { listeners.get('asr:port')({ports: [port]}); },
        deliverStatus(status) { listeners.get('asr:status')({}, status); },
    };
}

test('preload closes the private PCM port before delivering a remote ASR error status', async () => {
    const preload = loadPreload();
    const port = new FakePort();
    preload.deliver(port);
    await preload.api.asr.start(16000);
    let received;
    preload.api.asr.onStatus((status) => {
        received = status;
        assert.equal(port.closed, true);
    });

    preload.deliverStatus({state: 'error'});

    assert.deepEqual(received, {state: 'error'});
    assert.throws(() => preload.api.asr.writePcm(new Int16Array([1])), /ASR is not recording/);
});

test('preload closes the private PCM port before delivering a remote ASR idle status', async () => {
    const preload = loadPreload();
    const port = new FakePort();
    preload.deliver(port);
    await preload.api.asr.start(16000);
    let received;
    preload.api.asr.onStatus((status) => {
        received = status;
        assert.equal(port.closed, true);
    });

    preload.deliverStatus({state: 'idle'});

    assert.deepEqual(received, {state: 'idle'});
    assert.throws(() => preload.api.asr.writePcm(new Int16Array([1])), /ASR is not recording/);
});

test('preload closes the private PCM port after a successful stop', async () => {
    const preload = loadPreload();
    const port = new FakePort();
    preload.deliver(port);
    await preload.api.asr.start(16000);
    preload.api.asr.writePcm(new Int16Array([1]));
    preload.setInvoke(async (channel) => channel === 'asr:stop' ? {state: 'idle'} : {state: 'recording'});

    await preload.api.asr.stop();

    assert.equal(port.closed, true);
    assert.throws(() => preload.api.asr.writePcm(new Int16Array([1])), /ASR is not recording/);
    assert.deepEqual(Object.keys(preload.api.asr).sort(), ['getStatus', 'onResult', 'onStatus', 'start', 'stop', 'writePcm']);
});

test('preload closes the private PCM port after start or stop rejects', async () => {
    const startFailure = loadPreload();
    const startPort = new FakePort();
    startFailure.deliver(startPort);
    startFailure.setInvoke(async () => { throw new Error('start failed'); });

    await assert.rejects(startFailure.api.asr.start(16000), /start failed/);
    assert.equal(startPort.closed, true);
    assert.throws(() => startFailure.api.asr.writePcm(new Int16Array([1])), /ASR is not recording/);

    const stopFailure = loadPreload();
    const stopPort = new FakePort();
    stopFailure.deliver(stopPort);
    await stopFailure.api.asr.start(16000);
    stopFailure.setInvoke(async (channel) => {
        if (channel === 'asr:stop') throw new Error('stop failed');
        return {state: 'recording'};
    });

    await assert.rejects(stopFailure.api.asr.stop(), /stop failed/);
    assert.equal(stopPort.closed, true);
    assert.throws(() => stopFailure.api.asr.writePcm(new Int16Array([1])), /ASR is not recording/);
});
