/**
 * Everything the manager needs from the container engine. DockerRuntime is the real one;
 * FakeRuntime runs in-process fake daemons for tests and dashboard development.
 */
export interface DesktopSpec {
  id: string;
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  memoryBytes: number;
  cpus: number;
  /** Host path (already resolved) -> container path. */
  binds: Array<{ source: string; target: string; write: boolean }>;
}

export interface ContainerInfo {
  containerId: string;
  name: string;
  running: boolean;
  /** created | running | exited | paused | restarting | dead ... */
  state: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  /** Base URL of the daemon, when running. */
  daemonUrl: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  image: string;
  binds: Array<{ source: string; target: string; write: boolean }>;
}

export interface ContainerStats {
  /** Percent of one core (docker convention; can exceed 100). */
  cpuPercent: number;
  /** Percent of all host cores. */
  hostCpuPercent: number;
  memoryBytes: number;
}

export interface PathResolution {
  input: string;
  /** Fully resolved path through symlinks (as seen on the Docker host). */
  resolved: string;
  exists: boolean;
  type: "dir" | "file" | "socket" | "other" | "missing";
  error?: string;
}

export interface HostInfo {
  memTotalBytes: number;
  ncpu: number;
}

export interface Runtime {
  readonly kind: "docker" | "fake";
  /** Throws docker_unavailable when the engine cannot be reached. */
  ping(): Promise<void>;
  hostInfo(): Promise<HostInfo>;
  ensureNetwork(): Promise<void>;
  /** Pulls the image if it is not present (image_pull_failed on failure). */
  ensureImage(image: string): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  createDesktop(spec: DesktopSpec): Promise<string>;
  start(containerId: string): Promise<void>;
  stop(containerId: string, timeoutSec?: number): Promise<void>;
  restart(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
  inspect(containerId: string): Promise<ContainerInfo | null>;
  /** All desktop containers owned by this manager instance. */
  listDesktops(): Promise<ContainerInfo[]>;
  stats(containerId: string): Promise<ContainerStats | null>;
  /** Writable-layer size per container id. */
  diskUsage(): Promise<Map<string, number>>;
  commit(containerId: string, opts: { repo: string; tag: string; labels: Record<string, string>; env: string[] }): Promise<{ image: string; sizeBytes: number | null }>;
  removeImage(image: string): Promise<void>;
  /** Resolves host paths through symlinks, as the Docker host sees them. */
  resolveHostPaths(paths: string[]): Promise<PathResolution[]>;
  readHostFile(resolvedPath: string, maxBytes: number): Promise<Buffer>;
  writeHostFile(resolvedPath: string, data: Buffer, uid: number, gid: number): Promise<void>;
  close(): Promise<void>;
}
