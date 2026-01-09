/**
 * IVS-NDI Bridge - Main Process
 * 
 * TODO - Option B (Slot-based naming) pour une gestion encore plus robuste des reconnexions:
 *   - Créer des slots NDI fixes (IVS-Bridge-1, IVS-Bridge-2, etc.)
 *   - Mapper les participants aux slots par userId (pas participantId)
 *   - Si un user revient (même userId, nouveau participantId), réassigner son ancien slot
 *   - Avantage: noms 100% stables pour les récepteurs OBS/vMix
 * 
 * TODO - Phase 2 GPU (exploitation Apple Silicon) - Estimation: 4-5 jours
 *   Phase 2a (1j): Pipeline Metal standalone
 *     - Shader NV12→UYVY avec upsampling bilinéaire chroma 4:2:0→4:2:2
 *     - CVMetalTextureCache pour import IOSurface sans copie
 *     - MTLBuffer(storageModeShared) pour sortie GPU→CPU
 *   Phase 2b (2-3j): Module natif Electron (C++/ObjC)
 *     - Hook WebRTC pour intercepter RTCCVPixelBuffer avant JS
 *     - CVPixelBufferGetIOSurface() pour accès zero-copy
 *     - node-gyp + binding.gyp pour build arm64
 *   Phase 2c (0.5j): Intégration + double-buffering
 *     - 2 MTLBuffers alternants pour éviter stalls GPU
 *     - Connexion pipeline Metal → Grandiose NDI
 *   Phase 2d (0.5j): Tests perf
 *   Gains attendus: CPU 40%→5%, latence 40ms→5ms, support 60fps 1080p
 *   Réf: MCP ivs-ndi-apple pour détails techniques et code examples
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

const { app, BrowserWindow, ipcMain, Menu, dialog, screen } = require('electron');
const path = require('path');

// NDI (will be initialized after app ready)
let grandiose = null;
let ndiSenders = new Map(); // participantId -> NDI sender info

// Window references
let mainWindow = null;
let projectorWindows = new Map(); // participantId -> BrowserWindow

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

// Horloge commune pour synchronisation A/V NDI (en 100ns units)
// Initialisée au premier frame envoyé pour chaque sender
const ndiClocks = new Map(); // participantId -> { startTime: BigInt (hrtime), startTimestamp: number (Date.now) }

function getNDITimecode(participantId) {
    if (!ndiClocks.has(participantId)) {
        ndiClocks.set(participantId, {
            startTime: process.hrtime.bigint(),
            startTimestamp: Date.now()
        });
    }
    const clock = ndiClocks.get(participantId);
    // Temps écoulé en nanosecondes depuis le début
    const elapsedNs = process.hrtime.bigint() - clock.startTime;
    // Convertir en unités de 100ns (ce que NDI attend)
    return elapsedNs / BigInt(100);
}

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
 * Option C: Destroy existing + retry avec délai si collision
 */
