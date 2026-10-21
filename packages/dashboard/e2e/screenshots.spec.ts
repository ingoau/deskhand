import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, imagesLoaded, test } from "./fixtures";

/** Captures the main screens into ./screenshots for visual comparison with docs/prototypes. */
test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to capture screenshots");

const out = (project: string, name: string) => path.join(import.meta.dirname, "..", "screenshots", `${project}-${name}.png`);

async function snap(page: Page, project: string, name: string, fullPage = false) {
  await imagesLoaded(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: out(project, name), fullPage });
}

test("main screens", async ({ page }, info) => {
  const p = info.project.name;
  await page.goto("./");
  await expect(page.getByTestId(p === "mobile" ? "desktop-row" : "desktop-tile")).toHaveCount(8);
  await snap(page, p, "grid");

  await page.goto("desktops/7f3a");
  await expect(page.getByTestId("needs-you")).toBeVisible();
  await snap(page, p, "desktop-attention");

  await page.getByTestId("take-over").click();
  await expect(page.getByTestId("hand-back")).toBeVisible();
  await page.getByTestId("handback-note").fill("solved it, continue from the form");
  await snap(page, p, "desktop-control");

  await page.getByTestId("desktop-menu").click();
  await page.waitForTimeout(200);
  await snap(page, p, "desktop-menu");
  await page.keyboard.press("Escape");

  await page.goto("desktops/5a77/log");
  await expect(page.getByTestId("log-entry").first()).toBeVisible();
  await snap(page, p, "log");

  await page.goto("desktops/7f3a/log");
  await expect(page.getByTestId("log-entry").first()).toBeVisible();
  await page.locator('[data-testid="log-entry"][data-tool="zoom"]').getByTestId("log-shot").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await snap(page, p, "log-enlarged");
  await page.keyboard.press("Escape");

  await page.goto("templates");
  await expect(page.getByTestId("template-row")).toHaveCount(4);
  await snap(page, p, "templates");

  await page.goto("templates/research");
  await expect(page.getByTestId("version-row").first()).toBeVisible();
  await snap(page, p, "template-detail", true);

  await page.goto("settings");
  await expect(page.getByTestId("token-list")).toBeVisible();
  await snap(page, p, "settings");

  await page.goto("./");
  await page.getByTestId(p === "mobile" ? "desktop-row" : "desktop-tile").first().waitFor();
  if (p !== "mobile") {
    await page.getByTestId("new-desktop").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await snap(page, p, "new-desktop");
    await page.keyboard.press("Escape");
  }

  await page.request.post("__mock/reset?live=0&auth=1");
  await page.goto("./");
  await expect(page.getByLabel("api token")).toBeVisible();
  await snap(page, p, "login");
});
