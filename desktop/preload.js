'use strict';

const {contextBridge, ipcRenderer} = require('electron');

const serverUrlArgument = process.argv.find((argument) => (
    argument.startsWith('--meeting-monster-server-url=')
));
const serverUrl = serverUrlArgument?.slice('--meeting-monster-server-url='.length);

contextBridge.exposeInMainWorld('monsterOfferPrivacy', {
    getStatus: () => ipcRenderer.invoke('privacy:get-status'),
    setCaptureProtection: (enabled) => ipcRenderer.invoke('privacy:set-capture-protection', Boolean(enabled)),
    getPolicy: () => ipcRenderer.invoke('privacy:get-policy'),
    onStatus: (callback) => {
        if (typeof callback !== 'function') {
            throw new TypeError('privacy status callback must be a function');
        }
        const listener = (_event, status) => callback(status);
        ipcRenderer.on('privacy:status', listener);
        return () => ipcRenderer.removeListener('privacy:status', listener);
    },
});

contextBridge.exposeInMainWorld('meetingMonsterDesktop', {
    serverUrl,
    getWindowState: () => ipcRenderer.invoke('window:get-state'),
    setExpanded: (expanded) => ipcRenderer.invoke('window:set-expanded', Boolean(expanded)),
    toggleExpanded: () => ipcRenderer.invoke('window:toggle-expanded'),
    hideWindow: () => ipcRenderer.invoke('window:hide'),
    showWindow: () => ipcRenderer.invoke('window:show'),
    onWindowState: (callback) => {
        if (typeof callback !== 'function') {
            throw new TypeError('window state callback must be a function');
        }
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('window:state', listener);
        return () => ipcRenderer.removeListener('window:state', listener);
    },
});
