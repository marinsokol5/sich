// Thin wrapper around the git binary. Every call names the repository explicitly
// (--git-dir/--work-tree, both absolute) and runs with a scrubbed environment, so
// sich behaves the same inside git hooks, aliases, or shells with GIT_DIR exported.

import { spawnSync } from "node:child_process";
import { fail } from "./ui";

export interface Repo {
  /** "base" or the layer name. */
  name: string;
  gitDir: string;
  workTree: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Return a non-zero result instead of throwing. */
  allowFail?: boolean;
  /** Literal pathspecs (default true); check-ignore rejects that magic. */
  literal?: boolean;
}

/** Variables that would redirect git to another repository, index or pathspec mode. */
const STRIPPED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_QUARANTINE_PATH",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
];

export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

/** Run a command synchronously; output is captured unless `inherit` attaches the terminal. */
export function spawn(cmd: string[], cwd: string | undefined, env: Record<string, string>, inherit: boolean): GitResult {
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    // Node's default (1 MiB) is too small for ls-files/status in large repos.
    maxBuffer: 1024 ** 3,
  });
  if (r.error) fail(`cannot run ${cmd[0]}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function repoArgs(repo: Repo): string[] {
  return [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`];
}

/**
 * Run git for sich's own bookkeeping: output captured, pathspecs literal
 * (claimed paths may contain glob characters), no optional index locks.
 */
export function git(repo: Repo, args: string[], opts: GitOptions = {}): GitResult {
  const literal = opts.literal ?? true;
  const env = cleanEnv({ GIT_LITERAL_PATHSPECS: literal ? "1" : "0", GIT_OPTIONAL_LOCKS: "0", ...opts.env });
  const result = spawn(["git", ...repoArgs(repo), ...args], opts.cwd ?? repo.workTree, env, false);
  if (result.code !== 0 && !opts.allowFail) {
    const msg = result.stderr.trim().split("\n").filter(Boolean).pop() ?? `exit code ${result.code}`;
    fail(`${repo.name}: git ${args[0]} failed: ${msg}`);
  }
  return result;
}

/** Run git with the user's terminal attached (passthrough, pull/push). Returns the exit code. */
export function gitInherit(repo: Repo, args: string[], cwd?: string): number {
  return spawn(["git", ...repoArgs(repo), ...args], cwd ?? repo.workTree, cleanEnv(), true).code;
}

/** git without an explicit repository (used only to discover the base repo). */
export function gitPlain(args: string[], cwd: string): GitResult {
  return spawn(["git", ...args], cwd, cleanEnv(), false);
}

/** Split NUL-terminated output (from `-z`) into entries. */
export function splitZ(s: string): string[] {
  return s.split("\0").filter((x) => x !== "");
}

export function lines(s: string): string[] {
  return s.split("\n").filter((x) => x !== "");
}

/** Files in the repo's index at or under `path` (root-relative). */
export function trackedUnder(repo: Repo, paths: string[]): string[] {
  if (paths.length === 0) return [];
  return splitZ(git(repo, ["ls-files", "-z", "--cached", "--", ...paths]).stdout);
}

/** True if `path` (root-relative) is ignored in `repo`. */
export function isIgnored(repo: Repo, path: string, noIndex = false): boolean {
  const args = ["check-ignore", "-q", ...(noIndex ? ["--no-index"] : []), "--", path];
  return git(repo, args, { allowFail: true, literal: false }).code === 0;
}

export function currentBranch(repo: Repo): string | null {
  const r = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

export function upstreamOf(repo: Repo): string | null {
  const r = git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export function remotesOf(repo: Repo): string[] {
  return lines(git(repo, ["remote"]).stdout);
}
