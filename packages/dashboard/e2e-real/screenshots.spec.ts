import path from "node:path";
import type { Page } from "@playwright/test";
import { api, DOCKER, expect, liveConnected, login, test } from "./fixtures";

/**
 * Captures the main screens with real data into ./screenshots/real (compare with docs/prototypes).
 *   SCREENSHOTS=1 … pnpm e2e:docker screenshots
 */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture screenshots");

const out = (project: string, name: string) => path.join(import.meta.dirname, "..", "screenshots", "real", `${project}-${name}.png`);

async function snap(page: Page, project: string, name: string) {
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), undefined, { timeout: 15_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: out(project, name) });
}

const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Supplier portal · sign up</title><style>
body{font-family:sans-serif;background:#eef1f4;margin:0}header{background:#1f5f4a;color:#fff;padding:14px 28px;font-size:20px}
main{max-width:520px;margin:40px auto;background:#fff;padding:28px;border-radius:8px;box-shadow:0 2px 8px #0002}
label{display:block;margin:14px 0 4px;color:#333}input{width:100%;padding:8px;font-size:15px;box-sizing:border-box}
button{margin-top:20px;background:#1f5f4a;color:#fff;border:0;padding:10px 18px;font-size:15px;border-radius:4px}
.captcha{margin-top:18px;display:grid;grid-template-columns:repeat(3,80px);gap:4px}.captcha div{height:60px;background:#9aa7b4}
</style></head><body><header>Supplier portal</header><main><h2>Create your account</h2>
<label>Company</label><input value="Acme Pty Ltd"><label>Email</label><input value="bot@acme.example">
<p>Select all squares with traffic lights</p><div class="captcha"><div></div><div></div><div></div><div></div><div></div><div></div></div>
<button>Sign up</button></main></body></html>`;

test("real screens", async ({ page, agent }, info) => {
  test.setTimeout(DOCKER ? 420_000 : 90_000);
  const p = info.project.name;
  const mobile = p === "mobile";

  // Three agents on two hosts (named API tokens), three desktops doing different things.
  const tokens: string[] = [];
  const token = async (name: string) => {
    const r = await api<{ token: { id: string }; secret: string }>("POST", "/api/tokens", { name }); // revoked again at the end, so each project can reuse the name
    tokens.push(r.data.token.id);
    return r.data.secret;
  };
  const laptop = await token("claude-laptop");
  const ci = await token("codex-ci");
  const a = await agent("claude-code", laptop);
  const portal = await a.start("supplier-portal-sign-up");
  const b = await agent("codex", ci);
  const triage = await b.start("linear-triage");
  const c = await agent("claude-code", laptop);
  const drag = await c.start("drag-test-suite");
  if (DOCKER) {
    await a.exec(`cat > /tmp/portal.html <<'EOF'\n${FORM}\nEOF\nsetsid deskhand-chromium --new-window file:///tmp/portal.html >/dev/null 2>&1 &`, portal);
    await b.exec("setsid mousepad /etc/os-release >/dev/null 2>&1 &", triage);
    await c.exec("setsid xterm -geometry 90x24+120+90 -e top >/dev/null 2>&1 &", drag);
    await page.waitForTimeout(6000);
  }
  await b.call("left_click", { coordinate: [640, 300], desktop: triage });
  await b.call("left_click_drag", { start_coordinate: [212, 380], coordinate: [904, 410], desktop: triage });
  await b.call("zoom", { region: [0, 0, 640, 400], desktop: triage });
  await b.call("key", { text: "ctrl+End", desktop: triage });
  await c.call("left_click", { coordinate: [812, 344], desktop: drag });
  await a.call("left_click", { coordinate: [640, 470], desktop: portal });
  await a.call("zoom", { region: [480, 380, 800, 560], desktop: portal });
  const pending = a.call("request_human", { reason: "CAPTCHA on the sign-in page — please solve it, then hand back.", desktop: portal }, 15 * 60_000);
  // You hold one desktop.
  expect((await api("POST", `/api/desktops/${drag}/lock`, {})).status).toBe(200);

  await login(page);
  await expect(page.getByTestId(mobile ? "desktop-row" : "desktop-tile")).toHaveCount(3);
  await snap(page, p, "grid");

  await page.goto(`desktops/${portal}`);
  await expect(page.getByTestId("needs-you")).toBeVisible();
  await liveConnected(page, "view");
  await snap(page, p, "desktop-attention");

  await page.goto(`desktops/${drag}`);
  await liveConnected(page, "control");
  await page.getByTestId("handback-note").fill("tests pass locally, carry on");
  await snap(page, p, "desktop-control");

  await page.goto(`desktops/${triage}/log`);
  await expect(page.getByTestId("log-entry").first()).toBeVisible();
  await snap(page, p, "log");
  await page.locator('[data-testid="log-entry"][data-tool="left_click_drag"]').getByTestId("log-shot").click();
  await expect(page.getByRole("dialog").locator('[data-overlay="path"]')).toBeAttached();
  await snap(page, p, "log-enlarged");
  await page.keyboard.press("Escape");

  // A template an agent just changed, rolled back once.
  const name = `research-${p}`;
  const desc = { summary: "Chromium with the research bookmarks", use_when: "Reading papers and taking notes" };
  await b.call("template_save", { name, description: desc, desktop: triage }, 240_000);
  await b.call("template_save", { name, description: { ...desc, tags: ["research", "web"] }, desktop: triage }, 240_000);
  await page.goto("templates");
  await expect(page.getByTestId("template-row").filter({ hasText: name })).toContainText("changed by agent");
  await snap(page, p, "templates");
  await page.goto(`templates/${name}`);
  await page.getByTestId("rollback-v1").click();
  await expect(page.getByTestId("current-version")).toHaveText("v1");
  await snap(page, p, "template-detail");

  await api("DELETE", `/api/desktops/${drag}/lock`, { note: null });
  await api("DELETE", `/api/desktops/${portal}/attention`, { note: null });
  await pending;
  await api("DELETE", `/api/templates/${name}`);
  for (const id of tokens) await api("DELETE", `/api/tokens/${id}`);

  await page.context().clearCookies();
  await page.goto("auth/login?code=expired-example");
  await expect(page.getByTestId("login-reason")).toBeVisible();
  await snap(page, p, "login");
});
