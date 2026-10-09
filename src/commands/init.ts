// sich init: .sich/, the exclude blocks and the commit guard hooks of base and every layer.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { excludeTargets, isInitialized, layerNames, layerRepo, type Ctx } from "../context";
import { applyExclude, describeExclude } from "../excludes";
import { git, type Repo } from "../git";
import { parseArgs } from "../args";
import { c, fail, out } from "../ui";

const HOOK_HEADER = "# Installed by sich:";

/**
 * The hooks that guard a repo: git runs pre-commit for a commit, and
 * pre-merge-commit instead for a merge commit made without conflicts
 * (`git merge`, `git pull` without --rebase, unless they fast-forward). A merge
 * that stops on conflicts is finished with `git commit`, which runs pre-commit.
 * Fast-forwards, rebase and cherry-pick run neither; plain `sich check` catches
 * what they bring in. `op` is the git command the "skip once" hint names, and
 * `check` the arguments the hook runs sich with: --merge makes a blocked merge
 * print how to back out instead of commit hints (MERGE_HEAD doesn't exist yet
 * while pre-merge-commit runs).
 */
const GUARD_HOOKS = {
  "pre-commit": { op: "commit", check: "check --staged" },
  "pre-merge-commit": { op: "merge", check: "check --staged --merge" },
} as const;
type GuardHook = keyof typeof GUARD_HOOKS;
const HOOK_NAMES = Object.keys(GUARD_HOOKS) as GuardHook[];

/**
 * For hooks sich doesn't own, in base or any layer: `check --staged` works out
 * which repo is committing, so the same line also works in a shared
 * core.hooksPath. Fails closed: if `$SICH_BIN`/`sich` is missing it exits 127,
 * blocking the commit.
 */
function hookLine(hook: GuardHook): string {
  return `"\${SICH_BIN:-sich}" ${GUARD_HOOKS[hook].check} || exit 1`;
}

/** Matches hookLine(), the hooks sich writes, and a plain `sich check --staged` the user wired in. */
const HOOK_MARKER = /sich\S*\s+check --staged/;

/**
 * The guard hooks of base or a layer. SICH_BIN overrides which sich they run
 * (default: `sich` on PATH). If it can't be found the hook blocks the commit
 * rather than skipping the check. The hooks differ only in their comments,
 * messages and pre-merge-commit's --merge: the header marks a hook sich wrote
 * for that repo (and may refresh).
 */
interface HookSpec {
  header: string;
  body: (hook: GuardHook) => string;
}

const BASE_HOOK: HookSpec = {
  header: HOOK_HEADER,
  body: (hook) =>
    hookBody(`${HOOK_HEADER} stop private (layer-claimed) files from being committed to base.`, hook, "git"),
};

function layerHook(layer: string): HookSpec {
  const header = `# Installed by sich for layer ${layer}:`;
  return {
    header,
    body: (hook) => hookBody(`${header} stop files ${layer} doesn't own from being committed to it.`, hook, `sich ${layer}`),
  };
}

/** `run` is how to run git in the repo, for the "skip once" hint (`git`, `sich <layer>`). */
function hookBody(header: string, hook: GuardHook, run: string): string {
  const { op, check } = GUARD_HOOKS[hook];
  return `#!/bin/sh
${header}
sich="\${SICH_BIN:-sich}"
if ! command -v "$sich" >/dev/null 2>&1; then
  echo "sich: ${op} blocked: '$sich' not found; put sich on PATH or set SICH_BIN (skip once: ${run} ${op} --no-verify)" >&2
  exit 1
fi
exec "$sich" ${check}
`;
}

/** The guard hooks git runs for `repo` (core.hooksPath respected), with their paths relative to the root. */
function hookFiles(ctx: Ctx, repo: Repo): { name: GuardHook; hook: string; shown: string }[] {
  const hooksDir = resolve(ctx.root, git(repo, ["rev-parse", "--git-path", "hooks"]).stdout.trim());
  return HOOK_NAMES.map((name) => {
    const hook = join(hooksDir, name);
    return { name, hook, shown: relative(ctx.root, hook) || hook };
  });
}

/** For `sich check`: the guard hooks of `repo` that don't run sich's guard. */
export function unguarded(ctx: Ctx, repo: Repo): { names: string[]; files: string[] } {
  const names: string[] = [];
  const files: string[] = [];
  for (const { name, hook, shown } of hookFiles(ctx, repo)) {
    if (existsSync(hook) && HOOK_MARKER.test(readFileSync(hook, "utf8"))) continue;
    names.push(name);
    files.push(shown);
  }
  return { names, files };
}

/** "pre-commit hook", "pre-commit and pre-merge-commit hooks". */
export function hooksNamed(names: string[]): string {
  return `${names.join(" and ")} hook${names.length > 1 ? "s" : ""}`;
}

/**
 * Idempotent setup. Used by `sich init` and implicitly by `new`/`attach`.
 * Prints only what it changed (plus hook instructions when it can't install).
 */
export function ensureInit(ctx: Ctx): void {
  const fresh = !isInitialized(ctx);
  if (fresh) {
    mkdirSync(ctx.sichDir, { recursive: true });
    out(`created ${c.bold(".sich/")} (holds every layer's git data and claims list)`);
  }
  for (const t of excludeTargets(ctx)) {
    if (applyExclude(t, true)) out(describeExclude(t));
  }
  installHooks(ctx, ctx.base, BASE_HOOK);
  for (const layer of layerNames(ctx)) installLayerHooks(ctx, layer);
}

/** Install or refresh the guard hooks of one layer (`new`/`attach` call it once the layer exists). */
export function installLayerHooks(ctx: Ctx, layer: string): void {
  installHooks(ctx, layerRepo(ctx, layer), layerHook(layer));
}

/** Install or refresh every guard hook of `repo`; hooks sich didn't write are left alone. */
function installHooks(ctx: Ctx, repo: Repo, spec: HookSpec): void {
  const hooksPath = git(repo, ["config", "--get", "core.hooksPath"], { allowFail: true }).stdout.trim();
  const of = repo.name === "base" ? "" : ` of ${repo.name}`;
  for (const { name, hook, shown } of hookFiles(ctx, repo)) {
    const body = spec.body(name);
    if (existsSync(hook)) {
      const current = readFileSync(hook, "utf8");
      if (current.includes(spec.header)) {
        // Ours: bring hooks written by older sich versions up to date.
        if (current !== body) {
          writeFileSync(hook, body);
          chmodSync(hook, 0o755);
          out(`updated ${name} hook${of} -> ${shown}`);
        }
        continue;
      }
      if (HOOK_MARKER.test(current)) continue; // the user wired sich into their own hook
      out(`${c.yellow(`${name} hook${of} exists`)} (${shown}); add this line to it:`);
      out(`  ${hookLine(name)}`);
      continue;
    }
    // A hooks directory the user manages (possibly shared): ask rather than write into it.
    if (hooksPath) {
      out(`${c.yellow(`core.hooksPath${of} is set`)} (${hooksPath}); add this line to its ${name} hook:`);
      out(`  ${hookLine(name)}`);
      continue;
    }
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, body);
    chmodSync(hook, 0o755);
    out(`installed ${name} hook${of} -> ${shown}`);
  }
}

export function cmdInit(ctx: Ctx, args: string[]): number {
  if (parseArgs(args, {}).positionals.length) fail("usage: sich init");
  const already = isInitialized(ctx);
  ensureInit(ctx);
  out(already ? `sich already initialized in ${ctx.root}` : `${c.green("initialized")} sich in ${ctx.root}`);
  return 0;
}
