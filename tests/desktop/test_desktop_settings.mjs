import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETTINGS_MODULE = '../../desktop/dist/main/desktop-settings.js';

function fakeSafeStorage({available = true, decryptError} = {}) {
    return {
        isEncryptionAvailable: () => available,
        encryptString(value) {
            return Buffer.from(`encrypted:${value}`, 'utf8');
        },
        decryptString(value) {
            if (decryptError) throw decryptError;
            const plaintext = Buffer.from(value).toString('utf8');
            if (!plaintext.startsWith('encrypted:')) throw new Error('ciphertext is invalid');
            return plaintext.slice('encrypted:'.length);
        },
    };
}

async function loadSettingsModule() {
    return import(SETTINGS_MODULE);
}

function temporarySettingsPath() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-monster-settings-'));
    return {directory, file: path.join(directory, 'desktop-settings.json')};
}

test('production allows HTTPS and exact local HTTP only', async () => {
    const {validateBackendUrl} = await loadSettingsModule();

    assert.equal(validateBackendUrl(' https://api.example.com/base/ ', true).href, 'https://api.example.com/base/');
    assert.equal(validateBackendUrl('http://localhost:9000', true).hostname, 'localhost');
    assert.equal(validateBackendUrl('http://127.0.0.1:9000', true).hostname, '127.0.0.1');
    assert.equal(validateBackendUrl('http://api.example.com', false).protocol, 'http:');
    for (const invalidUrl of [
        'http://api.example.com',
        'https://user:password@example.com',
        'https://api.example.com/?token=nope',
        'https://api.example.com/#fragment',
        'ftp://api.example.com',
        'not-a-url',
    ]) {
        assert.throws(() => validateBackendUrl(invalidUrl, true), Error);
    }
});

test('settings refuse plaintext fallback when safeStorage is unavailable', async () => {
    const {DesktopSettingsStore} = await loadSettingsModule();
    const temporary = temporarySettingsPath();
    const store = new DesktopSettingsStore({
        safeStorage: fakeSafeStorage({available: false}),
        settingsPath: temporary.file,
        production: true,
    });

    await assert.rejects(
        store.saveConnection({baseUrl: 'https://api.example.com', adminToken: 'desktop-admin-token'}),
        /encryption/i,
    );
    assert.equal(fs.existsSync(temporary.file), false);
    fs.rmSync(temporary.directory, {recursive: true, force: true});
});

test('settings atomically persist only encrypted connection state and expose a public status', async () => {
    const {DesktopSettingsStore} = await loadSettingsModule();
    const temporary = temporarySettingsPath();
    const connection = {baseUrl: 'https://api.example.com/root', adminToken: 'desktop-admin-token'};
    const store = new DesktopSettingsStore({
        safeStorage: fakeSafeStorage(),
        settingsPath: temporary.file,
        production: true,
    });

    assert.deepEqual(await store.loadStatus(), {configured: false, baseUrl: null});
    assert.deepEqual(await store.saveConnection(connection), {
        configured: true,
        baseUrl: 'https://api.example.com/root/',
    });
    const raw = fs.readFileSync(temporary.file, 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['encryptedConnection', 'version']);
    assert.doesNotMatch(raw, /desktop-admin-token|api\.example\.com|baseUrl|adminToken/);
    assert.equal(fs.existsSync(`${temporary.file}.tmp`), false);
    assert.deepEqual(await store.loadStatus(), {configured: true, baseUrl: 'https://api.example.com/root/'});
    assert.deepEqual(await store.loadConnection(), {
        baseUrl: 'https://api.example.com/root/',
        adminToken: 'desktop-admin-token',
    });

    await store.clearConnection();
    assert.deepEqual(await store.loadStatus(), {configured: false, baseUrl: null});
    assert.equal(fs.existsSync(temporary.file), false);
    fs.rmSync(temporary.directory, {recursive: true, force: true});
});

test('corrupt or undecryptable settings are cleared without leaking connection secrets', async () => {
    const {DesktopSettingsStore} = await loadSettingsModule();
    const temporary = temporarySettingsPath();
    fs.writeFileSync(
        temporary.file,
        JSON.stringify({version: 1, encryptedConnection: Buffer.from('not-encrypted desktop-admin-token').toString('base64')}),
    );
    const store = new DesktopSettingsStore({
        safeStorage: fakeSafeStorage({decryptError: new Error('desktop-admin-token cannot decrypt')}),
        settingsPath: temporary.file,
        production: true,
    });

    await assert.rejects(store.loadConnection(), (error) => {
        assert.doesNotMatch(String(error.message), /desktop-admin-token/);
        return true;
    });
    assert.equal(fs.existsSync(temporary.file), false);
    assert.deepEqual(await store.loadStatus(), {configured: false, baseUrl: null});
    fs.rmSync(temporary.directory, {recursive: true, force: true});
});

test('valid encrypted settings survive unavailable encryption and read failures', async () => {
    const {DesktopSettingsStore} = await loadSettingsModule();
    const temporary = temporarySettingsPath();
    const connection = {baseUrl: 'https://api.example.com', adminToken: 'desktop-admin-token'};
    const writer = new DesktopSettingsStore({
        safeStorage: fakeSafeStorage(), settingsPath: temporary.file, production: true,
    });
    await writer.saveConnection(connection);
    const original = fs.readFileSync(temporary.file);

    const encryptionUnavailable = new DesktopSettingsStore({
        safeStorage: fakeSafeStorage({available: false}), settingsPath: temporary.file, production: true,
    });
    assert.deepEqual(await encryptionUnavailable.loadStatus(), {configured: false, baseUrl: null});
    assert.deepEqual(fs.readFileSync(temporary.file), original);

    const readFailure = new DesktopSettingsStore({
        safeStorage: fakeSafeStorage(),
        settingsPath: temporary.file,
        production: true,
        fileSystem: {
            readFile: async () => { throw Object.assign(new Error('access denied'), {code: 'EACCES'}); },
        },
    });
    assert.deepEqual(await readFailure.loadStatus(), {configured: false, baseUrl: null});
    assert.deepEqual(fs.readFileSync(temporary.file), original);
    fs.rmSync(temporary.directory, {recursive: true, force: true});
});

test('valid encrypted settings survive safeStorage availability errors', async () => {
    const {DesktopSettingsStore} = await loadSettingsModule();
    const temporary = temporarySettingsPath();
    const writer = new DesktopSettingsStore({
        safeStorage: fakeSafeStorage(), settingsPath: temporary.file, production: true,
    });
    await writer.saveConnection({baseUrl: 'https://api.example.com', adminToken: 'desktop-admin-token'});
    const original = fs.readFileSync(temporary.file);

    const availabilityFailure = new DesktopSettingsStore({
        safeStorage: {
            ...fakeSafeStorage(),
            isEncryptionAvailable: () => { throw new Error('temporary safeStorage failure'); },
        },
        settingsPath: temporary.file,
        production: true,
    });

    assert.deepEqual(await availabilityFailure.loadStatus(), {configured: false, baseUrl: null});
    assert.deepEqual(fs.readFileSync(temporary.file), original);
    fs.writeFileSync(temporary.file, original);
    await assert.rejects(availabilityFailure.loadConnection(), /encryption|storage/i);
    assert.deepEqual(fs.readFileSync(temporary.file), original);
    fs.rmSync(temporary.directory, {recursive: true, force: true});
});
