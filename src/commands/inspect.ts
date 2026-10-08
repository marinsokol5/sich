// sich which / sich ls: read-only views of ownership.

import { parseArgs } from "../args";
import { ownerOf } from "../claims";
import { allClaims, layerNames, layerRepo, requireLayer, resolveUserPath, type Ctx } from "../context";
import { git, isIgnored, splitZ, trackedUnder } from "../git";
import { c, fail, note, out } from "../ui";

export function cmdWhich(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, {});
  const [input, ...extra] = p.positionals;
  if (!input || extra.length) fail("usage: sich which <path>");
  const up = resolveUserPath(ctx, input, { allowSich: true });
  const path = up.rel;

  const owner = ownerOf(allClaims(ctx), path);
  if (owner) {
    const tracked = trackedUnder(layerRepo(ctx, owner.layer), [path]).length > 0;
    out(tracked ? owner.layer : `${owner.layer} ${c.dim("(claimed, not yet committed)")}`);
    return 0;
  }
  // Not claimed, but a layer may still track it (e.g. its own .sich/<layer>.paths).
  for (const layer of layerNames(ctx)) {
    if (trackedUnder(layerRepo(ctx, layer), [path]).length) {
      out(layer);
      return 0;
    }
  }
  if (trackedUnder(ctx.base, [path]).length) {
    out("base");
    return 0;
  }
  out(isIgnored(ctx.base, path, true) ? "ignored" : "untracked");
  return 0;
}

export function cmdLs(ctx: Ctx, args: string[]): number {
  const p = parseArgs(args, {});
  if (p.positionals.length > 1) fail("usage: sich ls [layer]");
  const only = p.positionals[0];
  if (only) requireLayer(ctx, only);
  const claims = allClaims(ctx);
  const layers = only ? [only] : layerNames(ctx);
  if (layers.length === 0) {
    note("no layers yet (create one with: sich new <layer>)");
    return 0;
  }
  layers.forEach((layer, i) => {
    if (i > 0) out();
    out(c.bold(layer));
    const own = claims.get(layer) ?? [];
    out(`  claims:${own.length ? "" : c.dim(" (none)")}`);
    for (const cl of own) out(`    ${cl}`);
    const files = splitZ(git(layerRepo(ctx, layer), ["ls-files", "-z"]).stdout);
    out(`  tracked:${files.length ? "" : c.dim(" (none)")}`);
    for (const f of files) out(`    ${f}`);
  });
  return 0;
}
