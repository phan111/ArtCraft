// Craft Hub AI assistant: a chat panel that drives the app open in the hub through the apps'
// own browser automation APIs (window.filmcraft / window.effectcraft / window.lightcraft).
//
// Providers: Anthropic (Messages API) or any OpenAI-compatible Chat Completions endpoint
// (OpenAI, Google Gemini, OpenRouter, Ollama / LM Studio, …). Calls go straight from this page
// to the provider with the user's own key; nothing passes through a server of ours.

const HUB = window.CraftHub;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------- providers
const PROVIDERS = {
  anthropic: { label: "Claude (Anthropic)", kind: "anthropic", base: "https://api.anthropic.com/v1",
    model: "claude-opus-5-5", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { label: "OpenAI (GPT)", kind: "openai", base: "https://api.openai.com/v1", model: "gpt-5",
    keyUrl: "https://platform.openai.com/api-keys" },
  gemini: { label: "Google Gemini", kind: "openai", base: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash", keyUrl: "https://aistudio.google.com/apikey" },
  openrouter: { label: "OpenRouter (หลายโมเดล)", kind: "openai", base: "https://openrouter.ai/api/v1",
    model: "openrouter/auto", keyUrl: "https://openrouter.ai/keys" },
  custom: { label: "กำหนดเอง (Ollama, LM Studio, อื่น ๆ)", kind: "openai", base: "http://localhost:11434/v1", model: "", keyOptional: true },
};

const store = {
  get(k, d) { try { const v = localStorage.getItem("crafthub.ai." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("crafthub.ai." + k, JSON.stringify(v)); } catch {} },
};
function config() {
  const provider = store.get("provider", "anthropic");
  const p = PROVIDERS[provider] || PROVIDERS.anthropic;
  const per = store.get("p." + provider, {});
  return { provider, kind: p.kind, base: (per.base || p.base).replace(/\/+$/, ""), key: per.key || "",
    model: per.model || p.model, keyOptional: !!p.keyOptional };
}

class ApiError extends Error {}

async function httpJson(url, opts, signal) {
  let res;
  try { res = await fetch(url, { ...opts, signal }); }
  catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError(`เชื่อมต่อ ${new URL(url).host} ไม่ได้ (${e.message}). ถ้าเป็นเซิร์ฟเวอร์ในเครื่อง ต้องเปิดให้รับคำขอจากเว็บนี้ (CORS) เช่น Ollama ตั้ง OLLAMA_ORIGINS`);
  }
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || (Array.isArray(body) && body[0]?.error?.message) || text.slice(0, 300);
    const err = new ApiError(`${res.status}: ${msg}`); err.status = res.status; err.body = body; throw err;
  }
  return body;
}

function anthropicHeaders(cfg) {
  return { "content-type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true" };
}

async function listModels(cfg) {
  if (cfg.kind === "anthropic") {
    const j = await httpJson(`${cfg.base}/models?limit=100`, { headers: anthropicHeaders(cfg) });
    return (j.data || []).map(m => m.id);
  }
  const headers = cfg.key ? { authorization: `Bearer ${cfg.key}` } : {};
  const j = await httpJson(`${cfg.base}/models`, { headers });
  return (j.data || j.models || []).map(m => String(m.id || m.name || "").replace(/^models\//, "")).filter(Boolean).sort();
}

// One model turn. Returns { text, calls: [{id, name, input}], stop, raw } and appends the
// assistant turn to `conv.messages` in the provider's own format.
const FALLBACK_MODELS = /^claude-(opus-5-5|sonnet-5-5|fable-5)/;
async function modelTurn(cfg, conv, system, tools, signal) {
  if (cfg.kind === "anthropic") {
    const body = { model: cfg.model, max_tokens: 16000, system, messages: conv.messages,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      cache_control: { type: "ephemeral" } };
    const headers = anthropicHeaders(cfg);
    const useFallback = FALLBACK_MODELS.test(cfg.model) && !conv.noFallback;
    if (useFallback) { body.fallbacks = "default"; headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; }
    let j;
    try { j = await httpJson(`${cfg.base}/messages`, { method: "POST", headers, body: JSON.stringify(body) }, signal); }
    catch (e) {
      if (useFallback && e.status === 400 && /fallback/i.test(e.message)) { conv.noFallback = true; return modelTurn(cfg, conv, system, tools, signal); }
      throw e;
    }
    conv.messages.push({ role: "assistant", content: j.content });
    const text = j.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const calls = j.content.filter(b => b.type === "tool_use").map(b => ({ id: b.id, name: b.name, input: b.input || {} }));
    return { text, calls, stop: j.stop_reason, usage: j.usage, details: j.stop_details };
  }
  const body = { model: cfg.model, messages: [{ role: "system", content: system }, ...conv.messages],
    tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) };
  const headers = { "content-type": "application/json" };
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  if (cfg.provider === "openrouter") headers["X-Title"] = "Craft Hub";
  const j = await httpJson(`${cfg.base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }, signal);
  const msg = j.choices?.[0]?.message || {};
  const calls = (msg.tool_calls || []).map((c, i) => {
    let input = {}; try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = { __bad_json: c.function?.arguments }; }
    return { id: c.id || `call_${Date.now()}_${i}`, name: c.function?.name, input };
  });
  const keep = { role: "assistant", content: msg.content ?? "" };
  if (calls.length) keep.tool_calls = calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }));
  conv.messages.push(keep);
  const text = typeof msg.content === "string" ? msg.content.trim() : "";
  return { text, calls, stop: j.choices?.[0]?.finish_reason, usage: j.usage };
}

// Append tool results ({id, text, image?, error?}) in the provider's format.
function pushResults(cfg, conv, results) {
  if (cfg.kind === "anthropic") {
    conv.messages.push({ role: "user", content: results.map(r => ({
      type: "tool_result", tool_use_id: r.id, is_error: !!r.error,
      content: r.image ? [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.image } }, { type: "text", text: r.text }]
        : r.text })) });
    return;
  }
  for (const r of results) conv.messages.push({ role: "tool", tool_call_id: r.id, content: (r.error ? "ERROR: " : "") + r.text });
  const imgs = results.filter(r => r.image);
  if (imgs.length) conv.messages.push({ role: "user", content: [
    { type: "text", text: "Screenshot(s) returned by the screenshot tool above:" },
    ...imgs.map(r => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${r.image}` } })) ] });
}
function pushUser(cfg, conv, text) { conv.messages.push({ role: "user", content: text }); }

