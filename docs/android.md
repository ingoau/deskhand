# Android emulator on a deskhand desktop: findings

deskhand does not ship Android tools or an Android template. A desktop started with `kvm: true` and more
memory/CPUs (see "Opt-in hardware" in `docs/design.md`) is enough for an agent to install the SDK into its
home directory and run a hardware-accelerated emulator. This page records what a real agent did with no hints.
It is not a recipe to paste anywhere.

## The run (2026-10-21)

- **Task**, verbatim, with nothing else in the prompt: "Set up what you need to run an Android emulator on a deskhand
  desktop, boot it, and report what the emulator's home screen shows; take a screenshot. Leave the emulator running on
  the desktop when you are done (do not stop the desktop)."
- **Agent:** `claude -p` (Claude Code 2.1.306), `--model claude-sonnet-5-5`, only the deskhand MCP tools (`--tools ""`,
  `--strict-mcp-config`, `--allowedTools "mcp__deskhand__*"`), `--max-turns 120`.
- **Host:** 8 cores, 31 GB, VT-x, Docker host `/dev/kvm`. Manager defaults: max 8g / 4 CPUs per desktop.
- **Outcome: success.** 11 turns, **11 min 45 s** wall clock, **$0.16** as reported by the CLI.
- **What it did (11 tool calls):**
  1. `template_list`. Only `base` existed.
  2. `desktop_start(kvm: true, memory: "8g", cpus: 4)`. It went straight to the maximum the description states.
  3. `desktop_exec` to check the environment: no Java, no `unzip`, curl and python3 present, `/dev/kvm` owned by
     `root:agent`, 191 GB free.
  4. Downloaded a Temurin JDK 17 tarball and the SDK command-line tools zip into `~/android`. Unpacked the zip with
     Python's `zipfile` because the image has no `unzip`.
  5. Accepted the licences with `sdkmanager`, then installed `platform-tools`, `emulator` and
     `system-images;android-34;google_apis;x86_64`, and created a Pixel 6 AVD with `avdmanager`.
  6. Started `emulator -avd pix -gpu swiftshader_indirect -no-audio -no-snapshot -no-boot-anim -memory 3072 -cores 3`
     with `nohup … &`. It waited on `adb shell getprop sys.boot_completed`, sent `KEYCODE_HOME` and took a screenshot.
  7. Reported the Pixel launcher on Android 14: clock and date, Gmail, Photos and YouTube, a dock with Phone,
     Messages, Chrome and Gmail, and the Google search bar. It did not save a template, since the task didn't ask for
     one.
- **Checked from the manager afterwards** (`desktop_exec` on the same desktop, and a screenshot):
  - `adb devices` lists `emulator-5554 device`, `sys.boot_completed` is 1, and the release is 14.
  - The top resumed activity is `com.google.android.apps.nexuslauncher/.NexusLauncherActivity`.
  - `emulator -accel-check` reports "KVM (version 12) is installed and usable".
  - Screenshot: [android-emulator.png](android-emulator.png).

## What was hard

- **Long calls went silent.** The SDK install (about 1.5 GB for the system image) ran longer than 300 s inside one
  `desktop_exec`. Claude Code aborts an MCP call that sends nothing for 300 s, so the call was cut off, although
  the install kept running in the desktop. deskhand flagged the next result as "may or may not have happened" and the
  agent polled `pgrep sdkmanager` until it finished. **Fixed after the run:** `desktop_exec` now sends MCP progress
  notifications every 20 s while the command runs, so clients keep waiting up to its timeout (600 s maximum).
- **No `unzip`** in the image. The agent worked around it with Python. Nothing changed in deskhand.
- **`free` shows the host's memory** (31 GB) rather than the desktop's 8 GB cap, because the container has no
  lxcfs. Agents that size the emulator from `free` could over-commit. The cap is in
  `/sys/fs/cgroup/memory.max`, and desktop_start's result states it.
- **Panel launchers hung under Docker's default open-file limit.** This turned up while checking that `/dev/kvm` works
  from panel-started processes, not in the agent run. Fixed in the entrypoint (soft 1024 / hard 524288), see
  design.md.

## Resource guidance

- **Memory:** 8g is comfortable. While idle on the home screen with a 3 GB AVD, the emulator's qemu RSS was about
  4.3 GB. The cgroup's `memory.current` sat at the 8 GiB cap, mostly page cache from the downloads, which the kernel
  reclaims. Below roughly 6g, use a smaller AVD (`-memory 2048`).
- **CPU:** 4 CPUs. With `swiftshader_indirect`, which renders in software because the desktop has no GPU, qemu used
  about 2.3 cores even on the idle home screen.
- **Disk:** about 7 GB in the home directory: `~/android` 5.9 GB (SDK, JDK, downloads) and `~/.android` 1.2 GB (AVD).
  It lives in the container's writable layer, so make sure the Docker host has the space. A template made from such a
  desktop is a large image.
- **Time:** the first setup took about 10 minutes, mostly downloads. Boot with KVM took under a minute. Save the
  desktop with `template_save` (it records `kvm`/memory/CPUs) so later agents skip the setup.
- **Without KVM** the emulator has no hardware acceleration and x86_64 system images are far too slow to
  be useful. That is why `kvm_unavailable` is an explicit error and not a silent downgrade.

## Reliability suite

`suite/tasks/android-emulator.json` is this task with checks. It is marked slow and expensive: it downloads several
GB and runs on demand only.
