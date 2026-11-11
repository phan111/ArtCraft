# Craft Hub

A personal hub for editing work that runs entirely in the browser. It brings four open-source apps from [storytold](https://github.com/storytold) together in one place:

| App | Use it for | Version |
|---|---|---|
| **PhotoCraft** | Photo retouching, layers, PSD files | see `apps.txt` |
| **FilmCraft** | Video editing, colour grading, sound | |
| **LightCraft** | Photo library, RAW development | |
| **EffectCraft** | Motion graphics, VFX | |

Open several apps in tabs at the top of the hub and switch between them; each app keeps its state.
Shortcuts: `Alt+1..4` opens an app, `Alt+0` goes back home. A link like `/#filmcraft` opens that app straight away.

## How it works

The repository holds only the hub page and the scripts, with no large files.
When Netlify builds, `scripts/fetch-apps.sh` downloads each app's **official prebuilt web release** (`<app>-web-<version>.zip`) from GitHub Releases and lays them out as:

```
dist/
  index.html        ← the hub
  photocraft/  filmcraft/  lightcraft/  effectcraft/
```

Nothing has to be compiled in Rust, and a build takes only a minute or two.

## Deploying to Netlify (once)

1. Netlify → **Add new site → Import an existing project** → choose GitHub → `phan111/ArtCraft`
2. Branch: pick the branch you use, for example `claude/funny-dirac-bp7sk0`, or `main` after merging.
3. You don't need to fill in anything else: Netlify reads the build command and the `dist` folder from `netlify.toml`.
4. Deploy. Later, every push rebuilds the site automatically.

> For personal use: in Site settings → **Access control** you can set a password (Netlify's paid plans only).
> The hub also has `noindex`, so search engines don't index it.

## Updating app versions

Edit the version numbers in `apps.txt` and push. Alternatively, set the environment variable `CRAFT_LATEST=1` in Netlify
(Site settings → Environment variables) so that every build pulls the latest release.

## Testing on your own machine

```bash
bash scripts/fetch-apps.sh
```

```bash
python3 -m http.server 8765 -d dist
```

Then open http://localhost:8765/

## Things to know

- **Files live in the browser**: projects and imported media are kept in the browser's storage for the site's domain. Save, Export or Back Up your work regularly.
- **Large files**: EffectCraft's WebAssembly is about 75 MB and FilmCraft's about 49 MB. Netlify compresses them as it serves them, so the first visit takes a while; after that they come from the cache.
- **PhotoCraft v0.22.0**: the release zip puts `snippets/` in the wrong place, so the app hangs on Loading. The build script copies it next to the loader automatically.
- Chrome or Edge, which have WebGPU, work best. If you get a black screen, use the ⚙ button on a card to open the app with WebGL instead.

## Licences

Every app is © the ArtCraft / storytold team, under MIT or Apache-2.0. Each app's folder keeps its `LICENSE-*`, `NOTICE` and `README.md`.
The app icons in `hub/icons/` come from each project's `assets/app-icon/`.
