import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = path.join(projectRoot, '.github', 'workflows', 'build-desktop.yml');

test('tag release workflow builds unsigned artifacts from the release directory', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /run: npm --prefix desktop run dist:win:unsigned/);
    assert.match(workflow, /run: npm --prefix desktop run dist:mac:unsigned/);
    assert.match(workflow, /path: desktop\/release\/\*\.exe/);
    assert.match(workflow, /desktop\/release\/\*\.dmg/);
    assert.match(workflow, /desktop\/release\/\*\.zip/);
    assert.doesNotMatch(workflow, /desktop\/dist\/\*\.(?:exe|dmg|zip)/);
    assert.doesNotMatch(workflow, /forceCodeSigning=true/);
});
