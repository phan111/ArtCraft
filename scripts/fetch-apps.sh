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

# offline.json: each app's files, for the hub's "use offline" button (docs and licences left out:
# they stay online-only). The app's folder URL ("photocraft/") stands for its index.html.
python3 -I - "$DIST" "$versions_json" <<'PY'
import json, os, sys
dist, versions = sys.argv[1], json.loads(sys.argv[2])
skip = {"README.md", "HOSTING.md", "NOTICE", "ATTRIBUTION.md", "LICENSE-MIT", "LICENSE-APACHE"}
apps = {}
for app in versions:
    files, size = [f"{app}/"], 0
    for d, _, names in os.walk(os.path.join(dist, app)):
        for n in sorted(names):
            if n in skip or n.startswith("OFL-") or n == "sw.js":
                continue
            p = os.path.join(d, n)
            files.append(os.path.relpath(p, dist).replace(os.sep, "/"))
            size += os.path.getsize(p)
    apps[app] = {"version": versions[app], "bytes": size, "files": sorted(files),
                 "ownServiceWorker": os.path.exists(os.path.join(dist, app, "sw.js"))}
json.dump({"apps": apps}, open(os.path.join(dist, "offline.json"), "w"), indent=1)
PY

# Fill in the service worker: BUILD changes whenever the hub or any app version changes.
build="$(cat "$DIST/versions.json" "$ROOT"/hub/*.html "$ROOT"/hub/*.js "$ROOT"/hub/*.webmanifest | sha256sum | cut -c1-16)"
sed -i -e "s/__BUILD__/$build/" -e "s|__VERSIONS__|$versions_json|" "$DIST/sw.js"

echo "Built $DIST:"
du -sh "$DIST"/*/ | sed 's#'"$DIST"'/##'
# Report big files: Netlify's CDN handles them, but keep an eye on them.
find "$DIST" -type f -size +24M -printf '  large file: %P (%s bytes)\n'
