# Meeting-Monster Window Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Add a Windows-first Electron desktop shell that starts the existing Python service, protects all Meeting-Monster windows from supported capture paths, and provides a visible content-redaction privacy mode.

**Architecture:** The Electron main process owns the BrowserWindow lifecycle, starts or reuses the local FastAPI sidecar, and delegates window policy to `WindowPrivacyManager`. A narrow preload bridge exposes only privacy status and redaction commands to the existing web frontend. The Python ASR, LLM, WebSocket, and HTTP routes remain unchanged.

**Tech Stack:** Electron, Node.js CommonJS main process, context-isolated preload, existing vanilla HTML/CSS/ES modules, Python FastAPI sidecar, Node `node:test`.

## Global Constraints

- Windows desktop is the first supported target; non-Windows reports capture protection as unsupported.
- Every Meeting-Monster top-level window receives `setContentProtection(true)` when it is created or re-created.
- `Ctrl+Shift+P` toggles content redaction; redaction never triggers a new ASR or LLM request.
- Taskbar/Dock hiding, process disguise, API Hooking, DLL injection, anti-debugging, and third-party window manipulation are excluded.
- Existing `/ws/asr`, `/api/chat/`, model configuration, and Python service behavior remain compatible.
- Renderer access is limited to an allowlisted preload API; no `nodeIntegration`, arbitrary IPC channel, filesystem, environment, or API-key access.

---

### Task 1: Add a testable privacy state manager

**Files:**
- Create: `desktop/privacy_manager.js`
- Create: `tests/test_privacy_manager.mjs`

**Interfaces:**
- Consumes: BrowserWindow-like objects with `setContentProtection`, optional `isContentProtected`, and optional `once` methods.
- Produces: `WindowPrivacyManager` with `registerWindow(win)`, `unregisterWindow(win)`, `reassertCaptureProtection()`, `setRedacted(enabled)`, `toggleRedacted()`, and `getStatus()`.

- [ ] **Step 1: Write failing tests for Windows protection, unsupported platforms, failures, redaction, and reassertion.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {WindowPrivacyManager} from '../desktop/privacy_manager.js';

function fakeWindow({protectedState = true, throws = false} = {}) {
    return {
        calls: 0,
        setContentProtection(enabled) {
            this.calls += 1;
            if (throws) throw new Error('SetWindowDisplayAffinity failed');
            this.protectedState = enabled;
        },
        isContentProtected() {
            return this.protectedState;
        },
        once() {},
    };
}

test('protects registered Windows windows and reports protected', () => {
    const win = fakeWindow();
    const manager = new WindowPrivacyManager({platform: 'win32'});
    manager.registerWindow(win);
    assert.equal(win.calls, 1);
    assert.equal(manager.getStatus().captureProtection, 'protected');
});

test('does not call capture API on unsupported platforms', () => {
    const win = fakeWindow();
    const manager = new WindowPrivacyManager({platform: 'linux'});
    manager.registerWindow(win);
    assert.equal(win.calls, 0);
    assert.equal(manager.getStatus().captureProtection, 'unsupported');
});

test('reports failed when the OS call throws', () => {
    const manager = new WindowPrivacyManager({platform: 'win32'});
    manager.registerWindow(fakeWindow({throws: true}));
    assert.equal(manager.getStatus().captureProtection, 'failed');
});

test('redaction is independent from capture protection', () => {
    const manager = new WindowPrivacyManager({platform: 'win32'});
    manager.setRedacted(true);
    assert.equal(manager.getStatus().redaction, 'on');
    manager.toggleRedacted();
    assert.equal(manager.getStatus().redaction, 'off');
});

test('reasserts protection for every registered window', () => {
    const first = fakeWindow();
    const second = fakeWindow();
    const manager = new WindowPrivacyManager({platform: 'win32'});
    manager.registerWindow(first);
    manager.registerWindow(second);
    first.calls = 0;
    second.calls = 0;
    manager.reassertCaptureProtection();
    assert.equal(first.calls, 1);
    assert.equal(second.calls, 1);
});
```

- [ ] **Step 2: Run the new test to verify it fails because the manager does not exist.**

Run: `node --test tests/test_privacy_manager.mjs`

Expected: FAIL with an import or constructor error for `WindowPrivacyManager`.

- [ ] **Step 3: Implement the minimal manager and status contract.**

```js
class WindowPrivacyManager {
    constructor({platform = process.platform, onStatus = () => {}} = {}) {
        this.platform = platform;
        this.onStatus = onStatus;
        this.windows = new Set();
        this.captureProtection = platform === 'win32' ? 'protected' : 'unsupported';
        this.redaction = 'off';
    }

    registerWindow(win) {
        this.windows.add(win);
        if (typeof win.once === 'function') win.once('closed', () => this.unregisterWindow(win));
        this._applyToWindow(win);
        this._notify();
    }

    unregisterWindow(win) {
        this.windows.delete(win);
    }

    reassertCaptureProtection() {
        for (const win of this.windows) this._applyToWindow(win);
        this._notify();
    }

