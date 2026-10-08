import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { excludeTargets, isInitialized, type Ctx } from "../context";
import { applyExclude } from "../excludes";
import { git } from "../git";
import { parseArgs } from "../args";
import { c, fail, out } from "../ui";

const HOOK_MARKER = "sich check --staged";
const HOOK_HEADER = "# Installed by sich:";

/** For hooks sich doesn't own. Fails closed: a missing `sich` exits 127 and blocks the commit. */
export const HOOK_LINE = "sich check --staged || exit 1";

/**
 * SICH_BIN overrides which sich the hook runs (default: `sich` on PATH). If it
 * can't be found the hook blocks the commit rather than skipping the check.
 */
const HOOK_BODY = `#!/bin/sh
${HOOK_HEADER} stop private (layer-claimed) files from being committed to base.
sich="\${SICH_BIN:-sich}"
if ! command -v "$sich" >/dev/null 2>&1; then
  echo "sich: commit blocked: '$sich' not found; put sich on PATH or set SICH_BIN (skip once: git commit --no-verify)" >&2
  exit 1
fi
exec "$sich" check --staged
`;

/**
 * Idempotent setup. Used by `sich init` and implicitly by `new`/`attach`.
 * Prints only what it changed (plus hook instructions when it can't install).
 */
export function ensureInit(ctx: Ctx): void {
  const fresh = !isInitialized(ctx);
  if (fresh) {
    mkdirSync(ctx.sichDir, { recursive: true });
    out(`created ${c.bold(".sich/")}`);
  }
  for (const t of excludeTargets(ctx)) {
    if (applyExclude(t, true)) out(`updated ${t.repo.name} exclude block`);
  }
  installHook(ctx);
}

function installHook(ctx: Ctx): void {
  const hooksDir = resolve(ctx.root, git(ctx.base, ["rev-parse", "--git-path", "hooks"]).stdout.trim());
  const hook = join(hooksDir, "pre-commit");
  const shown = relative(ctx.root, hook) || hook;
  const hooksPath = git(ctx.base, ["config", "--get", "core.hooksPath"], { allowFail: true }).stdout.trim();

  if (existsSync(hook)) {
    const current = readFileSync(hook, "utf8");
    if (current.includes(HOOK_HEADER)) {
      // Ours: bring hooks written by older sich versions up to date.
      if (current !== HOOK_BODY) {
        writeFileSync(hook, HOOK_BODY);
        chmodSync(hook, 0o755);
        out(`updated pre-commit hook (${shown})`);
      }
      return;
    }
    if (current.includes(HOOK_MARKER)) return; // the user wired sich into their own hook
    out(`${c.yellow("pre-commit hook exists")} (${shown}); add this line to it:`);
    out(`  ${HOOK_LINE}`);
    return;
  }
  if (hooksPath) {
    out(`${c.yellow("core.hooksPath is set")} (${hooksPath}); add this line to its pre-commit hook:`);
    out(`  ${HOOK_LINE}`);
    return;
  }
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hook, HOOK_BODY);
  chmodSync(hook, 0o755);
  out(`installed pre-commit hook (${shown})`);
}

export function cmdInit(ctx: Ctx, args: string[]): number {
  if (parseArgs(args, {}).positionals.length) fail("usage: sich init");
  const already = isInitialized(ctx);
  ensureInit(ctx);
  out(already ? `sich already initialized in ${ctx.root}` : `${c.green("initialized")} sich in ${ctx.root}`);
  return 0;
}
