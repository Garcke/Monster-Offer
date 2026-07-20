import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'main', 'main.ts'), 'utf8');
const stylesSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'renderer', 'overlay.css'), 'utf8');

test('Electron window is transparent, frameless, shadowless, and always on top', () => {
    assert.match(mainSource, /frame:\s*false/);
    assert.match(mainSource, /transparent:\s*true/);
    assert.match(mainSource, /hasShadow:\s*false/);
    assert.match(mainSource, /backgroundColor:\s*['"]#00000000['"]/);
    assert.match(mainSource, /alwaysOnTop:\s*true/);
});

test('Electron window enables and reasserts content protection', () => {
    assert.match(mainSource, /manager\.registerWindow\(mainWindow\)/);
    assert.match(mainSource, /manager\.reassertCaptureProtection\(\)/);
});

test('frameless window exposes a draggable header without dragging controls', () => {
    assert.match(stylesSource, /\.overlay-header\s*\{[\s\S]*-webkit-app-region:\s*drag/);
    assert.match(stylesSource, /\.overlay-actions\s*\{[\s\S]*-webkit-app-region:\s*no-drag/);
    assert.match(stylesSource, /\.overlay-button[^\{]*\{[\s\S]*-webkit-app-region:\s*no-drag/);
});
