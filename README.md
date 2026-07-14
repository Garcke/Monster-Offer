# Monster Offer

基于本地 Streaming Paraformer 中英双语模型和 OpenAI 兼容文本模型的实时面试助手。

- 实时语音识别完全在本机运行，不上传音频。
- 浏览器持续发送 PCM 音频，本地模型返回临时结果和最终断句。
- AI 回答默认使用 Qwen，也可在页面中配置其他 OpenAI 兼容接口。
- 网页、LLM API 和 ASR WebSocket 已合并为一个 FastAPI 服务。

## 环境要求

- Python 3.10～3.12（64 位）
- Windows、Linux 或 macOS
- 建议至少 8 GB 内存

## 首次安装

推荐使用全局 `uv` 创建项目独立环境并安装依赖：

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
```

如未安装 `uv`，也可以使用 `python -m pip install -r requirements.txt`。

下载本地语音模型：

```powershell
python download_asr_model.py
```

模型默认保存到：

```text
models/sherpa-onnx-streaming-paraformer-bilingual-zh-en/
```

如需使用默认 Qwen 文本模型，复制并编辑环境变量文件：

```powershell
Copy-Item .env.example .env
```

```dotenv
DASHSCOPE_API_KEY=sk-xxx
```

也可以不创建 `.env`，直接在网页的“模型配置”中填写其他 OpenAI 兼容模型。

## 启动项目

现在只需要启动一个服务：

```powershell
.\.venv\Scripts\python.exe server.py
```

也可以在 Windows 中双击 `start.bat` 一键启动。脚本会优先使用项目内的 `.venv`，不存在时才回退到全局 Python。

服务启动并完成本地 ASR 模型加载后，访问：

```text
http://127.0.0.1:9000/
```

统一服务提供以下入口：

| 路径 | 功能 |
|---|---|
| `/` | 前端网页和静态资源 |
| `/api/*` | 文本模型、提示词和配置接口 |
| `/ws/asr` | 本地实时语音识别 WebSocket |

不再需要分别启动 2333、6220 和静态文件服务器。前端会自动使用当前网页所在的域名、协议和端口，因此后续更适合封装为桌面端或移动端应用。

## 启动配置

可在 `.env` 或系统环境变量中调整：

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `APP_HOST` | `127.0.0.1` | 统一服务监听地址；局域网访问时可设为 `0.0.0.0` |
| `APP_PORT` | `9000` | 统一服务端口 |
| `LOCAL_ASR_MODEL_DIR` | 项目内默认模型目录 | 使用其他兼容 ASR 模型目录 |
| `LOCAL_ASR_NUM_THREADS` | `2` | ONNX CPU 推理线程数 |
| `LOCAL_ASR_RULE1_MIN_TRAILING_SILENCE` | `2.4` | 纯静音断句阈值（秒） |
| `LOCAL_ASR_RULE2_MIN_TRAILING_SILENCE` | `0.8` | 已识别文本后的断句静音（秒） |
| `LOCAL_ASR_RULE3_MIN_UTTERANCE_LENGTH` | `20.0` | 单句最长时长（秒） |

## 数据流

```text
浏览器麦克风
  -> AudioWorklet（PCM 音频块）
  -> 同源 WebSocket /ws/asr
  -> sherpa-onnx Streaming Paraformer INT8（CPU）
  -> {"text": "...", "is_end": false/true}
  -> 左侧问题列表

用户选择问题并生成回答
  -> 同源 HTTP /api/chat/
  -> OpenAI 兼容文本模型
  -> SSE 流式回答
  -> 右侧回答区
```

## 快捷键

| 按键 | 功能 |
|---|---|
| `A` | 开始或停止录音 |
| `C` | 清空问题、选择和当前页面缓存答案 |
| `F` | 为当前选中的问题生成回答 |
| `Ctrl + Enter` | 发送手动输入并生成回答 |

## 主要文件

```text
server.py                  统一 FastAPI 服务、ASR WebSocket 和静态网页入口
llm_api.py                 文本大模型 API
local_asr.py               本地模型加载、流式识别和断句
download_asr_model.py      模型下载与安全解压
static/scripts.js          同源 WebSocket、问题状态和 LLM 交互
static/audio_recorder.js   麦克风采集和停止时尾音刷新
static/recorder_worklet.js PCM 音频分块
start.bat                  Windows 一键启动入口
```

## 说明

- 本地化的是实时语音识别；默认 Qwen 文本回答仍是远程服务。
- 当前 Streaming Paraformer 模型不提供词级时间戳。
- 本次改造只合并了服务和启动入口，尚未进行 EXE 或 APK 打包。
