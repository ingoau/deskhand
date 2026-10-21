import { api, DOCKER, expect, login, test } from "./fixtures";

test("templates saved by an agent are marked, and roll back in one click", async ({ page, agent }) => {
  test.setTimeout(DOCKER ? 300_000 : 60_000);
  const a = await agent("template-agent");
  const id = await a.start("template-source");
  const name = `e2e-tpl-${Math.random().toString(36).slice(2, 7)}`;
  const description = { summary: "e2e template for rollback", use_when: "Testing the dashboard's template rollback" };
  const v1 = await a.call("template_save", { name, description, desktop: id }, 240_000);
  expect(v1.isError, v1.text).toBe(false);
  const v2 = await a.call("template_save", { name, description: { ...description, summary: "e2e template, second version", tags: ["e2e"] }, desktop: id }, 240_000);
  expect(v2.isError, v2.text).toBe(false);

  await login(page, "templates");
  // "templates ·" — the nav marks a recent agent change.
  await expect(page.getByTestId("templates-changed")).toBeVisible();
  const row = page.getByTestId("template-row").filter({ hasText: name });
  await expect(row).toContainText("v2");
  await expect(row.getByTestId("marker-agent")).toHaveText("changed by agent");
  await expect(row).toContainText("e2e template, second version");

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/templates/${name}$`));
  await expect(page.getByTestId("current-version")).toHaveText("v2");
  const v2row = page.locator('[data-testid="version-row"][data-version="2"]');
  await expect(v2row).toContainText("by agent");
  await expect(v2row.getByTestId("version-diff")).toContainText("e2e template, second version");

  // One click.
  await page.getByTestId("rollback-v1").click();
  await expect(page.getByTestId("current-version")).toHaveText("v1");
  await expect(page.getByText(`${name} now points at v1`)).toBeVisible();
  await expect(page.getByText("rolled back · latest v2").first()).toBeVisible();
  const t = (await api("GET", `/api/templates/${name}`)).data;
  expect([t.currentVersion, t.latestVersion]).toEqual([1, 2]);

  // New desktops start from the rolled-back version.
  const b = await agent("template-agent-2");
  const started = await b.call("desktop_start", { template: name });
  expect(started.text, started.text).toContain(`${name} v1`);

  // And forward again.
  await page.getByRole("button", { name: "restore v2" }).click();
  await expect(page.getByTestId("current-version")).toHaveText("v2");
});

test("new version keeping the description, recipe edit and rebuild from the dashboard", async ({ page, agent }) => {
  test.setTimeout(DOCKER ? 420_000 : 60_000);
  const a = await agent("recipe-agent");
  const id = await a.start("recipe-source");
  const name = `e2e-rcp-${Math.random().toString(36).slice(2, 7)}`;
  const v1 = await a.call("template_save", { name, description: { summary: "recipe e2e", use_when: "testing rebuilds" }, desktop: id }, 240_000);
  expect(v1.isError, v1.text).toBe(false);

  // v2 from the dashboard, keeping v1's description.
  await login(page, `desktops/${id}`);
  await page.getByTestId("desktop-menu").click();
  await page.getByRole("menuitem", { name: "save as template…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^name/).fill(name);
  await expect(dialog.getByTestId("keep-description")).toContainText("recipe e2e");
  await dialog.getByRole("button", { name: "save template" }).click();
  await expect(page.getByText(new RegExp(`saved ${name} v2`))).toBeVisible({ timeout: DOCKER ? 120_000 : 10_000 });

  await page.goto(`templates/${name}`);
  await expect(page.getByTestId("current-version")).toHaveText("v2");
  await expect(page.locator('[data-testid="version-row"][data-version="2"]').getByTestId("version-provenance")).toContainText("saved from “recipe-source”");
  await page.getByTestId("edit-recipe").click();
  await page.getByLabel("recipe").fill("echo rebuilt-by-recipe > ~/rebuilt.txt");
  await page.getByRole("button", { name: "save recipe" }).click();
  await expect(page.getByTestId("recipe")).toContainText("rebuilt-by-recipe");
  expect((await api("GET", `/api/templates/${name}`)).data.hasRecipe).toBe(true);

  await page.getByTestId("rebuild").click();
  await expect(page.getByText(new RegExp(`rebuilt ${name} as v3`))).toBeVisible({ timeout: DOCKER ? 300_000 : 20_000 });
  await expect(page.getByTestId("current-version")).toHaveText("v3");
  await expect(page.locator('[data-testid="version-row"][data-version="3"]').getByTestId("version-provenance")).toContainText("rebuilt from v2");
  if (DOCKER) {
    // A desktop from the rebuilt template has what the recipe made.
    const b = await agent("recipe-agent-2");
    const started = await b.call("desktop_start", { template: name });
    expect(started.text).toContain(`${name} v3`);
    expect(await b.exec("cat ~/rebuilt.txt")).toContain("rebuilt-by-recipe");
  }
});

test("a template saved from the dashboard is not marked as an agent change", async ({ page, agent }) => {
  test.setTimeout(DOCKER ? 240_000 : 60_000);
  const a = await agent("save-agent");
  const id = await a.start("save-from-dashboard");
  const name = `e2e-dash-${Math.random().toString(36).slice(2, 7)}`;
  await login(page, `desktops/${id}`);
  await page.getByTestId("desktop-menu").click();
  await page.getByRole("menuitem", { name: "save as template…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("name").fill(name);
  await dialog.getByPlaceholder("Chromium logged into GitHub and Linear as the bot account").fill("saved from the dashboard");
  await dialog.getByPlaceholder("Triaging issues or reviewing PRs in the web UI").fill("e2e checks");
  await dialog.getByRole("button", { name: /save/ }).click();
  await expect(page.getByText(new RegExp(`saved ${name}`))).toBeVisible({ timeout: DOCKER ? 120_000 : 10_000 });
  await page.goto("templates");
  const row = page.getByTestId("template-row").filter({ hasText: name });
  await expect(row).toContainText("saved from the dashboard");
  await expect(row.getByTestId("marker-agent")).toHaveCount(0);
});
