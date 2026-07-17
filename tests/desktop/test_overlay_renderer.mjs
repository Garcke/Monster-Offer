import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const overlayHtmlPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay.html');
const overlayCssPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay.css');
const overlayJsPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay.js');

test('Electron overlay page is a dedicated compact renderer', () => {
    const html = fs.readFileSync(overlayHtmlPath, 'utf8');
    const css = fs.readFileSync(overlayCssPath, 'utf8');
    const js = fs.readFileSync(overlayJsPath, 'utf8');

    assert.match(html, /id="overlayRoot"/);
    assert.match(html, /id="capsuleProtectionToggle"/);
    assert.match(html, /id="overlayStartButton"/);
    assert.match(html, /id="overlayAnswerButton"/);
    assert.match(html, /id="overlayComposer"/);
    assert.doesNotMatch(html, /workspace-grid|privacyRedactionShield|privacyToggleButton/);
    assert.match(css, /\.overlay-root/);
    assert.match(css, /\.overlay-root\.is-expanded/);
    assert.match(css, /\.overlay-header\s*\{[\s\S]*border-bottom/);
    assert.doesNotMatch(css, /margin:\s*\d+px;\s*\/\* outer gap \*\//);
    assert.match(js, /\/ws\/asr/);
    assert.match(js, /API_BASE_URL.*\/chat\//);
    assert.match(js, /PCMAudioRecorder/);
    assert.match(js, /ReadableStream|reader\.read/);
});

test('Electron overlay uses balanced semi-transparent glass layers', () => {
    const css = fs.readFileSync(overlayCssPath, 'utf8');

    assert.match(css, /--overlay-bg:\s*rgba\(13,\s*18,\s*28,\s*0\.56\)/);
    assert.match(css, /--overlay-header-bg:\s*rgba\(20,\s*26,\s*40,\s*0\.42\)/);
    assert.match(css, /--overlay-panel-start:\s*rgba\(17,\s*23,\s*35,\s*0\.34\)/);
    assert.match(css, /--overlay-panel-end:\s*rgba\(9,\s*13,\s*22,\s*0\.46\)/);
    assert.match(css, /-webkit-backdrop-filter:\s*blur\(24px\)\s+saturate\(145%\)/);
    assert.match(css, /backdrop-filter:\s*blur\(24px\)\s+saturate\(145%\)/);
    assert.match(css, /\.overlay-header\s*\{[\s\S]*?background:\s*var\(--overlay-header-bg\)/);
    assert.match(css, /\.overlay-panel\s*\{[\s\S]*?var\(--overlay-panel-start\)[\s\S]*?var\(--overlay-panel-end\)/);
});

test('Electron main process loads the dedicated local overlay renderer', () => {
    const main = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'main', 'main.ts'), 'utf8');
    assert.doesNotMatch(main, /child_process|spawn\(|python|loadURL/);
    assert.match(main, /loadFile\(path\.join\(__dirname, '\.\.', '\.\.', 'renderer', 'overlay\.html'\)\)/);
});
