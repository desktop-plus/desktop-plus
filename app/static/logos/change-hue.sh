#!/usr/bin/env bash

set -o errexit
set -o nounset

# Apply an ImageMagick -modulate transformation to every size of an ICNS image.
#
#   $1 - path to the ICNS to transform
#   $2 - argument for the ImageMagick `-modulate` flag
#
function modulate_icns() {
    icns_path="$1"
    modulate_arg="$2"

    # Get the filename, filename before extension
    # https://stackoverflow.com/a/965072/1558022
    filename=$(basename "$icns_path")
    icon_name="${filename%.*}"

    iconset_path="$icon_name.iconset"
    out_path="$icon_name-$modulate_arg.icns"

    # Unpack the ICNS as individual images
    iconutil --convert iconset --output "$iconset_path" "$icns_path"

    # Apply the -modulate transformation to every individual image
    find "$iconset_path" -type f -exec magick '{}' -modulate "$modulate_arg" '{}' \;

    # Join the images back together into a single ICNS file
    iconutil --convert icns --output "$out_path" "$iconset_path"
}

modulate_icns "icon-logo.icns" "100,100,60"
