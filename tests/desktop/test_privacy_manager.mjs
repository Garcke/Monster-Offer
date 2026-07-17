import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowPrivacyManager} from '../../desktop/dist/main/privacy-manager.js';

function fakeWindow({protectedState = true, throws = false, supported = true} = {}) {
    return {
        calls: 0,
        setContentProtection(enabled) {
            if (!supported) throw new Error('unsupported');
            this.calls += 1;
            if (throws) throw new Error('capture protection failed');
            this.protectedState = enabled;
        },
        isContentProtected() {
            return this.protectedState;
        },
        once() {},
    };
}

test('applies Electron content protection on registration', () => {
    const win = fakeWindow();
    const manager = new WindowPrivacyManager({platform: 'darwin'});

    manager.registerWindow(win);

    assert.equal(win.calls, 1);
    assert.equal(manager.getStatus().captureProtection, 'protected');
});

test('reports unsupported when the Electron capability is missing', () => {
    const win = {once() {}};
    const manager = new WindowPrivacyManager({platform: 'linux'});

    manager.registerWindow(win);

    assert.equal(manager.getStatus().captureProtection, 'unsupported');
});

test('reports failed when Electron content protection throws', () => {
    const manager = new WindowPrivacyManager({platform: 'win32'});

    manager.registerWindow(fakeWindow({throws: true}));

    assert.equal(manager.getStatus().captureProtection, 'failed');
});

test('reasserts content protection for every registered window', () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const manager = new WindowPrivacyManager({platform: 'win32'});
    manager.registerWindow(first);
    manager.registerWindow(second);
    first.calls = 0;
    second.calls = 0;

    manager.reassertCaptureProtection();

    assert.equal(first.calls, 1);
    assert.equal(second.calls, 1);
});

test('capture protection defaults on and can be toggled by the capsule', () => {
    const manager = new WindowPrivacyManager({platform: 'win32'});
    const win = fakeWindow();
    manager.registerWindow(win);

    assert.equal(manager.getStatus().captureProtection, 'protected');
    assert.equal('redaction' in manager.getStatus(), false);

    manager.setCaptureProtection(false);
    assert.equal(win.protectedState, false);
    assert.equal(manager.getStatus().captureProtection, 'disabled');

    manager.setCaptureProtection(true);
    assert.equal(win.protectedState, true);
    assert.equal(manager.getStatus().captureProtection, 'protected');
});
