#!/usr/bin/env bash

set -o errexit
set -o nounset

# Convert PNG logos to ICNS and ICO formats
function convert_logos() {
    # Create ICO file from multiple PNG sizes
    magick 32x32.png 64x64.png 128x128.png 256x256.png 512x512.png icon-logo.ico
    
    # Create iconset directory structure for ICNS
    mkdir -p icon-logo.iconset
    cp 32x32.png icon-logo.iconset/icon_16x16@2x.png
    cp 32x32.png icon-logo.iconset/icon_32x32.png
    cp 64x64.png icon-logo.iconset/icon_32x32@2x.png
    cp 128x128.png icon-logo.iconset/icon_128x128.png
    cp 256x256.png icon-logo.iconset/icon_128x128@2x.png
    cp 256x256.png icon-logo.iconset/icon_256x256.png
    cp 512x512.png icon-logo.iconset/icon_256x256@2x.png
    cp 512x512.png icon-logo.iconset/icon_512x512.png
    cp 1024x1024.png icon-logo.iconset/icon_512x512@2x.png
    
    # Convert to ICNS
    iconutil --convert icns --output icon-logo.icns icon-logo.iconset
}

convert_logos