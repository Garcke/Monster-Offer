import {contextBridge, ipcRenderer} from 'electron';
import {
    IPC_CHANNELS,
    type MeetingMonsterApi,
    type PrivacyStatus,
    type ChatStreamEvent,
    type AsrResultEvent,
    type AsrStatus,
    type Unsubscribe,
    type WindowState,
} from '../shared/contracts';

let pcmPort: MessagePort | null = null;

function closePcmPort(): void {
    pcmPort?.close();
    pcmPort = null;
}

ipcRenderer.on(IPC_CHANNELS.asr.port, (event) => {
    const port = event.ports[0];
    if (!port) throw new Error('ASR PCM channel is unavailable');
    closePcmPort();
    pcmPort = port;
});

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
    asr: {
        start: async (sampleRate) => {
            try {
                const status = await ipcRenderer.invoke(IPC_CHANNELS.asr.start, sampleRate);
                if (!pcmPort) throw new Error('ASR PCM channel is unavailable');
                return status;
            } catch (error) {
                closePcmPort();
                throw error;
            }
        },
        writePcm: (chunk) => {
            if (!(chunk instanceof Int16Array) || !chunk.byteLength) throw new TypeError('PCM chunk must be Int16Array');
            if (!pcmPort) throw new Error('ASR is not recording');
            const copy = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
            pcmPort.postMessage(copy, [copy]);
        },
        stop: async () => {
            try {
                return await ipcRenderer.invoke(IPC_CHANNELS.asr.stop);
            } finally {
                closePcmPort();
            }
        },
        getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.asr.getStatus),
        onStatus: (callback: (status: AsrStatus) => void) => subscribe<AsrStatus>(IPC_CHANNELS.asr.status, (status) => {
            if (status.state === 'error' || status.state === 'idle') closePcmPort();
            callback(status);
        }),
        onResult: (callback: (event: AsrResultEvent) => void) => subscribe(IPC_CHANNELS.asr.result, callback),
    },
};

contextBridge.exposeInMainWorld('meetingMonster', meetingMonster);
