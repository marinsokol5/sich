// Minimal hand-rolled option parser for subcommands.

import { fail } from "./ui";

/** bool: flag only; value: requires an argument; optional: takes the next arg unless it looks like an option. */
export type OptionKind = "bool" | "value" | "optional";

export interface Parsed {
  flags: Record<string, string | true>;
  positionals: string[];
}

export function parseArgs(
  argv: string[],
  spec: Record<string, OptionKind>,
  aliases: Record<string, string> = {},
): Parsed {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    let name = arg;
    let value: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    name = aliases[name] ?? name;
    const kind = spec[name];
    if (!kind) fail(`unknown option '${arg}'`);
    if (kind === "bool") {
      if (value !== undefined) fail(`option '${name}' takes no value`);
      flags[name] = true;
    } else if (kind === "value") {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) fail(`option '${name}' needs a value`);
      }
      flags[name] = value;
    } else {
      const next = argv[i + 1];
      if (value === undefined && next !== undefined && !next.startsWith("-")) {
        value = next;
        i++;
      }
      flags[name] = value ?? true;
    }
  }
  return { flags, positionals };
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** True if --help/-h appears before any "--". */
export function wantsHelp(argv: string[]): boolean {
  for (const a of argv) {
    if (a === "--") return false;
    if (a === "--help" || a === "-h") return true;
  }
  return false;
}
