# Monster Offer 窗口隐私防泄露设计

## 目标

在 Windows 桌面版 Monster Offer 中，降低线上会议、桌面共享和常见录屏工具捕获 Monster Offer 自身窗口内容的风险。保护对象包括悬浮控制条、实时转写、AI 回答和设置窗口；现有本地 ASR、FastAPI 和 LLM 协议保持不变。

本设计的边界是“保护应用自己的窗口内容”，不包含隐藏进程、规避监考或安全检测、修改第三方软件行为、注入或 Hook 其他进程。

## 方案选择

### 方案 A：系统级窗口捕获排除（推荐）

Electron 主进程对每个 Monster Offer 顶层窗口调用 `BrowserWindow.setContentProtection(true)`。Windows 下该 API 使用 `SetWindowDisplayAffinity`，在支持的系统和捕获路径上将窗口排除或显示为黑色区域。

优点：用户无需改变操作习惯，窗口仍可在本地正常显示；实现集中在桌面壳层，Python 服务无需改动。

限制：只作用于本进程窗口；不保证手机拍摄、硬件采集、管理员权限工具或不遵守系统捕获约束的工具；必须提供状态提示，不能宣称绝对防录屏。

### 方案 B：内容脱敏隐私模式

用户通过快捷键或悬浮窗按钮进入隐私模式。渲染层继续保留布局和控制，但将转写、问题、答案和 API 配置替换为占位符。退出隐私模式后恢复当前会话内容。

优点：即使录屏软件不遵守系统窗口保护，也不会直接获得敏感文本。缺点：需要用户主动操作，且隐私模式下不能阅读答案。

### 方案 C：监控或修改第三方捕获程序

不采用。该方向涉及进程隐藏、API Hook、DLL 注入、反调试或绕过第三方安全策略，超出隐私防护范围，也不具备稳定和可审计性。

## 推荐设计

采用 A+B 双层方案：

1. 系统级保护默认开启，覆盖所有 Monster Offer 顶层窗口。
2. 用户可用 `Ctrl+Shift+P` 或悬浮窗按钮切换内容脱敏隐私模式。
3. 桌面壳层报告保护状态：`protected`、`unsupported`、`failed`、`redacted`。
4. 不自动检测或控制 Zoom、Teams、OBS 等第三方进程；提供“共享前检查”页面，由用户主动验证当前工具是否遵守窗口保护。
5. Python sidecar 继续负责本地 ASR 和文本模型请求，敏感数据不经过新的第三方服务。

## 组件与数据流

```text
Electron main process
  ├─ 创建悬浮窗/回答窗/设置窗
  ├─ 调用 setContentProtection(true)
  ├─ 维护保护状态和快捷键
  └─ 通过受限 IPC 通知 renderer

Renderer
  ├─ 展示状态徽标和失败提示
  ├─ 根据 redacted 状态隐藏敏感内容
  └─ 通过 allowlist IPC 请求切换隐私模式

Python FastAPI sidecar
  ├─ /ws/asr：本地 sherpa-onnx 实时转写
  └─ /api/chat/：OpenAI Compatible / Anthropic Messages
```

IPC 只开放固定命令：

- `privacy:get-status`
- `privacy:set-redacted`
- `privacy:get-policy`

主进程必须校验 IPC 的 sender 是否属于已创建的 Monster Offer 窗口；renderer 不得直接访问 Node.js、文件系统或任意 IPC channel。

## 状态和失败处理

- `protected`：系统 API 调用成功，窗口处于捕获保护状态。
- `unsupported`：系统版本或窗口环境不支持，提示用户改用内容脱敏模式。
- `failed`：API 调用失败，记录错误码和窗口标识，不隐藏错误。
- `redacted`：用户主动启用内容脱敏，界面只显示占位内容。

启动时先尝试系统级保护，再显示状态；保护失败不阻止 ASR、AI 回答或主窗口启动。用户退出隐私模式前再次确认当前保护状态。

## 安全与隐私要求

- 默认不保存截图、麦克风原始音频和完整转写历史到磁盘。
- API 密钥继续由 Python 服务端从 `.env` 或配置文件读取，不能下发到 renderer。
- UI 必须显示保护状态，不能使用“不可检测”“绝对安全”等表述。
- 清空会话时同时清理内存中的转写和回答缓存。
- 记录最小化的本地诊断日志，不记录答案正文或 API 密钥。

## 测试计划

在 Windows 10 2004、Windows 11 上验证：

1. Teams、Zoom、OBS、Windows 截图工具分别共享单个窗口和整个桌面。
2. Monster Offer 窗口在本机仍可见，捕获结果中应被排除或显示黑色区域。
3. 系统不支持或 API 失败时，状态徽标变为 `unsupported`/`failed`，内容脱敏仍可用。
4. 打开和关闭 `Ctrl+Shift+P` 后，敏感文本只在本地正确恢复，不触发新的 ASR 或 LLM 请求。
5. 多窗口、窗口重建、最小化/恢复和程序退出后，保护状态不会泄漏到其他应用。
6. IPC allowlist、sender 校验和 renderer 沙箱配置通过安全检查。

## 验收标准

- 所有 Monster Offer 顶层窗口默认启用系统级捕获保护。
- 用户可以在一个快捷键内启用内容脱敏，并看到清晰状态。
- 保护不可用时有可见告警和安全降级，不阻塞正常面试功能。
- 不新增任何隐藏、注入、Hook 或绕过第三方检测逻辑。
- 现有 Python 服务、ASR WebSocket、`/api/chat/` 和模型配置接口保持兼容。
