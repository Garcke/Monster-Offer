export const IPC_CHANNELS = {
    window: {
        getState: 'window:get-state',
        setExpanded: 'window:set-expanded',
        toggleExpanded: 'window:toggle-expanded',
        hide: 'window:hide',
        show: 'window:show',
        state: 'window:state',
    },
    privacy: {
        getStatus: 'privacy:get-status',
        getPolicy: 'privacy:get-policy',
        setCaptureProtection: 'privacy:set-capture-protection',
        status: 'privacy:status',
    },
    settings: {
        get: 'settings:get', set: 'settings:set', clear: 'settings:clear', test: 'settings:test-connection',
    },
    models: {
        list: 'models:list', create: 'models:create', update: 'models:update', delete: 'models:delete',
        activate: 'models:activate', test: 'models:test',
    },
    chat: {send: 'chat:send', cancel: 'chat:cancel', event: 'chat:event'},
    asr: {
        start: 'asr:start',
        stop: 'asr:stop',
        getStatus: 'asr:get-status',
        status: 'asr:status',
        result: 'asr:result',
        port: 'asr:port',
    },
} as const;

type ValueOf<T> = T[keyof T];

export type IpcChannel = ValueOf<ValueOf<typeof IPC_CHANNELS>>;
export type WindowMode = 'capsule' | 'expanded';
export type CaptureProtection = 'protected' | 'disabled' | 'failed' | 'unsupported';

export interface WindowState {
    mode: WindowMode;
    visible: boolean;
}

export interface PrivacyStatus {
    captureProtection: CaptureProtection;
    captureProtectionEnabled: boolean;
    platform: NodeJS.Platform;
    windowCount: number;
}

export interface PrivacyPolicy {
    captureProtectionDefault: true;
    supportedPlatforms: readonly ['win32', 'darwin'];
    captureProtectionShortcut: 'CommandOrControl+Shift+P';
    taskbarHidden: false;
}

export interface DesktopSettingsStatus {
    configured: boolean;
    baseUrl: string | null;
}

export interface DesktopConnectionInput {
    baseUrl: string;
    adminToken: string;
}

export interface ConnectionTestResult {
    status: 'connected' | 'unauthorized' | 'unreachable';
    adminAuthorized: boolean;
}

export interface ChatStreamEvent {
    requestId: string;
    type: 'chunk' | 'done' | 'error';
    text?: string;
}

export type AsrState = 'idle' | 'connecting' | 'recording' | 'stopping' | 'error';

export interface AsrStatus {
    state: AsrState;
    message?: string;
}

export interface AsrResultEvent {
    type: 'partial' | 'final' | 'error';
    text: string;
}

export type Unsubscribe = () => void;

export interface MeetingMonsterApi {
    window: {
        getState(): Promise<WindowState>;
        setExpanded(expanded: boolean): Promise<WindowState>;
        toggleExpanded(): Promise<WindowState>;
        hide(): Promise<WindowState>;
        show(): Promise<WindowState>;
        onState(callback: (state: WindowState) => void): Unsubscribe;
    };
    privacy: {
        getStatus(): Promise<PrivacyStatus>;
        getPolicy(): Promise<PrivacyPolicy>;
        setCaptureProtection(enabled: boolean): Promise<PrivacyStatus>;
        onStatus(callback: (status: PrivacyStatus) => void): Unsubscribe;
    };
    settings: {
        getStatus(): Promise<DesktopSettingsStatus>;
        saveConnection(connection: DesktopConnectionInput): Promise<DesktopSettingsStatus>;
        clearConnection(): Promise<DesktopSettingsStatus>;
        testConnection(connection: DesktopConnectionInput): Promise<ConnectionTestResult>;
    };
    models: {
        list(): Promise<unknown>;
        create(profile: Record<string, unknown>): Promise<unknown>;
        update(profileId: string, profile: Record<string, unknown>): Promise<unknown>;
        delete(profileId: string): Promise<void>;
        activate(profileId: string): Promise<unknown>;
        test(profile: Record<string, unknown>): Promise<unknown>;
    };
    chat: {
        send(requestId: string, content: string): Promise<{requestId: string}>;
        cancel(requestId: string): Promise<{cancelled: boolean}>;
        onEvent(callback: (event: ChatStreamEvent) => void): Unsubscribe;
    };
    asr: {
        start(sampleRate: number): Promise<AsrStatus>;
        writePcm(chunk: Int16Array): void;
        stop(): Promise<AsrStatus>;
        getStatus(): Promise<AsrStatus>;
        onStatus(callback: (status: AsrStatus) => void): Unsubscribe;
        onResult(callback: (event: AsrResultEvent) => void): Unsubscribe;
    };
}