async function createNDISender(participantId, userId, retryCount = 0) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 1500;
    
    console.log(`[NDI] createNDISender: participantId=${participantId}, userId=${userId}, retry=${retryCount}`);
    
    if (!grandiose) {
        console.error('[NDI] Grandiose not initialized');
        return null;
    }

    const senderName = `IVS-${userId || participantId.slice(0, 8)}`;

    // Close existing sender if any (même participantId)
    if (ndiSenders.has(participantId)) {
        console.log(`[NDI] Closing existing sender for ${participantId}`);
        const existing = ndiSenders.get(participantId);
        try {
            if (existing.sender && typeof existing.sender.destroy === 'function') {
                await existing.sender.destroy();
                // Attendre que NDI libère le nom
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (e) {
            console.warn('[NDI] Error destroying sender:', e.message);
        }
        ndiSenders.delete(participantId);
    }

    // Chercher si un autre participant utilise déjà ce nom (reconnexion)
    for (const [existingId, info] of ndiSenders) {
        if (info.name === senderName && existingId !== participantId) {
            console.log(`[NDI] Name collision detected: ${senderName} used by ${existingId}`);
            console.log(`[NDI] Destroying old sender to reuse name for reconnected user`);
            try {
                if (info.sender && typeof info.sender.destroy === 'function') {
                    await info.sender.destroy();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } catch (e) {
                console.warn('[NDI] Error destroying colliding sender:', e.message);
            }
            ndiSenders.delete(existingId);
            break;
        }
    }

    try {
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
            displayName: userId || participantId.slice(0, 8),
            frameCount: 0,
            audioFrameCount: 0,
            audioSampleCount: 0,
            startTime: Date.now(),
            lastFrameTime: Date.now(),
            lastAudioTime: Date.now(),
            width: 0,
            height: 0
        });

        console.log(`[NDI] ✓ Sender ready: ${senderName}`);
        return senderName;

    } catch (error) {
        console.error(`[NDI] Failed to create sender:`, error.message);
        
        // Si collision de nom (sender fantôme), retry après délai
        if (retryCount < MAX_RETRIES && 
            (error.message.includes('already') || error.message.includes('exists') || error.message.includes('failed'))) {
            console.log(`[NDI] Retrying in ${RETRY_DELAY_MS}ms... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            return createNDISender(participantId, userId, retryCount + 1);
        }
        
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

        // Timecode synchronisé avec l'audio via horloge commune
        const timecode = getNDITimecode(participantId);

        // Create video frame object
        const videoFrame = {
            type: 'video',
            data: buffer,
            xres: width,
            yres: height,
            frameRateN: 30000,
            frameRateD: 1000,  // 30 fps
            fourCC: fourCC,
            lineStrideBytes: width * 4,  // RGBX = 4 bytes per pixel
            frameFormatType: grandiose.FORMAT_TYPE_PROGRESSIVE || 1,
            pictureAspectRatio: width / height,
            timecode: timecode  // Timecode synchronisé A/V
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
 * Send audio frame to NDI
 * Float32 planar format from AudioWorklet
 * NDI audio format: FLTp (Float32 planar) - channels stored separately
 */
async function sendNDIAudioFrame(participantId, left, right, sampleRate = 48000) {
    const senderInfo = ndiSenders.get(participantId);
    if (!senderInfo) {
        return false;
    }

    try {
        const { sender } = senderInfo;
        
        // Validate input - should be Float32Array from AudioWorklet
        if (!left || !right) {
            return false;
        }

        const noSamples = left.length || left.byteLength / 4;
        const noChannels = 2;
        
        // Channel stride = bytes per channel = samples * 4 (Float32)
        const channelStrideBytes = noSamples * 4;
        
        // Create planar buffer: [L0,L1,...Ln,R0,R1,...Rn]
        // Total size = 2 channels * samples * 4 bytes
        const buffer = Buffer.alloc(channelStrideBytes * noChannels);
        
        // Copy left channel
        if (Buffer.isBuffer(left)) {
            left.copy(buffer, 0);
        } else if (left instanceof Float32Array) {
            Buffer.from(left.buffer, left.byteOffset, left.byteLength).copy(buffer, 0);
        } else if (left.buffer) {
            Buffer.from(left.buffer).copy(buffer, 0);
        }
        
        // Copy right channel
        if (Buffer.isBuffer(right)) {
            right.copy(buffer, channelStrideBytes);
        } else if (right instanceof Float32Array) {
            Buffer.from(right.buffer, right.byteOffset, right.byteLength).copy(buffer, channelStrideBytes);
        } else if (right.buffer) {
            Buffer.from(right.buffer).copy(buffer, channelStrideBytes);
        }

        // FourCC for Float32 planar audio
        // 'FLTp' = 0x70544c46 in little-endian
        const FOURCC_FLTp = 0x70544c46;

        // Timecode synchronisé avec la vidéo via horloge commune
        const timecode = getNDITimecode(participantId);

        // Audio frame object matching grandiose_send.cc expectations
        const audioFrame = {
            sampleRate: sampleRate,
            noChannels: noChannels,
            noSamples: noSamples,
            channelStrideBytes: channelStrideBytes,
            fourCC: FOURCC_FLTp,
            data: buffer,
            timecode: timecode  // Timecode synchronisé A/V
        };

        // Send audio frame
        await sender.audio(audioFrame);

        // Update stats
        senderInfo.audioFrameCount++;
        senderInfo.audioSampleCount += noSamples;
        senderInfo.lastAudioTime = Date.now();

        // Log periodically (every ~10 seconds at 48kHz with 1024 sample buffers)
        if (senderInfo.audioFrameCount % 500 === 0) {
            const elapsed = (Date.now() - senderInfo.startTime) / 1000;
            const audioFps = Math.round(senderInfo.audioFrameCount / elapsed);
            console.log(`[NDI Audio] ${senderInfo.name}: ${senderInfo.audioSampleCount} samples, ${audioFps} buffers/s, ${sampleRate}Hz`);
        }

        return true;

    } catch (error) {
        if (senderInfo.audioFrameCount === 0) {
            console.error(`[NDI Audio] Send error (first frame):`, error.message);
            console.error('[NDI Audio] Sender.audio type:', typeof senderInfo.sender?.audio);
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
        ndiClocks.delete(participantId);  // Nettoyer l'horloge A/V
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

// Audio frame data - Float32 planar from AudioWorklet
ipcMain.on('ndi:audioFrame', (event, { participantId, left, right, sampleRate }) => {
    sendNDIAudioFrame(participantId, left, right, sampleRate);
});

ipcMain.handle('config:get', () => {
    return CONFIG;
});

ipcMain.handle('dialog:showError', (event, { title, message }) => {
    dialog.showErrorBox(title, message);
});

// ==================== PROJECTOR HANDLERS ====================

ipcMain.handle('projector:getDisplays', () => {
    const displays = screen.getAllDisplays();
    return displays.map((d, index) => ({
        id: d.id,
        index,
        label: d.label || `Écran ${index + 1}`,
        bounds: d.bounds,
        primary: d.id === screen.getPrimaryDisplay().id
    }));
});

ipcMain.handle('projector:open', (event, { participantId, displayName, displayId, windowed, token }) => {
    // Fermer fenêtre existante si présente
    if (projectorWindows.has(participantId)) {
        projectorWindows.get(participantId).close();
        projectorWindows.delete(participantId);
    }

    let windowOptions = {
        title: `Projecteur - ${displayName}`,
        backgroundColor: '#000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    };

    if (windowed) {
        // Mode fenêtré
        windowOptions.width = 960;
        windowOptions.height = 540;
        windowOptions.minWidth = 320;
        windowOptions.minHeight = 180;
        windowOptions.frame = true;
        windowOptions.resizable = true;
    } else {
        // Mode plein écran sur écran spécifié
        const displays = screen.getAllDisplays();
        const targetDisplay = displayId 
            ? displays.find(d => d.id === displayId) 
            : screen.getPrimaryDisplay();
        
        if (targetDisplay) {
            windowOptions.x = targetDisplay.bounds.x;
            windowOptions.y = targetDisplay.bounds.y;
            windowOptions.width = targetDisplay.bounds.width;
            windowOptions.height = targetDisplay.bounds.height;
        }
        windowOptions.frame = false;
        windowOptions.resizable = false;
        windowOptions.fullscreen = false; // On évite le fullscreen natif macOS (bugs connus)
        windowOptions.simpleFullscreen = true;
        windowOptions.alwaysOnTop = true;
    }

    const projectorWindow = new BrowserWindow(windowOptions);
    
    // Charger la page projecteur avec le token pour connexion directe WebRTC
    // Le projecteur se connecte lui-même au stage = flux vidéo direct sans transcodage
    projectorWindow.loadFile(path.join(__dirname, 'renderer', 'projector.html'), {
        query: { participantId, displayName, token: token || '' }
    });

    projectorWindow.on('closed', () => {
        projectorWindows.delete(participantId);
        // Notifier le renderer principal
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('projector:closed', { participantId });
        }
    });

    // Raccourci Escape pour fermer
    projectorWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') {
            projectorWindow.close();
        }
    });

    projectorWindows.set(participantId, projectorWindow);
    console.log(`[Projector] Opened for ${displayName} (windowed: ${windowed})`);
    
    return { success: true, windowed };
});

ipcMain.handle('projector:close', (event, { participantId }) => {
    if (projectorWindows.has(participantId)) {
        projectorWindows.get(participantId).close();
        projectorWindows.delete(participantId);
        return true;
    }
    return false;
});

ipcMain.handle('projector:isOpen', (event, { participantId }) => {
    return projectorWindows.has(participantId);
});

// Relayer les frames video vers les fenêtres projecteur
ipcMain.on('projector:frame', (event, { participantId, frameDataUrl }) => {
    const projectorWindow = projectorWindows.get(participantId);
    if (projectorWindow && !projectorWindow.isDestroyed()) {
        projectorWindow.webContents.send('projector:displayFrame', { frameDataUrl });
    }
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
            {
                label: 'WebRTC Internals',
                accelerator: 'CmdOrCtrl+Shift+W',
                click: () => {
                    const webrtcWindow = new BrowserWindow({
                        width: 1200,
                        height: 800,
                        title: 'WebRTC Internals'
                    });
                    webrtcWindow.loadURL('chrome://webrtc-internals');
                }
            },
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
