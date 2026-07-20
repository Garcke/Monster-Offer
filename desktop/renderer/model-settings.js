export class ModelSettingsController {
    constructor({api, elements, onActiveModelChanged}) {
        this.api = api;
        this.elements = elements;
        this.onActiveModelChanged = onActiveModelChanged;
        this.profiles = [];
        this.selectedProfile = null;
    }

    bind() {
        const {modelForm, modelTestButton} = this.elements;
        modelForm?.addEventListener('submit', (event) => event.preventDefault());
        modelTestButton?.addEventListener('click', () => this.testProfile());
    }

    async refreshModels() {
        const {modelList, modelStatus} = this.elements;
        try {
            const result = await this.api.models.list();
            this.profiles = Array.isArray(result?.profiles) ? result.profiles : [];
            const selected = this.profiles.find((profile) => profile.id === this.selectedProfile?.id)
                || this.profiles.find((profile) => profile.id === result.active_profile)
                || this.profiles[0]
                || null;
            this.selectProfile(selected, {render: false});
            this.renderModels();
            if (modelStatus) modelStatus.textContent = this.profiles.length ? '' : '后端尚未配置可用模型';
            return this.profiles;
        } catch (error) {
            this.profiles = [];
            this.selectedProfile = null;
            modelList?.replaceChildren();
            if (modelStatus) modelStatus.textContent = `无法读取后端模型：${error.message || '服务不可用'}`;
            throw error;
        }
    }

    selectProfile(profile, {render = true} = {}) {
        if (!profile) return null;
        this.selectedProfile = profile;
        const {modelProtocol, modelApiKey, modelMaxTokens, modelTemperature, modelStatus} = this.elements;
        if (modelProtocol) modelProtocol.value = profile.protocol || 'openai';
        if (modelMaxTokens) modelMaxTokens.value = String(profile.max_tokens || 4096);
        if (modelTemperature) modelTemperature.value = profile.temperature == null ? '' : String(profile.temperature);
        if (modelApiKey) modelApiKey.value = '';
        if (modelStatus) modelStatus.textContent = `已选择：${profile.label || profile.model}`;
        if (render) this.renderModels();
        this.onActiveModelChanged?.(profile, this.getSelection());
        return profile;
    }

    getSelection() {
        return this.#selectionFromForm();
    }

    async testProfile() {
        const {modelStatus} = this.elements;
        try {
            const result = await this.api.models.test(this.#selectionFromForm());
            if (modelStatus) modelStatus.textContent = result.ok
                ? `模型连接成功：${result.model}（${result.latency_ms}ms）`
                : '模型连接失败，请检查后端配置';
            return result;
        } catch (error) {
            if (modelStatus) modelStatus.textContent = `模型连接失败：${error.message || '请检查后端配置'}`;
            throw error;
        }
    }

    renderModels() {
        const {modelList} = this.elements;
        if (!modelList || typeof document === 'undefined') return;
        modelList.replaceChildren(...this.profiles.map((profile) => this.#createProfileRow(profile)));
    }

    #selectionFromForm() {
        if (!this.selectedProfile?.id) throw new Error('请先选择后端模型');
        const {modelApiKey, modelMaxTokens, modelTemperature} = this.elements;
        const selection = {
            profile_id: this.selectedProfile.id,
            max_tokens: Number(modelMaxTokens?.value || this.selectedProfile.max_tokens),
            temperature: modelTemperature?.value?.trim() === ''
                ? undefined
                : Number(modelTemperature?.value ?? this.selectedProfile.temperature),
        };
        const apiKey = modelApiKey?.value?.trim();
        if (apiKey) selection.api_key = apiKey;
        return selection;
    }

    #createProfileRow(profile) {
        const row = document.createElement('article');
        row.className = `model-row${profile.id === this.selectedProfile?.id ? ' is-selected' : ''}`;
        const summary = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = profile.label || profile.id;
        const detail = document.createElement('span');
        detail.textContent = `${profile.protocol} · ${profile.model}${profile.active ? ' · 默认' : ''}`;
        summary.append(label, detail);
        const actions = document.createElement('div');
        actions.className = 'model-row-actions';
        actions.append(this.#button(profile.id === this.selectedProfile?.id ? '已选择' : '选择', () => this.selectProfile(profile)));
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
