import {contextBridge, ipcRenderer} from 'electron';
import {
    IPC_CHANNELS,
    type MeetingMonsterApi,
    type PrivacyStatus,
    type ChatStreamEvent,
    type Unsubscribe,
    type WindowState,
} from '../shared/contracts';

function subscribe<T>(channel: string, callback: (value: T) => void): Unsubscribe {
    if (typeof callback !== 'function') throw new TypeError('Meeting Monster event callback must be a function');
    const listener = (_event: unknown, value: T) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

const meetingMonster: MeetingMonsterApi = {
    window: {
        getState: () => ipcRenderer.invoke(IPC_CHANNELS.window.getState),
        setExpanded: (expanded) => ipcRenderer.invoke(IPC_CHANNELS.window.setExpanded, Boolean(expanded)),
        toggleExpanded: () => ipcRenderer.invoke(IPC_CHANNELS.window.toggleExpanded),
        hide: () => ipcRenderer.invoke(IPC_CHANNELS.window.hide),
        show: () => ipcRenderer.invoke(IPC_CHANNELS.window.show),
        onState: (callback: (state: WindowState) => void) => subscribe(IPC_CHANNELS.window.state, callback),
    },
    privacy: {
        getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.privacy.getStatus),
        getPolicy: () => ipcRenderer.invoke(IPC_CHANNELS.privacy.getPolicy),
        setCaptureProtection: (enabled) => ipcRenderer.invoke(
            IPC_CHANNELS.privacy.setCaptureProtection,
            Boolean(enabled),
        ),
        onStatus: (callback: (status: PrivacyStatus) => void) => subscribe(IPC_CHANNELS.privacy.status, callback),
    },
    settings: {
        getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.settings.get),
        saveConnection: (connection) => ipcRenderer.invoke(IPC_CHANNELS.settings.set, connection),
        clearConnection: () => ipcRenderer.invoke(IPC_CHANNELS.settings.clear),
        testConnection: (connection) => ipcRenderer.invoke(IPC_CHANNELS.settings.test, connection),
    },
    models: {
        list: () => ipcRenderer.invoke(IPC_CHANNELS.models.list),
        create: (profile) => ipcRenderer.invoke(IPC_CHANNELS.models.create, profile),
        update: (profileId, profile) => ipcRenderer.invoke(IPC_CHANNELS.models.update, profileId, profile),
        delete: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.models.delete, profileId),
        activate: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.models.activate, profileId),
        test: (profile) => ipcRenderer.invoke(IPC_CHANNELS.models.test, profile),
    },
    chat: {
        send: (requestId, content) => ipcRenderer.invoke(IPC_CHANNELS.chat.send, requestId, content),
        cancel: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.chat.cancel, requestId),
        onEvent: (callback: (event: ChatStreamEvent) => void) => subscribe(IPC_CHANNELS.chat.event, callback),
    },
};

contextBridge.exposeInMainWorld('meetingMonster', meetingMonster);
