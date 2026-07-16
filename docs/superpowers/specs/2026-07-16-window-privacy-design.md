# Meeting-Monster 窗口隐私防泄露设计

## 1. 目标和边界

Meeting-Monster Windows 桌面版需要降低线上会议、桌面共享和常见录屏工具捕获本应用窗口内容的风险。保护对象包括悬浮控制条、实时转写、AI 回答和设置窗口。

本方案只保护 Meeting-Monster 自己创建的窗口和本地数据，不控制 Zoom、Teams、OBS 或其他第三方进程，也不实现进程隐藏、反调试、API Hook、DLL 注入、窗口伪装或绕过第三方安全检测。

现有 Python FastAPI、sherpa-onnx 本地 ASR、OpenAI Compatible / Anthropic LLM 接口保持不变。Electron 桌面层负责窗口管理和隐私策略，Python sidecar 继续负责语音识别与文本模型请求。

## 2. 总体架构

```text
Electron 主进程
  ├─ WindowPrivacyManager：管理所有 Meeting-Monster 顶层窗口
  ├─ GlobalShortcut：注册隐私模式快捷键
  ├─ IPC Policy：校验 sender，只开放固定命令
  └─ PrivacyStatus：维护保护状态和诊断信息

Electron 渲染进程
  ├─ 显示隐私保护状态徽标
  ├─ 根据 redaction 状态显示真实内容或占位内容
  └─ 通过受限 IPC 请求切换隐私模式

Python sidecar
  ├─ /ws/asr：本地实时语音识别
  └─ /api/chat/：OpenAI Compatible / Anthropic Messages 流式回答
```

## 3. 系统级窗口保护

Electron 主进程创建或重建窗口后，统一调用：

```ts
browserWindow.setContentProtection(true)
```

Windows 下该 API 使用系统的窗口显示亲和性机制。支持的 Windows 10 2004+ 和 Windows 11 捕获路径会尝试排除该窗口；旧系统或不遵守系统约束的捕获工具可能显示黑色或仍然捕获，因此应用必须提供状态提示，不能宣称绝对防录屏。

`WindowPrivacyManager` 的职责：

1. 保存所有活动窗口的弱引用或受控引用。
2. 窗口创建、显示、重建和恢复时应用保护。
3. 对相同状态变更去重，避免频繁触发 DWM 状态切换。
4. 在窗口生命周期变化后重新应用当前策略。
5. 不修改第三方窗口，不遍历或操作其他进程的 HWND。

需要保护的窗口清单：

- 主工作台窗口；
- 悬浮控制窗口；
- AI 回答窗口；
- 模型和应用设置窗口；
- 截图裁剪或预览窗口。

## 4. 内容脱敏隐私模式

系统级窗口保护之外，应用提供一个明确的“内容脱敏隐私模式”。快捷键固定为 `Ctrl+Shift+P`，悬浮窗中同时提供按钮。

开启后：

- 实时转写文本替换为“隐私保护中”；
- 面试问题和 AI 回答替换为占位内容；
- API 地址、模型名称和本地路径不显示；
- 录音状态、连接状态和保护状态仍然可见；
- 不触发新的 ASR 或 LLM 请求；
- 当前会话数据仍保留在内存中，退出脱敏模式后恢复显示。

关闭后恢复当前会话内容，并重新读取主进程报告的捕获保护状态。

脱敏模式不是隐藏窗口，而是在本应用内部主动减少敏感内容，从而为不完全遵守系统捕获约束的录屏工具提供安全降级。

## 5. 状态模型和用户界面

主进程维护两个互相独立的状态：

```ts
type CaptureProtectionState = 'protected' | 'unsupported' | 'failed';
type RedactionState = 'off' | 'on';
```

界面显示组合状态：

- `protected + off`：系统保护已开启；
- `protected + on`：系统保护和内容脱敏均已开启；
- `unsupported/failed + off`：显示风险警告，并建议用户开启内容脱敏；
- `unsupported/failed + on`：显示“内容脱敏已开启，系统捕获保护不可用”。

失败信息只记录窗口类型、平台版本和系统错误码，不记录答案正文、音频或 API 密钥。

## 6. IPC 安全策略

只开放以下固定命令：

- `privacy:get-status`
- `privacy:set-redacted`
- `privacy:get-policy`

主进程必须验证 IPC sender 属于已创建的 Meeting-Monster 窗口，并拒绝未知 channel、任意脚本参数和跨窗口控制。渲染进程保持 `nodeIntegration: false`、`contextIsolation: true` 和沙箱配置，不直接访问文件系统、环境变量或 API 密钥。

## 7. 数据隐私要求

- 默认不保存麦克风原始音频和完整转写历史到磁盘。
- 截图只在用户主动触发时生成，并在处理完成后清理临时文件。
- API 密钥继续由 Python 服务端从 `.env` 或配置文件读取，不下发到渲染进程。
- 清空会话时同时清理内存中的转写、问题和回答缓存。
- 本地诊断日志不包含答案正文、音频、截图内容或 API 密钥。
- 允许普通的“最小化到托盘”用户体验，但它不属于安全机制，也不能用于规避第三方检测。

## 8. 共享前检查和限制说明

应用提供共享前检查页面，检查当前系统版本、窗口保护调用结果和当前隐私模式状态。检查结果只用于提示用户，不自动检测或控制第三方会议软件。

界面必须明确说明：

- 系统级保护只覆盖支持该机制的捕获路径；
- 手机拍摄、硬件采集、管理员权限工具和特殊捕获驱动无法保证被阻止；
- 最安全的会议操作是只共享指定窗口，而不是共享整个桌面；
- 需要更高隔离等级时，应使用独立 Windows 用户、虚拟机或单独设备。

## 9. 测试计划

在 Windows 10 2004、Windows 11 上验证：

1. Teams、Zoom、OBS 和 Windows 截图工具共享单个窗口。
2. 上述工具共享整个桌面和多显示器桌面。
3. Meeting-Monster 窗口在本机仍可操作，捕获结果中按工具能力被排除或显示黑色区域。
4. 模拟系统不支持或 API 失败，确认状态变为 `unsupported`/`failed`，内容脱敏仍可用。
5. 快捷键开启和关闭脱敏模式，确认不会触发新的 ASR 或 LLM 请求。
6. 窗口创建、销毁、重建、最小化、恢复和程序退出后，保护状态正确收敛。
7. 验证 IPC allowlist、sender 校验、渲染进程沙箱和敏感数据日志脱敏。
8. 验证普通最小化到托盘只影响用户界面，不改变捕获保护和进程身份。

## 10. 验收标准

- 所有 Meeting-Monster 顶层窗口默认启用系统级捕获保护。
- 用户可以通过按钮或 `Ctrl+Shift+P` 启用内容脱敏。
- 保护不可用时有可见告警和安全降级，不阻塞 ASR、LLM 或会议工作流。
- 状态、错误和测试结果可审计，但不泄露敏感内容。
- 不新增隐藏进程、窗口伪装、注入、Hook、反调试或绕过第三方检测逻辑。
- Python 服务、`/ws/asr`、`/api/chat/` 和现有模型配置接口保持兼容。
