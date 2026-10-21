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

/** Pair each version (newest first) with its diff against the previous version number. */
export function versionHistory(versions: readonly TemplateVersion[]): { version: TemplateVersion; diff: VersionDiff }[] {
  const asc = [...versions].sort((a, b) => a.version - b.version);
  return asc.map((v, i) => ({ version: v, diff: diffVersions(asc[i - 1], v) })).reverse();
}
