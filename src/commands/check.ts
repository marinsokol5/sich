// sich check: consistency and leak checks. Also the body of the base pre-commit hook.

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "../args";
import { bare, ownerOf } from "../claims";
import { allClaims, excludeTargets, layerNames, layerRepo, manifestRel, type Ctx } from "../context";
import { applyExclude, describeExclude, excludeFileShown } from "../excludes";
import { git, splitZ } from "../git";
import { c, fail, out, plural } from "../ui";

/**
 * Inside a pre-commit hook git points GIT_INDEX_FILE at the index being committed
 * (for `git commit -a` or `git commit <paths>` that is a temporary index). sich
 * scrubs GIT_INDEX_FILE from its environment, so pass it back explicitly, but
 * only if it belongs to the base repo.
 */
function hookIndexEnv(ctx: Ctx): Record<string, string> {
  const raw = process.env.GIT_INDEX_FILE;
  if (!raw) return {};
  try {
    const abs = resolve(raw);
    const real = resolve(realpathSync(dirname(abs)), basename(abs));
    const gitDir = realpathSync(ctx.base.gitDir);
    return real.startsWith(gitDir + "/") ? { GIT_INDEX_FILE: real } : {};
  } catch {
    return {};
  }
}

export function cmdCheck(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, { "--fix": "bool", "--staged": "bool" });
  if (p.positionals.length) fail("usage: sich check [--fix] [--staged]");
  const issues: string[] = [];
  const fixed: string[] = [];
  const hints: string[] = [];
  const claims = allClaims(ctx);
  const layers = layerNames(ctx);
  const everyClaim = [...claims.values()].flat();
  const indexEnv = hookIndexEnv(ctx);

  // Same path claimed by two layers.
  const claimedBy = new Map<string, string[]>();
  for (const [layer, cs] of claims) {
    for (const cl of cs) claimedBy.set(bare(cl), [...(claimedBy.get(bare(cl)) ?? []), layer]);
  }
  for (const [path, ls] of claimedBy) {
    if (ls.length > 1) issues.push(`${path} is claimed by more than one layer: ${ls.join(", ")}`);
  }

  // Same file tracked by two layers, or tracked by a layer that doesn't own it.
  const trackedBy = new Map<string, string[]>();
  for (const layer of layers) {
    for (const f of splitZ(git(layerRepo(ctx, layer), ["ls-files", "-z"]).stdout)) {
      if (f === manifestRel(layer)) continue;
      trackedBy.set(f, [...(trackedBy.get(f) ?? []), layer]);
    }
  }
  for (const [f, ls] of trackedBy) {
    const owner = ownerOf(claims, f)?.layer;
    if (ls.length > 1) {
      issues.push(`${f} is tracked by more than one layer: ${ls.join(", ")}${owner ? ` (owner: ${owner})` : ""}`);
    } else if (owner !== ls[0]) {
      const why = owner ? `it belongs to ${owner}` : "none of its claims cover it";
      issues.push(`${ls[0]} tracks ${f} but ${why} (fix: sich ${ls[0]} rm --cached -- ${f})`);
    }
  }

  // Staged changes in base touching private paths (what the pre-commit hook enforces).
  // Deletions are fine: that is how a path moved out of base (add --move) gets committed.
  const reported = new Set<string>();
  if (p.flags["--staged"]) {
    const staged = splitZ(
      git(ctx.base, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=d", "-z"], { env: indexEnv })
        .stdout,
    );
    const leaks = staged.filter((f) => f.startsWith(".sich/") || ownerOf(claims, f));
    for (const f of leaks) {
      const owner = ownerOf(claims, f);
      issues.push(`base has a staged change to private path ${f}${owner ? ` (claimed by ${owner.layer})` : ""}`);
      reported.add(f);
    }
    if (leaks.length) {
      hints.push(`unstage with: git restore --staged -- ${leaks.join(" ")}`);
    }
  }

  // Base tracking claimed paths.
  if (everyClaim.length) {
    for (const f of splitZ(git(ctx.base, ["ls-files", "-z", "--", ...everyClaim], { env: indexEnv }).stdout)) {
      if (reported.has(f)) continue;
      const owner = ownerOf(claims, f);
      if (owner) issues.push(`base tracks ${f}, which is claimed by ${owner.layer} (fix: git rm --cached -- ${f})`);
    }
  }

  // Base tracking sich's own files.
  const sichFiles = splitZ(git(ctx.base, ["ls-files", "-z", "--", ".sich/"], { env: indexEnv }).stdout).filter(
    (f) => !reported.has(f),
  );
  if (sichFiles.length) {
    issues.push(`base tracks ${plural(sichFiles.length, "file")} under .sich/ (fix: git rm -r --cached -- .sich/)`);
  }

  // Generated exclude blocks out of date.
  for (const t of excludeTargets(ctx)) {
    if (!applyExclude(t, false)) continue;
    if (p.flags["--fix"]) {
      applyExclude(t, true);
      fixed.push(`rewrote: ${describeExclude(t)}`);
    } else {
      issues.push(`stale exclude rules of ${t.repo.name} in ${excludeFileShown(t.repo)} (fix: sich check --fix)`);
    }
  }

  for (const f of fixed) out(`${c.green("✓")} ${f}`);
  for (const i of issues) out(`${c.red("✗")} ${i}`);
  for (const h of hints) out(`  ${h}`);
  if (issues.length) {
    out(c.red(`sich check: ${plural(issues.length, "issue")} found`));
    return 1;
  }
  // Quiet on success with --staged: it runs on every base commit via the hook.
  if (!p.flags["--staged"]) out(c.green("sich check: ok"));
  return 0;
}
