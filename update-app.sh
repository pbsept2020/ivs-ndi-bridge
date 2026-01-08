#!/bin/bash
# Script de mise à jour de IVS-NDI Bridge dans /Applications
# À exécuter après chaque modification du projet

PROJECT_DIR="/Users/bessette_nouveau_macbook_pro/Projets/ivs-ndi-bridge"
APP_NAME="IVS-NDI Bridge.app"

echo "🔄 Mise à jour de $APP_NAME..."

# Synchroniser l'app vers /Applications
rsync -av --delete "$PROJECT_DIR/$APP_NAME/" "/Applications/$APP_NAME/"

# Rafraîchir Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/$APP_NAME"

# Touch pour forcer le refresh de l'icône
touch "/Applications/$APP_NAME"

echo "✅ $APP_NAME mis à jour dans /Applications"
