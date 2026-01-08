#!/bin/bash

# Script de build pour IVS-NDI Bridge.app
# Génère l'icône et prépare l'application

PROJECT_DIR="/Users/bessette_nouveau_macbook_pro/Projets/ivs-ndi-bridge"
APP_DIR="$PROJECT_DIR/IVS-NDI Bridge.app"
RESOURCES_DIR="$APP_DIR/Contents/Resources"

cd "$PROJECT_DIR"

echo "🔨 Building IVS-NDI Bridge.app..."

# 1. Créer l'iconset à partir du SVG (si disponible)
if [ -f "$RESOURCES_DIR/AppIcon.svg" ]; then
    echo "🎨 Génération de l'icône..."
    
    ICONSET_DIR="$RESOURCES_DIR/AppIcon.iconset"
    mkdir -p "$ICONSET_DIR"
    
    # Utiliser qlmanage pour convertir SVG en PNG (méthode native macOS)
    # ou sips si disponible
    
    # Créer les différentes tailles d'icônes
    for size in 16 32 64 128 256 512; do
        size2x=$((size * 2))
        
        # Utiliser sips avec un PNG intermédiaire si possible
        # Pour l'instant, créer un placeholder
        echo "  - Création icon_${size}x${size}.png"
    done
    
    # Note: La conversion SVG->ICNS nécessite des outils supplémentaires
    # On peut utiliser l'icône système par défaut pour l'instant
    echo "  ⚠️  Conversion SVG->ICNS requiert des outils supplémentaires"
    echo "     L'app utilisera l'icône générique pour l'instant"
fi

# 2. Copier les scripts de lancement
echo "📦 Préparation des scripts..."
chmod +x "$APP_DIR/Contents/MacOS/IVS-NDI-Bridge"

# 3. Créer un lien symbolique sur le Bureau
DESKTOP_LINK="$HOME/Desktop/IVS-NDI Bridge.app"
if [ -L "$DESKTOP_LINK" ] || [ -d "$DESKTOP_LINK" ]; then
    rm -rf "$DESKTOP_LINK"
fi
ln -s "$APP_DIR" "$DESKTOP_LINK"
echo "🖥️  Raccourci créé sur le Bureau"

# 4. Enregistrer l'app avec Launch Services pour l'icône
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR"
echo "📋 Application enregistrée avec Launch Services"

echo ""
echo "✅ Build terminé!"
echo ""
echo "Pour lancer l'application:"
echo "  • Double-cliquez sur 'IVS-NDI Bridge' sur le Bureau"
echo "  • Ou: open '$APP_DIR'"
echo ""
