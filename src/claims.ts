// Claims: root-relative POSIX paths owned by a layer. Directory claims end with "/".
// The manifest (.sich/<layer>.paths) lists them one per line and is the single
// source of truth for ownership.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { warn } from "./ui";

export type Claim = string;

export const isDirClaim = (c: Claim): boolean => c.endsWith("/");
/** Claim without its trailing slash. */
export const bare = (c: Claim): string => (isDirClaim(c) ? c.slice(0, -1) : c);

/** Same path, regardless of file/dir form. */
export function samePath(a: string, b: string): boolean {
  return bare(a) === bare(b);
}

/** True if `p` is strictly inside directory `dir`. */
export function isInside(p: string, dir: string): boolean {
  return bare(p).startsWith(bare(dir) + "/");
}

/** True if `claim` owns path `p` (same path, or `p` lies under a directory claim). */
export function covers(claim: Claim, p: string): boolean {
  return samePath(claim, p) || (isDirClaim(claim) && isInside(p, claim));
}

/** Validate and normalize one manifest line; returns null if it is not a usable path. */
export function cleanClaim(raw: string): Claim | null {
  let p = raw.trim();
  while (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/")) p = p.replace(/^\/+/, "");
  const dir = p.endsWith("/");
  const segs = bare(p).split("/");
  if (!p || segs.some((s) => s === "" || s === "." || s === "..") || p.includes("\0")) return null;
  if (segs[0] === ".git" || segs[0] === ".sich") return null;
  return segs.join("/") + (dir ? "/" : "");
}

/**
 * True if `claim` survives a round trip through the manifest, which is line based,
 * trims whitespace and treats a leading "#" as a comment.
 */
export function storable(claim: Claim): boolean {
  return !/[\r\n]/.test(claim) && !claim.startsWith("#") && cleanClaim(claim) === claim;
}

/** Dedupe, drop claims absorbed by a directory claim of the same layer, sort. */
export function normalizeClaims(claims: Claim[]): Claim[] {
  const unique = [...new Set(claims)];
  // A file and a directory claim on the same path: keep the directory form.
  const kept = unique.filter((c) => !(!isDirClaim(c) && unique.includes(c + "/")));
  return kept.filter((c) => !kept.some((d) => d !== c && isDirClaim(d) && isInside(c, d))).sort();
}

// Manifests are read several times per command; report each problem once.
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  warn(message);
}

export interface Manifest {
  claims: Claim[];
  /** Comment lines, kept (at the top) when sich rewrites the file. */
  comments: string[];
}

export function readManifest(file: string, layer: string): Manifest {
  if (!existsSync(file)) return { claims: [], comments: [] };
  return parseManifest(readFileSync(file, "utf8"), layer);
}

/** Parse a manifest's text (e.g. the version in a layer's index). */
export function parseManifest(text: string, layer: string): Manifest {
  const claims: Claim[] = [];
  const comments: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      comments.push(line.trimEnd());
      continue;
    }
    const claim = cleanClaim(t);
    if (claim) claims.push(claim);
    else warnOnce(`${layer}: ignoring invalid claim ${JSON.stringify(t)} in .sich/${layer}.paths`);
  }
  return { claims: normalizeClaims(claims), comments };
}

export function writeManifest(file: string, m: Manifest): void {
  const body = [...m.comments, ...normalizeClaims(m.claims)];
  writeFileSync(file, body.length ? body.join("\n") + "\n" : "");
}

/**
 * The most specific claim covering `p` among all layers, if any. `icase` matches
 * case-insensitively, as git does on case-insensitive filesystems (core.ignorecase).
 */
export function ownerOf(
  all: Map<string, Claim[]>,
  p: string,
  icase = false,
): { layer: string; claim: Claim } | null {
  const fold = (s: string) => (icase ? s.toLowerCase() : s);
  const path = fold(p);
  let best: { layer: string; claim: Claim } | null = null;
  for (const [layer, claims] of all) {
    for (const claim of claims) {
      if (covers(fold(claim), path) && (!best || bare(claim).length > bare(best.claim).length)) {
        best = { layer, claim };
      }
    }
  }
  return best;
}
