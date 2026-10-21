import { api, clickScreen, DOCKER, expect, fakeVncInputs, injectRfb, liveConnected, LOCK_WAIT_MS, login, near, pointerAt, test } from "./fixtures";

test.describe("takeover and hand back", () => {
  test("take over blocks the agent's input; hand back with a note delivers it in the next tool result", async ({ page, agent }) => {
    const a = await agent("takeover-agent");
    const id = await a.start("takeover");
    await a.call("mouse_move", { coordinate: [40, 40] });
    await login(page, `desktops/${id}`);
    await liveConnected(page, "view");
    await expect(page.getByTestId("view-mode")).toHaveText("view only");

    await page.getByTestId("take-over").click();
    await expect(page.getByTestId("view-mode")).toHaveText(/you have control · 0:0\d/);
    await expect(page.getByTestId("control-tools")).toContainText("agent input is paused");
    await liveConnected(page, "control");

    // The agent's click waits for the lock, then gives up with locked_by_user; nothing happens on the desktop.
    const t0 = Date.now();
    const blocked = await a.call("left_click", { coordinate: [300, 200] });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("locked_by_user");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 1000);
    // Screenshots still work, and say why.
    const shot = await a.call("screenshot");
    expect(shot.isError).toBe(false);
    expect(shot.images).toBe(1);
    expect(shot.text).toContain("controlling this desktop");

    // The tile on the grid shows the lock (violet) — check through the API the grid polls.
    const locked = (await api("GET", `/api/desktops/${id}`)).data;
    expect(locked.lock).toMatchObject({ holder: "dashboard" });

    await page.getByTestId("handback-note").fill("logged in for you, continue from the inbox");
    await page.getByTestId("hand-back").click();
    await expect(page.getByText("handed back with note")).toBeVisible();
    await expect(page.getByTestId("view-mode")).toHaveText("view only");
    await liveConnected(page, "view");

    const next = await a.call("left_click", { coordinate: [300, 200] });
    expect(next.isError).toBe(false);
    expect(next.text).toContain("The user handed control back: logged in for you, continue from the inbox");
    expect(next.images).toBe(1);
    // Neither the blocked click nor the one that carried the note moved the pointer.
    expect(await pointerAt(a, id)).toEqual([40, 40]);

    // The log records the takeover and the hand-back with its note.
    await page.goto(`desktops/${id}/log`);
    await expect(page.locator('[data-testid="log-entry"][data-tool="handback"]')).toContainText("logged in for you, continue from the inbox");
    await expect(page.locator('[data-testid="log-entry"][data-tool="takeover"]')).toBeVisible();
    await expect(page.locator('[data-testid="log-entry"][data-tool="left_click"]').first()).toBeVisible();
  });

  test("view-only live view cannot click or type; control can; stale control connections are refused", async ({ page, agent }) => {
    const a = await agent("vnc-agent");
    const id = await a.start("vnc-filter");
    await a.call("mouse_move", { coordinate: [50, 50] });
    await login(page, `desktops/${id}`);
    await liveConnected(page, "view");

    // 1. Clicking the view-only live view does nothing (noVNC is view-only) ...
    await clickScreen(page, 600, 300);
    // 2. ... and a client that ignores view-only and speaks raw RFB is filtered by the daemon.
    const raw = await injectRfb(page, id, "mode=view", 700, 350);
    expect(raw.handshake).toBe(true);
    await page.waitForTimeout(500);
    expect(await pointerAt(a, id)).toEqual([50, 50]);
    if (!DOCKER) expect(await fakeVncInputs(id)).toEqual([]);

    // 3. After taking over, clicks in the live view reach the desktop.
    await page.getByTestId("take-over").click();
    await liveConnected(page, "control");
    const gen = (await api("GET", `/api/desktops/${id}`)).data.lock.generation as number;
    await clickScreen(page, 600, 300);
    if (!DOCKER) {
      await expect.poll(async () => (await fakeVncInputs(id)).some((m) => m.type === 5)).toBe(true);
      await expect.poll(async () => near(await pointerAt(a, id), 600, 300)).toBe(true);
    }
    await page.getByTestId("hand-back").click();
    await liveConnected(page, "view");
    const clicked = await pointerAt(a, id);
    expect(near(clicked, 600, 300)).toBe(true);

    // 4. A control connection from the old generation is refused or filtered after hand back.
    const before = DOCKER ? 0 : (await fakeVncInputs(id)).length;
    await injectRfb(page, id, `mode=control&generation=${gen}`, 900, 500);
    await page.waitForTimeout(500);
    expect(await pointerAt(a, id)).toEqual(clicked);
    if (!DOCKER) expect((await fakeVncInputs(id)).length).toBe(before);
  });

  test("clipboard is shared both ways while in control", async ({ page, agent }) => {
    const a = await agent("clip-agent");
    const id = await a.start("clipboard");
    await login(page, `desktops/${id}`);
    await liveConnected(page, "view");
    if (DOCKER) {
      // Desktop → browser: x11vnc announces clipboard changes to connected viewers.
      await a.exec("printf 'from the desktop' | xclip -selection clipboard -i", id);
    }
    await page.getByTestId("take-over").click();
    await liveConnected(page, "control");
    const tools = page.getByTestId("control-tools");
    await tools.getByText("clipboard", { exact: true }).click();
    if (DOCKER) await expect(tools).toContainText("desktop clipboard: from the desktop");
    // Browser → desktop.
    await tools.getByPlaceholder("text to put on the desktop's clipboard").fill("pasted from my laptop");
    await tools.getByRole("button", { name: "send to desktop" }).click();
    await expect(page.getByText("sent to desktop clipboard")).toBeVisible();
    if (!DOCKER) await expect.poll(async () => (await fakeVncInputs(id)).some((m) => m.type === 6)).toBe(true);
    await page.getByTestId("hand-back").click();
    await liveConnected(page, "view");
    if (DOCKER) await expect.poll(() => a.exec("xclip -selection clipboard -o", id)).toContain("pasted from my laptop");
  });

  test("a long-held lock shows a warning on the tile and the desktop page", async ({ page, agent }) => {
    const a = await agent("long-lock-agent");
    const id = await a.start("long-lock");
    await login(page);
    expect((await api("POST", `/api/desktops/${id}/lock`, {})).status).toBe(200);
    const tile = page.getByTestId("desktop-tile").filter({ hasText: "long-lock" });
    await expect(tile).toHaveAttribute("data-state", "control");
    await expect(tile.getByTestId("long-lock")).toHaveCount(0);
    // Jump the page's clock 31 minutes ahead (the lock is never released automatically).
    await page.clock.install();
    await page.clock.setSystemTime(Date.now() + 31 * 60_000);
    await expect(tile.getByTestId("long-lock")).toBeVisible();
    await expect(tile).toContainText(/you have control · 3[01]m/);
    await tile.click();
    await expect(page.getByTestId("long-lock")).toContainText("agent waiting");
    expect((await api("DELETE", `/api/desktops/${id}/lock`, { note: null })).status).toBe(200);
  });
});
