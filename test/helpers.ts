// Test sandbox: temp dirs, isolated git config, and helpers to run git and the CLI.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect } from "bun:test";

// Tests run the Node bundle that ships (`pnpm test` builds it first).
export const CLI = resolve(import.meta.dir, "../dist/cli.js");
/** Absolute, so wrappers still work when a test restricts PATH. */
const NODE = Bun.which("node") ?? "node";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export class Sandbox {
  readonly dir: string;
  readonly env: Record<string, string>;

  constructor() {
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), "sich-test-")));
    const gitconfig = join(this.dir, "gitconfig");
    writeFileSync(
      gitconfig,
      [
        "[user]",
        "  name = Sich Test",
        "  email = sich@example.test",
        "[init]",
        "  defaultBranch = main",
        "[commit]",
        "  gpgsign = false",
        "[advice]",
        "  detachedHead = false",
      ].join("\n") + "\n",
    );
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("GIT_") && !k.startsWith("SICH_")) env[k] = v;
    }
    this.env = { ...env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1" };
    // The pre-commit hook fails closed, so plain `git commit` in base needs a reachable sich.
    this.env.SICH_BIN = join(this.sichOnPath(), "sich");
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  run(cmd: string[], cwd: string, extraEnv: Record<string, string> = {}): Run {
    const r = Bun.spawnSync({ cmd, cwd, env: { ...this.env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }

  /** Run git; throws on failure. Returns stdout. */
  git(cwd: string, ...args: string[]): string {
    const r = this.run(["git", ...args], cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr}${r.stdout}`);
    return r.stdout;
  }

  /** git against a layer's git dir. */
  layerGit(root: string, layer: string, ...args: string[]): string {
    return this.git(root, `--git-dir=${join(root, ".sich", layer)}`, `--work-tree=${root}`, ...args);
  }

  sich(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Run {
    return this.run([NODE, CLI, ...args], cwd, extraEnv);
  }

  /** Run the CLI and assert success. Returns stdout + stderr. */
  ok(cwd: string, ...args: string[]): string {
    const r = this.sich(cwd, args);
    if (r.code !== 0) throw new Error(`sich ${args.join(" ")} exited ${r.code}:\n${r.stderr}${r.stdout}`);
    return r.stdout + r.stderr;
  }

  /** Run the CLI and assert failure. Returns stdout + stderr. */
  bad(cwd: string, ...args: string[]): string {
    const r = this.sich(cwd, args);
    expect(r.code).toBe(1);
    return r.stdout + r.stderr;
  }

  bare(name: string): string {
    const p = this.path("remotes", name);
    mkdirSync(p, { recursive: true });
    this.git(p, "init", "-q", "--bare");
    return p;
  }

  /** A base repo with one commit (README.md). */
  repo(name: string): string {
    const p = this.path(name);
    mkdirSync(p, { recursive: true });
    this.git(p, "init", "-q");
    this.write(p, "README.md", "# project\n");
    this.git(p, "add", "README.md");
    this.git(p, "commit", "-q", "-m", "init");
    return p;
  }

  write(root: string, rel: string, content: string): void {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }

  read(root: string, rel: string): string {
    return readFileSync(join(root, rel), "utf8");
  }

  /** An executable script on disk. */
  script(rel: string, body: string): string {
    const p = this.path(rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  }

  /** A directory containing a `sich` wrapper, for PATH (the pre-commit hook calls `sich`). */
  sichOnPath(): string {
    this.script("bin/sich", `#!/bin/sh\nexec "${NODE}" "${CLI}" "$@"\n`);
    return this.path("bin");
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Paths from `git status --porcelain -uall` (untracked expanded to files). */
export function statusPaths(out: string): string[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3))
    .sort();
}

/** The sich-managed block of an exclude file. */
export function managedBlock(content: string): string[] {
  const start = content.indexOf("# >>> sich");
  const end = content.indexOf("# <<< sich <<<");
  return content.slice(start, end).split("\n").slice(1).filter(Boolean);
}
