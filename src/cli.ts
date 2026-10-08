#!/usr/bin/env node
// sich: private git layers sharing one working tree with a normal repo.

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../package.json";
import { wantsHelp } from "./args";
import { cmdAdd, cmdRm } from "./commands/add";
import { cmdCheck } from "./commands/check";
import { cmdCommit } from "./commands/commit";
import { cmdInit } from "./commands/init";
import { cmdLs, cmdWhich } from "./commands/inspect";
import { cmdAttach, cmdNew } from "./commands/layer";
import { cmdStatus } from "./commands/status";
import { cmdRemote } from "./commands/sync";
import { COMMANDS, layerExists, loadCtx, repoByName, requireInit, syncExcludes, type Ctx } from "./context";
import { gitInherit } from "./git";
import { COMMAND_HELP, MAIN_HELP } from "./help";
import { fail, out, printError, SichError } from "./ui";

/**
 * Replaced at build time via `--define SICH_DEV=...`. `install:global` builds
 * with SICH_DEV=true, so a locally installed `sich` reports "-dev"; publishing
 * always rebuilds without it (prepublishOnly).
 */
declare const SICH_DEV: boolean | undefined;

const VERSION = typeof SICH_DEV !== "undefined" && SICH_DEV ? `${pkg.version}-dev` : pkg.version;

type Command = (typeof COMMANDS)[number];
type Handler = (ctx: Ctx, args: string[]) => number;

const HANDLERS: Record<Exclude<Command, "help">, Handler> = {
  init: cmdInit,
  new: cmdNew,
  attach: cmdAttach,
  add: cmdAdd,
  rm: cmdRm,
  which: cmdWhich,
  ls: cmdLs,
  status: cmdStatus,
  commit: cmdCommit,
  pull: (ctx, a) => cmdRemote(ctx, "pull", a),
  push: (ctx, a) => cmdRemote(ctx, "push", a),
  sync: (ctx, a) => cmdRemote(ctx, "sync", a),
  check: cmdCheck,
};

/** Commands that work before `sich init` (they set it up themselves). */
const SELF_INIT = new Set<string>(["init", "new", "attach"]);

function changeDir(cwd: string, dir: string): string {
  const target = resolve(cwd, dir);
  try {
    if (!statSync(target).isDirectory()) fail(`-C ${dir}: not a directory`);
    return realpathSync(target);
  } catch (e) {
    if (e instanceof SichError) throw e;
    fail(`-C ${dir}: no such directory`);
  }
}

export function main(argv: string[]): number {
  let cwd = realpathSync(process.cwd());
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-C") {
      const dir = argv[++i];
      if (dir === undefined) fail("-C needs a directory");
      cwd = changeDir(cwd, dir);
    } else if (a.startsWith("-C") && a.length > 2) {
      cwd = changeDir(cwd, a.slice(2));
    } else if (a === "-h" || a === "--help") {
      out(MAIN_HELP.trimEnd());
      return 0;
    } else if (a === "-V" || a === "--version") {
      out(`sich ${VERSION}`);
      return 0;
    } else if (a.startsWith("-")) {
      fail(`unknown option '${a}' (see sich --help)`);
    } else break;
  }

  const name = argv[i];
  const rest = argv.slice(i + 1);
  if (name === undefined) {
    out(MAIN_HELP.trimEnd());
    return 0;
  }
  if (name === "help") {
    const topic = rest[0];
    if (topic && !COMMAND_HELP[topic]) fail(`no help for '${topic}'`);
    out((topic ? COMMAND_HELP[topic]! : MAIN_HELP).trimEnd());
    return 0;
  }

  if (Object.hasOwn(HANDLERS, name)) {
    if (wantsHelp(rest)) {
      out(COMMAND_HELP[name]!);
      return 0;
    }
    const ctx = loadCtx(cwd);
    if (!SELF_INIT.has(name)) requireInit(ctx);
    // Regenerate excludes on every command (cheap, self-healing). `check` is the
    // exception: it reports stale blocks, and rewrites them only with --fix.
    if (name !== "check") syncExcludes(ctx);
    return HANDLERS[name as keyof typeof HANDLERS](ctx, rest);
  }

  // Passthrough: sich <layer|base> <git args...>
  const ctx = loadCtx(cwd);
  if (name !== "base" && !layerExists(ctx, name)) {
    fail(`unknown command or layer '${name}' (see sich --help)`);
  }
  syncExcludes(ctx);
  const code = gitInherit(repoByName(ctx, name), rest, ctx.cwd);
  syncExcludes(ctx);
  return code;
}

let code: number;
try {
  code = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof SichError) printError(e.message);
  else printError(process.env.SICH_DEBUG ? String((e as Error).stack) : String((e as Error).message ?? e));
  code = 1;
}
process.exit(code);
