import {app, BrowserWindow, globalShortcut, ipcMain, safeStorage, type WebContents} from 'electron';
import path from 'node:path';
import {DesktopSettingsStore, validateBackendUrl, type DesktopConnection} from './desktop-settings';
import {WindowPrivacyManager} from './privacy-manager';
import {RemoteApiClient, type ChatStreamEvent, type ModelProfileInput} from './remote-api-client';
import {
    IPC_CHANNELS,
    type ConnectionTestResult,
    type DesktopSettingsStatus,
    type PrivacyPolicy,
    type WindowMode,
    type WindowState,
} from '../shared/contracts';

const CAPSULE_BOUNDS = {width: 360, height: 56};
const EXPANDED_BOUNDS = {width: 720, height: 520};

let mainWindow: BrowserWindow | null = null;
let privacyManager: WindowPrivacyManager | null = null;
let settingsStore: DesktopSettingsStore | null = null;
let windowMode: WindowMode = 'capsule';
let ipcHandlersRegistered = false;
const activeChatRequests = new Map<string, {controller: AbortController; sender: WebContents}>();

function isAuthorizedSender(event: Electron.IpcMainInvokeEvent): boolean {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return Boolean(senderWindow && senderWindow === mainWindow && !senderWindow.isDestroyed());
}

function getPrivacyManager(): WindowPrivacyManager {
    if (!privacyManager) throw new Error('Privacy manager is not ready');
    return privacyManager;
}

function getSettingsStore(): DesktopSettingsStore {
    if (!settingsStore) throw new Error('Desktop settings are not ready');
    return settingsStore;
}

async function getRemoteApiClient(connection?: DesktopConnection): Promise<RemoteApiClient> {
    const configuredConnection = connection ?? await getSettingsStore().loadConnection();
    if (!configuredConnection) throw new Error('Remote server is not configured');
    return new RemoteApiClient({...configuredConnection, fetch});
}

function requireConnection(value: unknown): DesktopConnection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Connection settings are invalid');
    const candidate = value as Partial<DesktopConnection>;
    if (typeof candidate.baseUrl !== 'string' || typeof candidate.adminToken !== 'string') {
        throw new TypeError('Connection settings are invalid');
    }
    return {baseUrl: candidate.baseUrl, adminToken: candidate.adminToken};
}

function requireText(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
    return value.trim();
}

function requireProfile(value: unknown): ModelProfileInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Model profile is invalid');
    return value as ModelProfileInput;
}

function sendChatEvent(sender: WebContents, event: ChatStreamEvent): void {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== sender || sender.isDestroyed()) return;
    sender.send(IPC_CHANNELS.chat.event, event);
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
        ...Object.values(IPC_CHANNELS.settings),
        ...Object.values(IPC_CHANNELS.models),
        ...Object.values(IPC_CHANNELS.chat).filter((channel) => channel !== IPC_CHANNELS.chat.event),
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
    ipcMain.handle(IPC_CHANNELS.settings.get, async (event): Promise<DesktopSettingsStatus> => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized settings request');
        return getSettingsStore().loadStatus();
    });
    ipcMain.handle(IPC_CHANNELS.settings.set, async (event, value: unknown): Promise<DesktopSettingsStatus> => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized settings request');
        return getSettingsStore().saveConnection(requireConnection(value));
    });
    ipcMain.handle(IPC_CHANNELS.settings.clear, async (event): Promise<DesktopSettingsStatus> => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized settings request');
        await getSettingsStore().clearConnection();
        return getSettingsStore().loadStatus();
    });
    ipcMain.handle(IPC_CHANNELS.settings.test, async (event, value: unknown): Promise<ConnectionTestResult> => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized settings request');
        const connection = requireConnection(value);
        const baseUrl = validateBackendUrl(connection.baseUrl, app.isPackaged).href;
        return (await getRemoteApiClient({...connection, baseUrl})).testConnection();
    });
    ipcMain.handle(IPC_CHANNELS.models.list, async (event) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized models request');
        return (await getRemoteApiClient()).listModels();
    });
    ipcMain.handle(IPC_CHANNELS.models.create, async (event, profile: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized models request');
        return (await getRemoteApiClient()).createModel(requireProfile(profile));
    });
    ipcMain.handle(IPC_CHANNELS.models.update, async (event, profileId: unknown, profile: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized models request');
        return (await getRemoteApiClient()).updateModel(requireText(profileId, 'Model profile id'), requireProfile(profile));
    });
    ipcMain.handle(IPC_CHANNELS.models.delete, async (event, profileId: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized models request');
        return (await getRemoteApiClient()).deleteModel(requireText(profileId, 'Model profile id'));
    });
    ipcMain.handle(IPC_CHANNELS.models.activate, async (event, profileId: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized models request');
        return (await getRemoteApiClient()).activateModel(requireText(profileId, 'Model profile id'));
    });
    ipcMain.handle(IPC_CHANNELS.models.test, async (event, profile: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized models request');
        return (await getRemoteApiClient()).testModel(requireProfile(profile));
    });
    ipcMain.handle(IPC_CHANNELS.chat.send, async (event, requestId: unknown, content: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized chat request');
        const id = requireText(requestId, 'Chat request id');
        const question = requireText(content, 'Chat content');
        activeChatRequests.get(id)?.controller.abort();
        const controller = new AbortController();
        const sender = event.sender;
        activeChatRequests.set(id, {controller, sender});
        void (async () => {
            try {
                for await (const chatEvent of (await getRemoteApiClient()).streamChat({
                    requestId: id, content: question, signal: controller.signal,
                })) {
                    if (activeChatRequests.get(id)?.controller !== controller) return;
                    sendChatEvent(sender, chatEvent);
                }
            } catch {
                if (!controller.signal.aborted && activeChatRequests.get(id)?.controller === controller) {
                    sendChatEvent(sender, {requestId: id, type: 'error', text: 'Remote chat request failed'});
                }
            } finally {
                if (activeChatRequests.get(id)?.controller === controller) activeChatRequests.delete(id);
            }
        })();
        return {requestId: id};
    });
    ipcMain.handle(IPC_CHANNELS.chat.cancel, (event, requestId: unknown) => {
        if (!isAuthorizedSender(event)) throw new Error('Unauthorized chat request');
        const id = requireText(requestId, 'Chat request id');
        const activeRequest = activeChatRequests.get(id);
        if (!activeRequest || activeRequest.sender !== event.sender) return {cancelled: false};
        activeRequest.controller.abort();
        return {cancelled: true};
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
    settingsStore = new DesktopSettingsStore({
        safeStorage,
        settingsPath: path.join(app.getPath('userData'), 'desktop-settings.json'),
        production: app.isPackaged,
    });
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
