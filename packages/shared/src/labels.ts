/** Docker labels on every container and image deskhand creates. */
export const LABEL_OWNER = "owner";
export const OWNER_VALUE = "deskhand";
export const LABELS = {
  owner: "owner",
  id: "deskhand.id",
  session: "deskhand.session",
  title: "deskhand.title",
  template: "deskhand.template",
  templateVersion: "deskhand.template-version",
  created: "deskhand.created",
  persistent: "deskhand.persistent",
  kind: "deskhand.kind", // "desktop" | "template" | "helper"
  /** Optional: scopes a manager instance's resources (tests run several managers side by side). */
  instance: "deskhand.instance",
} as const;
