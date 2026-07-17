import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(projectRoot, 'desktop', 'preload.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(projectRoot, 'web', 'index.html'), 'utf8');
const modeSource = fs.readFileSync(path.join(projectRoot, 'web', 'floating_mode.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(projectRoot, 'web', 'styles.css'), 'utf8');

test('main process owns capsule and expanded window sizes', () => {
    assert.match(mainSource, /CAPSULE_BOUNDS = \{width: 360, height: 56\}/);
    assert.match(mainSource, /EXPANDED_BOUNDS = \{width: 720, height: 520\}/);
    assert.match(mainSource, /setWindowMode\(/);
    assert.match(mainSource, /privacy:set-capture-protection/);
    assert.doesNotMatch(mainSource, /privacy:set-redacted|toggleRedacted/);
    assert.match(mainSource, /globalShortcut\.register\('CommandOrControl\+Shift\+M'/);
});

test('preload exposes window mode controls without exposing Electron internals', () => {
    assert.match(preloadSource, /meetingMonsterDesktop/);
    assert.match(preloadSource, /getWindowState/);
    assert.match(preloadSource, /setExpanded/);
    assert.match(preloadSource, /hideWindow/);
    assert.match(preloadSource, /showWindow/);
    assert.match(preloadSource, /onWindowState/);
    assert.match(preloadSource, /setCaptureProtection/);
    assert.doesNotMatch(preloadSource, /setRedacted/);
});

test('renderer contains capsule controls and mode synchronization', () => {
    assert.match(htmlSource, /id="floatingCapsule"/);
    assert.doesNotMatch(htmlSource, /class="capsule-brand"/);
    assert.match(htmlSource, /id="capsuleProtectionToggle"/);
    assert.doesNotMatch(htmlSource, /privacyRedactionShield|privacyToggleButton|开启脱敏/);
    assert.match(htmlSource, /id="floatingExpandButton"/);
    assert.match(htmlSource, /id="floatingHideButton"/);
    assert.match(htmlSource, /id="capsuleProtectionToggle"/);
    assert.match(htmlSource, /floating_mode\.js/);
    assert.match(modeSource, /floating-capsule/);
    assert.match(modeSource, /floating-expanded/);
});

test('privacy renderer controls content protection without a redaction overlay', () => {
    const privacySource = fs.readFileSync(path.join(projectRoot, 'web', 'privacy_mode.js'), 'utf8');
    assert.match(privacySource, /setCaptureProtection/);
    assert.match(privacySource, /capsuleProtectionToggle/);
    assert.doesNotMatch(privacySource, /setRedacted|privacy-redacted|privacyRedactionShield/);
});

test('capsule uses a transparent shell and readable glass panel', () => {
    assert.match(stylesSource, /\.floating-capsule/);
    assert.match(stylesSource, /\.floating-expanded/);
    assert.match(stylesSource, /min-width:\s*360px/);
    assert.match(stylesSource, /min-width:\s*720px/);
    assert.match(stylesSource, /backdrop-filter:\s*blur/);
    assert.match(stylesSource, /background:\s*rgba\(255,\s*255,\s*255,\s*0\.9/);
});
