export class ModelSettingsController {
    constructor({api, elements, onActiveModelChanged}) {
        this.api = api;
        this.elements = elements;
        this.onActiveModelChanged = onActiveModelChanged;
        this.editingProfileId = null;
        this.profiles = [];
    }

    bind() {
        const {serverSaveButton, serverTestButton, serverClearButton, modelForm, modelTestButton, modelCancelButton, modelNewButton} = this.elements;
        serverSaveButton.addEventListener('click', () => this.saveConnection());
        serverTestButton.addEventListener('click', () => this.testConnection());
        serverClearButton.addEventListener('click', () => this.clearConnection());
        modelForm.addEventListener('submit', (event) => {
            event.preventDefault();
            this.saveProfile();
        });
        modelTestButton.addEventListener('click', () => this.testProfile());
        modelCancelButton.addEventListener('click', () => this.resetProfileForm());
        modelNewButton.addEventListener('click', () => this.resetProfileForm());
        this.resetProfileForm();
    }

    async refreshConnection() {
        const meetingMonster = this.api;
        const status = await meetingMonster.settings.getStatus();
        const {serverBaseUrl, serverStatus} = this.elements;
        serverBaseUrl.value = status.configured ? status.baseUrl || '' : '';
        serverStatus.textContent = status.configured
            ? `已配置：${status.baseUrl || '服务地址不可用'}`
            : '请填写 Python 服务地址和管理员令牌';
        return status;
    }

    async saveConnection() {
        const meetingMonster = this.api;
        const {serverBaseUrl, serverAdminToken, serverStatus} = this.elements;
        const connection = {baseUrl: serverBaseUrl.value.trim(), adminToken: serverAdminToken.value};
        try {
            await meetingMonster.settings.saveConnection(connection);
            await this.refreshConnection();
            serverStatus.textContent = '连接已保存';
        } catch (error) {
            serverStatus.textContent = `请检查服务地址和管理员令牌：${error.message || '保存失败'}`;
        } finally {
            serverAdminToken.value = '';
        }
    }

    async testConnection() {
        const meetingMonster = this.api;
        const {serverBaseUrl, serverAdminToken, serverStatus} = this.elements;
        const connection = {baseUrl: serverBaseUrl.value.trim(), adminToken: serverAdminToken.value};
        try {
            const result = await meetingMonster.settings.testConnection(connection);
            serverStatus.textContent = result.status === 'connected' && result.adminAuthorized
                ? '连接测试成功'
                : '连接可达，但管理员令牌无权限';
        } catch (error) {
            serverStatus.textContent = `请检查服务地址和管理员令牌：${error.message || '连接失败'}`;
        } finally {
            serverAdminToken.value = '';
        }
    }

    async clearConnection() {
        const meetingMonster = this.api;
        const {serverBaseUrl, serverAdminToken, serverStatus} = this.elements;
        try {
            await meetingMonster.settings.clearConnection();
            serverBaseUrl.value = '';
            serverStatus.textContent = '连接已清除';
        } catch (error) {
            serverStatus.textContent = `无法清除连接：${error.message || '请重试'}`;
        } finally {
            serverAdminToken.value = '';
        }
    }

