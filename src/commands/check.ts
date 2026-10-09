// sich check: consistency and leak checks. Also the body of every pre-commit hook (base and layers).

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs, str } from "../args";
import { bare, covers, ownerOf, parseManifest, samePath } from "../claims";
import {
  allClaims,
  excludeTargets,
  ignoresCase,
  isInitialized,
  layerNames,
  layerRepo,
  manifestRel,
  repoByName,
  requireInit,
  type Ctx,
} from "../context";
import { applyExclude, describeExclude, excludeFileShown } from "../excludes";
import { git, splitZ, type Repo } from "../git";
import { c, fail, out, plural, shellQuote, warn } from "../ui";
import { unguarded } from "./init";

/**
 * Inside a pre-commit hook git points GIT_INDEX_FILE at the index being committed:
 * the repo's index, or for `git commit -a` / `git commit <paths>` a temporary one
 * (index.lock, next-index-*.lock), always inside the committing repo's git dir.
 * A relative path is relative to the hook's cwd, the top of the working tree.
 * sich scrubs GIT_INDEX_FILE from its environment, so it reads it here.
 */
function hookIndexFile(): string | null {
  const raw = process.env.GIT_INDEX_FILE;
  if (!raw) return null;
  try {
    const abs = resolve(raw);
    return resolve(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return null;
  }
}

function isInsideDir(file: string, dir: string): boolean {
  try {
    return file.startsWith(realpathSync(dir) + "/");
  } catch {
    return false;
  }
}

/**
 * The repo whose staged changes `check --staged` checks: the one named by --repo,
 * else the one whose git dir holds the index being committed, else base. So one
 * hook line works in base, in every layer and in a core.hooksPath they share.
 */
function committingRepo(ctx: Ctx, named: string | undefined, index: string | null): Repo {
  if (named !== undefined) return repoByName(ctx, named);
  if (!index || isInsideDir(index, ctx.base.gitDir)) return ctx.base;
  const layer = layerNames(ctx).find((l) => isInsideDir(index, layerRepo(ctx, l).gitDir));
  if (layer) return layerRepo(ctx, layer);
  // Fail closed rather than check the wrong repo.
  if (isInsideDir(index, ctx.sichDir)) fail(`cannot tell which layer is committing (index ${index})`);
  return ctx.base;
}

export function cmdCheck(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, { "--fix": "bool", "--staged": "bool", "--repo": "value" });
  if (p.positionals.length) fail("usage: sich check [--fix] [--staged [--repo <repo>]]");
  const repoName = str(p, "--repo");
  if (repoName !== undefined && !p.flags["--staged"]) fail("--repo only applies with --staged");
  if (!isInitialized(ctx)) {
    // The hook also runs in repos (or linked worktrees) without .sich/: nothing is
    // claimed there, so nothing can leak.
    if (p.flags["--staged"]) return 0;
    requireInit(ctx);
  }
  const index = p.flags["--staged"] ? hookIndexFile() : null;
  const committing = committingRepo(ctx, repoName, index);
  // The index being committed, passed back to git only if it is the committing repo's.
  const indexEnv: Record<string, string> =
    index && isInsideDir(index, committing.gitDir) ? { GIT_INDEX_FILE: index } : {};
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

  // Staged changes in a layer to paths it doesn't own (what a layer's pre-commit
  // hook enforces): unclaimed, claimed by another layer, or sich's own files.
  // Deletions are fine: that is how a stray file gets untracked again.
  // Its own paths must also be claimed by the manifest being committed (the index
  // version): otherwise collaborators who pull get a file their claims don't cover.
  const stagedStray = new Map<string, string>();
  if (p.flags["--staged"] && committing !== ctx.base) {
    const layer = committing.name;
    const manifest = manifestRel(layer);
    const staged = splitZ(
      git(committing, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=d", "-z"], { env: indexEnv })
        .stdout,
    );
    const committed = git(committing, ["show", `:${manifest}`], { env: indexEnv, allowFail: true });
    const committedClaims = new Map([
      [layer, committed.code === 0 ? parseManifest(committed.stdout, layer).claims : []],
    ]);
    const unrecorded: string[] = [];
    for (const f of staged) {
      if (fold(f) === fold(manifest)) continue;
      const by = isSich(f) ? undefined : owner(f)?.layer;
      if (by === layer) {
        if (!ownerOf(committedClaims, f, icase)) {
          unrecorded.push(f);
          problems.push(`${layer} has a staged change to ${f}, which ${manifest} as committed doesn't claim`);
        }
        continue;
      }
      const why = isSich(f)
        ? "which is under .sich/"
        : by
          ? `which is claimed by ${by}`
          : "which none of its claims cover";
      stagedStray.set(f, why);
      problems.push(`${layer} has a staged change to ${f}, ${why}`);
    }
    if (unrecorded.length) {
      hints.push(
        `commit ${manifest} along with it (sich ${layer} add ${manifest}; with 'commit -- <paths>', list it too)`,
      );
    }
    const files = [...stagedStray.keys()];
    const claimable = files.filter((f) => !isSich(f) && !owner(f));
    // claim refuses a path base tracks unless --move takes it out of base.
    const baseTracked = new Set(splitZ(git(ctx.base, ["ls-files", "-z"]).stdout).map(fold));
    const plain = claimable.filter((f) => !baseTracked.has(fold(f)));
    const moved = claimable.filter((f) => baseTracked.has(fold(f)));
    if (plain.length) hints.push(`claim with: sich claim ${layer} ${plain.map(shellQuote).join(" ")}`);
    if (moved.length) {
      const list = moved.map(shellQuote).join(" ");
      hints.push(`claim with (base tracks ${list}): sich claim ${layer} ${list} --move`);
    }
    if (files.length) {
      const verb = claimable.length ? "or untrack" : "untrack";
      hints.push(`${verb} with: sich ${layer} rm --cached -- ${files.map(shellQuote).join(" ")}`);
    }
  }

  // Same file tracked by two layers, or tracked by a layer that doesn't own it.
  const trackedBy = new Map<string, string[]>();
  for (const layer of layers) {
    const env = layer === committing.name ? indexEnv : {};
    for (const f of splitZ(git(layerRepo(ctx, layer), ["ls-files", "-z"], { env }).stdout)) {
      if (f === manifestRel(layer)) continue;
      trackedBy.set(f, [...(trackedBy.get(f) ?? []), layer]);
    }
  }
  for (const [f, all] of trackedBy) {
    // A stray path staged in the committing layer is reported above already.
    const ls = stagedStray.has(f) ? all.filter((l) => l !== committing.name) : all;
    const by = owner(f)?.layer;
    if (ls.length > 1) {
      problems.push(`${f} is tracked by more than one layer: ${ls.join(", ")}${by ? ` (owner: ${by})` : ""}`);
    } else if (ls.length === 1 && by !== ls[0]) {
      const why = by ? `it belongs to ${by}` : "none of its claims cover it";
      problems.push(`${ls[0]} tracks ${f} but ${why} (fix: sich ${ls[0]} rm --cached -- ${shellQuote(f)})`);
    }
  }

  // Staged changes in base touching private paths (what the pre-commit hook enforces).
  // Deletions are fine: that is how a path moved out of base (claim --move) gets committed.
  const reported = new Set<string>();
  if (p.flags["--staged"] && committing === ctx.base) {
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
  const baseEnv = committing === ctx.base ? indexEnv : {};
  for (const f of splitZ(git(ctx.base, ["ls-files", "-z"], { env: baseEnv }).stdout)) {
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

  // Repos without the guard (e.g. layers created before layers had hooks). Only
  // a warning: the hook is a safety net, not part of the repo's consistency.
  const unhooked: string[] = [];
  if (!p.flags["--staged"]) {
    for (const repo of [ctx.base, ...layers.map((l) => layerRepo(ctx, l))]) {
      const file = unguarded(ctx, repo);
      if (file) {
        unhooked.push(`${repo.name} has no pre-commit hook running sich check --staged (${file}); fix: sich init`);
      }
    }
  }

  // In the hook (--staged) stale excludes only warn, so they never push anyone
  // towards `git commit --no-verify`, which would skip the leak checks too.
  const hook = p.flags["--staged"] === true;
  const blocking = hook ? problems : [...problems, ...stale];
  for (const f of fixed) out(`${c.green("✓")} ${f}`);
  if (hook) for (const s of stale) warn(`${s}; not blocking this commit`);
  for (const u of unhooked) warn(u);
  for (const i of blocking) out(`${c.red("✗")} ${i}`);
  for (const h of hints) out(`  ${h}`);
  if (blocking.length) {
    out(c.red(`sich check: ${plural(blocking.length, "issue")} found`));
    return 1;
  }
  // Quiet on success with --staged: it runs on every commit via the hooks.
  if (!hook) out(c.green("sich check: ok"));
  return 0;
}
