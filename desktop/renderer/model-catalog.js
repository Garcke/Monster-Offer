// The selectable catalog is shipped with the Electron renderer. It mirrors
// server/config/default_model_profiles.json without shipping URLs or secrets.
export const BUILT_IN_MODEL_PROFILES = Object.freeze([
    {id: 'openrouter', label: 'OpenRouter', protocol: 'openai', model: 'anthropic/claude-sonnet-4.6', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'generic_openai', label: '通用 OpenAI Compatible', protocol: 'openai', model: 'local-model', api_key_required: false, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: true},
    {id: 'generic_anthropic', label: '通用 Anthropic Compatible', protocol: 'anthropic', model: 'anthropic-compatible-model', api_key_required: false, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'zai_glm', label: 'Z.AI / GLM', protocol: 'openai', model: 'glm-5.2', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'kimi_moonshot', label: 'Kimi / Moonshot', protocol: 'openai', model: 'kimi-k2.6', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'minimax_global', label: 'MiniMax Global', protocol: 'anthropic', model: 'MiniMax-M3', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'minimax_china', label: 'MiniMax 中国', protocol: 'anthropic', model: 'MiniMax-M3', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'kilocode', label: 'Kilo Code', protocol: 'openai', model: 'anthropic/claude-sonnet-4.6', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', model: 'claude-sonnet-4-6', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'vercel_ai_gateway', label: 'Vercel AI Gateway', protocol: 'openai', model: 'anthropic/claude-sonnet-4.6', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'opencode_zen_openai', label: 'OpenCode Zen · OpenAI', protocol: 'openai', model: 'deepseek-v4-flash', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'opencode_zen_anthropic', label: 'OpenCode Zen · Anthropic', protocol: 'anthropic', model: 'qwen3.7-plus', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
    {id: 'opencode_go', label: 'OpenCode Go', protocol: 'openai', model: 'deepseek-v4-flash', api_key_required: true, has_api_key: false, max_tokens: 4096, temperature: 0.3, active: false},
].map((profile) => Object.freeze(profile)));
