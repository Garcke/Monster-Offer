import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'main', 'main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'preload', 'index.ts'), 'utf8');
const contractsSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'shared', 'contracts.ts'), 'utf8');
const htmlSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'renderer', 'overlay.html'), 'utf8');
const modeSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'renderer', 'overlay.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'renderer', 'overlay.css'), 'utf8');

test('main process owns capsule and expanded window sizes', () => {
    assert.match(mainSource, /width: 360, height: 56/);
    assert.match(mainSource, /width: 720, height: 520/);
    assert.match(mainSource, /setWindowMode\(/);
    assert.match(contractsSource, /privacy:set-capture-protection/);
    assert.doesNotMatch(mainSource, /privacy:set-redacted|toggleRedacted/);
    assert.match(mainSource, /globalShortcut\.register\('CommandOrControl\+Shift\+M'/);
});

test('preload exposes window mode controls without exposing Electron internals', () => {
    assert.match(preloadSource, /'meetingMonster'/);
    assert.match(preloadSource, /getState/);
    assert.match(preloadSource, /setExpanded/);
    assert.match(preloadSource, /hide/);
    assert.match(preloadSource, /show/);
    assert.match(preloadSource, /onState/);
    assert.match(preloadSource, /setCaptureProtection/);
    assert.doesNotMatch(preloadSource, /setRedacted/);
});

test('Electron renderer contains capsule controls and mode synchronization', () => {
    assert.match(htmlSource, /id="overlayRoot"/);
    assert.match(htmlSource, /id="capsuleProtectionToggle"/);
    assert.match(htmlSource, /id="floatingExpandButton"/);
    assert.match(htmlSource, /id="floatingHideButton"/);
    assert.match(modeSource, /is-capsule/);
    assert.match(modeSource, /is-expanded/);
});

test('privacy renderer controls content protection without a redaction overlay', () => {
    assert.match(modeSource, /setCaptureProtection/);
    assert.match(htmlSource, /capsuleProtectionToggle/);
    assert.doesNotMatch(htmlSource, /privacyRedactionShield|privacyToggleButton/);
});

test('capsule uses a transparent shell and readable glass panel', () => {
    assert.match(stylesSource, /\.overlay-root/);
    assert.match(stylesSource, /\.overlay-root\.is-expanded/);
    assert.match(stylesSource, /backdrop-filter:\s*blur/);
    assert.match(stylesSource, /background:\s*var\(--overlay-bg\)/);
});
