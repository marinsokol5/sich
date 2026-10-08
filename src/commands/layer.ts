// sich new / sich attach: creating a layer's git dir inside .sich/.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs, str } from "../args";
import {
  layerRepo,
  manifestPath,
  manifestRel,
  syncExcludes,
  validateLayerName,
  type Ctx,
} from "../context";
import { git, splitZ, type Repo } from "../git";
import { c, fail, listSome, note, out, plural, warn } from "../ui";
import { ensureInit } from "./init";

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
  const remote = str(p, "--remote");
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

  out(`${c.green("created")} layer ${c.bold(layer)} (.sich/${layer}/)`);
  if (url) out(`origin: ${url}`);
  note(`next: sich add ${layer} <path>...  then  sich commit ${layer} -m <msg>${url ? `  and  sich push ${layer}` : ""}`);
  return 0;
}

/** Paths in `tree` that already exist on disk (or collide with an existing non-directory parent). */
function collisions(ctx: Ctx, paths: string[]): string[] {
  const hits = new Set<string>();
  const kind = (rel: string) => {
    try {
      return lstatSync(join(ctx.root, rel)).isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  };
  for (const p of paths) {
    if (kind(p)) hits.add(p);
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join("/");
      if (kind(parent) === "file") hits.add(parent);
    }
  }
  return [...hits].sort();
}

export function cmdAttach(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, {});
  const [layer, url, ...extra] = p.positionals;
  if (!layer || !url || extra.length) fail("usage: sich attach <layer> <url>");
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
    out(`${c.green("attached")} layer ${c.bold(layer)} from ${url} (branch ${branch}, ${plural(files.length, "file")})`);
    return 0;
  } catch (e) {
    cleanup();
    throw e;
  }
}
