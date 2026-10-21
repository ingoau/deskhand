import { expect, imagesLoaded, test, tiles } from "./fixtures";

test.describe("desktops grid", () => {
  test("renders 8 desktops with thumbnails, summary and the attention banner", async ({ page, mobile }) => {
    await page.goto("./");
    await expect(tiles(page, mobile)).toHaveCount(8);
    await expect(page.getByTestId("system-summary").first()).toHaveText("6/8 · 46% · 9.8G");
    const banner = page.getByTestId(mobile ? "attention-card" : "attention-banner");
    await expect(banner).toContainText("supplier-portal-sign-up needs you");
    await expect(banner).toContainText("“CAPTCHA on the sign-in page” · 2m");
    // first tile is the one needing attention, then the rest by age; starting one last
    await expect(tiles(page, mobile).first()).toHaveAttribute("data-state", "attention");
    await expect(tiles(page, mobile).last()).toContainText("untitled");
    await expect(tiles(page, mobile).last()).toContainText("starting…");
    await expect(page.getByText("you have control · 34m")).toBeVisible();
    await expect(page.getByText("stopped · idle 30m")).toBeVisible();
    await expect(page.getByText("left_click_drag [212,380]→[904,410]")).toBeVisible();
    await imagesLoaded(page);
    // thumbnails are cache-busted image URLs under the base path
    const src = await tiles(page, mobile).nth(1).locator("img").getAttribute("src");
    expect(src).toMatch(/^\/deskhand\/api\/desktops\/[0-9a-f]+\/thumbnail\?t=\d+$/);
  });

  test("filter tabs show counts and filter", async ({ page, mobile }) => {
    await page.goto("./");
    await expect(page.getByTestId("tab-all")).toHaveText("all 8");
    await expect(page.getByTestId("tab-attention")).toHaveText("attention 2");
    await expect(page.getByTestId("tab-running")).toHaveText("running 4");
    await expect(page.getByTestId("tab-stopped")).toHaveText("stopped 1");

    await page.getByTestId("tab-attention").click();
    await expect(tiles(page, mobile)).toHaveCount(2);
    await expect(page).toHaveURL(/tab=attention/);
    await page.getByTestId("tab-stopped").click();
    await expect(tiles(page, mobile)).toHaveCount(1);
    await expect(tiles(page, mobile).first()).toContainText("docs-screenshots");

    await page.getByTestId("tab-all").click();
    await page.getByLabel("filter desktops").fill("review");
    await expect(tiles(page, mobile)).toHaveCount(1);
    await expect(page.getByTestId("tab-all")).toHaveText("all 1");
    await expect(tiles(page, mobile).first()).toContainText("pr-review-212");
  });

  test("template change marker is shown", async ({ page, mobile }) => {
    await page.goto("./");
    if (mobile) await expect(page.getByRole("link", { name: "templates·" })).toBeVisible();
    else await expect(page.getByTestId("templates-changed")).toBeVisible();
  });
});

test.describe("takeover", () => {
  test("take over, then hand back with a note", async ({ page, request, mobile }) => {
    await page.goto("./");
    await tiles(page, mobile).filter({ hasText: "supplier-portal-sign-up" }).click();
    await expect(page).toHaveURL(/\/deskhand\/desktops\/7f3a$/);
    await expect(page.getByTestId("desktop-title")).toHaveText("supplier-portal-sign-up");
    await expect(page.getByTestId("desktop-meta")).toContainText("base@v1 · t3/onboarding-vendors · 18m");
    await expect(page.getByTestId("needs-you")).toContainText("“CAPTCHA on the sign-in page”");
    await expect(page.getByTestId("needs-you")).toContainText(/agent blocked · times out in [78]m/);
    await expect(page.getByTestId("view-mode")).toHaveText("view only");
    await expect(page.getByTestId("live-view")).toHaveAttribute("data-live-state", "mock");
    await expect(page.getByText("live view unavailable in mock")).toBeVisible();
    await expect(page.getByTestId("recent-actions")).toContainText('request_human("CAPTCHA…")');

    await page.getByTestId("take-over").click();
    await expect(page.getByTestId("view-mode")).toHaveText(/you have control · 0:0\d/);
    await expect(page.getByTestId("control-tools")).toBeVisible();
    await expect(page.getByTestId("hand-back")).toBeVisible();

    await page.getByTestId("handback-note").fill("solved the captcha, continue from the form");
    await page.getByTestId("hand-back").click();
    await expect(page.getByText("handed back with note")).toBeVisible();
    await expect(page.getByTestId("take-over")).toBeVisible();
    await expect(page.getByTestId("view-mode")).toHaveText("view only");
    await expect(page.getByTestId("needs-you")).toHaveCount(0);

    // the manager received the note and recorded it in the action log
    const d = await (await request.get("api/desktops/7f3a")).json();
    expect(d.lock).toBeNull();
    expect(d.attention).toBeNull();
    expect(d.lastHandback.note).toBe("solved the captcha, continue from the form");
    expect(d.generation).toBe(3);
    await expect(page.getByTestId("recent-actions")).toContainText('handback("solved the captcha, continue from the form")');
  });

  test("take over → from the attention banner takes control directly", async ({ page, mobile }) => {
    await page.goto("./");
    await page
      .getByTestId(mobile ? "attention-card" : "attention-banner")
      .getByRole("link", { name: "take over →" })
      .click();
    await expect(page.getByTestId("hand-back")).toBeVisible();
    await expect(page.getByTestId("view-mode")).toHaveText(/you have control/);
    await page.goBack();
    await expect(page.getByTestId("tab-attention")).toHaveText("attention 2");
    await expect(page.getByTestId(mobile ? "attention-card" : "attention-banner")).toHaveCount(0);
  });

  test("kill removes the desktop", async ({ page, mobile }) => {
    await page.goto("desktops/e1d8");
    await page.getByTestId("desktop-menu").click();
    await page.getByRole("menuitem", { name: "kill" }).click();
    await page.getByTestId("confirm-kill").click();
    await expect(page).toHaveURL(/\/deskhand\/?$/);
    await expect(tiles(page, mobile)).toHaveCount(7);
  });

  test("upload a file into ~/Downloads", async ({ page, request }) => {
    await page.goto("desktops/2c91");
    await page.getByTestId("upload-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello desktop") });
    await expect(page.getByLabel("save to (inside the desktop)")).toHaveValue("/home/agent/Downloads/notes.txt");
    await page.getByRole("button", { name: "upload", exact: true }).click();
    await expect(page.getByText("uploaded 13B to /home/agent/Downloads/notes.txt")).toBeVisible();
    const state = await (await request.get("__mock/state")).json();
    expect(state.uploads).toEqual([expect.objectContaining({ desktopId: "2c91", path: "/home/agent/Downloads/notes.txt", bytes: 13 })]);
  });
});

