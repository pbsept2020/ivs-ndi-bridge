/**
 * IVS-NDI Bridge - Main Process
 * 
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │                     ELECTRON MAIN                           │
 * │  - Window management                                        │
 * │  - NDI sender (via Grandiose)                              │
 * │  - IPC bridge for frame data                               │
 * └─────────────────────────────────────────────────────────────┘
 *                              │
 *                         IPC Bridge
 *                              │
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    ELECTRON RENDERER                        │
 * │  - IVS SDK (WebRTC)                                        │
 * │  - UI (same as contributor app)                            │
 * │  - Frame capture via Canvas (Phase 1)                      │
 * │  - Frame extraction native module (Phase 2: zero-copy)     │
 * └─────────────────────────────────────────────────────────────┘
 */

const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');

// NDI (will be initialized after app ready)
let grandiose = null;
let ndiSenders = new Map(); // participantId -> NDI sender info

// Window reference
let mainWindow = null;

// Configuration
const CONFIG = {
    apiBaseUrl: 'https://8o76zphwpa.execute-api.eu-central-1.amazonaws.com/prod',
    windowWidth: 1400,
    windowHeight: 900,
    ndi: {
        clockVideo: false,  // TEST: désactivé pour debug fullscreen freeze
        clockAudio: false,
        frameRate: 30
    }
};

/**
 * Create main application window
 */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: CONFIG.windowWidth,
        height: CONFIG.windowHeight,
        minWidth: 800,
        minHeight: 600,
        title: 'IVS-NDI Bridge',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 16 },
        backgroundColor: '#0a0a0f',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: true,
            allowRunningInsecureContent: false,
            enableBlinkFeatures: 'WebRTC',
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
        cleanupNDI();
    });

    mainWindow.webContents.on('did-finish-load', () => {
        console.log('[Main] Window loaded');
        console.log('[Main] Chrome version:', process.versions.chrome);
        console.log('[Main] Electron version:', process.versions.electron);
    });
}

/**
 * Initialize NDI SDK
 */
async function initializeNDI() {
    try {
        grandiose = require('grandiose');
        console.log('[NDI] Grandiose loaded successfully');
        console.log('[NDI] Grandiose exports:', Object.keys(grandiose));
        
        // Check available FourCC types
        console.log('[NDI] Available FourCC types:');
        if (grandiose.FOURCC_UYVY !== undefined) console.log('  - FOURCC_UYVY:', grandiose.FOURCC_UYVY);
        if (grandiose.FOURCC_BGRA !== undefined) console.log('  - FOURCC_BGRA:', grandiose.FOURCC_BGRA);
        if (grandiose.FOURCC_BGRX !== undefined) console.log('  - FOURCC_BGRX:', grandiose.FOURCC_BGRX);
        if (grandiose.FOURCC_RGBA !== undefined) console.log('  - FOURCC_RGBA:', grandiose.FOURCC_RGBA);
        if (grandiose.FOURCC_RGBX !== undefined) console.log('  - FOURCC_RGBX:', grandiose.FOURCC_RGBX);
        
        // Check format types
        if (grandiose.FORMAT_TYPE_PROGRESSIVE !== undefined) {
            console.log('[NDI] FORMAT_TYPE_PROGRESSIVE:', grandiose.FORMAT_TYPE_PROGRESSIVE);
        }
        
        return true;
    } catch (error) {
        console.error('[NDI] Failed to load Grandiose:', error.message);
        console.error('[NDI] Stack:', error.stack);
        return false;
    }
}

/**
 * Create NDI sender for a participant
 */
