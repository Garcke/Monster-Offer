import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const overlayHtmlPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay.html');
const overlayCssPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay.css');
const overlayJsPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay.js');
const sessionHelperPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay-session.js');

async function loadOverlaySessionHelper() {
    assert.ok(fs.existsSync(sessionHelperPath), 'overlay session helper must exist');
    const source = fs.readFileSync(sessionHelperPath, 'utf8');
    return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test('Electron overlay uses only the preload API for remote services', () => {
    const html = fs.readFileSync(overlayHtmlPath, 'utf8');
    const css = fs.readFileSync(overlayCssPath, 'utf8');
    const js = fs.readFileSync(overlayJsPath, 'utf8');

    assert.match(html, /id="overlayRoot"/);
    assert.match(html, /id="capsuleProtectionToggle"/);
    assert.match(html, /id="overlayStartButton"/);
    assert.match(html, /id="overlayAnswerButton"/);
    assert.match(html, /id="overlayComposer"/);
    assert.doesNotMatch(html, /https?:\/\/|marked(?:\.min)?\.js/i);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /id="overlaySettingsButton"/);
    assert.match(html, /id="overlaySettingsDrawer"/);
    assert.match(html, /id="overlayActiveModel"/);
    assert.match(html, /音频将发送到已配置的 Python 服务/);
    assert.doesNotMatch(html, /workspace-grid|privacyRedactionShield|privacyToggleButton/);
    assert.doesNotMatch(js, /\bfetch\s*\(|\bWebSocket\b|\/ws\/asr|API_BASE_URL/);
    assert.doesNotMatch(js, /marked|answer\.innerHTML\s*=\s*remote|globalThis\.marked/);
    assert.match(js, /meetingMonster\.chat\.send/);
    assert.match(js, /meetingMonster\.asr\.start/);
    assert.match(js, /meetingMonster\.asr\.writePcm/);
    assert.match(css, /white-space:\s*pre-wrap/);
});

test('Electron overlay retains the approved continuous semi-transparent glass shell', () => {
    const css = fs.readFileSync(overlayCssPath, 'utf8');

    assert.match(css, /--overlay-bg:\s*rgba\(13,\s*18,\s*28,\s*0\.56\)/);
    assert.match(css, /--overlay-header-bg:\s*rgba\(20,\s*26,\s*40,\s*0\.42\)/);
    assert.match(css, /--overlay-panel-start:\s*rgba\(17,\s*23,\s*35,\s*0\.34\)/);
    assert.match(css, /--overlay-panel-end:\s*rgba\(9,\s*13,\s*22,\s*0\.46\)/);
    assert.match(css, /-webkit-backdrop-filter:\s*blur\(24px\)\s+saturate\(145%\)/);
    assert.match(css, /backdrop-filter:\s*blur\(24px\)\s+saturate\(145%\)/);
    assert.match(css, /\.overlay-header\s*\{[\s\S]*?border-bottom/);
    assert.match(css, /\.overlay-header\s*\{[\s\S]*?background:\s*var\(--overlay-header-bg\)/);
    assert.match(css, /\.overlay-panel\s*\{[\s\S]*?var\(--overlay-panel-start\)[\s\S]*?var\(--overlay-panel-end\)/);
    assert.match(css, /\.settings-drawer\[hidden\]\s*\{\s*display:\s*none/);
    assert.doesNotMatch(css, /margin:\s*\d+px;\s*\/\* outer gap \*\//);
});

test('Electron main process loads the dedicated local overlay renderer', () => {
    const main = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'main', 'main.ts'), 'utf8');
    assert.doesNotMatch(main, /child_process|spawn\(|python|loadURL/);
    assert.match(main, /loadFile\(path\.join\(__dirname, '\.\.', '\.\.', 'renderer', 'overlay\.html'\)\)/);
});

test('replacement chat rejection does not clear the newer active request', async () => {
    const {isCurrentChatRequest} = await loadOverlaySessionHelper();
    const requestA = 'request-a';
    const requestB = 'request-b';
    let activeChatRequestId = requestA;

    activeChatRequestId = requestB;
    if (isCurrentChatRequest(activeChatRequestId, requestA)) activeChatRequestId = null;

    assert.equal(activeChatRequestId, requestB);
});

test('stream chunks keep their answer but do not render over another selected question', async () => {
    const {shouldRenderChatOutput} = await loadOverlaySessionHelper();
    const answerStore = {questionA: ''};
    const activeChatQuestionId = 'questionA';
    const selectedQuestionId = 'questionB';

    answerStore.questionA += 'first streamed chunk';
    const visibleAnswer = shouldRenderChatOutput(activeChatQuestionId, selectedQuestionId)
        ? answerStore.questionA
        : 'selected question B answer';

    assert.equal(answerStore.questionA, 'first streamed chunk');
    assert.equal(visibleAnswer, 'selected question B answer');
});

test('unload starts recorder cleanup before stopping ASR', async () => {
    const {stopRecorderBeforeAsr} = await loadOverlaySessionHelper();
    const calls = [];
    let finishRecorder;
    const recorder = {
        stop() {
            calls.push('recorder.stop');
            return new Promise((resolve) => { finishRecorder = resolve; });
        },
    };
    const asr = {stop() { calls.push('asr.stop'); return Promise.resolve(); }};

    const cleanup = stopRecorderBeforeAsr(recorder, asr);
    await Promise.resolve();
    assert.deepEqual(calls, ['recorder.stop']);
    finishRecorder();
    await cleanup;
    assert.deepEqual(calls, ['recorder.stop', 'asr.stop']);
});
