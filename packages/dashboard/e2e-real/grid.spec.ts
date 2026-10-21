import type { Locator } from "@playwright/test";
import { DOCKER, expect, login, test, waitRunning } from "./fixtures";

/** Digest of the image a tile currently shows (fetched again with the page's cookie). */
async function shown(tile: Locator): Promise<string> {
  return tile.locator("img").evaluate(async (img: HTMLImageElement) => {
    const buf = await (await fetch(img.src)).arrayBuffer();
    const d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
  });
}

test("the grid shows live thumbnails of every desktop", async ({ page, agent }) => {
  const a = await agent("grid-agent");
  const one = await a.start("grid-one");
  await a.start("grid-two");
  await login(page);

  // A third desktop started from the dashboard.
  await page.getByRole("button", { name: "+ new" }).click();
  await page.getByLabel("title (optional)").fill("grid-three");
  await page.getByRole("button", { name: "start desktop" }).click();
  await expect(page).toHaveURL(/\/desktops\/[0-9a-f]+$/);
  const third = page.url().split("/").pop()!;
  await waitRunning(third);
  await page.getByRole("link", { name: "‹ desktops" }).click();

  const tiles = page.getByTestId("desktop-tile");
  await expect(tiles).toHaveCount(3);
  await expect(page.getByTestId("tab-running")).toHaveText("running 3");
  await expect(page.getByTestId("system-summary").first()).toHaveText(/^3\/4 · /);
  for (const name of ["grid-one", "grid-two", "grid-three"]) {
    const img = tiles.filter({ hasText: name }).locator("img");
    await expect(img).toHaveAttribute("src", /\/deskhand\/api\/desktops\/[0-9a-f]+\/thumbnail\?t=\d+$/);
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => (i.complete ? [i.naturalWidth, i.naturalHeight] : null))).toEqual([320, 200]);
  }
  // Session label and last action on the tile.
  const tile = tiles.filter({ hasText: "grid-one" });
  await expect(tile).toHaveAttribute("title", /e2e-agent\/[0-9a-f]{4}/);

  // Thumbnails refresh on their own every ~1.5 s ...
  const src0 = await tile.locator("img").getAttribute("src");
  await expect.poll(() => tile.locator("img").getAttribute("src"), { timeout: 6000 }).not.toBe(src0);

  // ... and show what the agent does.
  const before = await shown(tile);
  if (DOCKER) await a.exec("setsid xterm -geometry 70x12+40+40 -bg '#b03030' >/dev/null 2>&1 &", one);
  else await a.call("left_click", { coordinate: [640, 400], desktop: one });
  await expect.poll(() => shown(tile), { timeout: DOCKER ? 20_000 : 8_000 }).not.toBe(before);
  if (!DOCKER) await expect(tile).toContainText("left_click [640, 400]");
});