test.describe("action log", () => {
  test("renders entries with click, drag and zoom overlays and enlarges a screenshot", async ({ page }) => {
    await page.goto("desktops/7f3a");
    await page.getByTestId("log-link").click();
    await expect(page).toHaveURL(/\/desktops\/7f3a\/log$/);
    await expect(page.getByTestId("log-entry").first()).toContainText("request_human");
    const zoom = page.locator('[data-testid="log-entry"][data-tool="zoom"]');
    await expect(zoom.locator('[data-overlay="region"] rect')).toHaveCount(1);
    const click = page.locator('[data-testid="log-entry"][data-tool="left_click"]').first();
    await expect(click.locator('[data-overlay="point"] circle').first()).toBeAttached();
    // region overlay geometry is in screen coordinates
    const rect = zoom.locator('[data-overlay="region"] rect');
    await expect(rect).toHaveAttribute("x", "480");
    await expect(rect).toHaveAttribute("width", "320");

    await page.goto("desktops/5a77/log");
    const drag = page.locator('[data-testid="log-entry"][data-tool="left_click_drag"]').first();
    await expect(drag.locator('[data-overlay="path"] polyline')).toHaveAttribute("points", /^212,380 .* 904,410$/);
    await expect(drag.locator('[data-overlay="path"] polygon')).toBeAttached();

    await drag.getByTestId("log-shot").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-overlay="path"] polyline')).toBeAttached();
    await expect(dialog.locator("img")).toHaveAttribute("src", /\/deskhand\/api\/log\/\d+\/screenshot$/);
  });

  test("shows errors and unknown outcomes", async ({ page }) => {
    await page.goto("desktops/b40e/log");
    await expect(page.getByText("locked_by_user · The user is controlling this desktop; wait and try again.")).toBeVisible();
    await page.goto("desktops/e1d8/log");
    await expect(page.locator('[data-tool="browser_click"]')).toContainText("unknown");
  });
});

