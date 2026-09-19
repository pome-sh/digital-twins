// SPDX-License-Identifier: Apache-2.0
//
// Records `assets/readme/dashboard.gif`, the README's hero: the live dashboard
// while an agent's calls land on a GitHub twin, ending on a write that did not.
//
//   npm run build && npm run record:readme-gif
//
// WHY A SCRIPT AND NOT A SCREEN RECORDING. The dashboard changes, and a hero
// that shows last month's page is a small lie on the first screen. Re-running
// this produces the same film against whatever the dashboard is today.
//
// WHAT IS REAL. The twin, the dashboard, and every request: they are MCP
// `tools/call`s over streamable HTTP with the twin's own bearer — the wire an
// agent speaks, so each row is exactly the row an agent's call would produce.
// The 404 is the twin's, for an issue that does not exist. The caller is this
// script rather than a model, because a model would not make the same calls
// twice and the film has to be reproducible.
//
// DEPENDENCIES. None added. The CLI is the one this repo builds; the browser is
// a local Chrome driven over the DevTools protocol with Node's built-in
// WebSocket; frames are assembled by ffmpeg. `CHROME_PATH` overrides discovery.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "cli/dist/src/cli/main.js");
const OUT = resolve(ROOT, process.argv[2] ?? "assets/readme/dashboard.gif");
const WIDTH = 1280;
const HEIGHT = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A failed await anywhere below ends the run with its reason on one line, the
// way `fail()` does, rather than as a stack trace.
process.on("uncaughtException", (error) => fail(error.message));
process.on("unhandledRejection", (error) => fail(error instanceof Error ? error.message : String(error)));

// ── The film ────────────────────────────────────────────────────────────────
// The same three steps the README's tape section narrates: list the issues,
// open #2, comment on #17 — which does not exist.
const REPO = { owner: "acme", repo: "api" };
//
// Every reply is checked. This file overwrites the README's hero, so a twin
// that regressed must stop the recording, not publish a film whose story is no
// longer true: the first two calls have to succeed and the last has to be
// refused, exactly as the page is about to say.
async function choreography(call) {
  await sleep(2200); // the empty state: "Nothing recorded yet", and how to connect
  expectOk(await call("list_issues", REPO), "list_issues");
  await sleep(2200); // a read, which the page lets recede
  expectOk(
    await call("create_issue", {
      ...REPO,
      title: "Login page returns 500 after the deploy",
      body: "Started after the 14:02 deploy. Reproduces on every login attempt.",
    }),
    "create_issue",
  );
  await sleep(2600); // the world ticks: issues 1 → 2
  expectRefused(
    await call("add_issue_comment", { ...REPO, issue_number: 17, body: "Looking into it now." }),
    "add_issue_comment on #17, which does not exist",
  );
  await sleep(5000); // hold on the write that did not land
}

function expectOk(reply, what) {
  if (reply.error || reply.result?.isError) {
    fail(`${what} failed, so the film would not show what the README says: ${JSON.stringify(reply.error ?? reply.result).slice(0, 240)}`);
  }
}

function expectRefused(reply, what) {
  if (reply.error || !reply.result?.isError) {
    fail(`${what} was expected to be refused by the twin and was not, so the film's last beat would be false.`);
  }
}

// ── Preconditions ───────────────────────────────────────────────────────────
for (const [path, fix] of [
  [CLI, "npm run build"],
  [join(ROOT, "cli/assets/dashboard/index.html"), "npm run build (the dashboard is built into cli/assets)"],
]) {
  if (!existsSync(path)) fail(`${path} is missing. Run: ${fix}`);
}
if (spawnSync("ffmpeg", ["-version"]).status !== 0) fail("ffmpeg is not on PATH.");
const chrome = findChrome();

