#!/usr/bin/env bash
# Build the Craft Hub site in ./dist.
#
# Downloads the official prebuilt web releases of PhotoCraft, FilmCraft, LightCraft and
# EffectCraft (github.com/storytold/*) and lays them out as:
#
#   dist/index.html          the hub
#   dist/photocraft/  dist/filmcraft/  dist/lightcraft/  dist/effectcraft/
#
# Versions are pinned in apps.txt. Set CRAFT_LATEST=1 to take each app's latest release instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
CACHE="${CRAFT_CACHE:-$ROOT/.cache}"
mkdir -p "$CACHE"
rm -rf "$DIST"
mkdir -p "$DIST"

latest_tag() {
  # github.com/<repo>/releases/latest redirects to .../releases/tag/vX.Y.Z (no API token needed).
  curl -fsSI "https://github.com/storytold/$1/releases/latest" \
    | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | sed 's#.*/tag/v##' | tail -1
}

versions_json="{"
while read -r app version; do
  [[ -z "$app" || "$app" == \#* ]] && continue
  if [[ "${CRAFT_LATEST:-0}" == "1" ]]; then
    v="$(latest_tag "$app" || true)"
    [[ -n "$v" ]] && version="$v"
  fi
  zip="$CACHE/$app-web-$version.zip"
  if [[ ! -s "$zip" ]]; then
    echo "→ downloading $app $version"
    curl -fL --retry 4 --retry-delay 2 -o "$zip.tmp" \
      "https://github.com/storytold/$app/releases/download/v$version/$app-web-$version.zip"
    mv "$zip.tmp" "$zip"
  else
    echo "→ $app $version (cached)"
  fi
  tmp="$(mktemp -d)"
  unzip -q "$zip" -d "$tmp"
  mv "$tmp/$app-web-$version" "$DIST/$app"
  rm -rf "$tmp"
  # Sample host configs and precompressed copies are not used on Netlify (it compresses itself).
  rm -f "$DIST/$app/_headers" "$DIST/$app/.htaccess"
  find "$DIST/$app" \( -name '*.gz' -o -name '*.br' \) -delete
  # PhotoCraft's loader (app/photocraft-web.js) imports ./snippets/… relative to app/, but the
  # release ships snippets/ only at the top level (v0.22.0): copy it next to the loader too.
  if [[ -d "$DIST/$app/app" && -d "$DIST/$app/snippets" && ! -d "$DIST/$app/app/snippets" ]] \
     && grep -q '\./snippets/' "$DIST/$app"/app/*.js 2>/dev/null; then
    cp -r "$DIST/$app/snippets" "$DIST/$app/app/snippets"
  fi
  versions_json+="\"$app\":\"$version\","
done < "$ROOT/apps.txt"
versions_json="${versions_json%,}}"

cp -r "$ROOT/hub/." "$DIST/"
echo "$versions_json" > "$DIST/versions.json"

echo "Built $DIST:"
du -sh "$DIST"/*/ | sed 's#'"$DIST"'/##'
# Report big files: Netlify's CDN handles them, but keep an eye on them.
find "$DIST" -type f -size +24M -printf '  large file: %P (%s bytes)\n'