    async refreshModels() {
        const meetingMonster = this.api;
        const {modelList, modelStatus} = this.elements;
        try {
            const result = await meetingMonster.models.list();
            this.profiles = Array.isArray(result?.profiles) ? result.profiles : [];
            const rows = this.profiles.map((profile) => this.#createProfileRow(profile));
            modelList.replaceChildren(...rows);
            if (!rows.length) modelList.textContent = '还没有模型配置。请选择“新建模型”。';
            modelStatus.textContent = '';
            return this.profiles;
        } catch (error) {
            modelList.replaceChildren();
            modelStatus.textContent = `请先保存连接后再读取模型：${error.message || '读取失败'}`;
            return [];
        }
    }

    editProfile(profile) {
        const {modelProfileId, modelLabel, modelProtocol, modelBaseUrl, modelName, modelApiKey, modelApiKeyRequired, modelMaxTokens, modelTemperature, modelSaveButton, modelStatus} = this.elements;
        this.editingProfileId = profile.id;
        modelProfileId.value = profile.id;
        modelLabel.value = profile.label || '';
        modelProtocol.value = profile.protocol || 'openai';
        modelBaseUrl.value = profile.base_url || '';
        modelName.value = profile.model || '';
        modelApiKey.value = '';
        modelApiKeyRequired.checked = profile.api_key_required === true;
        modelMaxTokens.value = String(profile.max_tokens || 1024);
        modelTemperature.value = profile.temperature ?? '';
        modelSaveButton.textContent = '保存模型';
        modelStatus.textContent = '编辑时留空 API 密钥会保留原密钥';
    }

    async saveProfile() {
        const meetingMonster = this.api;
        const {modelApiKey: apiKeyInput, modelStatus} = this.elements;
        try {
            const profile = this.#profileFromForm();
            if (this.editingProfileId) await meetingMonster.models.update(this.editingProfileId, profile);
            else await meetingMonster.models.create(profile);
            modelStatus.textContent = '模型已保存';
            await this.refreshModels();
            this.resetProfileForm();
        } catch (error) {
            modelStatus.textContent = `请检查模型参数和 API 密钥：${error.message || '保存失败'}`;
        } finally {
            apiKeyInput.value = '';
        }
    }

    async testProfile() {
        const meetingMonster = this.api;
        const {modelApiKey: apiKeyInput, modelStatus} = this.elements;
        try {
            const result = await meetingMonster.models.test(this.#profileFromForm());
            modelStatus.textContent = result.ok ? `模型测试成功（${result.latency_ms}ms）` : '模型测试失败，请检查配置';
        } catch (error) {
            modelStatus.textContent = `请检查模型参数和 API 密钥：${error.message || '测试失败'}`;
        } finally {
            apiKeyInput.value = '';
        }
    }

    async activateProfile(profile) {
        const meetingMonster = this.api;
        const {modelStatus} = this.elements;
        try {
            const result = await meetingMonster.models.activate(profile.id);
            const activeProfile = result?.profile || profile;
            await this.refreshModels();
            this.onActiveModelChanged?.(activeProfile);
            modelStatus.textContent = `当前模型：${activeProfile.label}`;
        } catch (error) {
            modelStatus.textContent = `无法设为当前：${error.message || '请重试'}`;
        }
    }

    async deleteProfile(profile) {
        const meetingMonster = this.api;
        const {modelStatus} = this.elements;
        if (!window.confirm(`删除模型“${profile.label}”？`)) return;
        try {
            await meetingMonster.models.delete(profile.id);
            const profiles = await this.refreshModels();
            this.onActiveModelChanged?.(profiles.find((item) => item.active) || null);
            modelStatus.textContent = '模型已删除';
        } catch (error) {
            modelStatus.textContent = `无法删除模型：${error.message || '请重试'}`;
        }
    }

    resetProfileForm() {
        const {modelForm, modelProfileId, modelProtocol, modelApiKey: apiKeyInput, modelApiKeyRequired, modelMaxTokens, modelTemperature, modelSaveButton, modelStatus} = this.elements;
        this.editingProfileId = null;
        modelForm.reset();
        modelProfileId.value = crypto.randomUUID();
        modelProtocol.value = 'openai';
        modelApiKeyRequired.checked = true;
        modelMaxTokens.value = '1024';
        modelTemperature.value = '0.2';
        apiKeyInput.value = '';
        modelSaveButton.textContent = '保存模型';
        modelStatus.textContent = '';
    }

    #profileFromForm() {
        const {modelProfileId, modelLabel, modelProtocol, modelBaseUrl, modelName, modelApiKey, modelApiKeyRequired, modelMaxTokens, modelTemperature} = this.elements;
        const profile = {
            id: modelProfileId.value.trim(),
            label: modelLabel.value.trim(),
            protocol: modelProtocol.value,
            base_url: modelBaseUrl.value.trim(),
            model: modelName.value.trim(),
            api_key_required: modelApiKeyRequired.checked,
            max_tokens: Number(modelMaxTokens.value),
            temperature: modelTemperature.value.trim() === '' ? null : Number(modelTemperature.value),
        };
        if (modelApiKey.value) profile.api_key = modelApiKey.value;
        return profile;
    }

    #createProfileRow(profile) {
        const row = document.createElement('article');
        row.className = 'model-row';
        const summary = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = profile.label;
        const detail = document.createElement('span');
        detail.textContent = `${profile.protocol} · ${profile.model}${profile.active ? ' · 当前' : ''}`;
        summary.append(label, detail);
        const actions = document.createElement('div');
        actions.className = 'model-row-actions';
        if (profile.active) {
            const active = document.createElement('span');
            active.className = 'model-active';
            active.textContent = '当前';
            actions.appendChild(active);
        }
        actions.append(
            this.#button('编辑', () => this.editProfile(profile)),
            this.#button('测试', () => {
                this.editProfile(profile);
                this.testProfile();
            }),
            this.#button('设为当前', () => this.activateProfile(profile)),
            this.#button('删除', () => this.deleteProfile(profile)),
        );
        row.append(summary, actions);
        return row;
    }

    #button(label, handler) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', handler);
        return button;
    }
}
