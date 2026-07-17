'use strict';

const {app, BrowserWindow, dialog, globalShortcut, ipcMain} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {WindowPrivacyManager} = require('./privacy_manager');

const PROJECT_ROOT = process.env.MONSTER_OFFER_PROJECT_ROOT || path.resolve(__dirname, '..');
const APP_HOST = '127.0.0.1';
const APP_PORT = Number(process.env.MONSTER_OFFER_APP_PORT || process.env.APP_PORT || 9000);
const SERVER_URL = `http://${APP_HOST}:${APP_PORT}`;
const SERVER_TIMEOUT_MS = 30_000;
const SERVER_POLL_MS = 400;
const CAPSULE_BOUNDS = {width: 360, height: 56};
const EXPANDED_BOUNDS = {width: 720, height: 520};

let mainWindow = null;
let sidecar = null;
let ownsSidecar = false;
let quitting = false;
let privacyManager = null;
let windowMode = 'capsule';

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function canReachServer() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
        const response = await fetch(`${SERVER_URL}/`, {signal: controller.signal});
        return response.status < 500;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

function isAllowedAppUrl(url) {
    try {
        return new URL(url).origin === SERVER_URL;
    } catch {
        return false;
    }
}

async function waitForServer(timeoutMs = SERVER_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await canReachServer()) return true;
        await sleep(SERVER_POLL_MS);
    }
    return false;
}

function resolvePythonCommand() {
    const override = process.env.MONSTER_OFFER_PYTHON;
    if (override) return override;

    const candidates = process.platform === 'win32'
        ? [path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe')]
        : [path.join(PROJECT_ROOT, '.venv', 'bin', 'python')];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'python';
}

function startSidecar() {
    const python = resolvePythonCommand();
    const environment = {
        ...process.env,
        APP_HOST,
        APP_PORT: String(APP_PORT),
    };
    sidecar = spawn(python, ['-m', 'server.app'], {
        cwd: PROJECT_ROOT,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    ownsSidecar = true;
    sidecar.stdout?.on('data', (chunk) => console.log(`[server] ${String(chunk).trimEnd()}`));
    sidecar.stderr?.on('data', (chunk) => console.error(`[server] ${String(chunk).trimEnd()}`));
    sidecar.once('error', (error) => console.error('[server] sidecar failed:', error));
    sidecar.once('exit', (code, signal) => {
        if (!quitting) console.error(`[server] sidecar exited with code=${code} signal=${signal}`);
        sidecar = null;
    });
}

async function ensureServer() {
    if (await canReachServer()) return;
    startSidecar();
    if (!(await waitForServer())) {
        throw new Error(`Python service did not become ready at ${SERVER_URL}`);
    }
}

function isAuthorizedSender(event) {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return Boolean(senderWindow && senderWindow === mainWindow && !senderWindow.isDestroyed());
}

function broadcastStatus(status) {
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('privacy:status', status);
    }
}

function getWindowState() {
    return {
        mode: windowMode,
        visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    };
}

function broadcastWindowState() {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('window:state', getWindowState());
}

function setWindowMode(mode) {
    if (mode !== 'capsule' && mode !== 'expanded') throw new TypeError('invalid window mode');
    if (!mainWindow || mainWindow.isDestroyed()) return getWindowState();

    const target = mode === 'expanded' ? EXPANDED_BOUNDS : CAPSULE_BOUNDS;
    const current = mainWindow.getBounds();
    const nextBounds = {
        x: current.x + Math.round((current.width - target.width) / 2),
        y: current.y + Math.round((current.height - target.height) / 2),
        ...target,
    };
    mainWindow.setBounds(nextBounds, false);
    windowMode = mode;
    broadcastWindowState();
    return getWindowState();
}

function registerIpcHandlers() {
    ipcMain.handle('privacy:get-status', (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized privacy request');
        return privacyManager.getStatus();
    });

    ipcMain.handle('privacy:get-policy', (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized privacy request');
        return {
            captureProtectionDefault: true,
            supportedPlatforms: ['win32', 'darwin'],
            captureProtectionShortcut: 'CommandOrControl+Shift+P',
            taskbarHidden: false,
        };
    });

    ipcMain.handle('privacy:set-capture-protection', (event, enabled) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized privacy request');
        if (typeof enabled !== 'boolean') throw new TypeError('capture protection state must be boolean');
        privacyManager.setCaptureProtection(enabled);
        return privacyManager.getStatus();
    });

    ipcMain.handle('window:get-state', (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        return getWindowState();
    });

    ipcMain.handle('window:set-expanded', (event, expanded) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        if (typeof expanded !== 'boolean') throw new TypeError('expanded state must be boolean');
        return setWindowMode(expanded ? 'expanded' : 'capsule');
    });

    ipcMain.handle('window:toggle-expanded', (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        return setWindowMode(windowMode === 'expanded' ? 'capsule' : 'expanded');
    });

    ipcMain.handle('window:hide', (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        mainWindow.hide();
        return getWindowState();
    });

    ipcMain.handle('window:show', (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        mainWindow.show();
        return getWindowState();
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        ...CAPSULE_BOUNDS,
        minWidth: CAPSULE_BOUNDS.width,
        minHeight: CAPSULE_BOUNDS.height,
        resizable: false,
        title: 'Meeting-Monster',
        show: false,
        alwaysOnTop: true,
        frame: false,
        transparent: true,
        hasShadow: false,
        autoHideMenuBar: true,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            additionalArguments: [`--meeting-monster-server-url=${SERVER_URL}`],
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    privacyManager.registerWindow(mainWindow);
    mainWindow.webContents.setWindowOpenHandler(({url}) => ({
        action: isAllowedAppUrl(url) ? 'allow' : 'deny',
    }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedAppUrl(url)) event.preventDefault();
    });
    mainWindow.webContents.on('did-finish-load', () => {
        privacyManager.reassertCaptureProtection();
        broadcastStatus(privacyManager.getStatus());
        broadcastWindowState();
    });
    mainWindow.once('ready-to-show', () => {
        setWindowMode('capsule');
        mainWindow?.show();
    });
    mainWindow.on('show', () => {
        privacyManager.reassertCaptureProtection();
        broadcastWindowState();
    });
    mainWindow.on('hide', () => {
        broadcastWindowState();
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html')).catch((error) => {
        console.error('[desktop] failed to load Meeting-Monster:', error);
    });
    mainWindow.show();
}

function stopSidecar() {
    if (!ownsSidecar || !sidecar) return;
    sidecar.kill();
    sidecar = null;
    ownsSidecar = false;
}

async function startApplication() {
    await ensureServer();
    privacyManager = new WindowPrivacyManager({
        platform: process.platform,
        onStatus: broadcastStatus,
    });
    registerIpcHandlers();
    createMainWindow();
    const registered = globalShortcut.register('CommandOrControl+Shift+P', () => {
        const {captureProtectionEnabled} = privacyManager.getStatus();
        privacyManager.setCaptureProtection(!captureProtectionEnabled);
    });
    if (!registered) console.warn('[desktop] privacy shortcut registration failed');
    const visibilityRegistered = globalShortcut.register('CommandOrControl+Shift+M', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
    });
    if (!visibilityRegistered) console.warn('[desktop] visibility shortcut registration failed');
}

app.whenReady().then(async () => {
    try {
        await startApplication();
    } catch (error) {
        console.error('[desktop] startup failed:', error);
        dialog.showErrorBox('Meeting-Monster 启动失败', error instanceof Error ? error.message : String(error));
        app.quit();
    }
});

app.on('activate', () => {
    if (!mainWindow) createMainWindow();
});

app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    stopSidecar();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
