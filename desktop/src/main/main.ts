import {app, BrowserWindow, globalShortcut, ipcMain} from 'electron';
import path from 'node:path';
import {WindowPrivacyManager} from './privacy-manager';
import {
    IPC_CHANNELS,
    type PrivacyPolicy,
    type WindowMode,
    type WindowState,
} from '../shared/contracts';

const CAPSULE_BOUNDS = {width: 360, height: 56};
const EXPANDED_BOUNDS = {width: 720, height: 520};

let mainWindow: BrowserWindow | null = null;
let privacyManager: WindowPrivacyManager | null = null;
let windowMode: WindowMode = 'capsule';
let ipcHandlersRegistered = false;

function isAuthorizedSender(event: Electron.IpcMainInvokeEvent): boolean {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return Boolean(senderWindow && senderWindow === mainWindow && !senderWindow.isDestroyed());
}

function getPrivacyManager(): WindowPrivacyManager {
    if (!privacyManager) throw new Error('Privacy manager is not ready');
    return privacyManager;
}

function getWindowState(): WindowState {
    return {
        mode: windowMode,
        visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    };
}

function broadcastWindowState(): void {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send(IPC_CHANNELS.window.state, getWindowState());
}

function broadcastPrivacyStatus(): void {
    const manager = getPrivacyManager();
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.privacy.status, manager.getStatus());
    }
}

function setWindowMode(mode: WindowMode): WindowState {
    if (!mainWindow || mainWindow.isDestroyed()) return getWindowState();

    const target = mode === 'expanded' ? EXPANDED_BOUNDS : CAPSULE_BOUNDS;
    const current = mainWindow.getBounds();
    mainWindow.setBounds({
        x: current.x + Math.round((current.width - target.width) / 2),
        y: current.y + Math.round((current.height - target.height) / 2),
        ...target,
    }, false);
    windowMode = mode;
    broadcastWindowState();
    return getWindowState();
}

function registerIpcHandlers(): void {
    if (ipcHandlersRegistered) return;

    const handledChannels = [
        ...Object.values(IPC_CHANNELS.window).filter((channel) => channel !== IPC_CHANNELS.window.state),
        ...Object.values(IPC_CHANNELS.privacy).filter((channel) => channel !== IPC_CHANNELS.privacy.status),
    ];
    for (const channel of handledChannels) ipcMain.removeHandler(channel);

    ipcMain.handle(IPC_CHANNELS.privacy.getStatus, (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized privacy request');
        return getPrivacyManager().getStatus();
    });
    ipcMain.handle(IPC_CHANNELS.privacy.getPolicy, (event): PrivacyPolicy => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized privacy request');
        return {
            captureProtectionDefault: true,
            supportedPlatforms: ['win32', 'darwin'],
            captureProtectionShortcut: 'CommandOrControl+Shift+P',
            taskbarHidden: false,
        };
    });
    ipcMain.handle(IPC_CHANNELS.privacy.setCaptureProtection, (event, enabled: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized privacy request');
        if (typeof enabled !== 'boolean') throw new TypeError('capture protection state must be boolean');
        const manager = getPrivacyManager();
        manager.setCaptureProtection(enabled);
        return manager.getStatus();
    });
    ipcMain.handle(IPC_CHANNELS.window.getState, (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        return getWindowState();
    });
    ipcMain.handle(IPC_CHANNELS.window.setExpanded, (event, expanded: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        if (typeof expanded !== 'boolean') throw new TypeError('expanded state must be boolean');
        return setWindowMode(expanded ? 'expanded' : 'capsule');
    });
    ipcMain.handle(IPC_CHANNELS.window.toggleExpanded, (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        return setWindowMode(windowMode === 'expanded' ? 'capsule' : 'expanded');
    });
    ipcMain.handle(IPC_CHANNELS.window.hide, (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        mainWindow?.hide();
        return getWindowState();
    });
    ipcMain.handle(IPC_CHANNELS.window.show, (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized window request');
        mainWindow?.show();
        return getWindowState();
    });

    ipcHandlersRegistered = true;
}

function createMainWindow(): void {
    const manager = getPrivacyManager();
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
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    manager.registerWindow(mainWindow);
    mainWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.on('did-finish-load', () => {
        manager.reassertCaptureProtection();
        broadcastPrivacyStatus();
        broadcastWindowState();
    });
    mainWindow.once('ready-to-show', () => {
        setWindowMode('capsule');
        mainWindow?.show();
    });
    mainWindow.on('show', () => {
        manager.reassertCaptureProtection();
        broadcastWindowState();
    });
    mainWindow.on('hide', broadcastWindowState);
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    void mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'overlay.html'));
}

function startApplication(): void {
    privacyManager = new WindowPrivacyManager({onStatus: broadcastPrivacyStatus});
    registerIpcHandlers();
    createMainWindow();

    globalShortcut.register('CommandOrControl+Shift+P', () => {
        const manager = getPrivacyManager();
        manager.setCaptureProtection(!manager.getStatus().captureProtectionEnabled);
    });
    globalShortcut.register('CommandOrControl+Shift+M', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
    });
}

app.whenReady().then(startApplication).catch((error: unknown) => {
    console.error('[desktop] startup failed:', error);
    app.quit();
});

app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
});

app.on('before-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
