// Hide the apps' "Discord" header pill.
//
// The apps draw their UI on a <canvas> (egui), so CSS can't reach the button. Instead, ask the app
// where it drew it (automation id `header.discord` via `ui.elements`), and lay a patch of the
// header's own colour over that spot in the hub, which also swallows taps on it.
// Works for FilmCraft and EffectCraft (they expose `ui.elements`); the setting lives in the ⋯ menu.

const HUB = window.CraftHub;
const APPS = ["filmcraft", "effectcraft"];
const IDS = ["header.discord"];
const KEY = "crafthub.hideDiscord";
const enabled = () => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };

const covers = new Map(); // app -> {els: [div], color, scale, scaleAt}
const stage = document.getElementById("stage");

function coverFor(app, i) {
  let c = covers.get(app);
  if (!c) { c = { els: [], color: null, scale: 0, scaleAt: 0, lastKey: "" }; covers.set(app, c); }
  if (!c.els[i]) {
    const d = document.createElement("div");
    d.className = "declutter";
    d.style.cssText = "position:absolute;z-index:5;display:none;border-radius:2px;";
    d.addEventListener("pointerdown", e => e.preventDefault());
    stage.appendChild(d);
    c.els[i] = d;
  }
  return c.els[i];
}
function hideAll(except) { for (const [app, c] of covers) if (app !== except) c.els.forEach(d => (d.style.display = "none")); }

// Points → CSS pixels: the canvas width over the window width the app reports in points.
async function scaleOf(app, api, frame, c) {
  if (c.scale && Date.now() - c.scaleAt < 4000) return c.scale;
  const ins = await api.request("ui.inspect", {});
  const w = Array.isArray(ins?.window) ? ins.window[0] : ins?.window?.width;
  const canvas = frame.contentDocument?.querySelector("canvas");
  if (!w || !canvas) return 0;
  c.scale = canvas.clientWidth / w; c.scaleAt = Date.now();
  return c.scale;
}

// The header's background colour around the pill, from one screenshot (only when the spot moves):
// sample a ring of points just outside the pill and keep the most common colour, so text from a
// menu that runs under the pill doesn't decide it.
async function headerColor(api, [x, y, w, h], canvasCssWidth) {
  try {
    const s = await api.screenshot({});
    const b64 = s?.pngBase64 || s?.png;
    if (!b64) return null;
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const k = img.naturalWidth / canvasCssWidth;
    const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const votes = new Map();
    const pts = [];
    for (let i = 0; i <= 6; i++) { const px = x + (w * i) / 6; pts.push([px, y - 3], [px, y + h + 3]); }
    for (const yy of [y + 2, y + h / 2, y + h - 2]) pts.push([x - 4, yy], [x + w + 4, yy]);
    for (const [px, py] of pts) {
      const X = Math.round(px * k), Y = Math.round(py * k);
      if (X < 0 || Y < 0 || X >= cv.width || Y >= cv.height) continue;
      const d = g.getImageData(X, Y, 1, 1).data, key = `rgb(${d[0]},${d[1]},${d[2]})`;
      votes.set(key, (votes.get(key) || 0) + 1);
    }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  } catch { return null; }
}

let busy = false;
async function tick() {
  if (busy || document.hidden) return;
  const app = HUB.current;
  hideAll(app);
  if (!APPS.includes(app)) return;
  const c = covers.get(app);
  if (!enabled()) { c?.els.forEach(d => (d.style.display = "none")); return; }
  const frame = HUB.frameOf(app);
  let api; try { api = frame?.contentWindow?.[app]; } catch { return; }
  if (!api?.request) return;
  busy = true;
  try {
    const cc = c || (coverFor(app, 0), covers.get(app));
    const scale = await scaleOf(app, api, frame, cc);
    if (!scale) return;
    const els = [];
    for (const id of IDS) {
      const list = await api.request("ui.elements", { prefix: id });
      for (const e of Array.isArray(list) ? list : []) if (e.id === id && Array.isArray(e.rect)) els.push(e.rect);
    }
    els.forEach(async (r, i) => {
      const d = coverFor(app, i);
      const [x, y, w, h] = r.map(v => v * scale);
      const key = `${x|0},${y|0},${w|0},${h|0}`;
      d.style.left = `${x - 1}px`; d.style.top = `${y - 1}px`; d.style.width = `${w + 2}px`; d.style.height = `${h + 2}px`;
      if (key !== cc.lastKey || !cc.color) {
        cc.lastKey = key;
        // Sample the header a few pixels left of the pill, at its vertical middle.
        const cw = frame.contentDocument.querySelector("canvas")?.clientWidth || frame.clientWidth;
        cc.color = (await headerColor(api, [x, y, w, h], cw)) || cc.color || "#1d1d1d";
      }
      d.style.background = cc.color;
      d.style.display = HUB.current === app ? "block" : "none";
    });
    cc.els.slice(els.length).forEach(d => (d.style.display = "none"));
  } catch { /* app busy or reloading: try again next tick */ }
  finally { busy = false; }
}

setInterval(tick, 1500);
HUB.onChange(() => { hideAll(HUB.current); setTimeout(tick, 300); });
// The app area changes size with the window and when the AI panel is pinned or unpinned.
new ResizeObserver(() => { for (const c of covers.values()) c.scaleAt = 0; setTimeout(tick, 300); }).observe(stage);

window.CraftDeclutter = {
  get enabled() { return enabled(); },
  set(on) { try { localStorage.setItem(KEY, on ? "1" : "0"); } catch {} for (const c of covers.values()) c.scaleAt = 0; tick(); },
  refresh() { for (const c of covers.values()) c.scaleAt = 0; tick(); },
};
