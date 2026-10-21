/**
 * Every failure deskhand reports carries one of these codes, a message written
 * for the agent, and the next step to take. Never a raw stack trace.
 */
export const ERROR_CODES = [
  "docker_unavailable",
  "limit_reached",
  "disk_full",
  "image_pull_failed",
  "mount_refused",
  "locked_by_user",
  "control_changed",
  "outcome_unknown",
  "desktop_not_found",
  "template_not_found",
  "invalid_argument",
  "timeout",
  "daemon_unavailable",
  "version_mismatch",
  "unauthorized",
  "forbidden",
  "internal",
  "desktop_stopped",
  "not_found",
  "kvm_unavailable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Default agent-facing messages. Callers may pass a more specific one. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  docker_unavailable: "Docker isn't running on the deskhand host; ask the user to start it.",
  limit_reached: "Desktop limit reached. Stop one with `desktop_stop` or wait.",
  disk_full: "The deskhand host is out of disk space; ask the user to free space or prune old templates.",
  image_pull_failed: "The desktop image could not be downloaded; check the network or ask the user.",
  mount_refused: "That path is blocked by deskhand's mount rules; choose another path or ask the user.",
  locked_by_user: "The user is controlling this desktop; wait and try again.",
  control_changed: "Control of this desktop changed while the action was queued, so it was not performed. Take a screenshot and decide again.",
  outcome_unknown: "The previous action may or may not have happened (it timed out or its connection dropped). Check the screenshot before continuing; it was not retried.",
  desktop_not_found: "No such desktop in this session. Call `desktop_list` to see your desktops or `desktop_start` to create one.",
  template_not_found: "No template with that name. Call `template_list` to see the available templates.",
  invalid_argument: "An argument was invalid; check the tool's parameters and try again.",
  timeout: "The action did not finish before its deadline; take a screenshot to check the desktop's state.",
  daemon_unavailable: "The desktop is not responding; deskhand is restarting it. Try again in a few seconds.",
  version_mismatch: "The desktop image and the deskhand manager are different versions; ask the user to update deskhand.",
  unauthorized: "Missing or invalid deskhand credentials.",
  forbidden: "This request is not allowed.",
  internal: "deskhand hit an internal error; try again, and ask the user to check the deskhand logs if it repeats.",
  desktop_stopped: "That desktop is stopped. Start it again (any tool call on it restarts it) and retry.",
  not_found: "Not found.",
  kvm_unavailable:
    "KVM is not available to desktops on this deskhand host (the Docker host has no /dev/kvm, or KVM is turned off with DESKHAND_KVM=off). Start the desktop without kvm, or ask the user to enable it.",
};

/** HTTP status used when an error crosses an HTTP boundary. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  docker_unavailable: 503,
  limit_reached: 429,
  disk_full: 507,
  image_pull_failed: 502,
  mount_refused: 403,
  locked_by_user: 423,
  control_changed: 409,
  outcome_unknown: 504,
  desktop_not_found: 404,
  template_not_found: 404,
  invalid_argument: 400,
  timeout: 504,
  daemon_unavailable: 503,
  version_mismatch: 409,
  unauthorized: 401,
  forbidden: 403,
  internal: 500,
  desktop_stopped: 409,
  not_found: 404,
  kvm_unavailable: 409,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export class DeskhandError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "DeskhandError";
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
  toJSON(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }
  static fromBody(body: unknown): DeskhandError | undefined {
    const e = (body as ErrorBody | undefined)?.error;
    if (e && typeof e.code === "string" && (ERROR_CODES as readonly string[]).includes(e.code)) {
      return new DeskhandError(e.code as ErrorCode, e.message, e.details);
    }
    return undefined;
  }
}
