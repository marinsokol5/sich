// Generated info/exclude blocks.
//
// Every repo sharing the worktree gets a sich-managed block in its info/exclude:
//   - base: excludes .sich/ and every claim of every layer.
//   - layer L: a whitelist. "/*" ignores everything, then L's claims are re-included.
//
// gitignore cannot re-include a file whose parent directory is excluded, so each
// claim needs its parent chain re-opened: for a/b/c.md
//     !/a/   /a/*   !/a/b/   /a/b/*   !/a/b/c.md
// When claims share parents, a later "/a/*" would re-exclude an earlier "!/a/x".
// Emitting from a tree (depth first) guarantees every "/dir/*" precedes the "!"
// lines of that dir's children, and dedupes shared parents for free.
//
// Finally other layers' claims are appended as plain excludes. Claims can't nest
// across layers (`add` refuses it, `check` flags it), so this is only a safety net
// for manifests that arrive nested anyway (e.g. via pull): last match wins, so
// another layer's claim inside one of L's directories is carved out of L. Other
// layers' claims that are an ancestor of (or equal to) one of L's claims are
// skipped: excluding them would hide L's own claim.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { bare, isDirClaim, isInside, samePath, type Claim } from "./claims";
import { git, type Repo } from "./git";
import { plural } from "./ui";

export const BLOCK_BEGIN = "# >>> sich: managed, do not edit >>>";
export const BLOCK_END = "# <<< sich <<<";

/** Escape gitignore glob characters in a literal path. */
export function escapePattern(p: string): string {
  return p.replace(/[\\*?[]/g, (m) => "\\" + m).replace(/ $/, "\\ ");
}

export function baseExcludeLines(allClaims: Claim[]): string[] {
  const patterns = [...new Set(allClaims)].sort().map((c) => "/" + escapePattern(c));
  return ["/.sich/", ...patterns];
}

interface Node {
  kind: "file" | "dir" | "parent";
  children: Map<string, Node>;
}

export function layerExcludeLines(layer: string, own: Claim[], others: Claim[]): string[] {
  const root: Node = { kind: "parent", children: new Map() };
  const insert = (claim: Claim) => {
    const segs = bare(claim).split("/");
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      let child = node.children.get(seg);
      if (!child) {
        child = { kind: "parent", children: new Map() };
        node.children.set(seg, child);
      }
      if (child.kind !== "parent") return; // already covered by a file/dir claim higher up
      if (i === segs.length - 1) {
        child.kind = isDirClaim(claim) ? "dir" : "file";
        child.children.clear(); // a claim absorbs anything claimed beneath it
      }
      node = child;
    }
  };
  // Sort by depth so ancestors are inserted first and absorb their descendants.
  const ownWithManifest = [...own, `.sich/${layer}.paths`];
  [...ownWithManifest].sort((a, b) => bare(a).split("/").length - bare(b).split("/").length).forEach(insert);

  const out = ["/*"];
  const emit = (node: Node, prefix: string) => {
    for (const name of [...node.children.keys()].sort()) {
      const child = node.children.get(name)!;
      const p = escapePattern(prefix + name);
      if (child.kind === "dir") out.push(`!/${p}/`);
      else if (child.kind === "file") out.push(`!/${p}`);
      else {
        out.push(`!/${p}/`, `/${p}/*`);
        emit(child, prefix + name + "/");
      }
    }
  };
  emit(root, "");

  const carve = [...new Set(others)]
    .filter((o) => !own.some((c) => samePath(o, c) || isInside(c, o)))
    .sort();
  for (const o of carve) out.push("/" + escapePattern(o));
  return out;
}

/** Replace (or append) the managed block, preserving everything outside it. */
export function spliceBlock(content: string, body: string[]): string {
  const block = [BLOCK_BEGIN, ...body, BLOCK_END].join("\n") + "\n";
  const start = content.indexOf(BLOCK_BEGIN);
  if (start === -1) {
    const pre = content && !content.endsWith("\n") ? content + "\n" : content;
    return pre + block;
  }
  const end = content.indexOf(BLOCK_END, start);
  let after = end === -1 ? "" : content.slice(end + BLOCK_END.length);
  if (after.startsWith("\n")) after = after.slice(1);
  return content.slice(0, start) + block + after;
}

export function excludeFile(repo: Repo): string {
  const p = git(repo, ["rev-parse", "--git-path", "info/exclude"]).stdout.trim();
  return resolve(repo.workTree, p);
}

export interface ExcludeTarget {
  repo: Repo;
  lines: string[];
}

/** Root-relative path of a repo's info/exclude, for messages. */
export function excludeFileShown(repo: Repo): string {
  return relative(repo.workTree, excludeFile(repo));
}

/** What a target's block does and which file holds it, for messages. */
export function describeExclude(t: ExcludeTarget): string {
  const file = excludeFileShown(t.repo);
  if (t.repo.name !== "base") return `${t.repo.name} ignores everything except its claims -> ${file}`;
  const claims = t.lines.length - 1; // the first line is /.sich/
  return `excluded .sich/${claims ? ` and ${plural(claims, "private path")}` : ""} from base -> ${file}`;
}

/** Write the block if it differs. Returns true if the file was (or would be) changed. */
export function applyExclude(t: ExcludeTarget, write: boolean): boolean {
  const file = excludeFile(t.repo);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = spliceBlock(current, t.lines);
  if (next === current) return false;
  if (write) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return true;
}
