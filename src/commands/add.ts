// sich add / sich rm: changing what a layer claims.

import { parseArgs } from "../args";
import {
  bare,
  covers,
  isDirClaim,
  isInside,
  normalizeClaims,
  readManifest,
  samePath,
  storable,
  writeManifest,
  type Claim,
} from "../claims";
import {
  allClaims,
  ignoresCase,
  layerNames,
  layerRepo,
  manifestPath,
  manifestRel,
  requireLayer,
  resolveUserPath,
  syncExcludes,
  type Ctx,
} from "../context";
import { excludeFileShown } from "../excludes";
import { git, isIgnored, splitZ, trackedUnder, type Repo } from "../git";
import { c, fail, listSome, note, out, plural, warn } from "../ui";

interface Move {
  from: Repo;
  claim: Claim;
  /** Files to untrack in `from`. */
  files: string[];
  /** Claims to drop from `from`'s manifest (empty for base). */
  dropClaims: Claim[];
}

export function cmdAdd(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, { "--move": "bool" });
  const [layer, ...inputs] = p.positionals;
  if (!layer || inputs.length === 0) fail("usage: sich add <layer> <path...> [--move]");
  const move = p.flags["--move"] === true;
  const repo = requireLayer(ctx, layer);
  const claims = allClaims(ctx);
  const own = claims.get(layer) ?? [];
  const icase = ignoresCase(ctx);
  const fold = (s: string) => (icase ? s.toLowerCase() : s);

  const targets: Claim[] = [];
  for (const input of inputs) {
    const up = resolveUserPath(ctx, input);
    if (!up.exists) fail(`'${input}' does not exist`);
    const claim = up.isDir ? up.rel + "/" : up.rel;
    // Otherwise the claim would be lost on the next read and the path left visible to base.
    if (!storable(claim)) {
      fail(
        `cannot claim '${up.rel}': claims can't start with '#', start or end with whitespace, ` +
          `or contain line breaks (rename it, or claim a directory containing it)`,
      );
    }
    if (!targets.includes(claim)) targets.push(claim);
  }

  // Validate everything before touching anything.
  const moves: Move[] = [];
  for (const t of targets) {
    const inBase = trackedUnder(ctx.base, [t]);
    if (inBase.length) {
      if (!move) {
        fail(`${t} is tracked by base (${listSome(inBase, 3)}); use --move to move it into ${layer}`);
      }
      moves.push({ from: ctx.base, claim: t, files: inBase, dropClaims: [] });
    }
    for (const other of layerNames(ctx)) {
      if (other === layer) continue;
      const theirs = claims.get(other) ?? [];
      // Claims never nest across layers: a path inside another layer's directory
      // claim is refused outright, even with --move...
      const outer = theirs.find((cl) => isDirClaim(cl) && isInside(fold(t), fold(cl)));
      if (outer) {
        fail(
          `${t} is inside ${outer}, claimed by layer ${other}; claims can't nest across layers ` +
            `(to move all of it: sich add ${layer} ${outer} --move)`,
        );
      }
      // ...while its claims at or inside this path are taken over whole with --move.
      const inner = theirs.filter((cl) => covers(fold(t), fold(cl)));
      const tracked = trackedUnder(layerRepo(ctx, other), [t]);
      if (inner.length === 0 && tracked.length === 0) continue;
      if (!move) {
        const why = inner.some((cl) => samePath(fold(cl), fold(t)))
          ? `is claimed by layer ${other}`
          : inner.length
            ? `contains ${listSome(inner, 3)}, claimed by layer ${other}`
            : `is tracked by layer ${other}`;
        fail(`${t} ${why}; use --move to move it into ${layer}`);
      }
      moves.push({ from: layerRepo(ctx, other), claim: t, files: tracked, dropClaims: inner });
    }
  }

  for (const m of moves) {
    if (m.files.length) git(m.from, ["rm", "--cached", "-q", "--", ...m.files]);
    if (m.dropClaims.length) {
      const file = manifestPath(ctx, m.from.name);
      const man = readManifest(file, m.from.name);
      writeManifest(file, { ...man, claims: man.claims.filter((cl) => !m.dropClaims.includes(cl)) });
      git(m.from, ["add", "-f", "--", manifestRel(m.from.name)]);
    }
    if (m.from.name === "base") {
      warn(
        `moved ${m.claim} out of base: its removal is staged in base, commit it there (git commit). ` +
          `Old versions remain in base's history (and on its remote, which may be public). ` +
          `Rewrite that history and rotate any secrets if that matters.`,
      );
    } else {
      const changes = [
        m.dropClaims.length &&
          `dropped its ${plural(m.dropClaims.length, "claim")} ${listSome(m.dropClaims)} -> ${manifestRel(m.from.name)}`,
        m.files.length && `untracked ${plural(m.files.length, "file")} there`,
      ].filter(Boolean);
      warn(
        `moved ${m.claim} from ${m.from.name}: ${changes.join("; ")} ` +
          `(commit with: sich commit ${m.from.name} -m <msg>)`,
      );
    }
  }

  const file = manifestPath(ctx, layer);
  const man = readManifest(file, layer);
  const already = targets.filter((t) => own.some((cl) => covers(cl, t)));
  writeManifest(file, { ...man, claims: normalizeClaims([...man.claims, ...targets]) });
  syncExcludes(ctx);

  for (const t of targets) stage(repo, t);
  git(repo, ["add", "-f", "--", manifestRel(layer)]);

  for (const t of already) note(`${t} was already claimed by ${layer}`);
  out(`${c.green("claimed")} ${listSome(targets)} for ${c.bold(layer)} -> ${manifestRel(layer)}`);
  out(`hidden from base -> ${excludeFileShown(ctx.base)}`);
  note(`staged in ${layer}; commit with: sich commit ${layer} -m <msg>`);
  return 0;
}

