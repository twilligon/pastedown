#!/bin/sh
set -euo pipefail

for size in 16 24 32 48 128; do
  rsvg-convert -w ${size} -h ${size} icon.svg -o pastedown/assets/icon${size}.png
done
