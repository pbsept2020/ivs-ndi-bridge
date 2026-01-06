# Architecture Technique IVS-NDI Bridge

Documentation technique détaillée pour le pipeline de conversion WebRTC → NDI sur Apple Silicon.

## 🎯 Objectifs de performance

| Contrainte | Cible |
|------------|-------|
| Latence end-to-end | < 250ms |
| Copies mémoire CPU | 0 (zero-copy) |
| Budget GPU par frame | < 2ms |
| Bande passante 720p30 | < 90MB/s shared memory |
| Opérations blit GPU | Max 1 par frame |

## 📐 Pipeline Zero-Copy (Cible Phase 3)

```
IVS SDK (Electron)
      ↓
WebRTC native module
      ↓
RTCVideoFrame
      ↓
RTCCVPixelBuffer (IOSurface NV12)
      ↓
Metal import Y / UV planes
      ↓
Compute shader NV12 → UYVY
      ↓
MTLBuffer(storageModeShared)
      ↓
NDI send (UYVY)
```

## 🔬 Formats vidéo

### Entrée (VideoToolbox decode)
- **Format** : NV12 bi-planar (`kCVPixelFormatType_420YpCbCr8BiPlanarFullRange`)
- **Structure** : Plan Y (luminance) + Plan UV interleaved (chrominance)
- **Backing** : IOSurface (GPU memory)

### Intermédiaire (Metal)
- **Plan Y** : MTLTexture `r8Unorm`
- **Plan UV** : MTLTexture `rg8Unorm`
- **Import** : Via `CVMetalTextureCache` (zero-copy)

### Sortie (NDI)
- **Format principal** : UYVY packed 4:2:2 (`NDIlib_FourCC_video_type_UYVY`)
- **Alternative** : RGBX pour compatibilité universelle (utilisé en Phase 1)

### Alternatives évaluées

| Format | Avantages | Inconvénients |
|--------|-----------|---------------|
| UYVY | Optimal NDI, faible bande passante | Conversion NV12→UYVY requise |
| P216 | Même layout que NV12, 16-bit | 2x bande passante, receivers limités |
| BGRA | Support universel | 4 bytes/pixel, conversion YUV→RGB |
| RGBX | Support universel, évite alpha | Utilisé en Phase 1 (Canvas) |

## 🔧 Techniques validées

### Zero-copy IOSurface → Metal
```swift
// Import CVPixelBuffer into Metal without copy
let ioSurface = CVPixelBufferGetIOSurface(pixelBuffer)
let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(...)
let texture = device.makeTexture(descriptor: desc, iosurface: ioSurface!, plane: 0)
```

### CVMetalTextureCache
```swift
// Create texture cache once
var textureCache: CVMetalTextureCache?
CVMetalTextureCacheCreate(nil, nil, device, nil, &textureCache)

// Import each frame (zero-copy)
var cvTexture: CVMetalTexture?
CVMetalTextureCacheCreateTextureFromImage(
    nil, textureCache!, pixelBuffer, nil,
    .r8Unorm, width, height, 0, &cvTexture
)
let metalTexture = CVMetalTextureGetTexture(cvTexture!)
```

### MTLBuffer storageModeShared (Apple Silicon)
```swift
// GPU writes directly to CPU-visible memory
let buffer = device.makeBuffer(length: size, options: .storageModeShared)
// No synchronize() needed on Apple Silicon unified memory
```

### Double-buffering
```swift
class DoubleBufferedPipeline {
    private var buffers: [MTLBuffer]
    private var currentIndex = 0
    
    func getNextBuffer() -> MTLBuffer {
        currentIndex = (currentIndex + 1) % 2
        return buffers[currentIndex]
    }
}
```

## 🎨 Shader Metal NV12 → UYVY

### Conversion basique
```metal
kernel void nv12ToUYVY(
    texture2d<float, access::read> yPlane [[texture(0)]],
    texture2d<float, access::read> uvPlane [[texture(1)]],
    device uchar4* output [[buffer(0)]],
    uint2 gid [[thread_position_in_grid]]
) {
    // Each thread processes 2 horizontal pixels → 1 UYVY macro-pixel
    uint2 yCoord0 = uint2(gid.x * 2, gid.y);
    uint2 yCoord1 = uint2(gid.x * 2 + 1, gid.y);
    uint2 uvCoord = uint2(gid.x, gid.y / 2);
    
    float y0 = yPlane.read(yCoord0).r;
    float y1 = yPlane.read(yCoord1).r;
    float2 uv = uvPlane.read(uvCoord).rg;
    
    // Pack as UYVY (U Y0 V Y1)
    uchar4 uyvy = uchar4(
        uchar(uv.r * 255.0),  // U
        uchar(y0 * 255.0),    // Y0
        uchar(uv.g * 255.0),  // V
        uchar(y1 * 255.0)     // Y1
    );
    
    uint outputIndex = gid.y * (outputWidth / 2) + gid.x;
    output[outputIndex] = uyvy;
}
```

