import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const require = createRequire(path.join(projectRoot, 'desktop', 'package.json'));
const {createPackage, listPackage} = require('@electron/asar');
const forbiddenEntry = /(?:^|\/)(?:server|web|source|python|pyinstaller|models|docs|tests|\.git|\.venv)(?:\/|$)|\.(?:py|pyc|onnx|node|map)$|sherpa-onnx-node|download_asr_model/i;

function normalizeEntry(entry) {
    return entry.replaceAll('\\', '/').replace(/^\/+/, '');
}

function isAllowedEntry(entry) {
    return entry === 'package.json'
        || entry === 'dist'
        || entry.startsWith('dist/')
        || entry === 'renderer'
        || entry.startsWith('renderer/');
}

export async function auditPackagedArtifact(releaseDirectory = path.join(projectRoot, 'desktop', 'release')) {
    const asarPath = path.join(releaseDirectory, 'win-unpacked', 'resources', 'app.asar');
    if (!fs.existsSync(asarPath)) throw new Error(`Expected packaged ASAR at ${asarPath}`);

    const entries = (await listPackage(asarPath)).map(normalizeEntry);
    for (const entry of entries) {
        if (forbiddenEntry.test(entry)) throw new Error(`Forbidden packaged entry: ${entry}`);
        if (!isAllowedEntry(entry)) throw new Error(`Unexpected packaged entry: ${entry}`);
    }
    return entries;
}

function writeFixtureFile(root, relativePath, contents = '') {
    const filePath = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, contents);
}

async function createFixture(entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-monster-asar-'));
    const source = path.join(root, 'source');
    const release = path.join(root, 'release');
    const asarPath = path.join(release, 'win-unpacked', 'resources', 'app.asar');
    for (const entry of entries) writeFixtureFile(source, entry, entry === 'package.json' ? '{}' : 'fixture');
    fs.mkdirSync(path.dirname(asarPath), {recursive: true});
    await createPackage(source, asarPath);
    return {root, release};
}

if (process.env.NODE_TEST_CONTEXT) {
    test('artifact audit fails when the Windows app ASAR is absent', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-monster-missing-asar-'));
        try {
            await assert.rejects(auditPackagedArtifact(root), /Expected packaged ASAR/);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('artifact audit rejects a forbidden packaged fixture entry', async () => {
        const fixture = await createFixture(['package.json', 'dist/main/main.js', 'server/app.py']);
        try {
            await assert.rejects(auditPackagedArtifact(fixture.release), /Forbidden packaged entry: server(?:\/app\.py)?/);
        } finally {
            fs.rmSync(fixture.root, {recursive: true, force: true});
        }
    });

    for (const entry of [
        'dist/asr/model.onnx',
        'renderer/helper.py',
        'dist/native/addon.node',
        'dist/.venv/config',
    ]) {
        test(`artifact audit rejects ${entry} under an allowed root`, async () => {
            const fixture = await createFixture(['package.json', 'dist/main/main.js', entry]);
            try {
                await assert.rejects(auditPackagedArtifact(fixture.release), /Forbidden packaged entry/);
            } finally {
                fs.rmSync(fixture.root, {recursive: true, force: true});
            }
        });
    }

    for (const entry of [
        'dist/source/main.js',
        'renderer/SoUrCe/helper.js',
        'renderer/cache/module.pyc',
        'dist/PyInstaller/bootstrap.js',
        'renderer/python/launcher.js',
        'dist/web/index.html',
        'renderer/models/profile.json',
        'dist/docs/guide.txt',
        'renderer/tests/spec.js',
        'dist/.git/config',
        'renderer/bundle.map',
        'dist/sherpa-onnx-node/index.js',
        'renderer/download_asr_model.js',
    ]) {
        test(`artifact audit rejects the forbidden path ${entry}`, async () => {
            const fixture = await createFixture(['package.json', 'dist/main/main.js', entry]);
            try {
                await assert.rejects(auditPackagedArtifact(fixture.release), /Forbidden packaged entry/);
            } finally {
                fs.rmSync(fixture.root, {recursive: true, force: true});
            }
        });
    }

    test('artifact audit permits JavaScript and CSS runtime fixture entries', async () => {
        const fixture = await createFixture(['package.json', 'dist/main/main.js', 'renderer/overlay.css']);
        try {
            assert.deepEqual((await auditPackagedArtifact(fixture.release)).sort(), [
                'dist', 'dist/main', 'dist/main/main.js', 'package.json', 'renderer', 'renderer/overlay.css',
            ]);
        } finally {
            fs.rmSync(fixture.root, {recursive: true, force: true});
        }
    });
}

if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    auditPackagedArtifact()
        .then((entries) => {
            console.log(`Packaged artifact audit passed (${entries.length} ASAR entries).`);
            console.log(entries.join('\n'));
        })
        .catch((error) => {
            console.error(`Packaged artifact audit failed: ${error.message}`);
            process.exitCode = 1;
        });
}
