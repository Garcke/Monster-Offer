import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('../static/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../static/styles.css', import.meta.url), 'utf8');
const scripts = await readFile(new URL('../static/scripts.js', import.meta.url), 'utf8');
const privacyScript = await readFile(new URL('../static/privacy_mode.js', import.meta.url), 'utf8');

test('desktop workspace exposes separate interview and answer panes', () => {
    assert.match(html, /class="workspace-grid"/);
    assert.match(html, /id="interviewPane"/);
    assert.match(html, /id="answerPane"/);
    assert.match(html, /id="transcriptList"/);
    assert.match(css, /grid-template-columns:\s*minmax\(330px,\s*34fr\)\s+minmax\(0,\s*66fr\)/);
    assert.match(css, /\.workspace-grid\s*\{[^}]*flex:\s*1;/s);
});

test('mobile layout provides tabs instead of stacked chat panes', () => {
    assert.match(html, /id="mobileTabs"/);
    assert.match(html, /data-panel="interview"/);
    assert.match(html, /data-panel="answer"/);
    assert.match(css, /@media\s*\(max-width:\s*900px\)/);
});

test('manual question composer and selected question controls are present', () => {
    assert.match(html, /id="manualInput"/);
    assert.match(html, /id="manualSendButton"/);
    assert.match(html, /id="selectedQuestionText"/);
    assert.match(html, /id="copyAnswerButton"/);
});

test('frontend uses the unified same-origin HTTP and WebSocket routes', () => {
    assert.match(scripts, /window\.location\.origin/);
    assert.match(scripts, /\/api/);
    assert.match(scripts, /\/ws\/asr/);
    assert.doesNotMatch(scripts, /localhost:2333|localhost:6220/);
});

test('Meeting-Monster branding provides a visible logo and browser icon', () => {
    assert.match(html, /<title>Meeting-Monster<\/title>/);
    assert.match(html, /rel="icon"[^>]*href="favicon\.png"/);
    assert.match(html, /class="brand-logo"[^>]*src="favicon\.png"/);
    assert.match(html, /<h1>Meeting-Monster<\/h1>/);
    assert.match(css, /\.brand-logo\s*\{/);
});

test('model configuration is server-owned and browser credentials are removed', () => {
    assert.match(html, /id="modelStatus"/);
    assert.doesNotMatch(html, /modelConfigButton|modelConfigModal|modelApiKey|modelBaseUrl/);
    assert.match(scripts, /\/model-config\//);
    assert.match(scripts, /JSON\.stringify\(\{content:\s*question\.text\}\)/);
    assert.doesNotMatch(
        scripts,
        /MODEL_CONFIG_STORAGE_KEY|localStorage|api_key|base_url|test_connection|models\/list/,
    );
    assert.doesNotMatch(css, /\.modal\s*\{|\.model-dropdown\s*\{|\.modal-field\s*\{/);
});

test('privacy controls and redaction shield are present', () => {
    assert.match(html, /id="privacyStatusBadge"/);
    assert.match(html, /id="privacyToggleButton"/);
    assert.match(html, /id="privacyRedactionShield"/);
    assert.match(css, /\.privacy-redaction-shield/);
    assert.match(privacyScript, /monsterOfferPrivacy/);
});
