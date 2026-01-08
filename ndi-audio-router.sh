#!/bin/bash
# NDI Audio Router - Route NDI audio to VB-Cable for IVS
# Usage: ./ndi-audio-router.sh "NDI_SOURCE_NAME"
#
# Example: ./ndi-audio-router.sh "OBS (MACBOOK-PRO)"

NDI_SOURCE="${1:-}"

if [ -z "$NDI_SOURCE" ]; then
    echo "Usage: $0 \"NDI_SOURCE_NAME\""
    echo ""
    echo "Available NDI sources can be found in NDI Monitor or NDI Virtual Input"
    echo "Example: $0 \"OBS (MACBOOK-PRO)\""
    exit 1
fi

echo "🎵 Starting NDI Audio Router..."
echo "📡 Source: $NDI_SOURCE"
echo "🔊 Output: VB-Cable"
echo ""
echo "Press Ctrl+C to stop"

# Run NDI FreeAudio to route audio from NDI source to VB-Cable
'/Library/NDI SDK for Apple/bin/Application.NDI.FreeAudio' \
    -output "VB-Cable" \
    -output_name "$NDI_SOURCE"
