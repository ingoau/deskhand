// Drives the desktop's own Chromium over CDP (127.0.0.1:9222 inside the desktop) for scripted tests:
// a real browser, a real form POST and a real Set-Cookie, no agent in the loop.
// Runs inside a deskhand desktop as the agent user (Node 24 is in the image; it has fetch + WebSocket):
//   node browser.mjs status <base-url>            prints the #status text of <base>/
//   node browser.mjs login  <base-url> <user> <password>
//   node browser.mjs logout <base-url>
import { spawn } from "node:child_process";

const CDP = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpUp() {
  try {
    return (await fetch(`${CDP}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function ensureChromium() {
  if (await cdpUp()) return;
  spawn("setsid", ["deskhand-chromium", "about:blank"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 100 && !(await cdpUp()); i++) await sleep(200);
  if (!(await cdpUp())) throw new Error("Chromium did not start (no CDP on 127.0.0.1:9222)");
}

async function page() {
  for (let i = 0; i < 50; i++) {
    const list = await (await fetch(`${CDP}/json`)).json();
    const p = list.find((t) => t.type === "page");
    if (p) return p;
    await sleep(200);
  }
  throw new Error("no page target");
}

async function session() {
  const p = await page();
  const ws = new WebSocket(p.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
  const goto = async (url) => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const st = await evaluate("document.readyState + ' ' + location.href");
      if (st && st.startsWith("complete") && st.includes(new URL(url).pathname)) return;
    }
  };
  const waitText = async (sel, want) => {
    let last = "";
    for (let i = 0; i < 100; i++) {
      last = (await evaluate(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||""`)) ?? "";
      if (!want || last.includes(want)) return last;
      await sleep(100);
    }
    return last;
  };
  return { ws, send, evaluate, goto, waitText };
}

const [cmd, base, user, password] = process.argv.slice(2);
await ensureChromium();
const s = await session();
if (cmd === "login") {
  await s.goto(`${base}/login`);
  await s.evaluate(
    // Click the button (the form has a button with id "submit", which shadows form.submit()).
    `document.getElementById('username').value=${JSON.stringify(user)};document.getElementById('password').value=${JSON.stringify(password)};document.getElementById('submit').click();true`,
  );
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const href = await s.evaluate("document.readyState + ' ' + location.pathname");
    if (href && href.startsWith("complete") && !href.endsWith("/login")) break;
  }
  await s.goto(`${base}/`);
  console.log(await s.waitText("#status", "Signed in"));
} else if (cmd === "logout") {
  await s.goto(`${base}/`);
  await s.evaluate("document.getElementById('logout') && document.getElementById('logout').click(); true");
  await sleep(500);
  await s.goto(`${base}/`);
  console.log(await s.waitText("#status", "Not signed in"));
} else {
  await s.goto(`${base}/`);
  console.log(await s.waitText("#status"));
}
s.ws.close();
process.exit(0);
