import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(projectRoot, 'desktop');

function filesIn(directory) {
    return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? filesIn(entryPath) : [entryPath];
    });
}

test('desktop source, package scripts, and documentation do not retain local Python or ASR packaging hooks', () => {
    const desktopFiles = [
        ...filesIn(path.join(desktopRoot, 'src')),
        ...filesIn(path.join(desktopRoot, 'renderer')),
        path.join(desktopRoot, 'package.json'),
        path.join(desktopRoot, 'README.md'),
    ];
    const forbidden = [
        /server\/app\.py/i,
        /python -m server\.app/i,
        /MONSTER_OFFER_PYTHON/i,
        /MONSTER_OFFER_PROJECT_ROOT/i,
        /sherpa-onnx-node/i,
        /model-manager/i,
        /utilityProcess/i,
        /download_asr_model/i,
    ];

    for (const file of desktopFiles) {
        const contents = fs.readFileSync(file, 'utf8');
        for (const pattern of forbidden) {
            assert.doesNotMatch(contents, pattern, `${path.relative(projectRoot, file)} must not contain ${pattern}`);
        }
    }
});

test('documentation explains model setup and development transport boundaries', () => {
    const rootReadme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
    const desktopReadme = fs.readFileSync(path.join(desktopRoot, 'README.md'), 'utf8');

    assert.match(rootReadme, /server\/config\/default_model_profiles\.json/);
    assert.match(rootReadme, /active_profile/);
    assert.match(rootReadme, /LLM_ACTIVE_PROFILE/);
    assert.match(rootReadme, /api_key_env/);
    assert.match(rootReadme, /供应商密钥.*Python 后端/);
    assert.match(rootReadme, /Web client.*no model settings UI/i);
    assert.match(rootReadme, /Electron.*脱敏模型列表.*profile_id/);
    assert.match(rootReadme, /127\.0\.0\.1:9000.*\/ws\/asr/);
    assert.match(desktopReadme, /127\.0\.0\.1:9000/);
    assert.match(desktopReadme, /does not create, edit, or delete/i);
    assert.match(desktopReadme, /non-local.*HTTPS\/WSS/i);
});

test('Electron uses the fixed local Python service and does not expose connection settings', () => {
    const mainSource = fs.readFileSync(path.join(desktopRoot, 'src', 'main', 'main.ts'), 'utf8');
    const preloadSource = fs.readFileSync(path.join(desktopRoot, 'src', 'preload', 'index.ts'), 'utf8');

    assert.match(mainSource, /DEFAULT_BACKEND_URL\s*=\s*['"]http:\/\/127\.0\.0\.1:9000\//);
    assert.doesNotMatch(mainSource, /DesktopSettingsStore|settingsStore|APP_ADMIN_TOKEN/);
    assert.doesNotMatch(preloadSource, /IPC_CHANNELS\.settings|saveConnection|clearConnection|testConnection/);
});
