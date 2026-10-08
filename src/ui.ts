// Output helpers: colors (TTY + NO_COLOR aware), errors, notes.

export class SichError extends Error {}

/** Abort the current command with a one-line message (printed as `sich: <msg>`, exit 1). */
export function fail(message: string): never {
  throw new SichError(message);
}

const colorOut = !!process.stdout.isTTY && !process.env.NO_COLOR;
const colorErr = colorOut && !!process.stderr.isTTY;

function painter(enabled: boolean) {
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    cyan: wrap("36"),
  };
}

/** Colors for stdout. */
export const c = painter(colorOut);
/** Colors for stderr. */
export const ce = painter(colorErr);

export function out(line = ""): void {
  process.stdout.write(line + "\n");
}

export function note(line: string): void {
  out(c.dim(line));
}

export function warn(message: string): void {
  process.stderr.write(`${ce.yellow("warning:")} ${message}\n`);
}

export function printError(message: string): void {
  process.stderr.write(`${ce.red("sich:")} ${message}\n`);
}

export function plural(n: number, word: string, pluralWord = word + "s"): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Show at most `max` items, then "and N more". */
export function listSome(items: string[], max = 5): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}
