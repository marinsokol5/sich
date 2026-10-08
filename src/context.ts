// Locating the base repo, enumerating layers, and keeping the generated excludes in sync.

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readManifest, type Claim } from "./claims";
import { applyExclude, baseExcludeLines, layerExcludeLines, type ExcludeTarget } from "./excludes";
import { git, gitPlain, type Repo } from "./git";
import { fail } from "./ui";

export interface Ctx {
  /** Effective working directory (after -C), real path. */
  cwd: string;
  /** Top level of the base repo. */
  root: string;
  base: Repo;
  sichDir: string;
}

export const COMMANDS = [
  "init",
  "new",
  "attach",
  "add",
  "rm",
  "which",
  "ls",
  "status",
  "commit",
  "pull",
  "push",
  "sync",
  "check",
  "help",
] as const;

const LAYER_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function validateLayerName(name: string): void {
  if (name === "base" || (COMMANDS as readonly string[]).includes(name)) {
    fail(`'${name}' is reserved and cannot be a layer name`);
  }
  if (!LAYER_NAME.test(name)) {
    fail(`invalid layer name '${name}' (use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit)`);
  }
  if (name.endsWith(".paths") || name.endsWith(".lock")) fail(`invalid layer name '${name}'`);
}

export function loadCtx(cwd: string): Ctx {
  let dir = cwd;
  while (!existsSync(join(dir, ".git"))) {
    const up = dirname(dir);
    if (up === dir) fail("not inside a git repository (sich needs a base repo: run git init first)");
    dir = up;
  }
  const r = gitPlain(["rev-parse", "--absolute-git-dir"], dir);
  if (r.code !== 0) fail(`cannot read the git repository at ${dir}: ${r.stderr.trim()}`);
  const root = dir;
  return {
    cwd,
    root,
    base: { name: "base", gitDir: r.stdout.trim(), workTree: root },
    sichDir: join(root, ".sich"),
  };
}

export function isInitialized(ctx: Ctx): boolean {
  return existsSync(ctx.sichDir);
}

export function requireInit(ctx: Ctx): void {
  if (!isInitialized(ctx)) fail(`sich is not initialized in ${ctx.root} (run: sich init)`);
}

export function layerRepo(ctx: Ctx, name: string): Repo {
  return { name, gitDir: join(ctx.sichDir, name), workTree: ctx.root };
}

export function manifestPath(ctx: Ctx, layer: string): string {
  return join(ctx.sichDir, `${layer}.paths`);
}

/** Root-relative manifest path (as tracked by the layer). */
export function manifestRel(layer: string): string {
  return `.sich/${layer}.paths`;
}

export function layerNames(ctx: Ctx): string[] {
  if (!existsSync(ctx.sichDir)) return [];
  return readdirSync(ctx.sichDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && LAYER_NAME.test(e.name) && existsSync(join(ctx.sichDir, e.name, "HEAD")))
    .map((e) => e.name)
    .sort();
}

export function layerExists(ctx: Ctx, name: string): boolean {
  return layerNames(ctx).includes(name);
}

export function requireLayer(ctx: Ctx, name: string | undefined): Repo {
  if (!name) fail("missing layer name");
  if (name === "base") fail("'base' is the public repo, not a layer");
  if (!layerExists(ctx, name)) fail(`no such layer '${name}' (layers: ${layerNames(ctx).join(", ") || "none"})`);
  return layerRepo(ctx, name);
}

/** "base" or a layer. */
export function repoByName(ctx: Ctx, name: string): Repo {
  if (name === "base") return ctx.base;
  return requireLayer(ctx, name);
}

export function allClaims(ctx: Ctx): Map<string, Claim[]> {
  const m = new Map<string, Claim[]>();
  for (const l of layerNames(ctx)) m.set(l, readManifest(manifestPath(ctx, l), l).claims);
  return m;
}

export function excludeTargets(ctx: Ctx): ExcludeTarget[] {
  const claims = allClaims(ctx);
  const everything = [...claims.values()].flat();
  const targets: ExcludeTarget[] = [{ repo: ctx.base, lines: baseExcludeLines(everything) }];
  for (const [layer, own] of claims) {
    const others = [...claims].filter(([l]) => l !== layer).flatMap(([, cs]) => cs);
    targets.push({ repo: layerRepo(ctx, layer), lines: layerExcludeLines(layer, own, others) });
  }
  return targets;
}

/** Regenerate every managed exclude block (no-op when sich isn't initialized). */
export function syncExcludes(ctx: Ctx): void {
  if (!isInitialized(ctx)) return;
  for (const t of excludeTargets(ctx)) applyExclude(t, true);
}

export interface UserPath {
  /** Root-relative POSIX path, no trailing slash. */
  rel: string;
  exists: boolean;
  isDir: boolean;
}

/** True if the base repo matches paths case-insensitively (core.ignorecase, the macOS default). */
export function ignoresCase(ctx: Ctx): boolean {
  const r = git(ctx.base, ["config", "--type=bool", "--get", "core.ignorecase"], { allowFail: true });
  return r.stdout.trim() === "true";
}

/**
 * `name` as spelled on disk in `dir`. Differs from `name` only on case-insensitive
 * filesystems, where `docs` may find `Docs`; git would stage nothing for the
 * mistyped spelling, and claims must match what git reports.
 */
function onDiskName(dir: string, name: string): string {
  try {
    lstatSync(join(dir, name));
    const entries = readdirSync(dir);
    if (entries.includes(name)) return name;
    return entries.find((e) => e.toLowerCase() === name.toLowerCase()) ?? name;
  } catch {
    return name;
  }
}

/**
 * Real path of `abs`, resolving symlinks in its parents but not the final
 * component. Spelling follows the disk (native realpath fixes case on macOS).
 */
function realParent(abs: string): string {
  const parent = dirname(abs);
  if (parent === abs) return abs;
  let real: string;
  try {
    real = realpathSync.native(parent);
  } catch {
    real = realParent(parent);
  }
  return join(real, onDiskName(real, basename(abs)));
}

/** Resolve a path given on the command line (relative to cwd) to a root-relative path. */
export function resolveUserPath(ctx: Ctx, input: string, opts: { allowSich?: boolean } = {}): UserPath {
  const abs = realParent(resolve(ctx.cwd, input));
  const rel = relative(ctx.root, abs);
  if (rel === "") fail(`'${input}' is the repository root`);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) fail(`'${input}' is outside the repository`);
  const posix = rel.split(sep).join("/");
  const first = posix.split("/")[0];
  if (first === ".git" || (first === ".sich" && !opts.allowSich)) fail(`'${input}' is inside ${first}/`);
  let exists = false;
  let isDir = false;
  try {
    const st = lstatSync(abs);
    exists = true;
    isDir = st.isDirectory();
  } catch {
    /* missing */
  }
  return { rel: posix, exists, isDir };
}

/**
 * Root-relative paths that already exist on disk, plus existing non-directories
 * standing where one of their parent directories would go. Checking these out
 * would clobber them: git treats ignored files (every other repo's) as expendable.
 */
export function collisions(ctx: Ctx, paths: string[]): string[] {
  const hits = new Set<string>();
  const kind = (rel: string) => {
    try {
      return lstatSync(join(ctx.root, rel)).isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  };
  for (const p of paths) {
    if (kind(p)) hits.add(p);
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join("/");
      if (kind(parent) === "file") hits.add(parent);
    }
  }
  return [...hits].sort();
}
