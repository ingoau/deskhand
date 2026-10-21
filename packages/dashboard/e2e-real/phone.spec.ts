import { clickScreen, DOCKER, expect, fakeVncInputs, liveCanvas, liveConnected, login, near, pointerAt, test } from "./fixtures";

/** The whole take over → interact → hand back flow on a ~390×844 touch screen (project "mobile"). */
test("phone: take over from the attention card, tap and type in the live view, hand back with a note", async ({ page, agent }) => {
  const a = await agent("phone-agent");
  const id = await a.start("phone-2fa");
  if (DOCKER) {
    // A terminal that writes what it receives to a file, so typing can be checked inside the desktop.
    await a.exec("rm -f /tmp/typed.txt; setsid xterm -geometry 80x20+300+200 -e 'cat > /tmp/typed.txt' >/dev/null 2>&1 &", id);
    await page.waitForTimeout(1500);
  }
  const pending = a.call("request_human", { reason: "Enter the 2FA code from my phone" }, 15 * 60_000);

  await login(page);
  const card = page.getByTestId("attention-card");
  await expect(card).toContainText("phone-2fa needs you");
  await expect(card).toContainText("times out in");
  await expect(page.getByTestId("desktop-row").first()).toHaveAttribute("data-state", "attention");
  await card.getByRole("link", { name: "take over →" }).tap();

  await expect(page).toHaveURL(new RegExp(`/desktops/${id}$`));
  await expect(page.getByTestId("view-mode")).toHaveText(/you have control/);
  await liveConnected(page, "control");
  // The live view fills the phone's width.
  const box = (await liveCanvas(page).boundingBox())!;
  expect(box.width).toBeGreaterThan(330);

  // Tap = click at that spot of the desktop (focuses the terminal).
  await clickScreen(page, 640, 400, undefined, { tap: true });
  if (!DOCKER) await expect.poll(async () => near(await pointerAt(a, id), 640, 400, 4)).toBe(true);

  // Type with the send box, then straight from the (on-screen) keyboard.
  await page.getByLabel("type into desktop").fill("123456");
  await page.getByRole("button", { name: "send", exact: true }).tap();
  await page.getByRole("button", { name: "enter" }).tap();
  await page.getByTestId("live-keys").tap();
  await expect(page.getByTestId("live-keys-input")).toBeFocused();
  await page.keyboard.type("ok");
  await page.keyboard.press("Enter");
  if (!DOCKER) {
    // KeyEvents (type 4) reached the fake desktop: "123456", Return, "ok", Return — each down + up.
    await expect.poll(async () => (await fakeVncInputs(id)).filter((m) => m.type === 4).length).toBeGreaterThanOrEqual(20);
  }

  // 1:1 shows the desktop at real size (the canvas becomes a 1:1 window onto it; drag pans), "fit" scales it back.
  const canvasPixels = () => liveCanvas(page).evaluate((c: HTMLCanvasElement) => [c.width, Math.round(c.getBoundingClientRect().width)]);
  expect((await canvasPixels())[0]).toBe(1280);
  await page.getByTestId("toggle-size").tap();
  await expect(page.getByTestId("toggle-size")).toHaveText("fit");
  await expect.poll(async () => {
    const [w, css] = await canvasPixels();
    return w < 1280 && Math.abs(w - css) <= 2;
  }).toBe(true);
  await page.getByTestId("toggle-size").tap();
  await expect.poll(async () => (await canvasPixels())[0]).toBe(1280);

  // Hand back from the pinned bar with a note.
  await page.getByTestId("handback-note").fill("code entered");
  await page.getByTestId("hand-back").tap();
  const r = await pending;
  expect(r.text).toContain("The user handed control back: code entered");
  await expect(page.getByTestId("take-over")).toBeVisible();
  await expect(page.getByTestId("view-mode")).toHaveText("view only");

  if (DOCKER) {
    expect(near(await pointerAt(a, id), 640, 400, 4)).toBe(true);
    await expect.poll(() => a.exec("cat /tmp/typed.txt")).toContain("123456\nok\n");
  }
});
