// sich pull / push / sync across base and every layer.

import { parseArgs } from "../args";
import { ownerOf } from "../claims";
import { allClaims, collisions, layerNames, repoByName, syncExcludes, type Ctx } from "../context";
import { currentBranch, git, gitInherit, remotesOf, splitZ, trackedUnder, upstreamOf, type Repo } from "../git";
import { c, fail, listSome, note, out, plural, printError } from "../ui";

type Action = "pull" | "push";

class StepFailed extends Error {
  constructor(
    readonly repo: string,
    readonly action: Action,
    /** Why, e.g. "git exit 1". */
    readonly reason: string,
  ) {
    super(`${action} failed in ${repo}`);
  }
}

function header(repo: Repo, argv: string[]): void {
  out(`${c.bold(repo.name)}: ${c.dim("git " + argv.join(" "))}`);
}

function exec(repo: Repo, action: Action, argv: string[]): void {
  const code = gitInherit(repo, argv);
  if (code !== 0) throw new StepFailed(repo.name, action, `git exit ${code}`);
}

function defaultRemote(remotes: string[]): string {
  return remotes.includes("origin") ? "origin" : remotes[0]!;
}

/**
 * Every other repo's files are ignored in this one, and git treats ignored files
 * as expendable: a pull that adds a path which already exists here (a file of
 * another layer or of base, or an untracked one) would silently overwrite it.
 * Refuse instead. `incoming` is the fetched commit the pull will rebase onto.
 */
function refuseOverwrite(ctx: Ctx, repo: Repo, incoming: string): void {
  const hasHead = git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true }).code === 0;
  const added = hasHead
    ? git(repo, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", "HEAD", incoming]).stdout
    : git(repo, ["ls-tree", "-r", "-z", "--name-only", incoming]).stdout;
  // A directory of this repo's own files being replaced is a normal change, not a clobber.
  const clash = collisions(ctx, splitZ(added)).filter((p) => trackedUnder(repo, [p]).length === 0);
  if (clash.length === 0) return;
  const claims = allClaims(ctx);
  const shown = clash.map((p) => {
    const owner = ownerOf(claims, p)?.layer;
    return owner && owner !== repo.name ? `${p} (${owner})` : p;
  });
  printError(
    `${repo.name}: pull would overwrite ${plural(clash.length, "local path")} it doesn't track: ` +
      `${listSome(shown)} (move aside and retry)`,
  );
  throw new StepFailed(repo.name, "pull", "would overwrite local files");
}

function pull(ctx: Ctx, repo: Repo, remotes: string[]): void {
  const argv = ["pull", "--rebase", "--autostash"];
  let fetch: string[];
  let incoming: string;
  if (upstreamOf(repo)) {
    fetch = [];
    incoming = "@{u}";
  } else {
    // No upstream yet (e.g. a layer that was never pushed): pull the same-named
    // branch if the remote has it, otherwise there is nothing to pull.
    const branch = currentBranch(repo);
    if (!branch) {
      note(`${repo.name}: detached HEAD and no upstream, skipped pull`);
      return;
    }
    const remote = defaultRemote(remotes);
    const has = git(repo, ["ls-remote", "--exit-code", "--heads", remote, branch], { allowFail: true }).code === 0;
    if (!has) {
      note(`${repo.name}: no upstream and nothing on ${remote} yet, skipped pull`);
      return;
    }
    fetch = [remote, branch];
    incoming = "FETCH_HEAD";
    argv.push(remote, branch);
  }
  header(repo, argv);
  // Fetch first to see what the pull would write (its own fetch then has nothing new to get).
  exec(repo, "pull", ["fetch", "-q", ...fetch]);
  refuseOverwrite(ctx, repo, incoming);
  exec(repo, "pull", argv);
  // Pulled manifests may add or drop claims.
  syncExcludes(ctx);
}

function push(repo: Repo, remotes: string[]): void {
  if (upstreamOf(repo)) {
    header(repo, ["push"]);
    exec(repo, "push", ["push"]);
    return;
  }
  const branch = currentBranch(repo);
  if (!branch) {
    printError(`${repo.name}: detached HEAD, cannot push`);
    throw new StepFailed(repo.name, "push", "detached HEAD");
  }
  const argv = ["push", "-u", defaultRemote(remotes), branch];
  header(repo, argv);
  exec(repo, "push", argv);
}

export function cmdRemote(ctx: Ctx, command: "pull" | "push" | "sync", args: string[]): number {
  const p = parseArgs(args, {});
  const names = p.positionals.length ? [...new Set(p.positionals)] : ["base", ...layerNames(ctx)];
  const repos = names.map((n) => repoByName(ctx, n));
  const actions: Action[] = command === "sync" ? ["pull", "push"] : [command];

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i]!;
    const remotes = remotesOf(repo);
    if (remotes.length === 0) {
      note(`${repo.name}: no remote, skipped`);
      continue;
    }
    try {
      for (const a of actions) {
        if (a === "pull") pull(ctx, repo, remotes);
        else push(repo, remotes);
      }
    } catch (e) {
      if (!(e instanceof StepFailed)) throw e;
      syncExcludes(ctx);
      const rest = repos.slice(i + 1).map((r) => r.name);
      fail(
        `${e.action} failed in ${e.repo} (${e.reason})` + (rest.length ? `; stopped before: ${rest.join(", ")}` : ""),
      );
    }
  }
  return 0;
}
