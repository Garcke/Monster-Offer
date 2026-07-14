import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('../static/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../static/styles.css', import.meta.url), 'utf8');
const scripts = await readFile(new URL('../static/scripts.js', import.meta.url), 'utf8');

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

test('Monster Offer branding provides a visible logo and browser icon', () => {
    assert.match(html, /<title>Monster Offer<\/title>/);
    assert.match(html, /rel="icon"[^>]*href="favicon\.png"/);
    assert.match(html, /class="brand-logo"[^>]*src="favicon\.png"/);
    assert.match(html, /<h1>Monster Offer<\/h1>/);
    assert.match(css, /\.brand-logo\s*\{/);
});
