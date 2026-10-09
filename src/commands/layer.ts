// sich new / sich attach: creating a layer's git dir inside .sich/.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { parseArgs, str } from "../args";
import {
  collisions,
  layerRepo,
  manifestPath,
  manifestRel,
  syncExcludes,
  validateLayerName,
  type Ctx,
} from "../context";
import { git, splitZ, type Repo } from "../git";
import { c, fail, listSome, note, out, plural, warn } from "../ui";
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
