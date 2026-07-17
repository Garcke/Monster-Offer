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
    settings: {get: 'settings:get', set: 'settings:set'},
    models: {getStatus: 'models:get-status', configure: 'models:configure'},
    chat: {send: 'chat:send', cancel: 'chat:cancel'},
    asr: {start: 'asr:start', stop: 'asr:stop', status: 'asr:status'},
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
}
