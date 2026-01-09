/**
 * IVS-NDI Bridge - Preload Script
 * 
 * Exposes safe APIs to the renderer process
 * Context isolation bridge between Node.js and browser
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected APIs to renderer
contextBridge.exposeInMainWorld('bridge', {
    // NDI Control
    ndi: {
        init: () => ipcRenderer.invoke('ndi:init'),
        createSender: (participantId, userId) => 
            ipcRenderer.invoke('ndi:createSender', { participantId, userId }),
        removeSender: (participantId) => 
            ipcRenderer.invoke('ndi:removeSender', { participantId }),
        getStatus: () => ipcRenderer.invoke('ndi:status'),
        // Send frame data (Phase 1 - with copies)
        sendFrame: (participantId, frameData) => {
            ipcRenderer.send('ndi:frame', { participantId, frameData });
        },
        // Send audio frame (Float32 planar)
        sendAudioFrame: (participantId, left, right, sampleRate) => {
            ipcRenderer.send('ndi:audioFrame', { participantId, left, right, sampleRate });
        }
    },

    // Configuration
    config: {
        get: () => ipcRenderer.invoke('config:get')
    },

    // Platform info
    platform: {
        os: process.platform,
        arch: process.arch,
        versions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node
        }
    },

    // Dialog helpers
    dialog: {
        showError: (title, message) => 
            ipcRenderer.invoke('dialog:showError', { title, message })
    },

    // Projector Control
    projector: {
        getDisplays: () => ipcRenderer.invoke('projector:getDisplays'),
        open: (participantId, displayName, displayId, windowed, token) => 
            ipcRenderer.invoke('projector:open', { participantId, displayName, displayId, windowed, token }),
        close: (participantId) => 
            ipcRenderer.invoke('projector:close', { participantId }),
        isOpen: (participantId) => 
            ipcRenderer.invoke('projector:isOpen', { participantId })
    },

    // Event listeners for NDI status updates
    on: (channel, callback) => {
        const validChannels = ['ndi:status-update', 'ndi:error', 'projector:closed'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => callback(...args));
        }
    },

    removeListener: (channel, callback) => {
        const validChannels = ['ndi:status-update', 'ndi:error', 'projector:closed'];
        if (validChannels.includes(channel)) {
            ipcRenderer.removeListener(channel, callback);
        }
    }
});

// Log that preload executed
console.log('[Preload] Bridge APIs exposed');
console.log('[Preload] Platform:', process.platform, process.arch);
