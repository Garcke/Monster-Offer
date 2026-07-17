import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagePath = path.join(projectRoot, 'desktop', 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

test('electron-builder packages only the desktop runtime and explicit unsigned targets', () => {
    assert.deepEqual(pkg.build.files, ['dist/**/*', 'renderer/**/*', 'package.json']);
    assert.equal(pkg.dependencies?.['sherpa-onnx-node'], undefined);
    assert.equal(pkg.devDependencies?.['sherpa-onnx-node'], undefined);
    assert.equal(pkg.build.asarUnpack, undefined);
    assert.equal(pkg.build.extraResources, undefined);
    assert.equal(pkg.build.extraFiles, undefined);
    assert.match(pkg.build.nsis.artifactName, /Setup/);
    assert.match(pkg.build.portable.artifactName, /Portable/);
    assert.match(pkg.build.mac.artifactName, /Mac-Universal/);
    assert.deepEqual(pkg.build.win.target, [
        {target: 'nsis', arch: ['x64']},
        {target: 'portable', arch: ['x64']},
    ]);
    assert.deepEqual(pkg.build.mac.target, [
        {target: 'dmg', arch: ['universal']},
        {target: 'zip', arch: ['universal']},
    ]);
    assert.equal(pkg.devDependencies?.['@electron/asar'], '3.2.18');
    assert.equal(pkg.scripts['audit:package'], 'node ../tests/desktop/audit_packaged_artifact.mjs');

    for (const [name, command] of Object.entries(pkg.scripts)) {
        if (name.startsWith('dist')) assert.match(command, /^npm run build &&/);
    }
});
