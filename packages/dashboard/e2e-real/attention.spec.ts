import { expect, liveConnected, login, test } from "./fixtures";

test.describe("request_human", () => {
  test("flags the tile; take over from the banner; hand back returns the agent's request_human with the note", async ({ page, agent }) => {
    const a = await agent("human-agent");
    const id = await a.start("needs-human");
    const pending = a.call("request_human", { reason: "Please solve the CAPTCHA on the sign-in page" }, 15 * 60_000);

    await login(page);
    const tile = page.getByTestId("desktop-tile").filter({ hasText: "needs-human" });
    await expect(tile).toHaveAttribute("data-state", "attention");
    await expect(tile).toContainText("waiting on you");
    await expect(page.getByTestId("tab-attention")).toHaveText("attention 1");
    const banner = page.getByTestId("attention-banner");
    await expect(banner).toContainText("needs-human needs you");
    await expect(banner).toContainText("“Please solve the CAPTCHA on the sign-in page”");
    await expect(banner.getByTestId("attention-timeout")).toHaveText(/ · times out in (10|9)m/);

    await banner.getByRole("link", { name: "take over →" }).click();
    await expect(page).toHaveURL(new RegExp(`/desktops/${id}$`));
    await expect(page.getByTestId("view-mode")).toHaveText(/you have control/);
    await expect(page.getByTestId("needs-you")).toContainText("agent blocked · times out in");
    await liveConnected(page, "control");

    await page.getByTestId("handback-note").fill("solved it, carry on from the dashboard");
    await page.getByTestId("hand-back").click();
    const r = await pending;
    expect(r.isError).toBe(false);
    expect(r.text).toContain("The user handed control back: solved it, carry on from the dashboard");
    expect(r.images).toBe(1);
    await expect(page.getByTestId("needs-you")).toHaveCount(0);
    await expect(page.getByTestId("view-mode")).toHaveText("view only");

    // Back on the grid the flag is gone and the request is in the log.
    await page.goto("./");
    await expect(page.getByTestId("attention-banner")).toHaveCount(0);
    await expect(tile).toHaveAttribute("data-state", "running");
    await page.goto(`desktops/${id}/log`);
    await expect(page.locator('[data-testid="log-entry"][data-tool="request_human"]')).toContainText("request_human");
  });

  test("dismiss clears the flag without taking over", async ({ page, agent }) => {
    const a = await agent("dismiss-agent");
    const id = await a.start("dismiss-me");
    const pending = a.call("request_human", { reason: "Approve the payment?" }, 15 * 60_000);
    await login(page);
    await expect(page.getByTestId("attention-banner")).toContainText("dismiss-me needs you");
    await page.goto(`desktops/${id}`);
    await page.getByTestId("dismiss-attention").click();
    const r = await pending;
    expect(r.text).toContain("dismissed the request without taking over");
    await expect(page.getByTestId("needs-you")).toHaveCount(0);
    await expect(page.getByTestId("take-over")).toBeEnabled();
  });
});
