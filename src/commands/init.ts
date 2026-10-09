// sich init: .sich/, the exclude blocks and the pre-commit hooks of base and every layer.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { excludeTargets, isInitialized, layerNames, layerRepo, type Ctx } from "../context";
import { applyExclude, describeExclude } from "../excludes";
import { git, type Repo } from "../git";
import { parseArgs } from "../args";
import { c, fail, out } from "../ui";

const HOOK_HEADER = "# Installed by sich:";

/**
 * For hooks sich doesn't own, in base or any layer: `check --staged` works out
 * which repo is committing, so the same line also works in a shared
 * core.hooksPath. Fails closed: if `$SICH_BIN`/`sich` is missing it exits 127,
 * blocking the commit.
 */
export const HOOK_LINE = '"${SICH_BIN:-sich}" check --staged || exit 1';

/** Matches HOOK_LINE, the hooks sich writes, and a plain `sich check --staged` the user wired in. */
const HOOK_MARKER = /sich\S*\s+check --staged/;

/**
 * The pre-commit hook of base or a layer. SICH_BIN overrides which sich the hook
 * runs (default: `sich` on PATH). If it can't be found the hook blocks the commit
 * rather than skipping the check. The hooks differ only in their comments: each
 * marks the hook sich wrote for that repo (and may refresh).
 */
interface HookSpec {
  header: string;
  body: string;
}

const BASE_HOOK: HookSpec = {
  header: HOOK_HEADER,
  body: hookBody(`${HOOK_HEADER} stop private (layer-claimed) files from being committed to base.`, "git commit"),
};

function layerHook(layer: string): HookSpec {
  const header = `# Installed by sich for layer ${layer}:`;
  return {
    header,
    body: hookBody(`${header} stop files ${layer} doesn't own from being committed to it.`, `sich ${layer} commit`),
  };
}

function hookBody(header: string, commit: string): string {
  return `#!/bin/sh
${header}
sich="\${SICH_BIN:-sich}"
if ! command -v "$sich" >/dev/null 2>&1; then
  echo "sich: commit blocked: '$sich' not found; put sich on PATH or set SICH_BIN (skip once: ${commit} --no-verify)" >&2
  exit 1
fi
exec "$sich" check --staged
`;
}

/** The pre-commit hook git runs for `repo` (core.hooksPath respected), relative to the root when inside it. */
function hookFile(ctx: Ctx, repo: Repo): { hook: string; shown: string } {
  const hooksDir = resolve(ctx.root, git(repo, ["rev-parse", "--git-path", "hooks"]).stdout.trim());
  const hook = join(hooksDir, "pre-commit");
  return { hook, shown: relative(ctx.root, hook) || hook };
}

/** For `sich check`: the hook file of `repo`, if it doesn't run sich's guard. */
export function unguarded(ctx: Ctx, repo: Repo): string | null {
  const { hook, shown } = hookFile(ctx, repo);
  if (!existsSync(hook)) return shown;
  return HOOK_MARKER.test(readFileSync(hook, "utf8")) ? null : shown;
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
  installHook(ctx, ctx.base, BASE_HOOK);
  for (const layer of layerNames(ctx)) installLayerHook(ctx, layer);
}

/** Install or refresh the pre-commit hook of one layer (`new`/`attach` call it once the layer exists). */
export function installLayerHook(ctx: Ctx, layer: string): void {
  installHook(ctx, layerRepo(ctx, layer), layerHook(layer));
}

function installHook(ctx: Ctx, repo: Repo, spec: HookSpec): void {
  const { hook, shown } = hookFile(ctx, repo);
  const hooksDir = dirname(hook);
  const hooksPath = git(repo, ["config", "--get", "core.hooksPath"], { allowFail: true }).stdout.trim();
  const of = repo.name === "base" ? "" : ` of ${repo.name}`;

  if (existsSync(hook)) {
    const current = readFileSync(hook, "utf8");
    if (current.includes(spec.header)) {
      // Ours: bring hooks written by older sich versions up to date.
      if (current !== spec.body) {
        writeFileSync(hook, spec.body);
        chmodSync(hook, 0o755);
        out(`updated pre-commit hook${of} -> ${shown}`);
      }
      return;
    }
    if (HOOK_MARKER.test(current)) return; // the user wired sich into their own hook
    out(`${c.yellow(`pre-commit hook${of} exists`)} (${shown}); add this line to it:`);
    out(`  ${HOOK_LINE}`);
    return;
  }
  if (hooksPath) {
    out(`${c.yellow(`core.hooksPath${of} is set`)} (${hooksPath}); add this line to its pre-commit hook:`);
    out(`  ${HOOK_LINE}`);
    return;
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hook, spec.body);
  chmodSync(hook, 0o755);
  out(`installed pre-commit hook${of} -> ${shown}`);
}

export function cmdInit(ctx: Ctx, args: string[]): number {
  if (parseArgs(args, {}).positionals.length) fail("usage: sich init");
  const already = isInitialized(ctx);
  ensureInit(ctx);
  out(already ? `sich already initialized in ${ctx.root}` : `${c.green("initialized")} sich in ${ctx.root}`);
  return 0;
}
