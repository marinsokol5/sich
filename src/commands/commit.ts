// sich commit: commit base and layers, each with `git add -A`.

import { parseArgs, str } from "../args";
import { ownerOf } from "../claims";
import { allClaims, ignoresCase, layerNames, manifestRel, repoByName, type Ctx } from "../context";
import { git, splitZ } from "../git";
import { c, fail, listSome, note, out, plural, warn } from "../ui";

export function cmdCommit(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, { "-m": "value" }, { "--message": "-m" });
  const message = str(p, "-m");
  if (!message) fail("usage: sich commit [repo...] -m <msg>");
  const named = p.positionals.length > 0;
  const names = named ? [...new Set(p.positionals)] : ["base", ...layerNames(ctx)];
  const repos = names.map((n) => repoByName(ctx, n));
  const claims = allClaims(ctx);
  const icase = ignoresCase(ctx);

  /** Which repo a path belongs to: its layer, base if unclaimed, null for sich's own files. */
  const ownerRepo = (f: string): string | null => {
    if (f.startsWith(".sich/")) return layerNames(ctx).find((l) => f === manifestRel(l)) ?? null;
    return ownerOf(claims, f, icase)?.layer ?? "base";
  };

  let committed = 0;
  for (const repo of repos) {
    // Excludes normally keep other repos' files out of `git add -A`, but a worktree
    // .gitignore negation ("!name") outranks them, and base may already track a
    // claimed file. Never commit an addition or change to a file another repo owns.
    git(repo, ["add", "-A"]);
    const changed = git(repo, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=d", "-z"]).stdout;
    const stray = splitZ(changed).filter((f) => ownerRepo(f) !== repo.name);
    if (stray.length) {
      git(repo, ["reset", "-q", "--", ...stray]);
      warn(`${repo.name}: left out ${plural(stray.length, "file")} it doesn't own: ${listSome(stray)} (see: sich check)`);
    }
    const files = splitZ(git(repo, ["diff", "--cached", "--name-only", "-z"]).stdout);
    if (files.length === 0) {
      if (named) note(`${repo.name}: nothing to commit`);
      continue;
    }
    // Each repo runs its pre-commit hook here; show its full output if it blocks.
    const r = git(repo, ["commit", "-q", "-m", message], { allowFail: true });
    if (r.code !== 0) {
      process.stderr.write(r.stderr + r.stdout);
      fail(`${repo.name}: commit failed (nothing committed there)`);
    }
    const sha = git(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    out(`${c.bold(repo.name)}: committed ${c.yellow(sha)} (${plural(files.length, "file")}): ${listSome(files)}`);
    committed++;
  }
  if (committed === 0 && !named) note("nothing to commit");
  return 0;
}
