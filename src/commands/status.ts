// sich status: one row per repo sharing the worktree.

import { parseArgs } from "../args";
import { layerNames, layerRepo, type Ctx } from "../context";
import { git, remotesOf, splitZ, type Repo } from "../git";
import { c, fail, out, warn } from "../ui";

export interface RepoStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Upstream configured but missing (no ahead/behind info). */
  gone: boolean;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  /** Short-status style lines: "XY path". */
  files: string[];
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw: string): RepoStatus {
  const s: RepoStatus = {
    branch: "?",
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
    files: [],
  };
  const entries = splitZ(raw);
  let sawAb = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.startsWith("# branch.head ")) s.branch = e.slice(14);
    else if (e.startsWith("# branch.upstream ")) s.upstream = e.slice(18);
    else if (e.startsWith("# branch.ab ")) {
      sawAb = true;
      const m = /\+(\d+) -(\d+)/.exec(e);
      s.ahead = Number(m?.[1] ?? 0);
      s.behind = Number(m?.[2] ?? 0);
    } else if (e.startsWith("? ")) {
      s.untracked++;
      s.files.push(`?? ${e.slice(2)}`);
    } else if (e[0] === "1" || e[0] === "2" || e[0] === "u") {
      // Fields before the path: 1 -> 8, 2 -> 9 (then the original path as its own entry), u -> 10.
      const n = e[0] === "1" ? 8 : e[0] === "2" ? 9 : 10;
      const parts = e.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(n).join(" ");
      if (e[0] === "2") i++;
      if (e[0] === "u") s.conflicted++;
      else {
        if (xy[0] !== ".") s.staged++;
        if (xy[1] !== ".") s.modified++;
      }
      s.files.push(`${xy.replace(/\./g, " ")} ${path}`);
    }
  }
  s.gone = s.upstream !== null && !sawAb;
  return s;
}

export function repoStatus(repo: Repo): RepoStatus {
  return parseStatus(git(repo, ["status", "--porcelain=v2", "--branch", "-z"]).stdout);
}

function tracking(s: RepoStatus): string {
  if (!s.upstream) return c.dim("no upstream");
  if (s.gone) return `${s.upstream} ${c.red("gone")}`;
  const parts = [];
  if (s.ahead) parts.push(c.green(`ahead ${s.ahead}`));
  if (s.behind) parts.push(c.yellow(`behind ${s.behind}`));
  return `${s.upstream} ${parts.length ? parts.join(", ") : c.dim("up to date")}`;
}

function changes(s: RepoStatus): string {
  const parts = [];
  if (s.conflicted) parts.push(c.red(`${s.conflicted} conflicted`));
  if (s.staged) parts.push(c.green(`${s.staged} staged`));
  if (s.modified) parts.push(c.yellow(`${s.modified} modified`));
  if (s.untracked) parts.push(c.red(`${s.untracked} untracked`));
  return parts.length ? parts.join(", ") : c.dim("clean");
}

// Pad by visible width (colors add invisible escape codes).
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visible(s)));

export function cmdStatus(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, { "-v": "bool", "--fetch": "bool" }, { "--verbose": "-v" });
  if (p.positionals.length) fail("usage: sich status [-v] [--fetch]");
  const repos = [ctx.base, ...layerNames(ctx).map((l) => layerRepo(ctx, l))];

  if (p.flags["--fetch"]) {
    for (const r of repos) {
      if (remotesOf(r).length === 0) continue;
      const f = git(r, ["fetch", "--quiet"], { allowFail: true });
      if (f.code !== 0) warn(`${r.name}: fetch failed: ${f.stderr.trim().split("\n").pop()}`);
    }
  }

  const rows = repos.map((r) => ({ repo: r, s: repoStatus(r) }));
  const rendered = rows.map(({ repo, s }) => [c.bold(repo.name), c.cyan(s.branch), tracking(s), changes(s)]);
  const widths = [0, 1, 2].map((i) => Math.max(...rendered.map((cols) => visible(cols[i]!))));
  rows.forEach(({ s }, idx) => {
    const cols = rendered[idx]!;
    out(cols.map((col, i) => (i < 3 ? pad(col, widths[i]!) : col)).join("  "));
    if (p.flags["-v"]) for (const f of s.files) out(`    ${f}`);
  });
  return 0;
}

