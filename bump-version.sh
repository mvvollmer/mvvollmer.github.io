#!/bin/sh
# Stamp a new version on every stylesheet, script, and PDF link so browsers fetch fresh copies.
# Run from this folder after changing the site, then commit and push:   ./bump-version.sh
set -e
cd "$(dirname "$0")"
NEW="$(date +%Y%m%d%H%M)"
sed -i '' -E "s/\?v=[A-Za-z0-9-]+\"/?v=$NEW\"/g" index.html resume.html projects.html case-studies.html poker.html
sed -i '' -E "s/VERSION = \"[A-Za-z0-9-]+\"/VERSION = \"$NEW\"/" js/sky.js
echo "Version stamped: $NEW"