async function createNDISender(participantId, userId) {
    console.log(`[NDI] createNDISender: participantId=${participantId}, userId=${userId}`);
    
    if (!grandiose) {
        console.error('[NDI] Grandiose not initialized');
        return null;
    }

    // Close existing sender if any
    if (ndiSenders.has(participantId)) {
        console.log(`[NDI] Closing existing sender for ${participantId}`);
        const existing = ndiSenders.get(participantId);
        try {
            if (existing.sender && typeof existing.sender.destroy === 'function') {
                await existing.sender.destroy();
            }
        } catch (e) {
            console.warn('[NDI] Error destroying sender:', e.message);
        }
        ndiSenders.delete(participantId);
    }

    try {
        const senderName = `IVS-${userId || participantId.slice(0, 8)}`;
        console.log(`[NDI] Creating sender: ${senderName}`);
        
        if (typeof grandiose.send !== 'function') {
            console.error('[NDI] grandiose.send is not a function!');
            return null;
        }
        
        // grandiose.send() returns a Promise!
        const senderPromise = grandiose.send({
            name: senderName,
            groups: null,
            clockVideo: CONFIG.ndi.clockVideo,
            clockAudio: CONFIG.ndi.clockAudio
        });
        
        console.log(`[NDI] Waiting for sender promise...`);
        const sender = await senderPromise;
        
        if (!sender) {
            console.error('[NDI] grandiose.send resolved to null');
            return null;
        }
        
        console.log(`[NDI] Sender resolved, type: ${typeof sender}`);
        console.log(`[NDI] Sender methods:`, Object.keys(sender));
        console.log(`[NDI] Sender.video type:`, typeof sender.video);

        ndiSenders.set(participantId, {
            sender,
            name: senderName,
            frameCount: 0,
            startTime: Date.now(),
            lastFrameTime: Date.now(),
            width: 0,
            height: 0
        });

        console.log(`[NDI] ✓ Sender ready: ${senderName}`);
        return senderName;

    } catch (error) {
        console.error(`[NDI] Failed to create sender:`, error.message);
        console.error(`[NDI] Stack:`, error.stack);
        return null;
    }
}

/**
 * Send video frame to NDI
 * Phase 1: BGRA buffer from Canvas (has memory copies but validates pipeline)
 * Phase 2: Zero-copy via native module
 */
async function sendNDIFrame(participantId, frameData) {
    const senderInfo = ndiSenders.get(participantId);
    if (!senderInfo) {
        return false;
    }

    try {
        const { sender } = senderInfo;
        const { width, height, data } = frameData;
        
        // Convert data to Buffer if needed
        let buffer;
        if (Buffer.isBuffer(data)) {
            buffer = data;
        } else if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
            buffer = Buffer.from(data);
        } else if (data instanceof ArrayBuffer) {
            buffer = Buffer.from(data);
        } else if (Array.isArray(data)) {
            buffer = Buffer.from(data);
        } else {
            console.error('[NDI] Invalid frame data type:', typeof data);
            return false;
        }

        // RGBA direct depuis Canvas - évite la conversion RGBA→BGRA côté renderer
        // qui tuait le frame rate (3.6M opérations par frame pour 720p)
        // RGBX = RGBA avec hint que alpha=255 (pas de compositing)
        const fourCC = grandiose.FOURCC_RGBX || 1480738642;

        // Timecode incrémental basé sur frame count (100ns units comme NDI attend)
        // 10,000,000 = 1 seconde en unités de 100ns
        const frameTime100ns = BigInt(senderInfo.frameCount) * BigInt(400000);  // 40ms par frame = 400000 * 100ns

        // Create video frame object
        // Frame rate aligné avec la source IVS (~25 fps)
        const videoFrame = {
            type: 'video',
            data: buffer,
            xres: width,
            yres: height,
            frameRateN: 25000,
            frameRateD: 1000,  // 25 fps exact
            fourCC: fourCC,
            lineStrideBytes: width * 4,  // BGRA = 4 bytes per pixel
            frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE || 1,
            pictureAspectRatio: width / height,
            timecode: frameTime100ns  // Timecode incrémental en 100ns units
        };

        // Send frame - video() returns a Promise
        await sender.video(videoFrame);

        // Update stats
        senderInfo.frameCount++;
        senderInfo.lastFrameTime = Date.now();
        senderInfo.width = width;
        senderInfo.height = height;

        // Log periodically
        if (senderInfo.frameCount % 300 === 0) {
            const elapsed = (Date.now() - senderInfo.startTime) / 1000;
            const fps = Math.round(senderInfo.frameCount / elapsed);
            console.log(`[NDI] ${senderInfo.name}: ${senderInfo.frameCount} frames, ${fps} fps, ${width}x${height}`);
        }

        return true;

    } catch (error) {
        if (senderInfo.frameCount === 0) {
            console.error(`[NDI] Send error (first frame):`, error.message);
            // Log sender object properties for debugging
            console.error('[NDI] Sender object:', Object.keys(senderInfo.sender || {}));
            console.error('[NDI] Sender proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(senderInfo.sender || {})));
        }
        return false;
    }
}

