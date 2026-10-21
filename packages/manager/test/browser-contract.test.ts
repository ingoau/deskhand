/**
 * Contract test for the re-exported browser_* tools. Playwright MCP's tool schemas change between
 * releases, so @playwright/mcp is pinned and this test snapshots exactly what deskhand re-exports
 * (names, descriptions, input schemas). An upgrade must update the snapshot deliberately:
 *   scripts/dev pnpm --filter @deskhand/manager exec vitest run test/browser-contract.test.ts -u
 * and every tool the new version adds must be either curated (BROWSER_TOOLS) or excluded with a
 * reason (BROWSER_EXCLUDED).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_EXCLUDED, BROWSER_TOOLS } from "@deskhand/mcp";
import { listPlaywrightTools, PLAYWRIGHT_MCP_VERSION } from "../src/browser.js";
import type { FakeRuntime } from "../src/runtime/fake.js";
import { connectMcp, startManager, tmpDir, type TestManager } from "./helpers.js";

const require = createRequire(import.meta.url);

let t: TestManager;
beforeAll(async () => {
  t = await startManager();
});
afterAll(async () => {
  await t?.close();
  await (t?.runtime as FakeRuntime | undefined)?.destroy();
});

describe("browser_* contract", () => {
  it("pins @playwright/mcp exactly", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@playwright/mcp"]).toBe(PLAYWRIGHT_MCP_VERSION);
    const installed = JSON.parse(readFileSync(require.resolve("@playwright/mcp/package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
    expect(installed.version).toBe(PLAYWRIGHT_MCP_VERSION);
    // playwright-core is imported directly (to attach over CDP); it must be the one Playwright MCP uses.
    expect(pkg.dependencies["playwright-core"]).toBe(installed.dependencies["playwright-core"]);
  });

  it("has a decision for every tool Playwright MCP offers", async () => {
    const upstream = await listPlaywrightTools(tmpDir());
    const undecided = upstream.map((u) => u.name).filter((n) => !(n in BROWSER_TOOLS) && !(n in BROWSER_EXCLUDED));
    expect(undecided, "new Playwright MCP tools: add them to BROWSER_TOOLS or BROWSER_EXCLUDED").toEqual([]);
    const missing = Object.keys(BROWSER_TOOLS).filter((n) => !upstream.some((u) => u.name === n));
    expect(missing, "curated tools that Playwright MCP no longer has").toEqual([]);
  });

  it("re-exports the curated set with `desktop` added and file names stripped (snapshot)", async () => {
    const { client } = await connectMcp(t.url, t.token);
    const tools = (await client.listTools()).tools.filter((x) => x.name.startsWith("browser_"));
    await client.close();
    expect(tools.map((x) => x.name).sort()).toEqual(Object.keys(BROWSER_TOOLS).sort());
    for (const tool of tools) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props, tool.name).toHaveProperty("desktop");
      expect(props, tool.name).not.toHaveProperty("filename");
      expect((tool.inputSchema as { required?: string[] }).required ?? [], tool.name).not.toContain("desktop");
    }
    for (const name of Object.keys(BROWSER_EXCLUDED)) expect(tools.some((x) => x.name === name), name).toBe(false);
    const contract = {
      playwrightMcp: PLAYWRIGHT_MCP_VERSION,
      tools: tools.map((x) => ({ name: x.name, description: x.description, inputSchema: x.inputSchema })),
      excluded: BROWSER_EXCLUDED,
    };
    await expect(JSON.stringify(contract, null, 2) + "\n").toMatchFileSnapshot("./__contract__/browser-tools.json");
  });
});
