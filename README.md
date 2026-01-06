# IVS-NDI Bridge

Convertisseur IVS Real-Time WebRTC → NDI pour Apple Silicon.

## 🎯 Objectif

Convertir les flux WebRTC d'AWS IVS Real-Time en flux NDI avec une latence < 250ms, en utilisant une architecture zero-copy sur Apple Silicon.

## 📊 État actuel

| Phase | Status | Performance |
|-------|--------|-------------|
| Phase 1 - POC Canvas | ✅ Fonctionnel | ~22-25 fps, ~200ms latence |
| Phase 2 - Native Module | 🔜 Planifié | Objectif: 30fps, <100ms |
| Phase 3 - Zero-Copy Metal | 🔜 Planifié | Objectif: 30fps, <50ms |

## 📋 Prérequis

- macOS (Apple Silicon M1/M2/M3/M4)
- Node.js 18+
- NDI SDK installé (https://ndi.video/tools/)
- Compte AWS avec IVS Real-Time configuré

## 🚀 Installation

```bash
cd ivs-ndi-bridge

# Installer les dépendances
npm install

# Rebuild des modules natifs pour Electron
npm run rebuild

# Lancer l'application
npm start
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     ELECTRON MAIN                           │
│  - Window management                                        │
│  - NDI sender (via Grandiose)                              │
│  - IPC bridge pour données frames                          │
└─────────────────────────────────────────────────────────────┘
                              │
                         IPC Bridge
                              │
┌─────────────────────────────────────────────────────────────┐
│                    ELECTRON RENDERER                        │
│  - IVS SDK (WebRTC)                                        │
│  - UI (basée sur contributor app)                          │
│  - Frame capture via Canvas (Phase 1)                      │
│  - CVPixelBuffer extraction (Phase 2: module natif)        │
└─────────────────────────────────────────────────────────────┘
```

## 📁 Structure

```
ivs-ndi-bridge/
├── package.json
├── src/
│   ├── main.js           # Process principal Electron + NDI sender
│   ├── preload.js        # Bridge IPC sécurisé
│   └── renderer/
│       └── index.html    # UI (IVS SDK + contrôles NDI)
├── build/
│   └── entitlements.mac.plist
└── docs/
    └── ARCHITECTURE.md   # Documentation technique détaillée
```

## 🔧 Phases de développement

### Phase 1 (Actuelle) - POC Canvas ✅
- [x] App Electron avec IVS SDK
- [x] UI reprenant la contributor app
- [x] Intégration Grandiose pour NDI
- [x] Envoi frames via Canvas RGBA (avec copies mémoire)
- [x] Optimisation RGBX (évite conversion RGBA→BGRA)

### Phase 2 - Module Natif (Planifié)
- [ ] Module C++ Electron pour extraction RTCVideoFrame
- [ ] Accès CVPixelBuffer via RTCCVPixelBuffer
- [ ] Import IOSurface dans Metal textures

### Phase 3 - Zero-Copy Metal (Planifié)
- [ ] Shader NV12 → UYVY compute
- [ ] MTLBuffer storageModeShared
- [ ] Double-buffering
- [ ] Latence cible < 50ms

## ⚠️ Problèmes connus

### NDI sender name collision
- **Symptôme** : `Failed to create NDI sender` après crash
- **Solution** : `killall -9 Electron`
- **Prévention** : Suffixe timestamp dans le nom sender

### Freeze plein écran macOS (Bug receivers - pas notre code)
- **Symptôme** : Saccades en fullscreen dans Sienna/NDI Monitor
- **Cause** : Bug CVDisplayLink + Metal fullscreen sur receivers NDI
- **Workaround** : Utiliser OBS comme monitor (Projecteur plein écran)

Voir `docs/ARCHITECTURE.md` pour les détails techniques complets.

## 🔗 Ressources

- [IVS Web Broadcast SDK](https://docs.aws.amazon.com/ivs/latest/RealTimeUserGuide/broadcast-web.html)
- [NDI SDK](https://ndi.video/for-developers/ndi-sdk/)
- [Grandiose (Node.js NDI)](https://github.com/Streampunk/grandiose)

## 📝 Configuration

L'API IVS est configurée dans `src/main.js` :
```javascript
const CONFIG = {
    apiBaseUrl: 'https://8o76zphwpa.execute-api.eu-central-1.amazonaws.com/prod',
    ndi: {
        clockVideo: false,
        clockAudio: false,
        frameRate: 30
    }
};
```

## 📄 License

MIT
