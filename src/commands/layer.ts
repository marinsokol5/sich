// sich new / attach / detach: creating and removing a layer's git dir inside .sich/.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseArgs, str } from "../args";
import { bare, readManifest } from "../claims";
import {
  collisions,
  excludeTargets,
  layerRepo,
  manifestPath,
  manifestRel,
  requireLayer,
  syncExcludes,
  validateLayerName,
  type Ctx,
} from "../context";
import { applyExclude, excludeFileShown } from "../excludes";
import { currentBranch, git, lines, remotesOf, splitZ, type Repo } from "../git";
import { c, confirm, fail, listSome, note, out, plural, shellQuote, warn } from "../ui";
import { ensureInit, installLayerHooks } from "./init";

function assertFree(ctx: Ctx, layer: string): void {
  validateLayerName(layer);
  if (existsSync(join(ctx.sichDir, layer))) fail(`layer '${layer}' already exists (.sich/${layer}/)`);
  if (existsSync(manifestPath(ctx, layer))) fail(`.sich/${layer}.paths already exists; remove it first`);
}

/** Create .sich/<layer>/ as a non-bare git dir whose worktree is the repo root. */
function createGitDir(ctx: Ctx, layer: string): Repo {
  const repo = layerRepo(ctx, layer);
  git(repo, ["init", "-q", "--initial-branch=main"], { cwd: ctx.root });
  // Relative, so the whole folder can be moved or renamed.
  git(repo, ["config", "core.worktree", "../.."]);
  git(repo, ["config", "core.bare", "false"]);
  return repo;
}

/**
 * A remote given as a relative local path (e.g. ../notes.git) made absolute: git would
 * resolve it against whatever directory it later runs in, not where it was typed.
 */
function remoteUrl(ctx: Ctx, url: string): string {
  if (isAbsolute(url) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  const local = resolve(ctx.cwd, url);
  return existsSync(local) ? local : url;
}

/** Name of the base repo: last segment of origin's URL, else the folder name. */
function baseRepoName(ctx: Ctx): string {
  const url = git(ctx.base, ["config", "--get", "remote.origin.url"], { allowFail: true }).stdout.trim();
  if (url) {
    const last = url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
    if (last) return last;
  }
  return basename(ctx.root);
}

function runGh(args: string[], capture: boolean): string {
  const bin = process.env.SICH_GH || "gh";
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"],
  });
  if (r.error) fail(`cannot run ${bin}: ${r.error.message}`);
  if (r.status !== 0) fail(`${bin} ${args.join(" ")} failed (exit ${r.status ?? "?"})`);
  return r.stdout?.trim() ?? "";
}

export function cmdNew(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, { "--remote": "value", "--gh": "optional" });
  const [layer, ...extra] = p.positionals;
  if (!layer || extra.length) fail("usage: sich new <layer> [--remote <url> | --gh [name]]");
  const given = str(p, "--remote");
  const remote = given && remoteUrl(ctx, given);
  const gh = p.flags["--gh"];
  if (remote && gh) fail("use either --remote or --gh, not both");
  assertFree(ctx, layer);
  ensureInit(ctx);

  let url = remote;
  if (gh) {
    const name = typeof gh === "string" ? gh : `${baseRepoName(ctx)}-${layer}`;
    runGh(["repo", "create", name, "--private"], false);
    url = runGh(["repo", "view", name, "--json", "sshUrl", "-q", ".sshUrl"], true);
    if (!url) fail(`could not read the SSH URL of GitHub repo ${name}`);
  }

  const repo = createGitDir(ctx, layer);
  try {
    writeFileSync(
      manifestPath(ctx, layer),
      `# Paths owned by sich layer '${layer}': one root-relative path per line, directories end with /\n`,
    );
    syncExcludes(ctx);
    git(repo, ["add", "-f", "--", manifestRel(layer)]);
    git(repo, ["commit", "-q", "-m", `sich: create layer ${layer}`]);
    if (url) git(repo, ["remote", "add", "origin", url]);
  } catch (e) {
    rmSync(repo.gitDir, { recursive: true, force: true });
    rmSync(manifestPath(ctx, layer), { force: true });
    syncExcludes(ctx);
    throw e;
  }

  out(`${c.green("created")} layer ${c.bold(layer)}: git data -> .sich/${layer}/, claims list -> ${manifestRel(layer)}`);
  if (url) out(`set origin of ${layer} -> ${url}`);
  // After the initial commit, which has nothing to guard.
  installLayerHooks(ctx, layer);
  note(`next: sich claim ${layer} <path>...  then  sich commit ${layer} -m <msg>${url ? `  and  sich push ${layer}` : ""}`);
  return 0;
}