    setRedacted(enabled) {
        this.redaction = enabled ? 'on' : 'off';
        this._notify();
    }

    toggleRedacted() {
        this.setRedacted(this.redaction !== 'on');
    }

    getStatus() {
        return {
            captureProtection: this.captureProtection,
            redaction: this.redaction,
            platform: this.platform,
            windowCount: this.windows.size,
        };
    }

    _applyToWindow(win) {
        if (this.platform !== 'win32' || typeof win.setContentProtection !== 'function') {
            this.captureProtection = 'unsupported';
            return;
        }
        try {
            win.setContentProtection(true);
            this.captureProtection = typeof win.isContentProtected === 'function' && !win.isContentProtected()
                ? 'failed'
                : 'protected';
        } catch {
            this.captureProtection = 'failed';
        }
    }

    _notify() {
        this.onStatus(this.getStatus());
    }
}

module.exports = {WindowPrivacyManager};
```

- [ ] **Step 4: Run the focused test and then commit the manager.**

Run: `node --test tests/test_privacy_manager.mjs`

Expected: 5 passing tests.

Commit: `git add desktop/privacy_manager.js tests/test_privacy_manager.mjs && git commit -m "feat: add window privacy state manager"`

### Task 2: Add the Electron shell and Python sidecar lifecycle

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/main.js`
- Create: `desktop/preload.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `WindowPrivacyManager` from Task 1 and the existing `server.py` at the project root.
- Produces: Electron app entrypoint, narrow `window.monsterOfferPrivacy` preload API, local sidecar startup, and `BrowserWindow` registration.

- [ ] **Step 1: Add the Electron package metadata without installing dependencies yet.**

```json
{
  "name": "meeting-monster-desktop",
  "version": "0.1.0",
  "private": true,
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "check": "node --check main.js && node --check preload.js && node --check privacy_manager.js"
  },
  "devDependencies": {
    "electron": "37.2.6"
  }
}
```

- [ ] **Step 2: Implement `main.js` with sidecar reuse, window protection, IPC validation, and cleanup.**

The main process must:

1. Probe `http://127.0.0.1:${APP_PORT}/` before spawning Python.
2. Spawn `.venv\\Scripts\\python.exe server.py` when no server is reachable, falling back to `python`.
3. Use `MONSTER_OFFER_PYTHON` and `MONSTER_OFFER_PROJECT_ROOT` overrides for packaged/dev environments.
4. Wait up to 30 seconds for the server before showing a failure dialog.
5. Create one visible 1180×760 BrowserWindow with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `alwaysOnTop: true`, and the preload bridge.
6. Register the window in `WindowPrivacyManager` and reassert protection after `did-finish-load`.
7. Register `CommandOrControl+Shift+P`; unregister it before quit.
8. Accept only the three allowlisted IPC commands and validate the sender BrowserWindow.
9. Kill only a Python child process spawned by this Electron instance.

- [ ] **Step 3: Implement `preload.js` with only typed privacy methods.**

Expose exactly:

```js
contextBridge.exposeInMainWorld('monsterOfferPrivacy', {
    getStatus: () => ipcRenderer.invoke('privacy:get-status'),
    setRedacted: (enabled) => ipcRenderer.invoke('privacy:set-redacted', Boolean(enabled)),
    getPolicy: () => ipcRenderer.invoke('privacy:get-policy'),
    onStatus: (callback) => {
        const listener = (_event, status) => callback(status);
        ipcRenderer.on('privacy:status', listener);
        return () => ipcRenderer.removeListener('privacy:status', listener);
    },
});
```

- [ ] **Step 4: Extend `.gitignore` for Electron artifacts and run syntax checks.**

Run: `node --check desktop/main.js; node --check desktop/preload.js; node --check desktop/privacy_manager.js`

Expected: all commands exit with code 0.

- [ ] **Step 5: Commit the desktop shell.**

Commit: `git add desktop .gitignore && git commit -m "feat: add Electron privacy desktop shell"`

### Task 3: Add renderer privacy mode and visible status controls

**Files:**
- Create: `static/privacy_mode.js`
- Modify: `static/index.html`
- Modify: `static/styles.css`
- Modify: `tests/test_frontend_structure.mjs`

**Interfaces:**
- Consumes: `window.monsterOfferPrivacy` from Task 2.
- Produces: visible protection status, `Ctrl+Shift+P`-compatible redaction state, and a shield that replaces sensitive content visually.

- [ ] **Step 1: Add structural assertions for the privacy control and redaction shield.**

```js
test('privacy controls and redaction shield are present', () => {
    assert.match(html, /id="privacyStatusBadge"/);
    assert.match(html, /id="privacyToggleButton"/);
    assert.match(html, /id="privacyRedactionShield"/);
    assert.match(css, /\.privacy-redaction-shield/);
    assert.match(scripts + privacyScript, /monsterOfferPrivacy/);
});
```

The test must read `static/privacy_mode.js` alongside the existing HTML, CSS, and scripts.

- [ ] **Step 2: Add the header controls and shield markup.**