### Avec upsampling bilinéaire (recommandé)
```metal
// Interpolation chroma 4:2:0 → 4:2:2
float2 uvCoordFloat = float2(float(gid.x) + 0.5, float(gid.y) / 2.0);
float2 uv = uvPlane.sample(linearSampler, uvCoordFloat / float2(uvWidth, uvHeight)).rg;
```

## 📊 Méthodes d'upsampling chroma

| Méthode | Qualité | Performance | Complexité shader |
|---------|---------|-------------|-------------------|
| Nearest neighbor | Faible | Rapide | Minimale |
| **Bilinéaire** | Bonne | Rapide | Faible |
| Catmull-Rom | Excellente | Moyenne | Élevée |

**Recommandation** : Bilinéaire (meilleur compromis qualité/performance)

## ⚠️ Limitations connues

### JavaScript/WebCodecs
- `MediaStreamTrackProcessor` et `WebCodecs` copient en mémoire JS
- Pas d'accès à `IOSurface` depuis JavaScript
- Chromium n'expose pas `CVPixelBuffer` au contexte web

### NDI SDK
- Ne consomme pas directement les textures GPU
- Requiert buffer CPU (`storageModeShared` évite memcpy)
- Pas de support natif NV12 (conversion requise)

### WebRTC natif
- Hook points Chromium complexes pour extraction CVPixelBuffer
- Mécanisme callback IVS SDK propriétaire

## 🐛 Problèmes connus et solutions

### NDI sender name collision
```javascript
// Problème: sender zombie après crash
// Solution: nom unique avec timestamp
const senderName = `IVS-NDI-Bridge-${Date.now()}`;
```

### Freeze fullscreen macOS
- **Cause racine** : Bug CVDisplayLink + Metal fullscreen sur receivers NDI
- **Pas notre code** : Testé avec OBS comme sender intermédiaire → même bug
- **Workarounds** :
  - OBS Projecteur plein écran (Preview)
  - Mode fenêtré maximisé
  - Désactiver ProMotion (120Hz → 60Hz)

### Performance RGBA→BGRA
```javascript
// AVANT: boucle JS sur 3.6M pixels (720p) = 17fps
for (let i = 0; i < data.length; i += 4) {
    [data[i], data[i+2]] = [data[i+2], data[i]];
}

// APRÈS: RGBX natif = 22-25fps
const fourCC = grandiose.FOURCC_RGBX;
```

## 📚 Références techniques

### Apple
- [CVPixelBuffer](https://developer.apple.com/documentation/corevideo/cvpixelbuffer)
- [CVMetalTextureCache](https://developer.apple.com/documentation/corevideo/cvmetaltexturecache)
- [IOSurface](https://developer.apple.com/documentation/iosurface)
- [Metal Best Practices](https://developer.apple.com/documentation/metal/resource_fundamentals/choosing_a_resource_storage_mode)

### NDI
- [NDI SDK Documentation](https://ndi.video/for-developers/ndi-sdk/)
- [NDI Advanced SDK](https://docs.ndi.video/)

### WebRTC
- [libwebrtc macOS](https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/objc/)
- [RTCCVPixelBuffer](https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/objc/components/video_frame_buffer/)

### Projets similaires
- [AirSend](https://github.com/nicholasrice/AirSend) - NDI depuis macOS
- [KlakNDI](https://github.com/keijiro/KlakNDI) - NDI pour Unity
- [OBS-NDI](https://github.com/obs-ndi/obs-ndi) - Plugin OBS

## 🧪 Tests à effectuer (Phase 2/3)

1. **Benchmark extraction CVPixelBuffer** depuis WebRTC native module
2. **Mesure latence** Metal texture import + compute shader
3. **Profile timing** GPU→SharedBuffer blit
4. **End-to-end** : IVS decode → NDI send → OBS receive

## 🔮 Évolutions futures

- Support multi-participants (multiple NDI senders)
- Audio passthrough (actuellement vidéo uniquement)
- Preview Metal natif dans l'app
- Statistiques temps réel (latence, dropped frames)
- Configuration NDI avancée (groupes, discovery server)
