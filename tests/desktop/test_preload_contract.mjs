import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');

test('preload exports one fixed nested Meeting Monster API', () => {
    const source = read('desktop', 'src', 'preload', 'index.ts');
    const exposedNamespaces = [...source.matchAll(
        /\bcontextBridge\.exposeInMainWorld\s*\(\s*'([^']+)'/g,
    )].map((match) => match[1]);

    assert.equal(exposedNamespaces.length, 1);
    assert.deepEqual(exposedNamespaces, ['meetingMonster']);
    assert.match(source, /contextBridge\.exposeInMainWorld\('meetingMonster', meetingMonster\)/);
    assert.match(source, /window:\s*\{/);
    assert.match(source, /privacy:\s*\{/);
    assert.match(source, /onState: \(callback: \(state: WindowState\) => void\)/);
    assert.match(source, /onStatus: \(callback: \(status: PrivacyStatus\) => void\)/);
    assert.doesNotMatch(source, /monsterOfferPrivacy|meetingMonsterDesktop/);
    assert.doesNotMatch(source, /send\s*:\s*ipcRenderer|invoke\s*:\s*ipcRenderer|on\s*:\s*ipcRenderer/);
    assert.doesNotMatch(source, /exposeInMainWorld\([^,]+,\s*\{[^}]*ipcRenderer/s);
});

test('shared contracts reserve typed IPC channel families for later desktop work', () => {
    const source = read('desktop', 'src', 'shared', 'contracts.ts');

    assert.match(source, /export const IPC_CHANNELS/);
    for (const family of ['window', 'privacy', 'settings', 'models', 'chat', 'asr']) {
        assert.match(source, new RegExp(`${family}:`));
    }
    assert.match(source, /export type IpcChannel/);
    assert.match(source, /export interface MeetingMonsterApi/);
});
