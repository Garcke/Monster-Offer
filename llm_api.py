import asyncio
import json
import threading
from pathlib import Path
from typing import Optional, Dict, Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import OpenAI
from pydantic import BaseModel

from config import DASHSCOPE_API_KEY, check_llm_connection, get_available_models

"""
统一的大模型聊天 API 服务。

约定：
- 文本模型的 api_key / base_url / model **优先由前端弹窗直接配置并随请求发送**
- 如果请求里没有提供任何文本模型配置，则默认调用 DashScope 的 OpenAI 兼容接口：
  - base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
  - model: qwen-max-latest
  - api_key: config/settings.py 中的 DASHSCOPE_API_KEY
"""

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL_NAME: str = "qwen-max-latest"
PROMPT_FILE = Path(__file__).resolve().parent / "cache" / "prompt.txt"
DEFAULT_REQUEST_PARAMS: Dict[str, Any] = {
    "temperature": 0.3,
    "top_p": 0.5,
    "presence_penalty": 0.8,
    "max_tokens": 4096,
    "n": 1,
    "extra_body": {"enable_search": True},
}

app = FastAPI(title="Unified LLM Chat API")

# ================== CORS 配置 ==================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源，生产环境请改为具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ================== 对话相关模型 ==================
conversation_history = []


class UserMessage(BaseModel):
    content: str
    # 逻辑模型名（例如 "qwen-max-latest"、"deepseek-chat"），可省略则使用默认
    model: Optional[str] = None
    # 以下字段允许前端临时覆盖后端配置，从而支持任意 OpenAI 接口风格的模型
    api_key: Optional[str] = None
    base_url: Optional[str] = None


class PromptMessage(BaseModel):
    prompt: str


class TestConnectionRequest(BaseModel):
    """测试 LLM 连接请求体"""
    base_url: Optional[str] = ""
    api_key: Optional[str] = ""
    model: Optional[str] = ""


class ListModelsRequest(BaseModel):
    """从远程 API 拉取模型列表请求体"""
    base_url: Optional[str] = ""
    api_key: Optional[str] = ""


@app.get("/prompt/")
async def get_prompt():
    """Return the local system prompt without exposing the project directory."""
    try:
        prompt = PROMPT_FILE.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail="无法读取系统提示词") from exc
    return {"prompt": prompt}


def resolve_runtime_config(user_message: UserMessage) -> Dict[str, Any]:
    """
    根据请求 + 服务器配置，解析出本次调用应使用的:
    - api_key
    - base_url
    - model_name
    - request_params（采样参数等）

    规则：
    1. 若 user_message.model 在后端配置中：
       - 以配置为基础，允许 api_key/base_url 被请求体覆盖
    2. 若 user_message.model 为空：
       - 使用 DEFAULT_MODEL_NAME 对应配置
    3. 若 user_message.model 不在配置中：
       - 需要同时提供 api_key 和 base_url，作为“自定义模型”调用
    """
    # 如果前端没有传任何文本模型配置，则走默认 qwen-max-latest
    model_name_from_req = (user_message.model or "").strip()
    api_key_from_req = (user_message.api_key or "").strip()
    base_url_from_req = (user_message.base_url or "").strip()

    if not model_name_from_req and not api_key_from_req and not base_url_from_req:
        return {
            "model_name": DEFAULT_MODEL_NAME,
            "api_key": DASHSCOPE_API_KEY,
            "base_url": DEFAULT_BASE_URL,
            "request_params": DEFAULT_REQUEST_PARAMS,
        }

    # 允许仅传 model（不传 key/url）且等于默认模型时也走默认
    if model_name_from_req == DEFAULT_MODEL_NAME and not api_key_from_req and not base_url_from_req:
        return {
            "model_name": DEFAULT_MODEL_NAME,
            "api_key": DASHSCOPE_API_KEY,
            "base_url": DEFAULT_BASE_URL,
            "request_params": DEFAULT_REQUEST_PARAMS,
        }

    # 其他情况：视为“前端自定义 OpenAI 兼容模型”，必须提供 api_key 和 base_url
    if not (api_key_from_req and base_url_from_req):
        raise HTTPException(status_code=400, detail="请同时提供 api_key 与 base_url（或清空三项走默认 qwen）。")

    return {
        "model_name": model_name_from_req or DEFAULT_MODEL_NAME,
        "api_key": api_key_from_req,
        "base_url": base_url_from_req,
        "request_params": {},
    }


