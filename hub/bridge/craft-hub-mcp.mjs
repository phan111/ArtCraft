#!/usr/bin/env node
// Craft Hub MCP bridge — lets Claude Desktop / Claude Code / Google Antigravity (or any MCP client) drive the apps
// open in Craft Hub in your browser.
//
//   MCP client ⇄ (stdio) ⇄ this script ⇄ (HTTP on 127.0.0.1) ⇄ Craft Hub page in the browser
//
// The page polls http://127.0.0.1:<port>/poll for tool calls, runs them against the app in the
// hub (the same tools as the hub's own AI panel) and posts the result to /result.
// No dependencies: Node.js 18+.
//
// Usage (Claude Desktop config / Claude Code):
//   node craft-hub-mcp.mjs --origin https://your-hub.netlify.app [--port 47821]
//
// Only pages from --origin (and http://localhost / 127.0.0.1) may connect. Nothing on your
// computer is run or read by this bridge: it only relays app commands to the hub page.

import http from "node:http";
import { randomUUID } from "node:crypto";

const VERSION = "1.0.0";
const args = process.argv.slice(2);
const arg = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(arg("port", process.env.CRAFT_HUB_PORT || 47821));
const ORIGINS = arg("origin", process.env.CRAFT_HUB_ORIGIN || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
const log = (...a) => process.stderr.write(`[craft-hub-mcp] ${a.join(" ")}\n`);

const originOk = o => !o ? false : ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

// ------------------------------------------------------------------ tools (mirrors hub/ai.js)
const APPS = ["photocraft", "filmcraft", "lightcraft", "effectcraft"];
const TOOLS = [
  { name: "hub_status", description: "Which Craft Hub app is open and shown now, and which apps are loaded. Call this first.",
    inputSchema: { type: "object", properties: {} } },
  { name: "open_app", description: "Open (or switch to) one of the hub's apps in the browser and make it the target of the other tools. Waits until the app's automation API is ready. photocraft has no automation API in its web version.",
    inputSchema: { type: "object", properties: { app: { type: "string", enum: APPS } }, required: ["app"] } },
  { name: "find_commands", description: "Search the current app's command registry (every menu item, button and action is a command). Returns id | label | menu | parameter documentation | DISABLED if not available now. All words in `query` must match id, label or menu (case-insensitive, English). Empty query lists the command groups.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 80 } }, required: ["query"] } },
  { name: "run_command", description: "Run one command in the current app by id with JSON params, exactly as documented by find_commands. Returns the command's JSON result or its error.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, params: { type: "object" } }, required: ["command"] } },
  { name: "ui_request", description: "FilmCraft/EffectCraft only: a UI control method, e.g. ui.elements {prefix} (widgets with automation ids and rects), ui.click {id}, ui.key {key}, ui.playback, render.frame. Use when no engine command does the job.",
    inputSchema: { type: "object", properties: { method: { type: "string" }, params: { type: "object" } }, required: ["method"] } },
  { name: "screenshot", description: "FilmCraft/EffectCraft only: a screenshot of the current app, to check the result of your actions. Optional `panel` to capture one panel.",
    inputSchema: { type: "object", properties: { panel: { type: "string" } } } },
  { name: "wait", description: "Wait for background work in the app (loading, rendering) for up to 15 seconds.",
    inputSchema: { type: "object", properties: { seconds: { type: "number", minimum: 0.5, maximum: 15 } }, required: ["seconds"] } },
];
const INSTRUCTIONS = [
  "These tools drive Craft Hub, a web hub in the user's browser that runs four open-source creative apps:",
  "FilmCraft (video editor), EffectCraft (motion graphics / VFX), LightCraft (photo library and raw developer) and PhotoCraft (image editor; no automation in its web version).",
  "Start with hub_status. Every action in an app is a command with an id: look it up with find_commands before running it, and follow its parameter documentation exactly.",
  "Verify your work: take a screenshot (FilmCraft/EffectCraft) or run a query command before saying it's done. If a command fails, read the error and try another way.",
  "You can't read the user's disk from here: ask them to drag media into the app first. Exports arrive as browser downloads.",
  "Ask before deleting or overwriting work. Reply in the user's language.",
].join("\n");

// ------------------------------------------------------------------ the page side (HTTP)
const queue = [];            // jobs not yet handed to the page
const pending = new Map();   // id -> {resolve, timer}
let waiter = null;           // the page's held /poll response
let lastSeen = 0, pageInfo = null;

function deliver() {
  if (!waiter || !queue.length) return;
  const { res, timer } = waiter; waiter = null; clearTimeout(timer);
  send(res, 200, { job: queue.shift() });
}
function send(res, code, body) {
  if (!res.headersSent) res.writeHead(code, { "content-type": "application/json", ...res._cors });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((ok, bad) => {
    let s = ""; req.setEncoding("utf8");
    req.on("data", c => { s += c; if (s.length > 64e6) { bad(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  res._cors = originOk(origin) ? {
    "access-control-allow-origin": origin, "vary": "origin",
    "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true", "access-control-max-age": "600",
  } : {};
  if (req.method === "OPTIONS") { res.writeHead(originOk(origin) ? 204 : 403, res._cors); return res.end(); }
  if (req.url === "/status" && req.method === "GET") {
    return send(res, 200, { ok: true, version: VERSION, connected: Date.now() - lastSeen < 40000, origins: ORIGINS });
  }
  if (!originOk(origin)) {
    log(`refused a page from ${origin || "(no origin)"}; allowed: ${ORIGINS.join(", ") || "(none, pass --origin)"}`);
    return send(res, 403, { error: `origin not allowed: start the bridge with --origin ${origin || "<hub url>"}` });
  }
  try {
    if (req.url === "/poll" && req.method === "POST") {
      const info = await readJson(req);
      if (!lastSeen || Date.now() - lastSeen > 40000) log(`hub connected: ${info.page || origin}`);
      lastSeen = Date.now(); pageInfo = info;
      if (waiter) { clearTimeout(waiter.timer); send(waiter.res, 200, { job: null }); }
      const timer = setTimeout(() => { if (waiter?.res === res) { waiter = null; lastSeen = Date.now(); send(res, 200, { job: null }); } }, 25000);
      waiter = { res, timer };
      // Send the headers now: the page learns it is connected without waiting for a job.
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...res._cors });
      res.flushHeaders();
      res.on("close", () => { if (waiter?.res === res) { clearTimeout(timer); waiter = null; } });
      return deliver();
    }
    if (req.url === "/result" && req.method === "POST") {
      const r = await readJson(req);
      lastSeen = Date.now();
      const p = pending.get(r.id);
      if (p) { pending.delete(r.id); clearTimeout(p.timer); p.resolve(r); }
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 400, { error: String(e.message || e) }); }
});
server.on("error", e => {
  log(e.code === "EADDRINUSE" ? `port ${PORT} is in use (another bridge running?). Use --port.` : String(e));
});
server.listen(PORT, "127.0.0.1", () => log(`listening on http://127.0.0.1:${PORT} for ${ORIGINS.join(", ") || "localhost pages only"}`));

const connected = () => Date.now() - lastSeen < 40000;
async function waitForPage(ms) {
  const t0 = Date.now();
  while (!connected() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 250));
  return connected();
}

async function callPage(name, input) {
  if (!(await waitForPage(15000))) {
    return { isError: true, content: [{ type: "text", text:
      `Craft Hub isn't connected. Ask the user to open the hub (${ORIGINS[0] || "their Craft Hub site"}) in the browser on this computer, ` +
      `open the 🤖 AI panel, choose “AI บนคอม (MCP)”, and allow access to local devices if the browser asks.` }] };
  }
  const id = randomUUID();
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, text: "The hub didn't answer within 3 minutes (is the tab still open?)." }); }, 180000);
    pending.set(id, { resolve, timer });
    queue.push({ id, name, input });
    deliver();
  });
  const content = [];
  if (result.image) content.push({ type: "image", data: result.image, mimeType: result.mime || "image/jpeg" });
  content.push({ type: "text", text: String(result.text ?? (result.ok ? "OK" : "error")) });
  return { content, isError: !result.ok };
}

// ------------------------------------------------------------------ MCP over stdio
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled…)
  switch (method) {
    case "initialize":
      return reply(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "craft-hub", version: VERSION }, instructions: INSTRUCTIONS });
    case "ping": return reply(id, {});
    case "tools/list": return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name, input = params?.arguments || {};
      if (!TOOLS.some(t => t.name === name)) return reply(id, { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
      try { return reply(id, await callPage(name, input)); }
      catch (e) { return reply(id, { isError: true, content: [{ type: "text", text: String(e.message || e) }] }); }
    }
    case "resources/list": return reply(id, { resources: [] });
    case "prompts/list": return reply(id, { prompts: [] });
    default: return fail(id, -32601, `method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { log("bad JSON from client"); continue; }
    handle(msg).catch(e => log(String(e)));
  }
});
process.stdin.on("end", () => process.exit(0));