// ---------------------------------------------------------------- app bridge
const CAPS = {
  filmcraft:   { api: "full", name: "FilmCraft", what: "non-linear video editor (timeline, clips, color, audio, titles, export)" },
  effectcraft: { api: "full", name: "EffectCraft", what: "motion graphics / VFX compositor (compositions, layers, keyframes, effects, render queue)" },
  lightcraft:  { api: "command", name: "LightCraft", what: "photo library and raw developer (import, rate, develop sliders, masks, export)" },
  photocraft:  { api: "none", name: "PhotoCraft", what: "layered image editor (PSD)" },
};
const catalogCache = new Map(); // app -> command list

async function appApi(app, timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const f = HUB.frameOf(app);
    const api = f?.contentWindow?.[app];
    if (api) return api;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${CAPS[app].name} ยังโหลดไม่เสร็จ`);
    await new Promise(r => setTimeout(r, 500));
  }
}

async function catalog(app) {
  if (catalogCache.has(app)) return catalogCache.get(app);
  let list = [];
  if (CAPS[app].api === "full") {
    const c = await (await appApi(app)).commands();
    list = Array.isArray(c) ? c : (c?.commands || []);
  } else if (app === "lightcraft") {
    const r = await fetch("ai/lightcraft-commands.json");
    list = r.ok ? await r.json() : [];
  }
  catalogCache.set(app, list);
  return list;
}
function forgetCatalog(app) { catalogCache.delete(app); }

const clip = (s, n = 8000) => (s.length > n ? s.slice(0, n) + `\n… (ตัดเหลือ ${n} จาก ${s.length} ตัวอักษร)` : s);
const asText = v => { if (v === undefined) return "OK (no result)"; if (typeof v === "string") return v; try { return JSON.stringify(v); } catch { return String(v); } };

async function toJpeg(shot) {
  let src;
  const b64 = shot?.pngBase64 || shot?.png; // FilmCraft: pngBase64, EffectCraft: png
  if (typeof b64 === "string") src = `data:image/png;base64,${b64}`;
  else if (typeof shot?.data === "string") src = shot.data.startsWith("data:") ? shot.data : `data:image/png;base64,${shot.data}`;
  else if (shot?.data instanceof Uint8Array || shot?.data instanceof ArrayBuffer || shot instanceof Uint8Array)
    src = URL.createObjectURL(new Blob([shot.data || shot], { type: "image/png" }));
  else if (typeof shot === "string") src = shot.startsWith("data:") ? shot : `data:image/png;base64,${shot}`;
  if (!src) throw new Error("แอปไม่ได้ส่งภาพหน้าจอกลับมา");
  const img = new Image(); img.src = src; await img.decode();
  const scale = Math.min(1, 1280 / img.naturalWidth);
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  if (src.startsWith("blob:")) URL.revokeObjectURL(src);
  return { b64: c.toDataURL("image/jpeg", 0.8).split(",")[1], w: c.width, h: c.height };
}

const APP_ENUM = Object.keys(CAPS);
const TOOLS = [
  { name: "open_app", description: "Open (or switch to) one of the hub's apps and make it the target of the other tools. Waits until the app's automation API is ready.",
    parameters: { type: "object", properties: { app: { type: "string", enum: APP_ENUM } }, required: ["app"], additionalProperties: false } },
  { name: "find_commands", description: "Search the current app's command registry (every menu item, button and action is a command). Returns matching commands with id, label, menu path, parameter documentation and whether it is enabled now. All words in `query` must match id, label or menu (case-insensitive). Use an empty query to see the command groups.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 80 } }, required: ["query"], additionalProperties: false } },
  { name: "run_command", description: "Run one command in the current app by id with JSON params, exactly as documented by find_commands. Returns the command's JSON result or its error.",
    parameters: { type: "object", properties: { command: { type: "string" }, params: { type: "object" } }, required: ["command"], additionalProperties: false } },
  { name: "ui_request", description: "FilmCraft/EffectCraft only: call a UI control method, e.g. ui.inspect (UI tree with automation ids), ui.click {id}, ui.key {key}, ui.playback, render.frame. Use when no engine command does the job.",
    parameters: { type: "object", properties: { method: { type: "string" }, params: { type: "object" } }, required: ["method"], additionalProperties: false } },
  { name: "screenshot", description: "FilmCraft/EffectCraft only: take a screenshot of the current app to see the result of your actions. Optional `panel` to capture one panel.",
    parameters: { type: "object", properties: { panel: { type: "string" } }, additionalProperties: false } },
  { name: "wait", description: "Wait for background work (loading, rendering) for up to 15 seconds.",
    parameters: { type: "object", properties: { seconds: { type: "number", minimum: 0.5, maximum: 15 } }, required: ["seconds"], additionalProperties: false } },
];

async function runTool(name, input, ui) {
  const app = HUB.current;
  const needApp = () => { if (!app) throw new Error("ยังไม่ได้เปิดแอปไหน ใช้ open_app ก่อน"); return app; };
  switch (name) {
    case "open_app": {
      if (!CAPS[input.app]) throw new Error(`ไม่รู้จักแอป ${input.app}`);
      HUB.openApp(input.app);
      if (CAPS[input.app].api === "none") return { text: `${CAPS[input.app].name} เปิดแล้ว แต่เวอร์ชันเว็บนี้ไม่มี API ให้ AI สั่งงาน ทำได้แค่แนะนำผู้ใช้` };
      const api = await appApi(input.app);
      let info = "";
      try { if (api.info) info = clip(asText(await api.info()), 1500); } catch {}
      return { text: `${CAPS[input.app].name} พร้อมแล้ว ${info}` };
    }
    case "find_commands": {
      const a = needApp();
      if (CAPS[a].api === "none") throw new Error(`${CAPS[a].name} ไม่มี API สั่งงาน`);
      const list = await catalog(a);
      const words = String(input.query || "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) {
        const groups = {};
        for (const c of list) { const g = String(c.id).split(".")[0]; groups[g] = (groups[g] || 0) + 1; }
        return { text: `${list.length} commands. Groups (prefix: count): ` + Object.entries(groups).sort((x, y) => y[1] - x[1]).map(([g, n]) => `${g}: ${n}`).join(", ") };
      }
      const hits = list.filter(c => {
        const hay = `${c.id} ${c.label || ""} ${(c.menu || []).join(" ")}`.toLowerCase();
        return words.every(w => hay.includes(w));
      }).slice(0, input.limit || 30);
      if (!hits.length) return { text: "ไม่พบคำสั่งที่ตรง ลองคำอื่น (ภาษาอังกฤษ) หรือส่ง query ว่างเพื่อดูกลุ่มคำสั่ง" };
      return { text: clip(hits.map(c => [c.id, c.label, (c.menu || []).join(" › ") || "-", c.params || "{}",
        c.enabled === false ? `DISABLED${c.why ? " (" + c.why + ")" : ""}` : ""].filter(Boolean).join(" | ")).join("\n"), 12000) };
    }
    case "run_command": {
      const a = needApp();
      const api = await appApi(a, 5000).catch(() => null);
      if (!api || CAPS[a].api === "none") throw new Error(`${CAPS[a].name} ไม่มี API สั่งงาน`);
      const params = input.params && typeof input.params === "object" ? input.params : {};
      let v;
      if (CAPS[a].api === "full") v = await api.execute(input.command, params);
      else { v = await api.command(input.command, JSON.stringify(params)); if (typeof v === "string") { try { v = JSON.parse(v); } catch {} } }
      if (/^(file\.(open|new)|project\.)/.test(input.command)) forgetCatalog(a);
      return { text: clip(asText(v)) };
    }
    case "ui_request": {
      const a = needApp();
      if (CAPS[a].api !== "full") throw new Error(`${CAPS[a].name} ไม่มี ui_request`);
      return { text: clip(asText(await (await appApi(a)).request(input.method, input.params || {})), 12000) };
    }
    case "screenshot": {
      const a = needApp();
      if (CAPS[a].api !== "full") throw new Error(`${CAPS[a].name} ถ่ายภาพหน้าจอผ่าน API ไม่ได้ ใช้คำสั่ง query ของแอปเพื่อตรวจผลแทน`);
      const shot = await (await appApi(a)).screenshot(input.panel ? { panel: input.panel } : {});
      const j = await toJpeg(shot);
      ui.image(j.b64);
      return { text: `screenshot ${j.w}x${j.h}`, image: j.b64 };
    }
    case "wait": {
      await new Promise(r => setTimeout(r, Math.min(15, Math.max(0.5, Number(input.seconds) || 1)) * 1000));
      return { text: "waited" };
    }
  }
  throw new Error(`ไม่รู้จักเครื่องมือ ${name}`);
}

function systemPrompt() {
  const app = HUB.current;
  const lines = [
    "You are the AI assistant inside Craft Hub, a personal web hub that runs four open-source creative apps in the browser (each in its own tab):",
    ...APP_ENUM.map(a => `- ${a}: ${CAPS[a].name}, ${CAPS[a].what}. Automation: ${{ full: "full (commands, UI control, screenshots)", command: "commands only (no screenshots)", none: "none in this web version" }[CAPS[a].api]}.`),
    "",
    `The app the user is looking at now: ${app ? CAPS[app].name : "none (the hub's home page)"}.`,
    "",
    "How to work:",
    "- Every action in an app is a command with an id. Before running a command you have not used in this conversation, look it up with find_commands and follow its parameter documentation exactly. Prefer engine commands over clicking the UI.",
    "- Work step by step and verify: after changes, take a screenshot (FilmCraft/EffectCraft) or run a query command to check the result before saying it's done.",
    "- If a command fails, read the error, adjust, and try another way; don't repeat the same failing call.",
    "- Media files: you cannot read the user's disk. If the task needs footage or photos that are not in the project yet, ask the user to drag them into the app first (or to use File › Import).",
    "- Exports and saves arrive as browser downloads.",
    "- Ask before anything destructive or hard to undo (deleting clips, media, photos, albums or projects; overwriting work) unless the user clearly asked for it.",
    "- If the request is ambiguous, ask one short question instead of guessing.",
    "- Reply in the user's language (usually Thai). Keep replies short: what you did and what the user should check.",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- UI
const SUGGEST = {
  filmcraft: ["ตัดคลิปที่เลือกออกเป็นสองส่วนที่ตำแหน่งหัวอ่าน", "ใส่ไตเติลชื่อ \"My Trip\" ช่วง 3 วินาทีแรก", "export ซีเควนซ์นี้เป็น MP4 1080p"],
  effectcraft: ["สร้างคอมโพสิชันใหม่ 1920x1080 30fps ยาว 10 วิ", "ทำข้อความ \"Hello\" ค่อย ๆ ปรากฏ (fade in) 1 วินาที", "เพิ่ม glow ให้เลเยอร์ที่เลือก"],
  lightcraft: ["ให้ 5 ดาวรูปที่เลือก", "เพิ่ม exposure +0.5 และ contrast +10 ให้รูปนี้", "export รูปที่เลือกเป็น JPEG ด้านยาว 2048px"],
  home: ["เปิด FilmCraft", "แอปไหนเหมาะกับการทำไตเติลเคลื่อนไหว?"],
};

let conv = { messages: [] }, busy = false, abort = null;

function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
function md(s) {
  return esc(s).replace(/```([\s\S]*?)```/g, "<pre>$1</pre>").replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}

const panel = el(`
<aside id="ai" aria-label="ผู้ช่วย AI" hidden>
  <header>
    <strong>🤖 ผู้ช่วย AI</strong><span id="ai-target"></span>
    <span class="sp"></span>
    <button data-act="settings" title="ตั้งค่า AI">⚙</button>
    <button data-act="clear" title="เริ่มแชทใหม่">🗑</button>
    <button data-act="close" title="ปิด">✕</button>
  </header>
  <section id="ai-settings" hidden>
    <label>ผู้ให้บริการ<select id="ai-provider">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join("")}</select></label>
    <label id="ai-base-row">URL ของ API<input id="ai-base" placeholder="http://localhost:11434/v1" autocomplete="off"></label>
    <label>API key <a id="ai-keylink" target="_blank" rel="noopener">สร้าง key</a><input id="ai-key" type="password" autocomplete="off" placeholder="วาง API key ที่นี่"></label>
    <label>โมเดล<span class="row"><select id="ai-model-select"></select><button id="ai-load" type="button" title="โหลดรายชื่อโมเดลจากผู้ให้บริการ">⟳</button></span></label>
    <label id="ai-model-row" hidden>ชื่อโมเดล<input id="ai-model" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="เช่น llama3.2-vision"></label>
    <p class="hint">key เก็บไว้ในเบราว์เซอร์เครื่องนี้เท่านั้น ส่งตรงไปยังผู้ให้บริการที่เลือก ค่าใช้จ่ายคิดตามการใช้งานของบัญชีนั้น ใช้ key ที่ตั้งวงเงินไว้จะปลอดภัยกว่า</p>
    <p class="hint" id="ai-status"></p>
    <div class="row"><button id="ai-save" class="primary" type="button">บันทึก</button><button id="ai-forget" type="button">ลบ key</button></div>
  </section>
  <div id="ai-log"></div>
  <form id="ai-form">
    <textarea id="ai-input" rows="2" placeholder="สั่งงาน เช่น ตัดช่วงเงียบออก แล้วใส่ไตเติล…"></textarea>
    <button id="ai-send" type="submit" title="ส่ง (Enter)">➤</button>
  </form>
