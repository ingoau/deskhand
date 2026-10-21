import { expect, login, test } from "./fixtures";

test("the action log shows every call with click points, drag paths and zoom regions in screen coordinates", async ({ page, agent }) => {
  const a = await agent("log-agent");
  const id = await a.start("log-overlays");
  await a.call("left_click", { coordinate: [300, 200] });
  await a.call("left_click_drag", { start_coordinate: [100, 120], coordinate: [500, 420] });
  await a.call("zoom", { region: [640, 400, 1280, 800] });
  await a.call("right_click", { coordinate: [1000, 150] });
  await a.call("screenshot");
  const failed = await a.call("left_click", { coordinate: [5000, 10] });
  expect(failed.isError).toBe(true);

  await login(page, `desktops/${id}`);
  // The detail page lists the most recent calls.
  await expect(page.getByTestId("recent-actions")).toContainText("right_click [1000, 150]");
  await page.getByTestId("log-link").click();
  await expect(page).toHaveURL(new RegExp(`/desktops/${id}/log$`));

  const entries = page.getByTestId("log-entry");
  const tools = ["desktop_start", "left_click", "left_click_drag", "zoom", "right_click", "screenshot"];
  for (const t of tools) await expect(entries.and(page.locator(`[data-tool="${t}"]`)).first()).toBeVisible();
  // Newest first; the out-of-screen click is logged as an error.
  await expect(entries.first()).toHaveAttribute("data-tool", "left_click");
  await expect(entries.first()).toContainText("error");
  await expect(entries.first()).toContainText("invalid_argument");

  const row = (tool: string) => page.locator(`[data-testid="log-entry"][data-tool="${tool}"]`).last();
  const click = row("left_click");
  await expect(click.locator("svg[data-testid=overlays]")).toHaveAttribute("viewBox", "0 0 1280 800");
  await expect(click.locator('[data-overlay="point"] circle').first()).toHaveAttribute("cx", "300");
  await expect(click.locator('[data-overlay="point"] circle').first()).toHaveAttribute("cy", "200");
  await expect(click).toContainText(/e2e-agent\/[0-9a-f]{4}/);
  await expect(row("right_click").locator('[data-overlay="point"] text')).toHaveText("right");
  await expect(row("left_click_drag").locator('[data-overlay="path"] polyline')).toHaveAttribute("points", "100,120 500,420");
  await expect(row("left_click_drag").locator('[data-overlay="path"] polygon')).toBeAttached();
  const rect = row("zoom").locator('[data-overlay="region"] rect');
  await expect(rect).toHaveAttribute("x", "640");
  await expect(rect).toHaveAttribute("y", "400");
  await expect(rect).toHaveAttribute("width", "640");
  await expect(rect).toHaveAttribute("height", "400");

  // Thumbnails and full screenshots come from the manager, framed as the whole screen (so overlays line up).
  const thumb = row("zoom").locator("img");
  await expect(thumb).toHaveAttribute("src", /\/deskhand\/api\/log\/\d+\/screenshot\?thumb=1$/);
  await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([320, 200]);
  await row("zoom").getByTestId("log-shot").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('[data-overlay="region"] rect')).toHaveAttribute("x", "640");
  const full = dialog.locator("img");
  await expect(full).toHaveAttribute("src", /\/deskhand\/api\/log\/\d+\/screenshot$/);
  await expect.poll(() => full.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([1280, 800]);
  await expect(dialog).toContainText('"region"');
});
