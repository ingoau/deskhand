import { describe, expect, it } from "vitest";
import { ago, formatAge, formatBytes, formatDuration, formatUptime, screenLabel, since, truncate, until } from "./format";

const S = 1000;
const M = 60 * S;
const H = 60 * M;

describe("formatUptime", () => {
  it.each([
    [0, "0:00"],
    [4 * S, "0:04"],
    [59 * S, "0:59"],
    [60 * S, "1m"],
    [18 * M + 40 * S, "18m"],
    [59 * M, "59m"],
    [H, "1h00m"],
    [H + 5 * M, "1h05m"],
    [2 * H + 10 * M, "2h10m"],
    [23 * H + 59 * M, "23h59m"],
    [26 * H, "1d02h"],
  ])("%d ms -> %s", (ms, out) => expect(formatUptime(ms)).toBe(out));

  it("clamps negative and NaN to zero", () => {
    expect(formatUptime(-5000)).toBe("0:00");
    expect(formatUptime(Number.NaN)).toBe("0:00");
  });
});

describe("ages", () => {
  it("formats short ages", () => {
    expect(formatAge(2 * S)).toBe("now");
    expect(formatAge(12 * S)).toBe("12s");
    expect(formatAge(2 * M + 30 * S)).toBe("2m");
    expect(formatAge(3 * H)).toBe("3h");
    expect(formatAge(2 * 24 * H)).toBe("2d");
    expect(formatAge(30 * 24 * H)).toBe("4w");
  });
  it("since/ago/until relative to now", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(since("2026-10-21T11:58:00Z", now)).toBe("2m");
    expect(since(null, now)).toBe("—");
    expect(ago("2026-10-21T11:59:58Z", now)).toBe("just now");
    expect(ago("2026-10-18T12:00:00Z", now)).toBe("3d ago");
    expect(ago(null, now)).toBe("never");
    expect(until("2026-10-21T12:08:00Z", now)).toBe("8m");
    expect(until("2026-10-21T12:07:30.5Z", now)).toBe("8m");
    expect(until("2026-10-21T12:00:20Z", now)).toBe("20s");
    expect(until("2026-10-21T11:00:00Z", now)).toBeNull();
    expect(until(null, now)).toBeNull();
  });
});

describe("formatBytes", () => {
  it.each([
    [512, "512B"],
    [40 * 1024, "40K"],
    [820 * 1024 ** 2, "820M"],
    [9.8 * 1024 ** 3, "9.8G"],
    [1.3 * 1024 ** 3, "1.3G"],
    [2 * 1024 ** 3, "2G"],
    [12.4 * 1024 ** 3, "12G"],
  ])("%d -> %s", (n, out) => expect(formatBytes(n)).toBe(out));
  it("handles missing values", () => expect(formatBytes(null)).toBe("—"));
});

describe("misc", () => {
  it("durations", () => {
    expect(formatDuration(340)).toBe("340ms");
    expect(formatDuration(1180)).toBe("1.2s");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(125_000)).toBe("2m05s");
    expect(formatDuration(null)).toBe("");
  });
  it("screen label and truncate", () => {
    expect(screenLabel({ width: 1280, height: 800 })).toBe("1280×800");
    expect(truncate("request_human", 8)).toBe("request…");
    expect(truncate("short", 8)).toBe("short");
  });
});
