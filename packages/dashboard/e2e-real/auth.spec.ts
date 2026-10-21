import { api, expect, login, test } from "./fixtures";

test.describe("auth against the manager", () => {
  test("401 → login page; a dead login link says so; a token signs in and returns to the page", async ({ page }) => {
    await page.goto("templates");
    await expect(page).toHaveURL(/\/deskhand\/login\?next=%2Ftemplates$/);
    await expect(page.getByLabel("api token")).toBeVisible();

    // A used or expired login link lands on the login page with an explanation.
    const { data } = await api<{ url: string }>("POST", "/api/login-links");
    const ctx2 = await page.context().browser()!.newContext();
    const other = await ctx2.newPage();
    await other.goto(data.url); // first use works
    await expect(other).toHaveURL(/\/deskhand\/?$/);
    await ctx2.close();
    await page.goto(data.url); // second use doesn't
    await expect(page).toHaveURL(/\/deskhand\/login\?next=%2F&reason=expired$/);
    await expect(page.getByTestId("login-reason")).toContainText("expired or was already used");

    await page.getByLabel("api token").fill("dh_not-a-real-token");
    await page.getByRole("button", { name: "sign in" }).click();
    await expect(page.getByRole("alert").last()).toContainText("not valid");
    await page.goto("login?next=%2Ftemplates");
    await page.getByLabel("api token").fill(process.env.E2E_AGENT_TOKEN!);
    await page.getByRole("button", { name: "sign in" }).click();
    await expect(page).toHaveURL(/\/deskhand\/templates$/);
    await expect(page.getByTestId("template-row").filter({ hasText: "base" })).toBeVisible();
  });

  test("a dead login link while signed in keeps the session; sign out everywhere ends it", async ({ page }) => {
    await login(page);
    await page.goto("auth/login?code=definitely-not-valid");
    await expect(page.getByText("That login link had expired or was already used; you're still signed in.")).toBeVisible();
    await expect(page).toHaveURL(/\/deskhand\/?$/);

    await page.goto("settings");
    await page.getByRole("button", { name: "sign out everywhere" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /sign out/ }).click();
    await expect(page).toHaveURL(/\/deskhand\/login/);
    await page.goto("./");
    await expect(page).toHaveURL(/\/deskhand\/login/);
  });
});
