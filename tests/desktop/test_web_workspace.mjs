import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html = await readFile(new URL('../../web/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../../web/styles.css', import.meta.url), 'utf8');

test('browser entry keeps the classic workspace instead of the Electron overlay', () => {
    assert.match(html, /class="app-shell"/);
    assert.match(html, /class="workspace-grid"/);
    assert.match(html, /id="interviewPane"/);
    assert.match(html, /id="answerPane"/);
    assert.doesNotMatch(html, /floatingCapsule|floating-capsule|overlayRoot/);
    assert.doesNotMatch(css, /\.floating-capsule|\.floating-expanded/);
});
