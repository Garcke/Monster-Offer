import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const overlayHtmlPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay.html');
const controllerPath = path.join(projectRoot, 'desktop', 'renderer', 'model-settings.js');

async function loadModelSettingsController() {
    const source = fs.readFileSync(controllerPath, 'utf8');
    return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test('model settings renderer exposes fixed controls and keeps connection secrets transient', () => {
    const html = fs.readFileSync(overlayHtmlPath, 'utf8');
    const source = fs.existsSync(controllerPath) ? fs.readFileSync(controllerPath, 'utf8') : '';
    const requiredIds = [
        'overlaySettingsButton', 'overlayActiveModel', 'overlaySettingsDrawer', 'overlaySettingsClose',
        'serverBaseUrl', 'serverAdminToken', 'serverSaveButton', 'serverTestButton', 'serverClearButton', 'serverStatus',
        'modelList', 'modelForm', 'modelProfileId', 'modelLabel', 'modelProtocol', 'modelBaseUrl', 'modelName',
        'modelApiKey', 'modelApiKeyRequired', 'modelMaxTokens', 'modelTemperature', 'modelSaveButton',
        'modelTestButton', 'modelCancelButton', 'modelStatus',
    ];

    for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`));
    assert.match(source, /export class ModelSettingsController/);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/);
    assert.doesNotMatch(source, /\bfetch\s*\(|\bWebSocket\b/);
    assert.match(source, /meetingMonster\.settings\.testConnection/);
    assert.match(source, /meetingMonster\.models\.list/);
    assert.match(source, /meetingMonster\.models\.create/);
    assert.match(source, /meetingMonster\.models\.update/);
    assert.match(source, /meetingMonster\.models\.activate/);
    assert.match(source, /meetingMonster\.models\.delete/);
    assert.match(source, /meetingMonster\.models\.test/);
    assert.match(source, /finally\s*\{[\s\S]*apiKeyInput\.value\s*=\s*['"][^'"]*['"]/);
});

function createElement() {
    return {
        children: [],
        textContent: '',
        className: '',
        type: '',
        append(...nodes) { this.children.push(...nodes); },
        appendChild(node) { this.children.push(node); },
        addEventListener() {},
        replaceChildren(...nodes) { this.children = nodes; },
    };
}

test('deleting the active profile refreshes the active-model callback', async () => {
    const {ModelSettingsController} = await loadModelSettingsController();
    const deletedProfile = {id: 'old', label: 'Old', active: true};
    const activeProfile = {
        id: 'new', label: 'Current', protocol: 'openai', base_url: 'https://example.test', model: 'gpt',
        api_key_required: true, max_tokens: 100, temperature: 0.2, active: true,
    };
    const updates = [];
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    globalThis.window = {confirm: () => true};
    globalThis.document = {createElement};
    try {
        const controller = new ModelSettingsController({
            api: {
                models: {
                    delete: async (id) => assert.equal(id, 'old'),
                    list: async () => ({active_profile: 'new', profiles: [activeProfile]}),
                },
            },
            elements: {modelList: createElement(), modelStatus: createElement()},
            onActiveModelChanged: (profile) => updates.push(profile),
        });

        await controller.deleteProfile(deletedProfile);
        assert.deepEqual(updates, [activeProfile]);
    } finally {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
    }
});
