import fs from "node:fs";
import { api, DOCKER, expect, login, MANAGER, test, waitRunning } from "./fixtures";

test.describe("desktop actions against the manager", () => {
  test("upload into ~/Downloads and download it again", async ({ page, agent }) => {
    const a = await agent("files-agent");
    const id = await a.start("files");
    await login(page, `desktops/${id}`);
    await page.getByTestId("upload-input").setInputFiles({ name: "hello e2e.txt", mimeType: "text/plain", buffer: Buffer.from("hello from the dashboard\n") });
    await expect(page.getByLabel("save to (inside the desktop)")).toHaveValue("/home/agent/Downloads/hello e2e.txt");
    await page.getByRole("button", { name: "upload", exact: true }).click();
    await expect(page.getByText("uploaded 25B to /home/agent/Downloads/hello e2e.txt")).toBeVisible();
    if (DOCKER) {
      // Owned by the agent user, inside the desktop.
      expect(await a.exec("stat -c '%U %s' ~/Downloads/'hello e2e.txt' && cat ~/Downloads/'hello e2e.txt'")).toContain("agent 25\nhello from the dashboard");
    }

    await page.getByTestId("desktop-menu").click();
    await page.getByRole("menuitem", { name: /download file/ }).click();
    const dialog = page.getByRole("dialog");
    // A missing file shows a message instead of downloading an error.
    await dialog.getByLabel("path inside the desktop").fill("/home/agent/Downloads/nope.txt");
    await dialog.getByRole("link", { name: "download" }).click();
    await expect(dialog.getByRole("alert")).toContainText("No such file in the desktop: /home/agent/Downloads/nope.txt");
    await dialog.getByLabel("path inside the desktop").fill("/home/agent/Downloads/hello e2e.txt");
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("link", { name: "download" }).click()]);
    expect(download.suggestedFilename()).toBe("hello e2e.txt");
    expect(fs.readFileSync((await download.path())!, "utf8")).toBe("hello from the dashboard\n");
  });

  test("persistent, copy session link, stop and start, kill", async ({ page, agent, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const a = await agent("actions-agent");
    const id = await a.start("actions");
    await login(page, `desktops/${id}`);
    const menu = async (item: string | RegExp) => {
      await page.getByTestId("desktop-menu").click();
      await page.getByRole("menuitem", { name: item }).click();
    };

    await page.getByTestId("desktop-menu").click();
    await page.getByRole("menuitemcheckbox", { name: /persistent/ }).click();
    await expect.poll(async () => (await api("GET", `/api/desktops/${id}`)).data.persistent).toBe(true);
    await expect(page.getByRole("menuitemcheckbox", { name: /persistent/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape"); // the checkbox item keeps the menu open
    await expect(page.getByTestId("desktop-meta")).toContainText("persistent");

    await menu("copy session link");
    await expect(page.getByText("session link copied")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${MANAGER}/desktops/${id}`);

    await menu("stop");
    await expect(page.getByTestId("view-mode")).toHaveText("stopped", { timeout: DOCKER ? 60_000 : 10_000 });
    await expect(page.getByTestId("take-over")).toHaveCount(0);
    // The manager refuses to lock a stopped desktop with 409 desktop_stopped.
    const lock = await api("POST", `/api/desktops/${id}/lock`, {});
    expect([lock.status, lock.data.error.code]).toEqual([409, "desktop_stopped"]);
    await page.getByRole("link", { name: "‹ desktops" }).click();
    const tile = page.getByTestId("desktop-tile").filter({ hasText: "actions" });
    await expect(tile).toHaveAttribute("data-state", "stopped");
    await expect(tile).toContainText(/stopped/);
    await tile.click();

    await page.getByRole("button", { name: "start" }).click();
    await waitRunning(id);
    await expect(page.getByTestId("view-mode")).toHaveText("view only", { timeout: DOCKER ? 60_000 : 10_000 });

    await menu("kill");
    await page.getByTestId("confirm-kill").click();
    await expect(page).toHaveURL(/\/deskhand\/?$/);
    await expect(page.getByTestId("desktop-tile")).toHaveCount(0);
    expect((await api("GET", `/api/desktops/${id}`)).status).toBe(404);
    // The agent is told the desktop is gone.
    const r = await a.call("screenshot", { desktop: id });
    expect(r.isError).toBe(true);
  });
});
