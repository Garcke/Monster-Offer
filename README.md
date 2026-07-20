<p align="center">
  <img src="web/favicon.png" alt="Meeting-Monster Logo" width="180">
</p>

<h1 align="center">Meeting-Monster</h1>

<p align="center">本地实时语音转写与 AI 面试辅助回答</p>

Meeting-Monster 使用本地 sherpa-onnx Streaming Paraformer 完成中英双语实时转写，并通过服务端配置的 OpenAI Compatible 或 Anthropic Messages 模型流式生成回答。

- 音频在本机识别，不上传到语音云服务。
- 桌面端使用左右双栏，窄屏使用“面试内容 / AI 回答”标签切换。
- 网页、LLM API 和 ASR WebSocket 合并为一个 FastAPI 服务。
- 模型地址、名称和密钥全部由服务端管理，浏览器不保存 API Key。

## 环境要求

- Python 3.10–3.12（64 位）
- Windows、Linux 或 macOS
- 建议至少 8 GB 内存
- Node.js 仅在运行前端测试时需要

## 首次安装

推荐使用全局 `uv` 创建项目虚拟环境并安装依赖：

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -r server\requirements.txt
```

下载本地语音模型：

```powershell
.\.venv\Scripts\python.exe -m server.scripts.download_asr_model
```

默认保存目录：

```text
models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/
```

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

默认活动配置是 `generic_openai`，指向本机 `http://127.0.0.1:8000/v1`，不要求 API Key。语音转写不依赖文本模型，因此即使尚未启动文本模型服务，本地 ASR 仍可正常启动和使用。

使用云端或带鉴权的兼容端点时，请修改 `server/config/default_model_profiles.json` 中对应 Profile 的 `base_url`、`model`，并在 `.env` 填写该 Profile 的 `api_key_env`。

## 文本模型配置

非敏感配置位于 [`server/config/default_model_profiles.json`](server/config/default_model_profiles.json)，密钥位于本机 `.env`。Web client has no model settings UI；Electron 只读取后端脱敏模型列表并选择 `profile_id`，不保存 Python 服务地址、管理员令牌或模型配置。模型地址、模型名称和供应商密钥始终由 Python 后端管理。

```json
{
  "active_profile": "openrouter",
  "profiles": {
    "openrouter": {
      "label": "OpenRouter",
      "protocol": "openai",
      "base_url": "https://openrouter.ai/api/v1",
      "model": "anthropic/claude-sonnet-4.6",
      "api_key_env": "OPENROUTER_API_KEY",
      "api_key_required": true,
      "max_tokens": 4096,
      "temperature": 0.3
    }
  }
}
```

切换模型有两种方式：

1. 修改 `server/config/default_model_profiles.json` 的 `active_profile`。
2. 在 `.env` 中设置 `LLM_ACTIVE_PROFILE=openrouter` 覆盖 JSON 默认值。

Electron 浮层还可以从 `/api/model-options/` 选择一个 `profile_id` 用于当前请求；这种选择不会修改后端 `active_profile` 或模型配置文件。

然后在 `.env` 填写该配置的 `api_key_env` 对应变量并重启服务。系统不会因为检测到其他 API Key 而自动切换服务商，也不会失败后自动消费其他服务商额度。

### 内置配置

| Profile ID | 服务商 | 协议 | 默认模型 | `.env` 变量 |
|---|---|---|---|---|
| `openrouter` | OpenRouter | OpenAI | `anthropic/claude-sonnet-4.6` | `OPENROUTER_API_KEY` |
| `generic_openai` | 通用 OpenAI Compatible | OpenAI | `local-model` | `OPENAI_COMPATIBLE_API_KEY`（可空） |
| `generic_anthropic` | 通用 Anthropic Compatible | Anthropic | `anthropic-compatible-model` | `ANTHROPIC_COMPATIBLE_API_KEY`（可空） |
| `zai_glm` | Z.AI / GLM | OpenAI | `glm-5.2` | `GLM_API_KEY` |
| `kimi_moonshot` | Kimi / Moonshot | OpenAI | `kimi-k2.6` | `KIMI_API_KEY` |
| `minimax_global` | MiniMax Global | Anthropic | `MiniMax-M3` | `MINIMAX_API_KEY` |
| `minimax_china` | MiniMax 中国 | Anthropic | `MiniMax-M3` | `MINIMAX_CN_API_KEY` |
| `kilocode` | Kilo Code | OpenAI | `anthropic/claude-sonnet-4.6` | `KILOCODE_API_KEY` |
| `anthropic` | Anthropic | Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `vercel_ai_gateway` | Vercel AI Gateway | OpenAI | `anthropic/claude-sonnet-4.6` | `AI_GATEWAY_API_KEY` |
| `opencode_zen_openai` | OpenCode Zen | OpenAI | `deepseek-v4-flash` | `OPENCODE_ZEN_API_KEY` |
| `opencode_zen_anthropic` | OpenCode Zen | Anthropic | `qwen3.7-plus` | `OPENCODE_ZEN_API_KEY` |
| `opencode_go` | OpenCode Go | OpenAI | `deepseek-v4-flash` | `OPENCODE_GO_API_KEY` |

模型 ID 与账户权限会随服务商变化；表中值是可编辑预设。OpenCode Zen 同时提供不同 wire protocol 的模型，因此拆成两个 profile，切换模型时要选择与目标端点一致的协议。

自托管 vLLM、LM Studio 或其他 OpenAI Compatible 服务可编辑 `generic_openai`：