def create_client(api_key: str, base_url: str) -> OpenAI:
    """根据运行时配置创建 OpenAI 兼容客户端。"""
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
    )


@app.post("/set_prompt/")
async def set_prompt(prompt_message: PromptMessage):
    """
    设置系统级提示词（system prompt），会加入到全局对话历史中。
    """
    global conversation_history
    conversation_history.append({"role": "system", "content": prompt_message.prompt})
    return {"message": "Prompt has been set."}


@app.post("/chat/")
async def chat(user_message: UserMessage):
    """
    通用聊天接口：
    - 请求体示例：
      {
        "content": "你好",
        "model": "deepseek-chat",      # 可选，省略则使用默认模型
        "api_key": "sk-xxx",           # 可选，覆盖后端配置；自定义模型时必填
        "base_url": "https://..."      # 可选，覆盖后端配置；自定义模型时必填
      }
    - 返回 NDJSON 流，每行形如：{"response": "..."}\\n
    """
    global conversation_history

    # 将用户的消息添加到对话历史中
    conversation_history.append({"role": "user", "content": user_message.content})

    # 解析本次调用配置
    runtime_cfg = resolve_runtime_config(user_message)
    client = create_client(api_key=runtime_cfg["api_key"], base_url=runtime_cfg["base_url"])

    # 组装请求参数
    request_params: Dict[str, Any] = {
        "model": runtime_cfg["model_name"],
        "messages": conversation_history,
        "stream": True,
    }
    request_params.update(runtime_cfg.get("request_params") or {})

    # 调用大模型进行流式文本生成
    try:
        response = client.chat.completions.create(**request_params)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # OpenAI 的 stream=True 返回的是同步 Stream，需在子线程中消费，再通过队列交给异步生成器
    async def stream_response():
        yield ": stream start\n\n"  # 立即刷新，避免首包被缓冲
        loop = asyncio.get_event_loop()
        queue = asyncio.Queue()

        def consume_stream():
            for chunk in response:
                asyncio.run_coroutine_threadsafe(queue.put(chunk), loop).result()
            asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()

        threading.Thread(target=consume_stream, daemon=True).start()
        assistant_message = ""

        while True:
            chunk = await queue.get()
            if chunk is None:
                break
            try:
                delta = chunk.choices[0].delta
            except (AttributeError, IndexError, KeyError):
                delta = None
            if delta and getattr(delta, "content", None):
                content = delta.content
                assistant_message += content
                payload = json.dumps({"response": content}, ensure_ascii=False)
                yield f"event: chunk\ndata: {payload}\n\n"

        if assistant_message:
            conversation_history.append({"role": "assistant", "content": assistant_message})
        yield "event: done\ndata: {}\n\n"

    # 返回 SSE 流式响应
    return StreamingResponse(
        stream_response(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/history/")
async def get_history():
    global conversation_history
    return {"history": conversation_history}


@app.post("/reset/")
async def reset_history():
    global conversation_history
    conversation_history = []
    return {"message": "Conversation history has been reset."}


@app.get("/models/")
async def list_models():
    """
    返回后端默认模型（前端也可不依赖该列表，直接自定义配置）。
    """
    return {
        "default": DEFAULT_MODEL_NAME,
        "models": [DEFAULT_MODEL_NAME],
    }


@app.post("/test_connection/")
async def test_connection(req: TestConnectionRequest):
    """
    测试 LLM 连接：使用当前填写的 base_url、api_key、model 发起一次简单对话。
    返回 success 与 message（成功时为模型回复，失败时为错误信息）。
    """
    success, message = check_llm_connection(
        base_url=req.base_url,
        api_key=req.api_key,
        model=req.model,
    )
    return {"success": success, "message": message or ""}


@app.post("/models/list/")
async def list_models_from_api(req: ListModelsRequest):
    """
    根据 base_url 与 api_key 从远程 API 拉取可用模型列表（OpenAI 兼容接口）。
    """
    models = get_available_models(base_url=req.base_url, api_key=req.api_key)
    return {"models": models}


@app.get("/health/")
async def health_check():
    return {"status": "ok"}
