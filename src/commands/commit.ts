// sich commit: commit layers (never base).

import { parseArgs, str } from "../args";
import { layerNames, requireLayer, type Ctx } from "../context";
import { git, splitZ } from "../git";
import { c, fail, note, out, plural } from "../ui";

export function cmdCommit(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, { "-m": "value" }, { "--message": "-m" });
  const message = str(p, "-m");
  if (!message) fail("usage: sich commit [layer...] -m <msg>");
  if (p.positionals.includes("base")) fail("base is a normal repo: use git commit for base");
  const named = p.positionals.length > 0;
  const repos = (named ? [...new Set(p.positionals)] : layerNames(ctx)).map((l) => requireLayer(ctx, l));

  let committed = 0;
  for (const repo of repos) {
    // Safe: the layer's whitelist exclude only lets its claims through.
    git(repo, ["add", "-A"]);
    const files = splitZ(git(repo, ["diff", "--cached", "--name-only", "-z"]).stdout);
    if (files.length === 0) {
      if (named) note(`${repo.name}: nothing to commit`);
      continue;
    }
    git(repo, ["commit", "-q", "-m", message]);
    const sha = git(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim();
    out(`${c.bold(repo.name)}: committed ${c.yellow(sha)} (${plural(files.length, "file")})`);
    committed++;
  }
  if (committed === 0 && !named) note("nothing to commit in any layer");
  return 0;
}