export function cmdAttach(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, {});
  const [layer, given, ...extra] = p.positionals;
  if (!layer || !given || extra.length) fail("usage: sich attach <layer> <url>");
  const url = remoteUrl(ctx, given);
  assertFree(ctx, layer);
  ensureInit(ctx);

  const repo = createGitDir(ctx, layer);
  const cleanup = () => rmSync(repo.gitDir, { recursive: true, force: true });
  try {
    git(repo, ["remote", "add", "origin", url]);
    const fetched = git(repo, ["fetch", "-q", "origin"], { allowFail: true });
    if (fetched.code !== 0) fail(`cannot fetch ${url}: ${fetched.stderr.trim().split("\n").pop()}`);

    const head = git(repo, ["ls-remote", "--symref", "origin", "HEAD"], { allowFail: true }).stdout;
    const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1] ?? "main";
    const ref = `refs/remotes/origin/${branch}`;
    if (git(repo, ["rev-parse", "--verify", "-q", ref], { allowFail: true }).code !== 0) {
      fail(`${url} has no branch '${branch}' (is it a sich layer? create new layers with sich new)`);
    }

    const files = splitZ(git(repo, ["ls-tree", "-r", "-z", "--name-only", ref]).stdout);
    const clash = collisions(ctx, files);
    if (clash.length) {
      fail(`attach would overwrite existing files: ${listSome(clash)} (move them away and retry)`);
    }
    git(repo, ["checkout", "-q", "-B", branch, "--track", `origin/${branch}`]);
    if (!existsSync(manifestPath(ctx, layer))) {
      warn(`${url} has no .sich/${layer}.paths; is the layer name right?`);
    }
    syncExcludes(ctx);
    out(`${c.green("attached")} layer ${c.bold(layer)} from ${url} -> .sich/${layer}/ (branch ${branch})`);
    out(`checked out ${plural(files.length, "file")}: ${listSome(files)}`);
  } catch (e) {
    cleanup();
    throw e;
  }
  installLayerHooks(ctx, layer);
  return 0;
}

/** Something only the layer's git dir holds, which detaching would discard. */
interface Loss {
  what: string;
  fix: string;
}

/** Operations whose state lives in the git dir, by the file that marks them. */
const IN_PROGRESS: [file: string, op: string][] = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply/applying", "am"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

const preferredRemote = (remotes: string[]) => (remotes.includes("origin") ? "origin" : remotes[0]);

/**
 * What exists only in .sich/<layer>/: commits on no remote (branches as of the
 * last fetch or push), stashes, staged versions of files that changed again on
 * disk, linked worktrees, submodule repos and operations in progress. Changes
 * to files don't count: the files stay.
 */
