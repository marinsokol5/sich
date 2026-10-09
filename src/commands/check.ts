// sich check: consistency and leak checks. Also the body of the base pre-commit hook.

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "../args";
import { bare, covers, ownerOf, samePath } from "../claims";
import {
  allClaims,
  excludeTargets,
  ignoresCase,
  isInitialized,
  layerNames,
  layerRepo,
  manifestRel,
  requireInit,
  type Ctx,
} from "../context";
import { applyExclude, describeExclude, excludeFileShown } from "../excludes";
import { git, splitZ } from "../git";
import { c, fail, out, plural, shellQuote, warn } from "../ui";

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
  if (!isInitialized(ctx)) {
    // The hook also runs in repos (or linked worktrees) without .sich/: nothing is
    // claimed there, so nothing can leak.
    if (p.flags["--staged"]) return 0;
    requireInit(ctx);
  }
  /**
   * Leaks into base and ambiguous ownership between layers (which can leak one
   * layer's files into another, e.g. personal notes into a team layer). Always block.
   */
  const problems: string[] = [];
  /** Stale exclude rules: not a leak by themselves, and any sich command rewrites them. */
  const stale: string[] = [];
  const fixed: string[] = [];
  const hints: string[] = [];
  const claims = allClaims(ctx);
  const layers = layerNames(ctx);
  const indexEnv = hookIndexEnv(ctx);
  // On case-insensitive filesystems `git add -f docs` stages a claimed Docs/x.md
  // under the spelling typed, so match ownership the way git matches excludes.
  const icase = ignoresCase(ctx);
  const fold = (s: string) => (icase ? s.toLowerCase() : s);
  const owner = (f: string) => ownerOf(claims, f, icase);
  const isSich = (f: string) => fold(f).startsWith(".sich/");

  // Claims of different layers must not overlap: same path, or one inside the
  // other's directory (`claim` refuses both; manifests can still arrive via pull).
  const flat = [...claims].flatMap(([layer, cs]) => cs.map((claim) => ({ layer, claim })));
  for (const [i, a] of flat.entries()) {
    for (const b of flat.slice(i + 1)) {
      if (a.layer === b.layer) continue;
      const [x, y] = [fold(a.claim), fold(b.claim)];
      if (samePath(x, y)) {
        problems.push(`${bare(a.claim)} is claimed by more than one layer: ${a.layer}, ${b.layer}`);
      } else if (covers(x, y) || covers(y, x)) {
        const [outer, inner] = covers(x, y) ? [a, b] : [b, a];
        problems.push(
          `${inner.claim} (${inner.layer}) is nested inside ${outer.claim} (${outer.layer}); ` +
            `claims can't nest across layers (fix: sich unclaim ${inner.layer} ${shellQuote(inner.claim)})`,
        );
      }
    }
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
    const by = owner(f)?.layer;
    if (ls.length > 1) {
      problems.push(`${f} is tracked by more than one layer: ${ls.join(", ")}${by ? ` (owner: ${by})` : ""}`);
    } else if (by !== ls[0]) {
      const why = by ? `it belongs to ${by}` : "none of its claims cover it";
      problems.push(`${ls[0]} tracks ${f} but ${why} (fix: sich ${ls[0]} rm --cached -- ${shellQuote(f)})`);
    }
  }

  // Staged changes in base touching private paths (what the pre-commit hook enforces).
  // Deletions are fine: that is how a path moved out of base (claim --move) gets committed.
  const reported = new Set<string>();
  if (p.flags["--staged"]) {
    const staged = splitZ(
      git(ctx.base, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=d", "-z"], { env: indexEnv })
        .stdout,
    );
    const stagedPrivate = staged.filter((f) => isSich(f) || owner(f));
    for (const f of stagedPrivate) {
      const by = owner(f);
      problems.push(`base has a staged change to private path ${f}${by ? ` (claimed by ${by.layer})` : ""}`);
      reported.add(f);
    }
    if (stagedPrivate.length) {
      hints.push(`unstage with: git restore --staged -- ${stagedPrivate.map(shellQuote).join(" ")}`);
    }
  }

  // Base tracking claimed paths or sich's own files. Scans the whole index rather
  // than passing claims as pathspecs, which would match case-sensitively.
  let sichFiles = 0;
  for (const f of splitZ(git(ctx.base, ["ls-files", "-z"], { env: indexEnv }).stdout)) {
    if (reported.has(f)) continue;
    if (isSich(f)) {
      sichFiles++;
      continue;
    }
    const by = owner(f);
    if (by) problems.push(`base tracks ${f}, which is claimed by ${by.layer} (fix: git rm --cached -- ${shellQuote(f)})`);
  }
  if (sichFiles) {
    problems.push(`base tracks ${plural(sichFiles, "file")} under .sich/ (fix: git rm -r --cached -- .sich/)`);
  }

  // Generated exclude blocks out of date.
  for (const t of excludeTargets(ctx)) {
    if (!applyExclude(t, false)) continue;
    if (p.flags["--fix"]) {
      applyExclude(t, true);
      fixed.push(`rewrote: ${describeExclude(t)}`);
    } else {
      stale.push(`stale exclude rules of ${t.repo.name} in ${excludeFileShown(t.repo)} (fix: sich check --fix)`);
    }
  }

  // In the hook (--staged) stale excludes only warn, so they never push anyone
  // towards `git commit --no-verify`, which would skip the leak checks too.
  const hook = p.flags["--staged"] === true;
  const blocking = hook ? problems : [...problems, ...stale];
  for (const f of fixed) out(`${c.green("✓")} ${f}`);
  if (hook) for (const s of stale) warn(`${s}; not blocking this commit`);
  for (const i of blocking) out(`${c.red("✗")} ${i}`);
  for (const h of hints) out(`  ${h}`);
  if (blocking.length) {
    out(c.red(`sich check: ${plural(blocking.length, "issue")} found`));
    return 1;
  }
  // Quiet on success with --staged: it runs on every base commit via the hook.
  if (!hook) out(c.green("sich check: ok"));
  return 0;
}
