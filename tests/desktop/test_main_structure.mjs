import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');

test('desktop has no Python sidecar and loads the local overlay renderer', () => {
    const source = read('desktop', 'src', 'main', 'main.ts');

    assert.doesNotMatch(source, /child_process|spawn\(|python|ensureServer|loadURL|fetch\(|https?:/i);
    assert.match(source, /loadFile\(path\.join\(__dirname, '\.\.', '\.\.', 'renderer', 'overlay\.html'\)\)/);
});

test('main preserves the secured floating window and its controls', () => {
    const source = read('desktop', 'src', 'main', 'main.ts');

    assert.match(source, /width: 360, height: 56/);
    assert.match(source, /width: 720, height: 520/);
    assert.match(source, /transparent: true/);
    assert.match(source, /frame: false/);
    assert.match(source, /hasShadow: false/);
    assert.match(source, /alwaysOnTop: true/);
    assert.match(source, /backgroundColor: '#00000000'/);
    assert.match(source, /contextIsolation: true/);
    assert.match(source, /nodeIntegration: false/);
    assert.match(source, /sandbox: false/);
    assert.match(source, /manager\.registerWindow\(mainWindow\)/);
    assert.match(source, /CommandOrControl\+Shift\+P/);
    assert.match(source, /CommandOrControl\+Shift\+M/);
    assert.match(source, /current\.x \+ Math\.round\(\(current\.width - target\.width\) \/ 2\)/);
    assert.match(source, /setWindowOpenHandler\(\(\) => \(\{action: 'deny'\}\)\)/);
    assert.match(source, /will-navigate[\s\S]*preventDefault\(\)/);
});

test('main IPC registration is sender-authorized and idempotent', () => {
    const source = read('desktop', 'src', 'main', 'main.ts');

    assert.match(source, /function isAuthorizedSender/);
    assert.match(source, /if \(!isAuthorizedSender\(event\)\) throw new Error\('Unauthorized/);
    assert.match(source, /ipcMain\.removeHandler\(/);
    assert.match(source, /if \(ipcHandlersRegistered\) return/);
});