function onlyInGitDir(repo: Repo): Loss[] {
  const run = `sich ${repo.name}`;
  const losses: Loss[] = [];
  const count = (revs: string[], allowFail = false) =>
    Number(git(repo, ["rev-list", "--count", ...revs, "--"], { allowFail }).stdout.trim() || 0);

  const remote = preferredRemote(remotesOf(repo));
  if (!remote) {
    const n = count(["--exclude=refs/stash", "--all"]);
    losses.push({
      what: `${plural(n, "commit")} with no remote to push to`,
      fix: `${run} remote add origin <url>, then sich push ${repo.name}`,
    });
  } else {
    const current = currentBranch(repo);
    const refs = lines(git(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]).stdout).map((l) => {
      const [oid, ref] = l.split(" ") as [string, string];
      return { oid, ref };
    });
    for (const { ref } of refs.filter((r) => r.ref.startsWith("refs/heads/"))) {
      const n = count([ref, "--not", "--remotes"]);
      if (!n) continue;
      const branch = ref.slice("refs/heads/".length);
      losses.push({
        what: `${plural(n, "commit")} on ${branch} not on any remote`,
        fix: branch === current ? `sich push ${repo.name}` : `${run} push -u ${remote} ${shellQuote(branch)}`,
      });
    }
    // Pushing a tag or a ref like refs/notes/commits leaves no remote-tracking
    // ref behind, so ask the remote (only if some such ref has commits of its own).
    let advertised: Set<string> | null | undefined;
    const remoteHas = (oid: string) => {
      if (advertised === undefined) {
        const r = git(repo, ["ls-remote", remote], { allowFail: true });
        advertised = r.code === 0 ? new Set(lines(r.stdout).map((l) => l.split("\t")[0]!)) : null;
      }
      return advertised?.has(oid) ?? false;
    };
    const others = refs.filter((r) => !/^refs\/(heads|remotes|prefetch)\//.test(r.ref) && r.ref !== "refs/stash");
    for (const { oid, ref } of others) {
      // A tag of a tree or blob has no commits to lose.
      const n = count([`${ref}^{commit}`, "--not", "--remotes", "--branches"], true);
      if (!n || remoteHas(oid)) continue;
      const name = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : ref;
      const unchecked = advertised === null ? ` (could not reach ${remote} to check)` : "";
      losses.push({
        what: `${plural(n, "commit")} only on ${name === ref ? ref : `tag ${name}`}${unchecked}`,
        fix: `${run} push ${remote} ${shellQuote(name)}`,
      });
    }
    if (current === null) {
      const n = count(["HEAD", "--not", "--remotes", "--branches", "--tags"]);
      if (n) {
        losses.push({ what: `${plural(n, "commit")} only on the detached HEAD`, fix: `${run} switch -c <branch>` });
      }
    }
  }

  const stashes = lines(git(repo, ["stash", "list"]).stdout).length;
  if (stashes) {
    losses.push({ what: plural(stashes, "stash entry", "stash entries"), fix: `${run} stash pop, then commit` });
  }

  // A staged version is safe while the file on disk still matches it. git diff
  // can't tell for assume-unchanged (lowercase tag) or skip-worktree (S) entries.
  const staged = splitZ(git(repo, ["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=du"]).stdout);
  const changed = new Set(splitZ(git(repo, ["diff", "--name-only", "-z", "--no-renames"]).stdout));
  for (const e of splitZ(git(repo, ["ls-files", "-v", "-z"]).stdout)) {
    if (/^[a-zS] /.test(e)) changed.add(e.slice(2));
  }
  const stagedOnly = staged.filter((f) => changed.has(f));
  if (stagedOnly.length) {
    losses.push({
      what: `staged versions of ${listSome(stagedOnly)} that differ from what is on disk`,
      fix: `${run} commit -m <msg>, then sich push ${repo.name}`,
    });
  }

  // Their HEADs, indexes and repos live in the layer's git dir too.
  const worktrees = lines(git(repo, ["worktree", "list", "--porcelain"]).stdout)
    .filter((l) => l.startsWith("worktree "))
    .slice(1)
    .map((l) => l.slice("worktree ".length));
  if (worktrees.length) {
    losses.push({
      what: `${plural(worktrees.length, "linked worktree")}: ${listSome(worktrees)}`,
      fix: `${run} worktree remove <path>`,
    });
  }
  const modules = join(repo.gitDir, "modules");
  if (existsSync(modules) && readdirSync(modules).length) {
    losses.push({ what: `submodule repos in .sich/${repo.name}/modules/`, fix: `push and remove the submodules` });
  }

  const op = IN_PROGRESS.find(([file]) => existsSync(join(repo.gitDir, file)))?.[1];
  if (op) losses.push({ what: `a ${op} in progress`, fix: `finish it, or ${run} ${op} --abort` });
  return losses;
}

