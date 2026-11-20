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

## Installing it as an app (PWA, Android, desktop)

1. Open the site in **Chrome** on Android (or Chrome/Edge on a computer).
2. Tap **⤓ Install app** at the top right, or go to the ⋮ menu → **Add to Home screen / Install app**.
3. A Craft Hub icon appears on the home screen and opens full screen like an app. **Long-press the icon** to go straight into PhotoCraft, FilmCraft, LightCraft or EffectCraft.

**Offline use:** on each card, tap **⬇ Use offline** to download that app's files into the device (14–72 MB per app). After that it opens even with no internet.
When a new app version comes out (you bump `apps.txt`), the old files are dropped and you download the new ones.

> On a phone, landscape works best, or use a tablet with a mouse/keyboard: these apps have desktop-style UIs.
> Your work (projects, photo library) lives in the device's browser storage. Uninstalling the app or clearing Chrome's data deletes it, so Export/Back Up regularly.

### ใช้ Claude Desktop / Claude Code สั่งงาน (บนคอมพิวเตอร์)
ฮับเลือกโหมดให้เอง: **มือถือ/แท็บเล็ต → AI ในเบราว์เซอร์ (API key)**, **คอมพิวเตอร์ → Claude Desktop** (สลับเองได้ที่หัวแผง AI)

Claude Desktop / Claude Code ใช้แพ็กเกจ Claude ที่มีอยู่ ไม่ต้องจ่าย API แยก ทำงานผ่านตัวเชื่อม MCP เล็ก ๆ
(`hub/bridge/craft-hub-mcp.mjs`, Node.js 18+, ไม่มี dependency) ที่รันบนเครื่องคุณ:

```
Claude ⇄ (MCP stdio) ⇄ craft-hub-mcp.mjs ⇄ (HTTP 127.0.0.1:47821) ⇄ หน้า Craft Hub ในเบราว์เซอร์
```

ใช้ได้กับ Claude Desktop, Claude Code, Google Antigravity (`agy`, ไฟล์ `~/.gemini/config/mcp_config.json`) และโปรแกรมอื่นที่รองรับ MCP แบบ stdio
ตั้งค่า: เปิดแผง AI โหมด “AI บนคอม (MCP)” เลือกโปรแกรม แล้วคัดลอก config ที่ฮับสร้างให้ หรือสำหรับ Claude Code:

```bash
claude mcp add craft-hub -- node /path/to/craft-hub-mcp.mjs --origin https://<your-hub>.netlify.app
```

ตัวเชื่อมรับเฉพาะหน้าเว็บจาก `--origin` (และ localhost) และไม่อ่าน/รันอะไรในเครื่อง แค่ส่งคำสั่งแอปไปให้หน้าฮับ
เครื่องมือที่ Claude ใช้: `hub_status`, `open_app`, `find_commands`, `run_command`, `ui_request`, `screenshot`, `wait`

### ปุ่ม Discord ในแอป
FilmCraft และ EffectCraft วาดหน้าจอบน `<canvas>` จึงซ่อนด้วย CSS ไม่ได้ ฮับ (`hub/declutter.js`) ถามตำแหน่งปุ่ม `header.discord`
จากแอปผ่าน `ui.elements` แล้ววางแผ่นสีเดียวกับแถบหัวทับไว้ (กดไม่ได้) ปิด/เปิดได้ที่เมนู ⋯ → “ซ่อนปุ่ม Discord ในแอป”
LightCraft/PhotoCraft ไม่มี API บอกตำแหน่ง จึงยังซ่อนไม่ได้

## ผู้ช่วย AI (ให้ AI ช่วยตัดต่อ)

กดปุ่ม **🤖 AI** มุมขวาบน (หรือ `Alt+A`) แล้วพิมพ์สั่งงาน เช่น “เปิดโปรเจกต์ตัวอย่าง แล้วใส่ไตเติล Hello ช่วง 3 วิแรก”
AI จะค้นหาคำสั่งของแอป สั่งงาน แล้วถ่ายภาพหน้าจอดูผลเอง ทุกขั้นที่ทำแสดงในแชท กด ■ เพื่อหยุดได้ตลอด

| แอป | AI ทำอะไรได้ |
|---|---|
| FilmCraft | ครบ: 700+ คำสั่ง, คลิก UI, ดูภาพหน้าจอ |
| EffectCraft | ครบ: 700+ คำสั่ง, คลิก UI, ดูภาพหน้าจอ, render เฟรม |
| LightCraft | สั่งงานได้ 388 คำสั่ง (รายชื่ออยู่ใน `hub/ai/lightcraft-commands.json`) แต่มองไม่เห็นหน้าจอ |
| PhotoCraft | ยังไม่ได้ (เวอร์ชันเว็บไม่มี API ให้สั่ง) |

**ผู้ให้บริการที่เลือกได้** (⚙ ในแผง AI): Claude, OpenAI, Google Gemini, OpenRouter, หรือ “กำหนดเอง” สำหรับ API แบบ OpenAI
เช่น Ollama / LM Studio ในเครื่อง (`http://localhost:11434/v1`, ต้องตั้ง `OLLAMA_ORIGINS` ให้รับเว็บนี้)
โมเดลต้องรองรับ tool calling และควรดูรูปได้ งานซับซ้อนใช้โมเดลระดับบนจะทำได้ดีกว่ามาก

- API key เก็บใน localStorage ของเบราว์เซอร์เครื่องนั้น ส่งตรงไปผู้ให้บริการเท่านั้น ค่าใช้จ่ายคิดตามบัญชีของคุณ (แนะนำตั้งวงเงินไว้)
- AI อ่านไฟล์ในเครื่องไม่ได้: ลากฟุตเทจ/รูปเข้าแอปเองก่อน แล้วค่อยสั่ง
- อัปเดต LightCraft แล้ว ให้สร้างรายชื่อคำสั่งใหม่: `python3 tools/lightcraft_commands.py <lightcraft>/crates/engine/src hub/ai/lightcraft-commands.json`

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
