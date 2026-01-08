#!/usr/bin/env python3
"""
Génère un fichier .icns pour IVS-NDI Bridge
Version simplifiée avec icône géométrique
"""

import os
import subprocess
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    subprocess.run(["pip3", "install", "Pillow"], check=True)
    from PIL import Image, ImageDraw

SIZES = [16, 32, 64, 128, 256, 512, 1024]

def create_icon_png(size, output_path):
    """Crée une icône PNG de la taille spécifiée"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Fond arrondi
    padding = int(size * 0.03)
    radius = int(size * 0.18)
    bg_color = (26, 26, 46, 255)
    
    x0, y0, x1, y1 = padding, padding, size - padding, size - padding
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=bg_color)
    
    # Bordure subtile
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, outline=(60, 60, 80, 255), width=max(1, size//128))
    
    # Couleurs
    ivs_orange = (255, 153, 0, 255)
    ndi_blue = (0, 212, 255, 255)
    white = (255, 255, 255, 230)
    dark = (26, 26, 46, 255)
    
    center = size // 2
    
    # === Section IVS (gauche) ===
    ivs_cx = int(size * 0.28)
    ivs_cy = int(size * 0.45)
    ivs_r = int(size * 0.14)
    
    # Rectangle avec coin arrondi (représente une caméra/écran)
    cam_w = int(size * 0.22)
    cam_h = int(size * 0.16)
    cam_x = ivs_cx - cam_w // 2
    cam_y = ivs_cy - cam_h // 2
    draw.rounded_rectangle([cam_x, cam_y, cam_x + cam_w, cam_y + cam_h], 
                          radius=int(size * 0.02), fill=ivs_orange)
    
    # Objectif de caméra (triangle)
    obj_w = int(size * 0.08)
    draw.polygon([
        (cam_x + cam_w, cam_y + int(cam_h * 0.2)),
        (cam_x + cam_w + obj_w, cam_y - int(cam_h * 0.1)),
        (cam_x + cam_w + obj_w, cam_y + cam_h + int(cam_h * 0.1)),
        (cam_x + cam_w, cam_y + int(cam_h * 0.8))
    ], fill=ivs_orange)
    
    # Triangle play au centre de la caméra
    play_size = int(cam_h * 0.5)
    play_offset = int(play_size * 0.12)
    draw.polygon([
        (ivs_cx - play_size//3 + play_offset, ivs_cy - play_size//2),
        (ivs_cx - play_size//3 + play_offset, ivs_cy + play_size//2),
        (ivs_cx + play_size//2 + play_offset, ivs_cy)
    ], fill=dark)
    
    # === Flèche centrale ===
    arrow_y = int(size * 0.45)
    arrow_x1 = int(size * 0.44)
    arrow_x2 = int(size * 0.56)
    arrow_height = int(size * 0.035)
    arrow_head = int(size * 0.05)
    
    # Corps de la flèche
    draw.rectangle([arrow_x1, arrow_y - arrow_height//2,
                    arrow_x2 - arrow_head, arrow_y + arrow_height//2],
                   fill=white)
    # Pointe de la flèche
    draw.polygon([
        (arrow_x2 - arrow_head, arrow_y - int(arrow_head * 0.8)),
        (arrow_x2, arrow_y),
        (arrow_x2 - arrow_head, arrow_y + int(arrow_head * 0.8))
    ], fill=white)
    
    # === Section NDI (droite) ===
    ndi_cx = int(size * 0.72)
    ndi_cy = int(size * 0.45)
    ndi_r = int(size * 0.06)
    
    # Cercle central bleu
    draw.ellipse([ndi_cx - ndi_r, ndi_cy - ndi_r,
                  ndi_cx + ndi_r, ndi_cy + ndi_r],
                 fill=ndi_blue)
    
    # Arcs de signal (cercles partiels)
    arc_width = max(2, int(size * 0.018))
    for i, mult in enumerate([1.8, 2.5, 3.2]):
        arc_r = int(ndi_r * mult)
        opacity = int(255 * (1 - i * 0.2))
        arc_color = (0, 212, 255, opacity)
        
        bbox = [ndi_cx - arc_r, ndi_cy - arc_r, 
                ndi_cx + arc_r, ndi_cy + arc_r]
        draw.arc(bbox, 200, 340, fill=arc_color, width=arc_width)
    
    # === Indicateurs de texte simplifiés (barres) ===
    bar_y = int(size * 0.70)
    bar_h = max(2, int(size * 0.025))
    
    # Barre orange (IVS)
    bar_w_ivs = int(size * 0.15)
    draw.rounded_rectangle([ivs_cx - bar_w_ivs//2, bar_y, 
                           ivs_cx + bar_w_ivs//2, bar_y + bar_h],
                          radius=bar_h//2, fill=ivs_orange)
    
    # Barre bleue (NDI)
    bar_w_ndi = int(size * 0.12)
    draw.rounded_rectangle([ndi_cx - bar_w_ndi//2, bar_y,
                           ndi_cx + bar_w_ndi//2, bar_y + bar_h],
                          radius=bar_h//2, fill=ndi_blue)
    
    # Barre centrale (BRIDGE)
    bar_w_bridge = int(size * 0.18)
    bar_y_bridge = int(size * 0.78)
    draw.rounded_rectangle([center - bar_w_bridge//2, bar_y_bridge,
                           center + bar_w_bridge//2, bar_y_bridge + bar_h],
                          radius=bar_h//2, fill=(100, 100, 100, 200))
    
    img.save(output_path, 'PNG')
    return True

def create_iconset(base_path):
    """Crée un iconset complet"""
    iconset_path = base_path / "AppIcon.iconset"
    iconset_path.mkdir(exist_ok=True)
    
    for size in SIZES:
        output = iconset_path / f"icon_{size}x{size}.png"
        print(f"  Création {output.name}...")
        create_icon_png(size, output)
        
        if size <= 512:
            output_2x = iconset_path / f"icon_{size}x{size}@2x.png"
            print(f"  Création {output_2x.name}...")
            create_icon_png(size * 2, output_2x)
    
    return iconset_path

def create_icns(iconset_path, output_path):
    """Convertit l'iconset en .icns"""
    result = subprocess.run(
        ["iconutil", "-c", "icns", str(iconset_path), "-o", str(output_path)],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"Erreur iconutil: {result.stderr}")
        return False
    return True

def main():
    project_dir = Path("/Users/bessette_nouveau_macbook_pro/Projets/ivs-ndi-bridge")
    resources_dir = project_dir / "IVS-NDI Bridge.app" / "Contents" / "Resources"
    
    print("🎨 Génération de l'icône IVS-NDI Bridge...")
    
    iconset_path = create_iconset(resources_dir)
    
    icns_path = resources_dir / "AppIcon.icns"
    print(f"\n📦 Conversion en {icns_path.name}...")
    
    if create_icns(iconset_path, icns_path):
        print(f"✅ Icône créée: {icns_path}")
        
        import shutil
        shutil.rmtree(iconset_path)
        print("🧹 Iconset temporaire supprimé")
    else:
        print("❌ Échec de la création de l'icns")
    
    subprocess.run([
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        "-f", str(project_dir / "IVS-NDI Bridge.app")
    ])
    
    subprocess.run(["touch", str(project_dir / "IVS-NDI Bridge.app")])
    
    print("\n✅ Terminé!")

if __name__ == "__main__":
    main()
