import path from "node:path";

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\.?\//, "").replace(/\/+$/, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

export function normalizeRelativePath(input: string, workspaceRoot?: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Path cannot be empty.");
  }

  const absolute = workspaceRoot && path.isAbsolute(raw)
    ? path.resolve(raw)
    : null;
  const relative = absolute && workspaceRoot
    ? path.relative(workspaceRoot, absolute)
    : raw;

  return trimSlashes(toPosix(relative));
}

export function getPatternBasePath(pattern: string): string {
  const normalized = normalizeRelativePath(pattern);
  const wildcardIndex = normalized.search(/[*?[]/);
  const base = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  return trimSlashes(base);
}

export function pathMatchesPattern(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizeRelativePath(filePath);
  const normalizedPattern = normalizeRelativePath(pattern);

  if (
    normalizedFile === normalizedPattern ||
    normalizedFile.startsWith(`${normalizedPattern}/`)
  ) {
    return true;
  }

  const regexSource = `^${escapeRegex(normalizedPattern)
    .replaceAll("\\*\\*", ".*")
    .replaceAll("\\*", "[^/]*")}$`;

  return new RegExp(regexSource).test(normalizedFile);
}

function isSameOrParent(parent: string, child: string): boolean {
  if (!parent || !child) {
    return false;
  }

  return parent === child || child.startsWith(`${parent}/`);
}

export function patternsOverlap(a: string, b: string): boolean {
  const left = normalizeRelativePath(a);
  const right = normalizeRelativePath(b);

  if (left === right) {
    return true;
  }

  const leftBase = getPatternBasePath(left);
  const rightBase = getPatternBasePath(right);

  if (!leftBase || !rightBase) {
    return true;
  }

  if (isSameOrParent(leftBase, rightBase) || isSameOrParent(rightBase, leftBase)) {
    return true;
  }

  return pathMatchesPattern(leftBase, right) || pathMatchesPattern(rightBase, left);
}
