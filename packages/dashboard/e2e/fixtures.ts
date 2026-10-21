import { test as base, expect, type Page } from "@playwright/test";

/** Every test starts from the prototype fixture with simulated agent activity off. */
export const test = base.extend<{ mobile: boolean }>({
  mobile: async ({}, use, info) => use(info.project.name === "mobile"),
  page: async ({ page, request }, use) => {
    const r = await request.post("__mock/reset?live=0");
    expect(r.status()).toBe(204);
    await use(page);
  },
});

export { expect };

/** Wait until every <img> on the page has loaded (thumbnails, screenshots). */
export async function imagesLoaded(page: Page) {
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0), undefined, { timeout: 10_000 });
}

export const tiles = (page: Page, mobile: boolean) => page.getByTestId(mobile ? "desktop-row" : "desktop-tile");
