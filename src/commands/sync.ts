// sich pull / push / sync across base and every layer.

import { parseArgs } from "../args";
import { layerNames, repoByName, syncExcludes, type Ctx } from "../context";
import { currentBranch, git, gitInherit, remotesOf, upstreamOf, type Repo } from "../git";
import { c, fail, note, out, printError } from "../ui";

type Action = "pull" | "push";

class StepFailed extends Error {
  constructor(
    readonly repo: string,
    readonly action: Action,
    readonly code: number,
  ) {
    super(`${action} failed in ${repo}`);
  }
}

function header(repo: Repo, argv: string[]): void {
  out(`${c.bold(repo.name)}: ${c.dim("git " + argv.join(" "))}`);
}

function run(repo: Repo, action: Action, argv: string[]): void {
  header(repo, argv);
  const code = gitInherit(repo, argv);
  if (code !== 0) throw new StepFailed(repo.name, action, code);
}

function defaultRemote(remotes: string[]): string {
  return remotes.includes("origin") ? "origin" : remotes[0]!;
}

function pull(ctx: Ctx, repo: Repo, remotes: string[]): void {
  if (upstreamOf(repo)) {
    run(repo, "pull", ["pull", "--rebase", "--autostash"]);
  } else {
    // No upstream yet (e.g. a layer that was never pushed): pull the same-named
    // branch if the remote has it, otherwise there is nothing to pull.
    const branch = currentBranch(repo);
    const remote = defaultRemote(remotes);
    const has =
      branch !== null &&
      git(repo, ["ls-remote", "--exit-code", "--heads", remote, branch], { allowFail: true }).code === 0;
    if (!has) {
      note(`${repo.name}: no upstream and nothing on ${remote} yet, skipped pull`);
      return;
    }
    run(repo, "pull", ["pull", "--rebase", "--autostash", remote, branch!]);
  }
  // Pulled manifests may add or drop claims.
  syncExcludes(ctx);
}

function push(repo: Repo, remotes: string[]): void {
  if (upstreamOf(repo)) {
    run(repo, "push", ["push"]);
    return;
  }
  const branch = currentBranch(repo);
  if (!branch) {
    printError(`${repo.name}: detached HEAD, cannot push`);
    throw new StepFailed(repo.name, "push", 1);
  }
  run(repo, "push", ["push", "-u", defaultRemote(remotes), branch]);
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
        `${e.action} failed in ${e.repo} (git exit ${e.code})` +
          (rest.length ? `; stopped before: ${rest.join(", ")}` : ""),
      );
    }
  }
  return 0;
}
