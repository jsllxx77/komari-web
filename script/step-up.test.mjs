// Behavioural test for src/lib/stepUp.ts against a fake window/fetch.
// Run with: npm run test:step-up
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { build } = createRequire(import.meta.url)("esbuild");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 打包到内存再以 data: URL 导入，不依赖临时目录。
const bundled = await build({
  entryPoints: [path.join(root, "src/lib/stepUp.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  logLevel: "error",
});
const moduleURL =
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64");

// ---- fake server ----
let windowValid = false;
const calls = [];
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url, "http://panel.test");
  const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  calls.push(`${method} ${url.pathname}`);
  if (url.pathname === "/api/admin/2fa/status") {
    return json(200, { status: "success", data: { enabled: true, step_up_valid_until: windowValid ? Date.now() / 1000 + 600 : 0, window_seconds: 600 } });
  }
  if (url.pathname === "/api/admin/2fa/verify") {
    const code = init.headers?.["X-2FA-Code"];
    if (code === "123456") {
      windowValid = true;
      return json(200, { status: "success", data: "2FA verified" });
    }
    return json(401, { status: "error", message: "Invalid 2FA code" });
  }
  if (url.pathname === "/api/admin/download/backup" || url.pathname === "/api/admin/session/remove") {
    if (!windowValid) return json(401, { status: "error", message: "2FA code is required" });
    return json(200, { status: "success", data: { echoed: body ?? null } });
  }
  if (url.pathname === "/api/admin/other") return json(401, { status: "error", message: "Unauthorized." });
  return json(404, { status: "error", message: "not found" });
}

globalThis.window = { fetch: fakeFetch, location: { href: "http://panel.test/admin", origin: "http://panel.test" } };

const m = await import(moduleURL);
m.installStepUpFetch();

// Dialog stand-in: first a wrong code, then the right one.
let prompts = 0;
let mode = "submit";
const typed = [];
m.subscribeStepUp(async (prompt) => {
  if (!prompt) return;
  prompts++;
  if (mode === "cancel") {
    prompt.cancel();
    return;
  }
  try {
    await prompt.submit("000000");
  } catch (e) {
    typed.push(e.message);
  }
  await prompt.submit("123456");
});

test("step-up dialog flow: intercept, share prompt, retry, cancel", async () => {
  // 1. Intercepted request: 401 -> prompt -> verify -> retry with the same body.
  let r = await window.fetch("/api/admin/session/remove", { method: "POST", body: JSON.stringify({ id: "abc" }) });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).data.echoed, JSON.stringify({ id: "abc" }));
  assert.equal(prompts, 1);
  assert.deepEqual(typed, ["Invalid 2FA code"]);

  // 2. Concurrent 401s share one prompt.
  windowValid = false;
  prompts = 0;
  const [a, b] = await Promise.all([
    window.fetch("/api/admin/download/backup"),
    window.fetch(new Request("http://panel.test/api/admin/session/remove", { method: "POST", body: "x" })),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await b.json()).data.echoed, "x", "Request bodies are cloned before retry");
  assert.equal(prompts, 1, "concurrent failures must share one dialog");

  // 3. Other 401s are passed through untouched; no prompt.
  prompts = 0;
  r = await window.fetch("/api/admin/other");
  assert.equal(r.status, 401);
  assert.equal(prompts, 0);

  // 4. ensureStepUp: no prompt while the window is valid; prompt when it is not.
  await m.ensureStepUp();
  assert.equal(prompts, 0);
  windowValid = false;
  await m.ensureStepUp();
  assert.equal(prompts, 1);

  // 5. withStepUp retries RPC-style errors once.
  windowValid = false;
  prompts = 0;
  let attempts = 0;
  const v = await m.withStepUp(async () => {
    attempts++;
    if (!windowValid) throw new Error("RPC Error -32041: 2FA code is required");
    return "ok";
  });
  assert.equal(v, "ok");
  assert.equal(attempts, 2);
  assert.equal(prompts, 1);

  // 6. Cancelling returns the original 401 to fetch callers and rejects withStepUp.
  windowValid = false;
  mode = "cancel";
  r = await window.fetch("/api/admin/download/backup");
  assert.equal(r.status, 401, "cancel hands the 401 back");
  assert.equal((await r.json()).message, "2FA code is required");
  await assert.rejects(
    m.withStepUp(async () => { throw new Error("RPC Error -32041: 2FA code is required"); }),
    (e) => e instanceof m.StepUpCancelledError,
  );
});