Add a status badge and button in `.header-actions`, plus this shield immediately inside `<body>`:

```html
<div id="privacyRedactionShield" class="privacy-redaction-shield hidden" role="status" aria-live="polite">
    <span class="privacy-shield-icon" aria-hidden="true">◆</span>
    <strong>隐私保护中</strong>
    <span>转写和 AI 回答已暂时隐藏</span>
    <button id="privacyShieldToggle" class="button button-primary button-small" type="button">恢复显示</button>
</div>
```

Load `privacy_mode.js` before `scripts.js` so it can initialize the bridge independently.

- [ ] **Step 3: Implement `privacy_mode.js`.**

The script must no-op when loaded in a normal browser without the preload API. In Electron it must:

- call `getStatus()` once;
- subscribe with `onStatus()`;
- render `protected`, `unsupported`, and `failed` copy without exposing error details;
- show the toggle only in Electron;
- add/remove `privacy-redacted` on `<body>` and show/hide the shield;
- make both the header button and shield button call `setRedacted(current.redaction !== 'on')` using the current status;
- never touch transcript text, answer text, localStorage, or network requests.

- [ ] **Step 4: Add CSS for the status badge and full-page redaction shield.**

The shield must be fixed above page content with a neutral surface, no transcript or answer text, and a visible restore action. It must not use `filter: blur()` as the only protection because blurred text can remain partially readable.

- [ ] **Step 5: Run frontend tests and commit the renderer changes.**

Run: `node --test tests/test_frontend_structure.mjs tests/test_question_store.mjs; node --check static/privacy_mode.js; node --check static/scripts.js`

Expected: all tests pass and both syntax checks exit with code 0.

Commit: `git add static tests/test_frontend_structure.mjs && git commit -m "feat: add visible privacy redaction mode"`

### Task 4: Add startup documentation and sidecar verification

**Files:**
- Modify: `README.md`
- Modify: `start.bat`
- Create: `desktop/README.md`

**Interfaces:**
- Consumes: Electron startup behavior from Task 2 and privacy controls from Task 3.
- Produces: reproducible local development instructions and explicit privacy limitations.

- [ ] **Step 1: Document the one-command Electron development flow.**

Document:

```powershell
cd desktop
npm install
npm start
```

Explain that Electron starts or reuses the Python server at `http://127.0.0.1:9000/`, and that the existing `start.bat` remains available for browser-only use.

- [ ] **Step 2: Document privacy behavior and limitations.**

Include the `Ctrl+Shift+P` shortcut, supported Windows capture paths, unsupported/failure states, recommended window-only sharing, and the fact that phone cameras, hardware capture, privileged tools, and non-cooperating capture drivers cannot be guaranteed against.

- [ ] **Step 3: Run the Python regression suite and commit documentation.**

Run: `.venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_*.py" -v`

Expected: all existing Python tests pass.

Commit: `git add README.md start.bat desktop/README.md && git commit -m "docs: document Electron privacy startup"`

### Task 5: Run the complete verification matrix and sync the runnable workspace

**Files:**
- Verify only: `desktop/*`, `static/*`, `tests/*`, `server.py`, `llm_api.py`, `llm_providers.py`

- [ ] **Step 1: Run all Node tests and syntax checks.**

Run: `node --test tests/*.mjs; node --check desktop/main.js; node --check desktop/preload.js; node --check desktop/privacy_manager.js; node --check static/privacy_mode.js; node --check static/scripts.js`

Expected: all Node tests pass and all syntax checks exit with code 0.

- [ ] **Step 2: Run all Python tests and dependency checks.**

Run: `.venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_*.py" -v; uv pip check --python .venv\\Scripts\\python.exe`

Expected: all Python tests pass and `uv pip check` reports compatible packages.

- [ ] **Step 3: Verify no unsafe stealth behavior was added.**

Run: `rg -n "setSkipTaskbar|app\.dock\.hide|process\.title|undetectable|SetWindowLong|WriteProcessMemory|CreateRemoteThread|VirtualAllocEx" desktop static README.md`

Expected: no matches in new Meeting-Monster implementation files.

- [ ] **Step 4: Copy only the new runnable source files to the local runtime workspace.**

Copy `desktop`, `static/privacy_mode.js`, the updated `static/index.html`, `static/styles.css`, `README.md`, and `start.bat` from `QW-InterviewAssitsant-remote-sync` to `QW-InterviewAssitsant-main`, preserving the local `.venv`, `.uv-cache`, and `models` directories.

- [ ] **Step 5: Review repository status and record the final commit list.**

Run: `git -c safe.directory="D:\\Code Project\\QW-InterviewAssitsant-remote-sync" -C "D:\\Code Project\\QW-InterviewAssitsant-remote-sync" status --short; git -c safe.directory="D:\\Code Project\\QW-InterviewAssitsant-remote-sync" -C "D:\\Code Project\\QW-InterviewAssitsant-remote-sync" log --oneline -6`

Expected: the tracked repository is clean after the implementation commits.
