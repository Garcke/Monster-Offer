import {contextBridge, ipcRenderer} from 'electron';
import {
    IPC_CHANNELS,
    type MeetingMonsterApi,
    type PrivacyStatus,
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
};

contextBridge.exposeInMainWorld('meetingMonster', meetingMonster);
