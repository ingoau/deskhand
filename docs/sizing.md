# Sizing desktops

Measured 2026-10-22 (phase 2) on the development host: 8 cores, 31 GiB RAM, Debian 13, Docker 26.1, amd64.
Each desktop used the default caps (2 GiB memory, 1.5 CPUs) and the 1280×800 screen, with Chromium's sandbox on.
Reproduce with `suite/measure-resources.py`. It drives Chromium with `docker exec` and samples `docker stats`
(memory without page cache, the same figure the manager reports). It makes no model calls. Other agents were using
the host at the same time (load average about 1.6), so treat CPU numbers as ±5 points.

## Measurements

Numbers are per desktop. "One desktop" is a single desktop running. "Two at once" is two desktops doing the same
steps in parallel.

| State | Memory (one / two at once) | CPU, % of one core (mean, peak) |
| --- | --- | --- |
| Idle: Xvfb, openbox, tint2, x11vnc, AT-SPI, daemon | **103 / 102 MiB** | 0.3–1.4, peak 6 |
| Chromium loading Wikipedia (first launch) | 316–340 MiB | 22–46, **peak 144–150 (at the cap)** |
| Chromium, one busy tab, nothing happening | **318 MiB** | 1.3, peak 6 |
| + news.ycombinator.com tab loading | 335–344 MiB | 10, peak 65–69 |
| + bbc.com/news tab loading (photos, ads) | 482–580 MiB | 80–134, peak 152–158 (at the cap) |
| + github.com/microsoft/playwright tab loading | 650–727 MiB | 46–65, peak 136–148 |
| Chromium, four busy tabs, nothing happening | **594–676 MiB** | 3–14, peak 15–32 |
| Scrolling the active tab (PageDown every 0.4 s) | 603–649 MiB | 10–26, peak 20–35 |

Other figures:

| What | Value |
| --- | --- |
| Desktop start (`POST /api/desktops` until running, daemon healthy and panel up) | 3.2 s (3 runs: 3175, 3212, 3177 ms); image already pulled |
| Writable layer after the four-tab session (Chromium profile and cache) | 54 MB per desktop; the image (1.72 GB virtual) is shared |
| Manager container (`deskhand`) idle, after about 40 desktops in a day | 199 MiB, 0 % CPU |
| Images | `deskhand` 343 MB, `deskhand-desktop` 1.67 GB (amd64, uncompressed) |

## What this means

- **Idle desktops cost about 100 MB and no CPU.** That matches the plan's estimate. Twenty idle desktops fit in
  2 GB.
- **A browsing desktop costs 0.3–0.7 GB** with one to four ordinary tabs. Heavy web apps (Google Docs, Figma, many
  tabs) can approach the 2 GiB cap. Chromium's `/dev/shm` (up to 1 GiB) counts toward the same memory limit.
- **Page loads are short CPU bursts that hit the 1.5-CPU cap.** Between loads, CPU is near zero. While an agent
  works, its desktop is idle most of the time: the agent spends seconds thinking between actions, and every action
  waits for the screen to settle. A page load takes 1–3 s at the cap, and an agent loads a page every few actions.
  So an actively browsing desktop averages about 0.2–0.4 of a core, not the plan's "up to 1 core" sustained.
- **CPU is the limit when many desktops load pages at the same moment.** Memory is the limit only for heavy tabs.
  On 8 cores, five desktops can burst at the 1.5 cap at once before they slow each other down. Bursts rarely line
  up, so 8 desktops browsing actively feel responsive.

## Guidance

| Host | Actively browsing desktops | Settings |
| --- | --- | --- |
| 4 cores, 8 GB | 2–3 | `DESKHAND_MAX_DESKTOPS=3`. The default memory budget (80 % = 6.4 GB) already admits 3 × 2 GiB. |
| 8 cores, 16 GB | 4–6 | Defaults admit 6. `DESKHAND_DESKTOP_MEMORY=1.5g` gives 8 if tabs stay light. |
| 8 cores, 32 GB (plan's reference) | 6–10 | Defaults (8 desktops). The memory budget would admit 12. |
| 16+ cores, 64 GB | 12–20 | Raise `DESKHAND_MAX_DESKTOPS`; the budget admits about 25 at 2 GiB. |

- Admission counts the **memory cap** of every running desktop against `DESKHAND_MEMORY_BUDGET`, not what each
  desktop actually uses. A smaller cap admits more desktops, but a heavy tab can then hit the container's
  memory limit and be killed by the kernel. Lower the cap only for light browsing.
- Idle desktops are stopped after `DESKHAND_IDLE_TIMEOUT` (30m) and free their memory. Stopped desktops do not count
  against admission.
- Raising `DESKHAND_DESKTOP_CPUS` makes page loads finish faster. It is worth doing on hosts with spare cores.
  Lowering it below 1 makes every page load and screenshot settle noticeably slower.
- The manager itself needs about 200 MB.
- Disk: one desktop image (1.7 GB) plus about 50–100 MB of writable layer per browsing desktop, plus template images
  (shared layers) and action-log screenshots (`DESKHAND_LOG_RETENTION`).

## Defaults

The plan's defaults hold and are unchanged: 2 GiB memory and 1.5 CPUs per desktop, 8 running desktops, and a memory
budget of 80 % of host memory. The plan's per-state estimates were close. Idle is 100 MB (as estimated). Browsing
is 0.3–0.7 GB for ordinary pages (the plan estimated 0.5–1.5 GB, so the upper end is for heavy apps). CPU is short
bursts at the cap rather than about one core sustained.
