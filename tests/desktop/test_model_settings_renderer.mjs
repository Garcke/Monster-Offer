import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const overlayHtmlPath = path.join(projectRoot, 'desktop', 'renderer', 'overlay.html');
const controllerPath = path.join(projectRoot, 'desktop', 'renderer', 'model-settings.js');
const catalogPath = path.join(projectRoot, 'desktop', 'renderer', 'model-catalog.js');

async function loadModelSettingsController() {
    const source = fs.readFileSync(controllerPath, 'utf8');
    const catalog = fs.readFileSync(catalogPath, 'utf8');
    const combined = `${catalog}\n${source.replace("import {BUILT_IN_MODEL_PROFILES} from './model-catalog.js';", '')}`;
    return import(`data:text/javascript,${encodeURIComponent(combined)}`);
}

test('model settings renderer exposes selectable vendors and saved connection controls', () => {
    const html = fs.readFileSync(overlayHtmlPath, 'utf8');
    const source = fs.existsSync(controllerPath) ? fs.readFileSync(controllerPath, 'utf8') : '';
    const requiredIds = [
        'overlaySettingsButton', 'overlayActiveModel', 'overlaySettingsDrawer', 'overlaySettingsClose',
        'modelList', 'modelForm', 'modelApiKey', 'modelMaxTokens', 'modelTemperature',
        'modelTestButton', 'modelSaveButton', 'modelStatus',
    ];

    for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`));
    for (const id of ['serverBaseUrl', 'serverAdminToken', 'modelBaseUrl', 'modelName', 'modelCancelButton']) {
        assert.doesNotMatch(html, new RegExp(`id="${id}"`));
    }
    assert.match(source, /export class ModelSettingsController/);
    assert.doesNotMatch(html, /id="modelProtocol"/);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/);
    assert.doesNotMatch(source, /\bfetch\s*\(|\bWebSocket\b/);
    assert.match(source, /BUILT_IN_MODEL_PROFILES/);
    assert.match(source, /this\.api\.models\.getSaved/);
    assert.doesNotMatch(source, /this\.api\.models\.list/);
    assert.match(source, /this\.api\.models\.test/);
    assert.match(source, /this\.api\.models\.save/);
    assert.doesNotMatch(source, /modelProtocol/);
    assert.match(source, /profile_id/);
    assert.doesNotMatch(source, /meetingMonster\.models\.(create|update|delete|activate)/);
    assert.match(source, /profile_id/);
});

test('bundled model catalog contains every README built-in profile', async () => {
    const source = fs.readFileSync(catalogPath, 'utf8');
    assert.match(source, /export const BUILT_IN_MODEL_PROFILES/);
    const {BUILT_IN_MODEL_PROFILES} = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    const ids = BUILT_IN_MODEL_PROFILES.map((profile) => profile.id);
    assert.deepEqual(ids, [
        'openrouter', 'generic_openai', 'generic_anthropic', 'zai_glm', 'kimi_moonshot',
        'minimax_global', 'minimax_china', 'kilocode', 'anthropic', 'vercel_ai_gateway',
        'opencode_zen_openai', 'opencode_zen_anthropic', 'opencode_go',
    ]);
    assert.ok(BUILT_IN_MODEL_PROFILES.every((profile) => profile.label && profile.model));
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

test('selecting a backend profile refreshes the active-model callback', async () => {
    const {ModelSettingsController} = await loadModelSettingsController();
    const activeProfile = {
        id: 'new', label: 'Current', protocol: 'openai', model: 'gpt',
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
                models: {getSaved: async () => null},
            },
            elements: {modelList: createElement(), modelStatus: createElement()},
            onActiveModelChanged: (profile) => updates.push(profile),
        });

        await controller.selectProfile(activeProfile);
        assert.deepEqual(updates, [activeProfile]);
    } finally {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
    }
});

test('saving a selected model persists the current vendor and advanced fields', async () => {
    const {ModelSettingsController} = await loadModelSettingsController();
    const activeProfile = {
        id: 'generic_anthropic', label: 'Anthropic', protocol: 'anthropic', model: 'claude',
        api_key_required: true, max_tokens: 100, temperature: 0.2, active: true,
    };
    const elements = {
        modelList: createElement(), modelStatus: createElement(), modelForm: createElement(),
        modelApiKey: {value: 'temporary-key'}, modelMaxTokens: {value: '2048'},
        modelTemperature: {value: '0.4'}, modelSaveButton: {addEventListener() {}},
        modelTestButton: {addEventListener() {}},
    };
    const saved = [];
    const controller = new ModelSettingsController({
        api: {
            models: {
                getSaved: async () => null,
                save: async (selection) => { saved.push(selection); return {profile_id: selection.profile_id}; },
            },
        },
        elements,
    });

    await controller.refreshModels();
    await controller.selectProfile(activeProfile);
    elements.modelApiKey.value = 'temporary-key';
    elements.modelMaxTokens.value = '2048';
    elements.modelTemperature.value = '0.4';
    await controller.saveConnection();
    assert.deepEqual(saved, [{
        profile_id: 'generic_anthropic', protocol: 'anthropic', api_key: 'temporary-key',
        max_tokens: 2048, temperature: 0.4,
    }]);
});
