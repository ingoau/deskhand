import type { TemplateDescription, TemplateVersion } from "@deskhand/shared";

export interface ListDiff {
  added: string[];
  removed: string[];
}

export interface FieldChange {
  field: keyof TemplateDescription;
  before: string;
  after: string;
}

export interface VersionDiff {
  /** True for the first version (nothing to compare with). */
  initial: boolean;
  description: FieldChange[];
  loggedInSites: ListDiff;
  extensions: ListDiff;
  packages: ListDiff;
  baseChanged: { before: string; after: string } | null;
  recipeChanged: { before: boolean; after: boolean } | null;
}

export function diffList(before: readonly string[], after: readonly string[]): ListDiff {
  const b = new Set(before);
  const a = new Set(after);
  return { added: [...a].filter((x) => !b.has(x)).sort(), removed: [...b].filter((x) => !a.has(x)).sort() };
}

const FIELDS: (keyof TemplateDescription)[] = ["summary", "use_when", "not_for", "setup_notes", "tags"];

function fieldText(d: TemplateDescription, f: keyof TemplateDescription): string {
  const v = d[f];
  if (Array.isArray(v)) return v.join(", ");
  return (v ?? "").trim();
}

export function diffDescription(before: TemplateDescription, after: TemplateDescription): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of FIELDS) {
    const b = fieldText(before, field);
    const a = fieldText(after, field);
    if (b !== a) out.push({ field, before: b, after: a });
  }
  return out;
}

/** What changed from `prev` to `next`; `prev` undefined means `next` is the first version. */
export function diffVersions(prev: TemplateVersion | undefined, next: TemplateVersion): VersionDiff {
  if (!prev) {
    return {
      initial: true,
      description: [],
      loggedInSites: { added: [...next.loggedInSites].sort(), removed: [] },
      extensions: { added: [...next.extensions].sort(), removed: [] },
      packages: { added: [...next.packages].sort(), removed: [] },
      baseChanged: null,
      recipeChanged: null,
    };
  }
  return {
    initial: false,
    description: diffDescription(prev.description, next.description),
    loggedInSites: diffList(prev.loggedInSites, next.loggedInSites),
    extensions: diffList(prev.extensions, next.extensions),
    packages: diffList(prev.packages, next.packages),
    baseChanged: prev.baseVersion !== next.baseVersion ? { before: prev.baseVersion, after: next.baseVersion } : null,
    recipeChanged: prev.hasRecipe !== next.hasRecipe ? { before: prev.hasRecipe, after: next.hasRecipe } : null,
  };
}

export function isEmptyDiff(d: VersionDiff): boolean {
  const lists = [d.loggedInSites, d.extensions, d.packages];
  return !d.description.length && lists.every((l) => !l.added.length && !l.removed.length) && !d.baseChanged && !d.recipeChanged;
}

const asText = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v).trim());

/**
 * The manager's own per-version diff (phase 4, `TemplateVersion.changes`, against the previous *kept* version) in
 * the shape the page renders. `prev` is only used for the base versions' labels.
 */
export function fromServerChanges(next: TemplateVersion, prev: TemplateVersion | undefined): VersionDiff | null {
  const c = next.changes;
  if (!c) return null;
  if (c.from == null) return { ...diffVersions(undefined, next) };
  return {
    initial: false,
    description: c.description
      .map((d) => ({ field: d.field as keyof TemplateDescription, before: asText(d.before), after: asText(d.after) }))
      .filter((d) => d.before !== d.after),
    loggedInSites: { added: [...c.loggedInSites.added].sort(), removed: [...c.loggedInSites.removed].sort() },
    extensions: { added: [...c.extensions.added].sort(), removed: [...c.extensions.removed].sort() },
    packages: { added: [...c.packages.added].sort(), removed: [...c.packages.removed].sort() },
    baseChanged: c.baseChanged ? { before: prev?.baseVersion ?? "previous", after: next.baseVersion } : null,
    recipeChanged: c.recipeChanged ? { before: prev?.hasRecipe ?? !next.hasRecipe, after: next.hasRecipe } : null,
  };
}

/** Pair each version (newest first) with its diff against the previous version (the manager's diff when it sends one). */
export function versionHistory(versions: readonly TemplateVersion[]): { version: TemplateVersion; diff: VersionDiff }[] {
  const asc = [...versions].sort((a, b) => a.version - b.version);
  return asc
    .map((v, i) => {
      const prev = v.changes?.from != null ? (asc.find((x) => x.version === v.changes!.from) ?? asc[i - 1]) : asc[i - 1];
      return { version: v, diff: fromServerChanges(v, prev) ?? diffVersions(asc[i - 1], v) };
    })
    .reverse();
}