export async function cmdDetach(ctx: Ctx, args: string[]): Promise<number> {
  const p = parseArgs(args, { "--force": "bool", "--yes": "bool" }, { "-y": "--yes" });
  const [layer, ...extra] = p.positionals;
  if (!layer || extra.length) fail("usage: sich detach <layer> [--force] [--yes]");
  const repo = requireLayer(ctx, layer);

  const losses = onlyInGitDir(repo);
  if (losses.length && !p.flags["--force"]) {
    for (const l of losses) out(`${c.red("✗")} ${l.what} (fix: ${l.fix})`);
    fail(`detaching ${layer} would lose what exists only in .sich/${layer}/ (see above); --force discards it`);
  }

  const claims = readManifest(manifestPath(ctx, layer), layer).claims;
  const remote = preferredRemote(remotesOf(repo));
  const url = remote && git(repo, ["remote", "get-url", remote], { allowFail: true }).stdout.trim();

  if (p.flags["--yes"]) {
    for (const l of losses) warn(`discarding ${l.what}`);
  } else {
    const onDisk = claims.filter((cl) => existsSync(join(ctx.root, bare(cl))));
    const row = (label: string, text: string) => out(`  ${label}${" ".repeat(10 - label.length)}${text}`);
    out(`detaching ${c.bold(layer)}:`);
    row("deletes", `.sich/${layer}/ (its git data: local history, index, hooks, config)`);
    if (existsSync(manifestPath(ctx, layer))) {
      row("deletes", `${manifestRel(layer)} (claims list: ${claims.length ? listSome(claims) : "empty"})`);
    }
    for (const l of losses) row("discards", l.what);
    row("keeps", onDisk.length ? `${listSome(onDisk)} on disk, no longer hidden from base` : "files: none on disk");
    if (url) row("keeps", `remote ${remote} (${url}) and everything pushed to it`);
    if (!(await confirm(`Detach ${layer}?`))) {
      fail(process.stdin.isTTY ? "not detached" : "not detached (no answer on stdin; --yes skips the question)");
    }
    // The layer may have changed while the question waited.
    const shown = new Set(losses.map((l) => l.what));
    const added = onlyInGitDir(repo).filter((l) => !shown.has(l.what));
    if (added.length) {
      for (const l of added) out(`${c.red("✗")} ${l.what} (fix: ${l.fix})`);
      fail(`${layer} changed while waiting for the answer (see above); not detached`);
    }
  }

  const manifest = existsSync(manifestPath(ctx, layer));
  rmSync(repo.gitDir, { recursive: true, force: true });
  rmSync(manifestPath(ctx, layer), { force: true });
  const deleted = `git data -> .sich/${layer}/${manifest ? `, claims list -> ${manifestRel(layer)}` : ""}`;
  out(`${c.green("detached")} layer ${c.bold(layer)}: deleted ${deleted}`);
  for (const t of excludeTargets(ctx)) {
    if (!applyExclude(t, true)) continue;
    const file = excludeFileShown(t.repo);
    out(t.repo.name === "base" ? `no longer hidden from base -> ${file}` : `updated the excludes of ${t.repo.name} -> ${file}`);
  }

  // Nothing guards them any more: a `git add -A` in base would commit them.
  const untracked = ["ls-files", "-z", "--others", "--exclude-standard", "--directory", "--no-empty-directory"];
  const visible = claims.length ? splitZ(git(ctx.base, [...untracked, "--", ...claims]).stdout) : [];
  if (visible.length) {
    warn(
      `base now sees ${listSome(visible)} as untracked ` +
        `(delete, .gitignore or claim ${visible.length === 1 ? "it" : "them"} before committing base)`,
    );
  }
  if (url) {
    // attach refuses to overwrite files, ignored ones included.
    const away = claims.some((cl) => existsSync(join(ctx.root, bare(cl)))) ? "move its files away, then " : "";
    note(`its remote is untouched; to attach again: ${away}sich attach ${layer} ${shellQuote(url)}`);
  }
  return 0;
}