const work = mkdtempSync(join(tmpdir(), "pome-readme-gif-"));
const children = [];
process.on("exit", () => {
  // SIGKILL, not SIGTERM: Chrome flushes its profile into `work` on a graceful
  // exit, and removing the directory underneath that write fails ENOTEMPTY.
  for (const child of children) child.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ── 1 · A real twin, with its dashboard ─────────────────────────────────────
const twin = spawn(process.execPath, [CLI, "twin", "start", "github"], {
  cwd: work,
  env: { ...process.env, POME_TELEMETRY: "0", NO_COLOR: "1" },
});
children.push(twin);
const banner = await readUntil(twin, (text) => /^Dashboard: (\S+)/m.test(text), 60_000, "the twin's banner");
const token = /POME_AUTH_TOKEN=(\S+)/.exec(banner)?.[1] ?? fail("no POME_AUTH_TOKEN in the banner");
const mcpUrl = /POME_GITHUB_MCP_URL=(\S+)/.exec(banner)?.[1] ?? fail("no POME_GITHUB_MCP_URL in the banner");
const dashboardUrl = /^Dashboard: (\S+)/m.exec(banner)[1];

// ── 2 · A browser on the dashboard ──────────────────────────────────────────
const browser = spawn(chrome, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--window-size=${WIDTH},${HEIGHT}`,
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${join(work, "chrome")}`,
  "about:blank",
]);
children.push(browser);
const devtools = await readUntil(browser, (text) => /DevTools listening on (ws:\S+)/.test(text), 30_000, "Chrome", "stderr");
const cdp = await connect(/DevTools listening on (ws:\S+)/.exec(devtools)[1]);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const page = (method, params) => cdp.send(method, params, sessionId);
await page("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
await page("Page.enable");
await page("Page.navigate", { url: dashboardUrl });
await sleep(1500); // first paint, and the first poll

// ── 3 · Film while the calls land ───────────────────────────────────────────
// Screencast pushes a frame only when the page repaints, stamped with the
// time it painted, so the GIF keeps real timing without a capture loop.
//
// The handler does nothing but keep the frame. Decoding and writing a PNG here
// blocks the event loop at up to 60 fps while the page animates, and a blocked
// loop fires the choreography's timers late: the first cut of this film ran
// 24 s instead of 12 because its sleeps stretched. Frames stay in memory as
// base64 until filming stops, and `everyNthFrame: 4` keeps roughly 15 fps —
// the GIF is 12.
const frames = [];
cdp.on("Page.screencastFrame", (params, from) => {
  if (from !== sessionId) return;
  frames.push({ data: params.data, t: params.metadata.timestamp });
  cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
});
await page("Page.startScreencast", { format: "png", maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 4 });

const mcp = await mcpClient(mcpUrl, token);
await choreography(mcp.call);
const stoppedAt = Date.now() / 1000;
await page("Page.stopScreencast");
// The API said the right things; the page has to have shown them too.
const shown = await page("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
if (!/1 write did not land/.test(shown.result.value)) {
  fail("the dashboard never showed the refused write, so the film's last frame would not say what the README claims.");
}
if (frames.length < 10) fail(`only ${frames.length} frame(s) captured — the page did not repaint as calls landed`);
frames.forEach((frame, i) => {
  frame.file = join(work, `f${String(i).padStart(5, "0")}.png`);
  writeFileSync(frame.file, Buffer.from(frame.data, "base64"));
});

// ── 4 · Assemble, keeping each frame on screen until the next one painted ──
// The last frame holds until the moment filming stopped, so a page that goes
// still during the final hold is still on screen for all of it.
const concat = frames
  .map((frame, i) => {
    const next = frames[i + 1]?.t ?? stoppedAt;
    return `file '${frame.file}'\nduration ${Math.max(next - frame.t, 0.02).toFixed(4)}`;
  })
  .concat(`file '${frames.at(-1).file}'`)
  .join("\n");
writeFileSync(join(work, "concat.txt"), concat);
const ffmpeg = spawnSync(
  "ffmpeg",
  [
    "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", join(work, "concat.txt"),
    "-vf",
    // A palette fitted to the page and only the changed rectangle re-encoded:
    // the page is flat colour, so a 12-second film stays a few hundred KB.
    "fps=12,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    OUT,
  ],
  { stdio: "inherit" },
);
if (ffmpeg.status !== 0) fail("ffmpeg failed to assemble the GIF");

console.log(`${OUT.replace(`${ROOT}/`, "")} — ${frames.length} frames, ${Math.round(statSync(OUT).size / 1024)} KB`);
cdp.close();
process.exit(0);

// ── Helpers ─────────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`record-readme-gif: ${message}`);
  process.exit(1);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map(
      (name) => spawnSync("which", [name], { encoding: "utf8" }).stdout.trim(),
    ),
  ];
  return candidates.find((path) => path && existsSync(path)) ?? fail("no Chrome found. Set CHROME_PATH.");
}

function readUntil(child, done, timeoutMs, what, stream = "stdout") {
  return new Promise((resolvePromise, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}:\n${text}`)), timeoutMs);
    child[stream].on("data", (chunk) => {
      text += chunk;
      if (done(text)) {
        clearTimeout(timer);
        resolvePromise(text);
      }
    });
    child.on("exit", (code) => reject(new Error(`${what} exited (${code}) before it was ready:\n${text}`)));
  });
}

/**
 * A DevTools-protocol connection over Node's built-in WebSocket.
 *
 * Every request is bounded, and a socket that closes or errors fails every
 * request still waiting on it: a browser that dies mid-film has to end the run
 * with an error, not leave it waiting on replies that will never come.
 */
function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let id = 0;
  let dead = null;
  const failPending = (error) => {
    dead ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.addEventListener("close", () => failPending(new Error("Chrome closed the DevTools connection")));
  socket.addEventListener("error", () => failPending(new Error("the DevTools connection failed")));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return; // a reply to nothing this client sent: ignore it, do not throw
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(`${message.error.message}`)) : waiter.resolve(message.result);
    } else {
      // Only a listener this script registered can run. Anything else Chrome
      // sends is ignored, never dispatched by the name it arrived with.
      const listener = listeners.get(message.method);
      if (typeof listener === "function") listener(message.params, message.sessionId);
    }
  });
  return new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener("error", () => rejectSocket(new Error(`could not open DevTools at ${url}`)), { once: true });
    socket.addEventListener("open", () =>
      resolveSocket({
        send: (method, params = {}, sessionId) =>
          new Promise((settle, reject) => {
            if (dead) return reject(dead);
            const requestId = ++id;
            const timer = setTimeout(() => {
              pending.delete(requestId);
              reject(new Error(`DevTools did not answer ${method} within 15 s`));
            }, 15_000);
            pending.set(requestId, {
              resolve: (value) => (clearTimeout(timer), settle(value)),
              reject: (error) => (clearTimeout(timer), reject(error)),
            });
            socket.send(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }));
          }),
        on: (method, listener) => listeners.set(method, listener),
        close: () => socket.close(),
      }),
    );
  });
}

/** MCP over streamable HTTP: the handshake, then `tools/call`. */
async function mcpClient(url, bearer) {
  let session;
  let id = 0;
  async function rpc(method, params, notification = false) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) fail(`the twin answered ${method} with HTTP ${response.status}`);
    session = response.headers.get("mcp-session-id") ?? session;
    const body = await response.text();
    if (notification) return null;
    // Either a JSON body or an SSE stream whose last `data:` line is the reply.
    return JSON.parse(body.startsWith("{") ? body : body.split("\n").filter((line) => line.startsWith("data:")).at(-1).slice(5));
  }
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "record-readme-gif", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  return { call: (name, args) => rpc("tools/call", { name, arguments: args }) };
}