```json
{
  "protocol": "openai",
  "base_url": "http://127.0.0.1:8000/v1",
  "model": "your-local-model",
  "api_key_env": "OPENAI_COMPATIBLE_API_KEY",
  "api_key_required": false
}
```

Anthropic Messages 兼容端点使用 `generic_anthropic`，将 `protocol` 保持为 `anthropic`，并把 `base_url`、`model` 和 `ANTHROPIC_COMPATIBLE_API_KEY` 改为服务商提供的值。

本配置方式参考 [NousResearch/hermes-agent 的 Provider 配置](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md)，但 Meeting-Monster 只实现面试回答需要的 OpenAI Chat Completions 与 Anthropic Messages 两种协议。Nous Portal、OpenAI Codex 登录、GitHub Copilot 和 GitHub Copilot ACP 依赖 OAuth、专用令牌交换、Responses API 或本地 ACP 进程，本版本不支持。

## 启动项目

只需启动一个服务：

```powershell
.\.venv\Scripts\python.exe -m server.app
```

Windows 也可以双击 `start.bat`。ASR 模型加载完成后访问：

```text
http://127.0.0.1:9000/
```

| 路径 | 功能 |
|---|---|
| `/` | 前端网页和静态资源 |
| `/api/chat/` | SSE 流式文本回答 |
| `/api/models/` | 不含密钥和地址的模型配置摘要 |
| `/api/model-options/` | Electron 可选择的脱敏模型列表 |
| `/api/model-test/` | 使用后端 profile 测试模型连接 |
| `/api/prompt/` | 系统提示词 |
| `/ws/asr` | 本地实时语音识别 WebSocket |

## 启动与 ASR 配置

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `APP_HOST` | `127.0.0.1` | 监听地址；局域网访问时可设为 `0.0.0.0` |
| `APP_PORT` | `9000` | 服务端口 |
| `LOCAL_ASR_MODEL_DIR` | 项目内默认模型目录 | 其他兼容 ASR 模型目录 |
| `LOCAL_ASR_NUM_THREADS` | `2` | ONNX CPU 推理线程数 |
| `LOCAL_ASR_RULE1_MIN_TRAILING_SILENCE` | `2.4` | 纯静音断句阈值（秒） |
| `LOCAL_ASR_RULE2_MIN_TRAILING_SILENCE` | `0.8` | 已识别文本后的静音阈值（秒） |
| `LOCAL_ASR_RULE3_MIN_UTTERANCE_LENGTH` | `20.0` | 单句最长时长（秒） |

## 数据流

```text
浏览器麦克风 -> AudioWorklet PCM -> /ws/asr
  -> 本地 sherpa-onnx Streaming Paraformer -> 左侧问题列表

选中问题 -> /api/model-options/ 选择 profile_id -> /api/chat/
  -> 服务端 profile 配置
  -> OpenAI Compatible 或 Anthropic Messages -> SSE -> 右侧回答区
```

## 快捷键

| 按键 | 功能 |
|---|---|
| `A` | 开始或停止录音 |
| `C` | 清空问题、选择和当前页面缓存答案 |
| `F` | 为当前选中的问题生成回答 |
| `Ctrl + Enter` | 发送手动输入并生成回答 |

## 测试

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests/server -p "test_*.py" -v
node --test tests/desktop/*.mjs
node --check web/scripts.js
```

可选的真实页面验收使用本机 Edge，不会下载额外浏览器：

```powershell
uv pip install --python .venv\Scripts\python.exe -r requirements-dev.txt
.\.venv\Scripts\python.exe tests\browser_smoke.py
```

## 主要文件

```text
server/app.py                     统一 FastAPI、ASR WebSocket 和 Web 入口
server/llm_api.py                 文本模型 HTTP/SSE API
server/llm_providers.py           OpenAI 与 Anthropic 流式协议适配
server/settings/model_profiles.py 配置验证、活动 profile 和密钥解析
server/config/default_model_profiles.json 非敏感模型预设
server/asr.py                     本地模型加载、流式识别和断句
web/scripts.js                    同源 WebSocket、问题状态和 LLM 交互
start.bat                         Windows 一键启动入口
```

本地化的是 Python 服务中的实时语音识别；配置的文本模型仍可能是远程服务。Electron 桌面端默认连接本机 `http://127.0.0.1:9000/`，聊天、模型选择和 `/ws/asr` 都复用该地址，语音 WebSocket 路径由客户端自动派生，不需要单独配置语音接口。

## Windows 桌面隐私模式

Windows 桌面版位于 [`desktop/`](desktop/)，它连接已运行的 Python 服务并使用独立的 Electron 浮层页面。开发启动方式：

```powershell
cd desktop
npm install
npm start
```

Electron 窗口默认启用系统级捕获保护，并使用透明、无边框、置顶的 Cluely 风格专用悬浮渲染器；桌面端加载 `desktop/renderer/overlay.html`，不再加载旧网页工作台。收起时是紧凑胶囊，展开时胶囊与回复面板直接连接。底层调用 `BrowserWindow.setContentProtection(true/false)`，由 Electron 映射到当前平台支持的窗口内容保护机制。点击胶囊中的保护按钮或按 `Ctrl+Shift+P` 可以切换保护状态，状态徽标会显示保护已开启、已关闭、系统不支持或保护失败。

该机制只保护 Meeting-Monster 自己的窗口，属于尽力而为的系统级捕获保护，不是进程隐藏或反监控机制；不能保证阻止手机拍摄、硬件采集、管理员权限工具或不遵守系统捕获策略的驱动。敏感会议时请优先共享指定窗口，不要共享整个桌面。任务栏图标保持可见，托盘功能不属于安全防护机制。
