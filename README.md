# QW-InterviewAssistant

基于 **Qwen / 任意 OpenAI 兼容 LLM** + **Paraformer-Realtime-V2** 的实时语音 AI 面试助手。

An interview assistant with real-time voice (DashScope ASR) and text chat (default: qwen-max-latest, configurable to other OpenAI-compatible models).

---

## 环境要求（Requirements）

- **Python 3.10**

---

## 快速开始（Quick Start）

### 1. 配置 API Key

在 **`config/settings.py`** 中配置 `DASHSCOPE_API_KEY`（用于实时语音识别 + 默认文本模型）。

- 获取地址：<https://bailian.console.aliyun.com/?apiKey=1#/api-key>

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

### 3. 启动三个服务

**终端 1 - 文本对话 API（LLM，SSE 流式）**

```bash
uvicorn llm_api:app --host 0.0.0.0 --port 2333
```

**终端 2 - 实时语音识别（WebSocket）**

```bash
python server.py
```

**终端 3 - 前端静态资源**

```bash
python -m http.server 9000
```

### 4. 访问页面

浏览器打开：

```
http://localhost:9000/static/
```
<img width="1733" height="901" alt="example" src="https://github.com/user-attachments/assets/98238e50-c1a7-4116-a810-7bf0e44a6ea0" />


---
## 项目结构（Project Structure）

```
realtime-chat/
├── config/                 # 统一配置目录
│   ├── __init__.py         # 导出 DASHSCOPE_API_KEY、check_llm_connection、get_available_models
│   ├── settings.py         # DASHSCOPE_API_KEY（语音 + 默认 Qwen）
│   ├── llm_checker.py      # LLM 连接测试、模型列表拉取
│   └── SetVocabulary.py    # 热词表管理（ASR 专有名词）
├── cache/
│   ├── prompt.txt         # 系统提示词（可编辑）
│   └── audio.pcm          # 录音缓存
├── static/                 # 前端
│   ├── index.html
│   ├── scripts.js         # 对话逻辑、模型配置弹窗、快捷键
│   ├── styles.css
│   ├── audio_recorder.js  # 录音
│   └── recorder_worklet.js
├── llm_api.py             # 统一 LLM API（/chat/ 流式、/set_prompt/、/history/、/reset/、/models/、/test_connection/、/models/list/）
├── server.py              # 实时语音 WebSocket 服务（DashScope ASR）
├── requirements.txt
└── README.md
```

- **LLM**：默认使用 DashScope 的 Qwen；前端可在「模型配置」弹窗中填写模型名、API Key、Base URL，保存后对话将使用新配置（配置存于浏览器 localStorage）。
- **流式输出**：`/chat/` 使用 SSE（`text/event-stream`），前端按 `data:` 行解析，支持事件区分与后续断线重连。

---

## 快捷键（Shortcuts）

| 按键 | 功能 |
|------|------|
| `A` | 开始 / 暂停录音 |
| `C` | 清除文本 |
| `D` | AI Chat（发送当前文本并请求 AI 回复） |
| `Enter` | 发送当前文本 |
| `Alt+Enter` | 文本换行 |

可在 **`static/scripts.js`** 中修改快捷键逻辑。

---

## 可配置项（Configurable Options）

- **API Key**：`config/settings.py` 中的 `DASHSCOPE_API_KEY`（语音 + 默认 Qwen）。
- **模型配置**：页面内「模型配置」按钮 → 填写模型名、API Key、Base URL → 测试连接 / 拉取模型列表 → 保存；后续对话使用该配置。
- **热词（ASR）**：使用 `config/SetVocabulary.py` 等管理热词表，提升语音识别专有名词准确率。参考：<https://help.aliyun.com/zh/model-studio/developer-reference/custom-hot-words>。
- **提示词**：编辑 **`cache/prompt.txt`** 修改系统提示词。
- **快捷键**：在 **`static/scripts.js`** 中修改。
- **聊天记录**：可将对话保存为本地文件（如 MD）。

---

## 参考项目（Reference）

- [在网页中录音并进行语音识别](https://github.com/aliyun/alibabacloud-bailian-speech-demo/tree/master/samples/gallery/input-text-out-audio-html-ai-assistant)
