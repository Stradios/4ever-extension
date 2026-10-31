#!/bin/sh
# Builds 4ever.zip, ready for: gnome-extensions install --force 4ever.zip
set -e
cd "$(dirname "$0")"
glib-compile-schemas --strict schemas/
rm -f 4ever.zip
zip -qr 4ever.zip metadata.json extension.js prefs.js tray.js trayutil.js searchproviders.js \
    stylesheet.css start.svg schemas/*.gschema.xml schemas/gschemas.compiled
echo "Built 4ever.zip"