</aside>`);
document.body.appendChild(panel);

const log = $("#ai-log", panel), input = $("#ai-input", panel), sendBtn = $("#ai-send", panel);
const scrollDown = () => { log.scrollTop = log.scrollHeight; };
const ui = {
  user(t) { log.appendChild(el(`<div class="msg user">${esc(t)}</div>`)); scrollDown(); },
  bot(t) { log.appendChild(el(`<div class="msg bot">${md(t)}</div>`)); scrollDown(); },
  note(t, cls = "") { log.appendChild(el(`<div class="note ${cls}">${md(t)}</div>`)); scrollDown(); },
  tool(name, inp) {
    const d = el(`<details class="tool"><summary><span class="st">⏳</span> <code>${esc(name)}</code> <span class="arg">${esc(summ(name, inp))}</span></summary><pre>${esc(JSON.stringify(inp, null, 1))}</pre></details>`);
    log.appendChild(d); scrollDown();
    return { done(text, err) { $(".st", d).textContent = err ? "⚠️" : "✓"; d.appendChild(el(`<pre class="res">${esc(text.slice(0, 3000))}</pre>`)); } };
  },
  image(b64) { log.appendChild(el(`<img class="shot" alt="ภาพหน้าจอ" src="data:image/jpeg;base64,${b64}">`)); scrollDown(); },
};
function summ(name, i) {
  if (name === "run_command") return i.command + (i.params && Object.keys(i.params).length ? " " + JSON.stringify(i.params).slice(0, 60) : "");
  if (name === "find_commands") return `"${i.query}"`;
  if (name === "open_app") return i.app;
  if (name === "ui_request") return i.method;
  return "";
}

function renderEmpty() {
  if (log.children.length) return;
  const cfg = config();
  const key = cfg.key || cfg.keyOptional;
  const sug = SUGGEST[HUB.current] || SUGGEST.home;
  log.appendChild(el(`<div class="empty">
    <p>${key ? "บอกสิ่งที่อยากให้ทำในแอปที่เปิดอยู่ AI จะสั่งงานแอปให้ และตรวจผลเอง" : "ตั้งค่าผู้ให้บริการ AI และ API key ก่อนใช้งาน"}</p>
    ${key ? sug.map(s => `<button class="chip">${esc(s)}</button>`).join("") : `<button class="chip" data-act="settings">⚙ ตั้งค่า AI</button>`}
    <p class="hint">ใช้ได้เต็มที่กับ FilmCraft และ EffectCraft · LightCraft สั่งงานได้แต่ AI มองไม่เห็นหน้าจอ · PhotoCraft เวอร์ชันเว็บยังสั่งงานไม่ได้</p>
  </div>`));
}

function updateTarget() {
  const a = HUB.current;
  $("#ai-target", panel).textContent = a ? ` · ${CAPS[a].name}` : "";
  const e = $(".empty", log); if (e) { e.remove(); renderEmpty(); }
}

function toggle(show = panel.hidden) {
  panel.hidden = !show;
  document.body.classList.toggle("ai-open", show);
  $("#ai-btn")?.classList.toggle("active", show);
  if (show) { renderEmpty(); updateTarget(); if (!config().key && !config().keyOptional) openSettings(); else input.focus(); }
}

// settings
function openSettings() {
  const s = $("#ai-settings", panel); s.hidden = false;
  const provider = store.get("provider", "anthropic");
  $("#ai-provider", panel).value = provider;
  fillProvider(provider);
}
// Models that can't chat with tools (embeddings, speech, image/video generation…) are left out.
const NOT_CHAT = /embed|tts|audio|speech|transcri|whisper|dall-e|imagen|veo|-image|image-|moderation|realtime|aqa|search|robotics|computer-use|lyria|babbage|davinci/i;
const CUSTOM = "__custom__";
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function setModelOptions(provider, ids, current) {
  const p = PROVIDERS[provider];
  const chat = [...new Set(ids)].filter(id => !NOT_CHAT.test(id));
  // Suggested models first (in their order), then the rest newest-looking first.
  const preferred = (p.models || []).filter(m => !ids.length || chat.includes(m));
  const rest = chat.filter(m => !preferred.includes(m)).sort((a, b) => natural.compare(b, a));
  const sel = $("#ai-model-select", panel);
  const opt = m => `<option value="${esc(m)}">${esc(m)}</option>`;
  const all = [...preferred, ...rest];
  const known = !current || all.includes(current);
  sel.innerHTML =
    (preferred.length && rest.length ? `<optgroup label="แนะนำ">${preferred.map(opt).join("")}</optgroup><optgroup label="ทั้งหมด">${rest.map(opt).join("")}</optgroup>` : all.map(opt).join("")) +
    (!known ? `<optgroup label="ที่ตั้งไว้">${opt(current)}</optgroup>` : "") +
    `<option value="${CUSTOM}">✎ พิมพ์ชื่อโมเดลเอง…</option>`;
  sel.value = current || all[0] || CUSTOM;
  syncCustom();
  return chat.length;
}
function syncCustom() {
  const custom = $("#ai-model-select", panel).value === CUSTOM;
  $("#ai-model-row", panel).hidden = !custom;
  if (!custom) $("#ai-model", panel).value = $("#ai-model-select", panel).value;
}
$("#ai-model-select", panel).addEventListener("change", () => {
  syncCustom();
  if ($("#ai-model-select", panel).value === CUSTOM) { $("#ai-model", panel).value = ""; $("#ai-model", panel).focus(); }
});

function fillProvider(provider) {
  const p = PROVIDERS[provider], per = store.get("p." + provider, {});
  $("#ai-base-row", panel).hidden = provider !== "custom";
  $("#ai-base", panel).value = per.base || p.base;
  $("#ai-key", panel).value = per.key || "";
  $("#ai-key", panel).placeholder = p.keyOptional ? "ไม่บังคับ" : "วาง API key ที่นี่";
  const link = $("#ai-keylink", panel); link.hidden = !p.keyUrl; if (p.keyUrl) link.href = p.keyUrl;
  $("#ai-status", panel).textContent = "";
  const current = per.model || p.model;
  setModelOptions(provider, store.get("models." + provider, p.models || []), current);
  $("#ai-model", panel).value = current;
  if (per.key || p.keyOptional) loadModels(true);
}
function readSettings() {
  const provider = $("#ai-provider", panel).value;
  const sel = $("#ai-model-select", panel).value;
  return { provider, per: { base: provider === "custom" ? $("#ai-base", panel).value.trim() : "",
    key: $("#ai-key", panel).value.trim(), model: (sel === CUSTOM ? $("#ai-model", panel).value : sel).trim() } };
}

let loadSeq = 0;
async function loadModels(quiet = false) {
  const { provider, per } = readSettings(), p = PROVIDERS[provider];
  if (!per.key && !p.keyOptional) { if (!quiet) $("#ai-status", panel).textContent = "ใส่ API key ก่อน แล้วรายชื่อโมเดลจะโหลดเอง"; return; }
  const st = $("#ai-status", panel), seq = ++loadSeq;
  st.textContent = "กำลังโหลดรายชื่อโมเดล…";
  try {
    const ids = await listModels({ kind: p.kind, provider, base: (per.base || p.base).replace(/\/+$/, ""), key: per.key });
    if (seq !== loadSeq || $("#ai-provider", panel).value !== provider) return;
    store.set("models." + provider, ids);
    // Keep what the user is doing: a typed custom name stays typed, a picked model stays picked.
    const wasCustom = $("#ai-model-select", panel).value === CUSTOM, typed = $("#ai-model", panel).value;
    const n = setModelOptions(provider, ids, wasCustom ? null : per.model);
    if (wasCustom) { $("#ai-model-select", panel).value = CUSTOM; syncCustom(); $("#ai-model", panel).value = typed; }
    st.textContent = `โหลดแล้ว ${n} โมเดล (ซ่อนโมเดลที่ไม่ใช่แชท) · ต้องรองรับ tool calling และควรดูรูปได้`;
  } catch (e) { if (seq === loadSeq) st.textContent = "โหลดรายชื่อไม่สำเร็จ: " + e.message; }
}
$("#ai-provider", panel).addEventListener("change", e => fillProvider(e.target.value));
$("#ai-load", panel).addEventListener("click", () => loadModels());
$("#ai-key", panel).addEventListener("change", () => loadModels(true));
$("#ai-base", panel).addEventListener("change", () => loadModels(true));
$("#ai-save", panel).addEventListener("click", () => {
  const { provider, per } = readSettings();
  store.set("provider", provider); store.set("p." + provider, per);
  $("#ai-settings", panel).hidden = true;
  if (conv.provider && conv.provider !== provider) resetChat();
  log.innerHTML = ""; renderEmpty(); input.focus();
});
$("#ai-forget", panel).addEventListener("click", () => {
  const { provider } = readSettings(); const per = store.get("p." + provider, {}); delete per.key;
  store.set("p." + provider, per); $("#ai-key", panel).value = ""; $("#ai-status", panel).textContent = "ลบ key แล้ว";
});

function resetChat() { abort?.abort(); conv = { messages: [] }; log.innerHTML = ""; renderEmpty(); }

panel.addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); const chip = e.target.closest(".chip:not([data-act])");
  if (chip) { input.value = chip.textContent; send(); return; }
  if (!b) return;
  if (b.dataset.act === "close") toggle(false);
  if (b.dataset.act === "clear") resetChat();
  if (b.dataset.act === "settings") { const s = $("#ai-settings", panel); if (s.hidden) openSettings(); else s.hidden = true; }
});
input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$("#ai-form", panel).addEventListener("submit", e => { e.preventDefault(); busy ? abort?.abort() : send(); });

function setBusy(b) {
  busy = b; sendBtn.textContent = b ? "■" : "➤"; sendBtn.title = b ? "หยุด" : "ส่ง (Enter)";
  panel.classList.toggle("busy", b);
}

const MAX_STEPS = 40;
async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  const cfg = config();
  if (!cfg.key && !cfg.keyOptional) { openSettings(); return; }
  if (!cfg.model) { openSettings(); $("#ai-status", panel).textContent = "ยังไม่ได้เลือกโมเดล"; return; }
  $(".empty", log)?.remove();
  if (conv.provider && (conv.provider !== cfg.provider || conv.model !== cfg.model)) { conv = { messages: [] }; ui.note("เปลี่ยนโมเดล เริ่มบทสนทนาใหม่"); }
  conv.provider = cfg.provider; conv.model = cfg.model;
  input.value = ""; ui.user(text);
  const where = HUB.current ? `[ผู้ใช้กำลังดู ${CAPS[HUB.current].name}] ` : "[ผู้ใช้อยู่หน้าหลักของฮับ] ";
  pushUser(cfg, conv, where + text);
  setBusy(true); abort = new AbortController();
  const before = conv.messages.length - 1;
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const turn = await modelTurn(cfg, conv, systemPrompt(), TOOLS, abort.signal);
      if (turn.text) ui.bot(turn.text);
      if (turn.stop === "refusal") { ui.note("โมเดลปฏิเสธคำขอนี้" + (turn.details?.explanation ? `: ${turn.details.explanation}` : ""), "warn"); break; }
      if (!turn.calls.length) {
        if (turn.stop === "max_tokens" || turn.stop === "length") ui.note("คำตอบยาวเกินกำหนดจึงถูกตัด", "warn");
        break;
      }
      const results = [];
      for (const c of turn.calls) {
        if (abort.signal.aborted) { results.push({ id: c.id, text: "cancelled by user", error: true }); continue; }
        const row = ui.tool(c.name, c.input);
        try {
          if (c.input?.__bad_json !== undefined) throw new Error("tool arguments were not valid JSON");
          const r = await runTool(c.name, c.input, ui);
          row.done(r.text); results.push({ id: c.id, ...r });
        } catch (e) {
          const msg = e?.message || String(e);
          row.done(msg, true); results.push({ id: c.id, text: msg, error: true });
        }
      }
      pushResults(cfg, conv, results);
      if (abort.signal.aborted) { ui.note("หยุดแล้ว"); break; }
      if (step === MAX_STEPS - 1) ui.note(`ครบ ${MAX_STEPS} ขั้นแล้ว พิมพ์ “ทำต่อ” ถ้าต้องการให้ทำต่อ`, "warn");
    }
  } catch (e) {
    if (e.name === "AbortError") ui.note("หยุดแล้ว");
    else {
      ui.note("เกิดข้อผิดพลาด: " + (e.message || e), "warn");
      // Drop this exchange so the history stays well-formed (no tool call left without its result).
      conv.messages.length = before;
      ui.note("ล้างคำขอนี้ออกจากบทสนทนาแล้ว ลองส่งใหม่ได้");
    }
  } finally { setBusy(false); abort = null; input.focus(); }
}

// ---------------------------------------------------------------- hub wiring
const btn = el(`<button id="ai-btn" class="icon-btn" title="ผู้ช่วย AI (Alt+A)">🤖 <span class="label">AI</span></button>`);
$("#bar .right").prepend(btn);
btn.addEventListener("click", () => toggle());
addEventListener("keydown", e => { if (e.altKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); toggle(); } });
HUB.onChange(updateTarget);