/**
 * Remove NDI sender for a participant
 */
async function removeNDISender(participantId) {
    const senderInfo = ndiSenders.get(participantId);
    if (senderInfo) {
        const elapsed = (Date.now() - senderInfo.startTime) / 1000;
        const fps = elapsed > 0 ? Math.round(senderInfo.frameCount / elapsed) : 0;
        console.log(`[NDI] Removing ${senderInfo.name}: ${senderInfo.frameCount} frames sent, avg ${fps} fps`);
        
        try {
            if (senderInfo.sender && typeof senderInfo.sender.destroy === 'function') {
                await senderInfo.sender.destroy();
            }
        } catch (e) {
            console.warn('[NDI] Error disposing sender:', e.message);
        }
        ndiSenders.delete(participantId);
    }
}

/**
 * Cleanup all NDI resources
 */
function cleanupNDI() {
    console.log('[NDI] Cleaning up all senders...');
    for (const [participantId] of ndiSenders) {
        removeNDISender(participantId);
    }
    ndiSenders.clear();
}

/**
 * Get NDI status
 */
function getNDIStatus() {
    const senders = [];
    for (const [participantId, info] of ndiSenders) {
        const elapsed = (Date.now() - info.startTime) / 1000;
        const fps = elapsed > 0 ? Math.round(info.frameCount / elapsed) : 0;
        senders.push({
            participantId,
            name: info.name,
            frameCount: info.frameCount,
            fps,
            resolution: info.width > 0 ? `${info.width}x${info.height}` : 'N/A'
        });
    }
    return {
        initialized: grandiose !== null,
        senderCount: ndiSenders.size,
        senders
    };
}

// ==================== IPC HANDLERS ====================

ipcMain.handle('ndi:init', async () => {
    return await initializeNDI();
});

ipcMain.handle('ndi:createSender', async (event, { participantId, userId }) => {
    console.log('[IPC] ndi:createSender received:', { participantId, userId });
    const result = await createNDISender(participantId, userId);
    console.log('[IPC] ndi:createSender result:', result);
    return result;
});

ipcMain.handle('ndi:removeSender', (event, { participantId }) => {
    removeNDISender(participantId);
    return true;
});

ipcMain.handle('ndi:status', () => {
    return getNDIStatus();
});

// Frame data - using 'on' for high-frequency messages (not invoke)
ipcMain.on('ndi:frame', (event, { participantId, frameData }) => {
    sendNDIFrame(participantId, frameData);
});

ipcMain.handle('config:get', () => {
    return CONFIG;
});

ipcMain.handle('dialog:showError', (event, { title, message }) => {
    dialog.showErrorBox(title, message);
});

// ==================== APP LIFECYCLE ====================

app.whenReady().then(async () => {
    console.log('[App] Starting IVS-NDI Bridge...');
    console.log('[App] Platform:', process.platform, process.arch);
    
    const ndiReady = await initializeNDI();
    if (!ndiReady) {
        console.warn('[App] NDI not available - preview mode only');
    }

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    cleanupNDI();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    cleanupNDI();
});

// ==================== MENU ====================

const menuTemplate = [
    {
        label: app.name,
        submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
                label: 'NDI Status',
                click: () => {
                    const status = getNDIStatus();
                    const detail = status.senders.map(s => 
                        `${s.name}: ${s.frameCount} frames, ${s.fps} fps, ${s.resolution}`
                    ).join('\n') || 'No active senders';
                    
                    dialog.showMessageBox(mainWindow, {
                        type: 'info',
                        title: 'NDI Status',
                        message: `NDI Initialized: ${status.initialized}\nActive Senders: ${status.senderCount}`,
                        detail
                    });
                }
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
        ]
    },
    {
        label: 'View',
        submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'togglefullscreen' }
        ]
    },
    {
        label: 'Window',
        submenu: [
            { role: 'minimize' },
            { role: 'zoom' },
            { type: 'separator' },
            { role: 'front' }
        ]
    }
];

app.whenReady().then(() => {
    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
});