/**
 * Stage a claim in its layer. Worktree .gitignore files outrank info/exclude, so an
 * explicitly claimed file is force-added (e.g. a .gitignore'd .env). Directory claims
 * are added normally so ignored junk inside them (node_modules, .DS_Store) stays out.
 */
function stage(repo: Repo, claim: Claim): void {
  if (!isDirClaim(claim)) {
    git(repo, ["add", "-f", "--", claim]);
    return;
  }
  const candidates = splitZ(git(repo, ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", claim]).stdout);
  if (candidates.length) {
    git(repo, ["add", "-A", "--", claim]);
  } else if (isIgnored(repo, bare(claim))) {
    warn(`${claim} is ignored by a .gitignore, so nothing in it was staged; claim individual files instead`);
  } else {
    note(`${claim} has no files yet; new files in it will belong to ${repo.name}`);
  }
}

export function cmdRm(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, {});
  const [layer, ...inputs] = p.positionals;
  if (!layer || inputs.length === 0) fail("usage: sich rm <layer> <path...>");
  const repo = requireLayer(ctx, layer);
  const file = manifestPath(ctx, layer);
  const man = readManifest(file, layer);

  const remove: Claim[] = [];
  for (const input of inputs) {
    const up = resolveUserPath(ctx, input);
    const forms = up.exists ? [up.isDir ? up.rel + "/" : up.rel] : [up.rel, up.rel + "/"];
    const hit = man.claims.find((cl) => forms.includes(cl));
    if (!hit) {
      const parent = man.claims.find((cl) => covers(cl, up.rel));
      fail(`${up.rel} is not claimed by ${layer}` + (parent ? ` (it is inside the claim ${parent})` : ""));
    }
    if (!remove.includes(hit)) remove.push(hit);
  }

  writeManifest(file, { ...man, claims: man.claims.filter((cl) => !remove.includes(cl)) });
  for (const cl of remove) git(repo, ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", cl]);
  syncExcludes(ctx);
  git(repo, ["add", "-f", "--", manifestRel(layer)]);

  out(`${c.green("released")} ${listSome(remove)} from ${c.bold(layer)} -> ${manifestRel(layer)}`);
  out(`no longer hidden from base -> ${excludeFileShown(ctx.base)}`);
  note(`staged in ${layer}; commit with: sich commit ${layer} -m <msg>`);
  note(`${plural(remove.length, "path")} left on disk; they now show as untracked in base (add, delete or .gitignore them)`);
  return 0;
}