test.describe("templates", () => {
  test("lists templates with markers and rolls back a version", async ({ page }) => {
    await page.goto("templates");
    await expect(page.getByTestId("template-row")).toHaveCount(4);
    const research = page.getByTestId("template-row").filter({ hasText: "research" });
    await expect(research).toContainText("changed by agent");
    await expect(research).toContainText("github.com");
    await expect(research).toContainText("linear.app");
    await expect(page.getByTestId("template-row").filter({ hasText: "vendor-portals" })).toContainText("stale");
    await expect(page.getByTestId("template-row").filter({ hasText: "office" })).toContainText("outdated base");

    await research.click();
    await expect(page).toHaveURL(/\/templates\/research$/);
    await expect(page.getByTestId("current-version")).toHaveText("v2");
    const v2 = page.locator('[data-testid="version-row"][data-version="2"]');
    await expect(v2.getByTestId("version-diff")).toContainText("+linear.app");
    await expect(v2.getByTestId("version-diff")).toContainText("+Refined GitHub");
    await expect(v2.getByTestId("version-diff")).toContainText("+jq");
    await expect(v2).toContainText("by agent");

    await page.getByTestId("rollback-v1").click();
    await expect(page.getByTestId("current-version")).toHaveText("v1");
    await expect(page.getByText("research now points at v1")).toBeVisible();
    await expect(page.getByRole("button", { name: "restore v2" })).toBeVisible();

    await page.goto("templates");
    await expect(page.getByTestId("template-row").filter({ hasText: "research" })).toContainText("rolled back · latest v2");
  });

  test("recipe editor, rebuild, stale reason and base (phase 4 fields)", async ({ page }) => {
    await page.goto("templates");
    await expect(page.getByTestId("template-row").filter({ hasText: "vendor-portals" }).getByTestId("marker-stale")).toContainText("Ariba login expired");
    await page.goto("templates/research");
    await expect(page.getByTestId("template-base")).toContainText("base 0.1.0");
    await expect(page.getByTestId("recipe")).toContainText("apt-get install -y gh jq");
    await page.getByTestId("edit-recipe").click();
    await page.getByLabel("recipe").fill("apt-get install -y gh jq ripgrep");
    await page.getByRole("button", { name: "save recipe" }).click();
    await expect(page.getByText("recipe saved")).toBeVisible();
    await expect(page.getByTestId("recipe")).toContainText("ripgrep");
    await page.getByTestId("rebuild").click();
    await expect(page.getByText(/rebuilt research as v3/)).toBeVisible();
    await expect(page.getByTestId("current-version")).toHaveText("v3");
    await expect(page.locator('[data-testid="version-row"][data-version="3"]').getByTestId("version-provenance")).toContainText("rebuilt from v2");
    // Snapshot-only templates have no rebuild button.
    await page.goto("templates/office");
    await expect(page.getByTestId("rebuild")).toHaveCount(0);
    await expect(page.getByTestId("template-base")).toContainText("manager runs 0.1.0");
  });

  test("save as template offers to keep the current description for a new version", async ({ page }) => {
    await page.goto("desktops/2c91");
    await page.getByTestId("desktop-menu").click();
    await page.getByRole("menuitem", { name: "save as template…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^name/).fill("research");
    await expect(dialog.getByTestId("keep-description")).toContainText("keep the current description");
    await expect(dialog.getByPlaceholder("Triaging issues or reviewing PRs in the web UI")).toHaveCount(0);
    await dialog.getByRole("button", { name: "save template" }).click();
    await expect(page.getByText("saved research v3")).toBeVisible({ timeout: 10_000 });
  });

  test("new desktop with memory, cpus and kvm shows the markers", async ({ page, mobile }) => {
    test.skip(mobile, "dialog flow is the same on phones");
    await page.goto("./");
    await page.getByTestId("new-desktop").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("max 8g")).toBeVisible();
    await dialog.getByLabel("memory").fill("8g");
    await dialog.getByLabel("cpus").fill("4");
    await dialog.getByRole("switch", { name: "kvm" }).click();
    await dialog.getByLabel(/^title/).fill("android-emu");
    await dialog.getByRole("button", { name: "start desktop" }).click();
    await expect(page).toHaveURL(/\/desktops\/[0-9a-f]{4}$/);
    await expect(page.getByTestId("desktop-meta")).toContainText("kvm · 8g");
    await expect(page.getByTestId("desktop-meta")).toContainText("4 cpu");
    await page.goto("./");
    await expect(tiles(page, mobile).filter({ hasText: "android-emu" }).getByTestId("hw-marks")).toHaveText("kvm · 8g");
  });

  test("edit starts a desktop from the template", async ({ page }) => {
    await page.goto("templates/vendor-portals");
    await page.getByRole("button", { name: "edit" }).click();
    await expect(page).toHaveURL(/\/desktops\/[0-9a-f]{4}$/);
    await expect(page.getByTestId("desktop-title")).toHaveText("edit-vendor-portals");
    await expect(page.getByTestId("desktop-meta")).toContainText("vendor-portals@v3");
  });
});

test.describe("auth", () => {
  test("401 shows the login page; a valid token signs in", async ({ page, request }) => {
    await request.post("__mock/reset?live=0&auth=1");
    await page.goto("templates");
    await expect(page).toHaveURL(/\/deskhand\/login\?next=%2Ftemplates$/);
    await expect(page.getByText("deskhand login-link").first()).toBeVisible();
    await page.getByLabel("api token").fill("wrong");
    await page.getByRole("button", { name: "sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("isn't valid");
    await page.getByLabel("api token").fill("dh_claude_laptop_demo");
    await page.getByRole("button", { name: "sign in" }).click();
    await expect(page).toHaveURL(/\/deskhand\/templates$/);
    await expect(page.getByTestId("template-row")).toHaveCount(4);
  });

  test("settings creates a token shown once", async ({ page }) => {
    await page.goto("settings");
    await expect(page.getByTestId("token-list").locator("li")).toHaveCount(3);
    await expect(page.getByTestId("log-disk")).toContainText("1.3G");
    await page.getByLabel("new token name").fill("my-phone");
    await page.getByRole("button", { name: "create token" }).click();
    await expect(page.getByTestId("new-token-secret")).toHaveText(/^dh_[0-9a-f]{32}$/);
    await page.getByRole("button", { name: "done" }).click();
    await expect(page.getByTestId("token-list").locator("li")).toHaveCount(4);
  });
});
