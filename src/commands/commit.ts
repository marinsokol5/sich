// sich commit: commit layers (never base).

import { parseArgs, str } from "../args";
import { ownerOf } from "../claims";
import { allClaims, ignoresCase, layerNames, manifestRel, requireLayer, type Ctx } from "../context";
import { git, splitZ } from "../git";
import { c, fail, listSome, note, out, plural, warn } from "../ui";

export function cmdCommit(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, { "-m": "value" }, { "--message": "-m" });
  const message = str(p, "-m");
  if (!message) fail("usage: sich commit [layer...] -m <msg>");
  if (p.positionals.includes("base")) fail("base is a normal repo: use git commit for base");
  const named = p.positionals.length > 0;
  const repos = (named ? [...new Set(p.positionals)] : layerNames(ctx)).map((l) => requireLayer(ctx, l));
  const claims = allClaims(ctx);
  const icase = ignoresCase(ctx);

  let committed = 0;
  for (const repo of repos) {
    // The layer's whitelist exclude normally lets only its claims through, but a
    // worktree .gitignore negation ("!name") outranks it. Never commit an addition
    // or change to a file the layer doesn't own (it may be another layer's).
    git(repo, ["add", "-A"]);
    const changed = git(repo, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=d", "-z"]).stdout;
    const stray = splitZ(changed).filter(
      (f) => f !== manifestRel(repo.name) && ownerOf(claims, f, icase)?.layer !== repo.name,
    );
    if (stray.length) {
      git(repo, ["reset", "-q", "--", ...stray]);
      warn(`${repo.name}: left out ${plural(stray.length, "file")} it doesn't own: ${listSome(stray)} (see: sich check)`);
    }
    const files = splitZ(git(repo, ["diff", "--cached", "--name-only", "-z"]).stdout);
    if (files.length === 0) {
      if (named) note(`${repo.name}: nothing to commit`);
      continue;
    }
    git(repo, ["commit", "-q", "-m", message]);
    const sha = git(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    out(`${c.bold(repo.name)}: committed ${c.yellow(sha)} (${plural(files.length, "file")}): ${listSome(files)}`);
    committed++;
  }
  if (committed === 0 && !named) note("nothing to commit in any layer");
  return 0;
}
