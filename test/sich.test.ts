// Integration tests: run the CLI as a subprocess against temp repos with local bare remotes.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { CLI, managedBlock, Sandbox, statusPaths } from "./helpers";

setDefaultTimeout(60_000);

let sb: Sandbox;
beforeEach(() => {
  sb = new Sandbox();
});
afterEach(() => {
  sb.cleanup();
});

const baseStatus = (root: string) => statusPaths(sb.git(root, "status", "--porcelain", "-uall"));
const layerStatus = (root: string, layer: string) =>
  statusPaths(sb.layerGit(root, layer, "status", "--porcelain", "-uall"));
const layerFiles = (root: string, layer: string) =>
  sb.layerGit(root, layer, "ls-files").split("\n").filter(Boolean).sort();
/** Exit code of `git check-ignore -q` (0 = ignored). */
const ignoredIn = (root: string, layer: string | null, path: string) => {
  const repoArgs = layer ? [`--git-dir=${join(root, ".sich", layer)}`, `--work-tree=${root}`] : [];
  return sb.run(["git", ...repoArgs, "check-ignore", "-q", path], root).code === 0;
};

/** True on case-insensitive filesystems (the macOS default). */
const CASE_INSENSITIVE_FS = (() => {
  const probe = new Sandbox();
  try {
    probe.write(probe.dir, "CaseProbe", "");
    return existsSync(probe.path("caseprobe"));
  } finally {
    probe.cleanup();
  }
})();

/** Base repo with sich initialized and the given layers created. */
function setup(...layers: string[]): string {
  const root = sb.repo("proj");
  sb.ok(root, "init");
  for (const l of layers) sb.ok(root, "new", l);
  return root;
}

describe("1. init", () => {
  test("is idempotent, installs the hook, preserves user excludes", () => {
    const root = sb.repo("proj");
    sb.write(root, ".git/info/exclude", "# mine\n*.tmp\n");
    const first = sb.ok(root, "init");
    expect(first).toContain("installed pre-commit hook");
    const hook = join(root, ".git/hooks/pre-commit");
    expect(readFileSync(hook, "utf8")).toContain('exec "$sich" check --staged');
    expect(statSync(hook).mode & 0o111).not.toBe(0);

    const second = sb.ok(root, "init");
    expect(second).toContain("already initialized");
    expect(second).not.toContain("installed");
    const exclude = sb.read(root, ".git/info/exclude");
    expect(exclude.startsWith("# mine\n*.tmp\n")).toBe(true);
    expect(exclude.split("# >>> sich").length).toBe(2);
    expect(managedBlock(exclude)).toEqual(["/.sich/"]);
    expect(baseStatus(root)).toEqual([]);
  });

  test("does not overwrite an existing hook or a core.hooksPath setup", () => {
    const root = sb.repo("proj");
    sb.write(root, ".git/hooks/pre-commit", "#!/bin/sh\necho custom\n");
    const out = sb.ok(root, "init");
    expect(out).toContain("add this line");
    const line = '"${SICH_BIN:-sich}" check --staged || exit 1';
    expect(out).toContain(line);
    expect(sb.read(root, ".git/hooks/pre-commit")).toBe("#!/bin/sh\necho custom\n");

    // Once the line is added, init stops asking and the user's hook guards base
    // (sich is found via SICH_BIN, which the sandbox sets).
    sb.write(root, ".git/hooks/pre-commit", `#!/bin/sh\necho custom\n${line}\n`);
    chmodSync(join(root, ".git/hooks/pre-commit"), 0o755);
    expect(sb.ok(root, "init")).not.toContain("add this line");
    sb.ok(root, "new", "notes");
    sb.write(root, "secret.md", "s\n");
    sb.ok(root, "claim", "notes", "secret.md");
    sb.git(root, "add", "-f", "secret.md");
    const blocked = sb.run(["git", "commit", "-m", "leak"], root, { PATH: "/usr/bin:/bin" });
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("staged change to private path secret.md");

    const other = sb.repo("other");
    sb.git(other, "config", "core.hooksPath", ".githooks");
    const out2 = sb.ok(other, "init");
    expect(out2).toContain("core.hooksPath");
    expect(existsSync(join(other, ".githooks/pre-commit"))).toBe(false);
    expect(existsSync(join(other, ".git/hooks/pre-commit"))).toBe(false);
  });
});

describe("2. claims hide files from base and show them in the layer", () => {
  test("new + add file + add dir", () => {
    const root = setup("notes");
    expect(sb.read(root, ".sich/notes/config")).toMatch(/worktree = \.\.\/\.\./);
    expect(sb.layerGit(root, "notes", "log", "--format=%s")).toBe("sich: create layer notes\n");

    sb.write(root, "NOTES.md", "notes\n");
    sb.write(root, "roadmap/q1.md", "q1\n");
    sb.write(root, "src/app.ts", "code\n");
    sb.ok(root, "claim", "notes", "NOTES.md", "roadmap");

    expect(sb.read(root, ".sich/notes.paths")).toContain("NOTES.md\nroadmap/\n");
    expect(baseStatus(root)).toEqual(["src/app.ts"]);
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "NOTES.md", "roadmap/q1.md"]);
    expect(ignoredIn(root, null, "NOTES.md")).toBe(true);
    expect(ignoredIn(root, "notes", "src/app.ts")).toBe(true);

    // A new file inside a claimed directory belongs to the layer automatically.
    sb.write(root, "roadmap/q2.md", "q2\n");
    expect(baseStatus(root)).toEqual(["src/app.ts"]);
    expect(layerStatus(root, "notes")).toContain("roadmap/q2.md");

    // Paths are taken relative to the current directory.
    sb.write(root, "src/private.md", "p\n");
    sb.ok(join(root, "src"), "claim", "notes", "private.md");
    expect(sb.read(root, ".sich/notes.paths")).toContain("src/private.md\n");
    expect(baseStatus(root)).toEqual(["src/app.ts"]);
  });

  test("names the manifest can't hold are refused instead of silently left visible to base", () => {
    const root = setup("notes");
    const manifest = sb.read(root, ".sich/notes.paths");
    for (const name of ["trailing ", " leading", "#hash.md"]) {
      sb.write(root, name, "x\n");
      expect(sb.bad(root, "claim", "notes", name)).toContain("cannot claim");
    }
    expect(sb.read(root, ".sich/notes.paths")).toBe(manifest);
    expect(layerStatus(root, "notes")).toEqual([]);
    // Only a leading "#" in the whole path is a problem.
    sb.write(root, "dir/#ok.md", "x\n");
    sb.ok(root, "claim", "notes", "dir/#ok.md");
    expect(baseStatus(root)).toHaveLength(3);
    expect(baseStatus(root)).not.toContain("dir/#ok.md");
  });

  test.if(CASE_INSENSITIVE_FS)("a mistyped case is claimed as spelled on disk", () => {
    const root = setup("notes");
    sb.write(root, "Docs/NOTES.md", "n\n");
    sb.ok(root, "claim", "notes", "docs/notes.md");
    expect(sb.read(root, ".sich/notes.paths")).toContain("\nDocs/NOTES.md\n");
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "Docs/NOTES.md"]);
    expect(baseStatus(root)).toEqual([]);
  });
});

describe("3. overlapping claims", () => {
  test("claims sharing parent directories", () => {
    const root = setup("notes");
    for (const f of ["a/x.md", "a/y.md", "a/b/c.md", "a/b/z.md", "a/b/d/e.md", "a/b/d/f.md"]) sb.write(root, f, f);
    sb.ok(root, "claim", "notes", "a/b/c.md", "a/x.md", "a/b/d");
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "a/b/c.md", "a/b/d/e.md", "a/b/d/f.md", "a/x.md"]);
    expect(baseStatus(root)).toEqual(["a/b/z.md", "a/y.md"]);
    sb.ok(root, "commit", "notes", "-m", "claims");
    // Claiming a sibling later must not hide earlier ones.
    sb.ok(root, "claim", "notes", "a/y.md");
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "a/y.md"]);
    expect(baseStatus(root)).toEqual(["a/b/z.md"]);
  });

  test("files in the same folder can belong to different layers", () => {
    const root = setup("notes", "keys");
    sb.write(root, "docs/guide.md", "g\n");
    sb.write(root, "docs/api.env", "KEY=1\n");
    sb.write(root, "docs/public.md", "p\n");
    sb.ok(root, "claim", "notes", "docs/guide.md");
    sb.ok(root, "claim", "keys", "docs/api.env");
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "docs/guide.md"]);
    expect(layerStatus(root, "keys")).toEqual([".sich/keys.paths", "docs/api.env"]);
    expect(baseStatus(root)).toEqual(["docs/public.md"]);
    expect(sb.ok(root, "which", "docs/api.env").trim()).toBe("keys");
    expect(sb.ok(root, "which", "docs/guide.md").trim()).toBe("notes");
  });

  test("claims can't nest across layers, even with --move", () => {
    const root = setup("notes", "keys");
    sb.write(root, "docs/guide.md", "g\n");
    sb.write(root, "docs/api.env", "KEY=1\n");
    sb.ok(root, "claim", "notes", "docs");
    for (const flags of [[], ["--move"]]) {
      expect(sb.bad(root, "claim", "keys", "docs/api.env", ...flags)).toContain(
        "docs/api.env is inside docs/, claimed by layer notes; claims can't nest across layers",
      );
    }
    expect(sb.read(root, ".sich/keys.paths")).not.toContain("docs");
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "docs/api.env", "docs/guide.md"]);
  });

  test("an outer folder takes over another layer's claims inside it only with --move", () => {
    const root = setup("notes", "keys");
    sb.write(root, "docs/guide.md", "g\n");
    sb.write(root, "docs/api.env", "KEY=1\n");
    sb.ok(root, "claim", "keys", "docs/api.env");
    sb.ok(root, "commit", "keys", "-m", "keys");
    expect(sb.bad(root, "claim", "notes", "docs")).toContain("docs/ contains docs/api.env, claimed by layer keys");

    const moved = sb.sich(root, ["claim", "notes", "docs", "--move"]);
    expect(moved.code).toBe(0);
    expect(moved.stderr).toContain(
      "warning: moved docs/ from keys: dropped its 1 claim docs/api.env -> .sich/keys.paths; untracked 1 file there",
    );
    expect(sb.read(root, ".sich/keys.paths")).not.toContain("docs/api.env");
    expect(sb.layerGit(root, "keys", "ls-files", "--cached", "docs")).toBe("");
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "docs/api.env", "docs/guide.md"]);
    sb.ok(root, "commit", "notes", "keys", "-m", "moved");
    expect(sb.ok(root, "check")).toContain("ok");
  });

  test("check flags claims that arrive nested (e.g. via pull)", () => {
    const root = setup("notes", "keys");
    sb.write(root, "docs/guide.md", "g\n");
    sb.ok(root, "claim", "notes", "docs");
    sb.write(root, ".sich/keys.paths", "docs/api.env\n");
    expect(sb.bad(root, "check")).toContain(
      "docs/api.env (keys) is nested inside docs/ (notes); claims can't nest across layers (fix: sich unclaim keys docs/api.env)",
    );
  });
});

describe("4. moving paths out of base", () => {
  test("add refuses a base-tracked path without --move; --move untracks it from base and warns", () => {
    const root = setup("notes");
    sb.write(root, "plan.md", "secret plan\n");
    sb.git(root, "add", "plan.md");
    sb.git(root, "commit", "-q", "-m", "oops");

    const refused = sb.bad(root, "claim", "notes", "plan.md");
    expect(refused).toContain("tracked by base");
    expect(sb.read(root, ".sich/notes.paths")).not.toContain("plan.md");

    const r = sb.sich(root, ["claim", "notes", "plan.md", "--move"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("warning");
    expect(r.stderr).toContain("history");
    expect(sb.git(root, "ls-files", "plan.md")).toBe("");
    expect(sb.git(root, "status", "--porcelain")).toBe("D  plan.md\n");
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "plan.md"]);
    expect(sb.read(root, "plan.md")).toBe("secret plan\n");
  });

  test("add refuses a path claimed by another layer", () => {
    const root = setup("notes", "keys");
    sb.write(root, "x.md", "x\n");
    sb.ok(root, "claim", "notes", "x.md");
    expect(sb.bad(root, "claim", "keys", "x.md")).toContain("notes");
    sb.ok(root, "claim", "keys", "x.md", "--move");
    expect(sb.read(root, ".sich/notes.paths")).not.toContain("x.md");
    expect(layerFiles(root, "keys")).toContain("x.md");
    expect(layerFiles(root, "notes")).not.toContain("x.md");
  });
});

describe("5. gitignored files", () => {
  test("a .gitignore'd .env can be claimed and committed by a layer", () => {
    const root = setup("keys");
    sb.write(root, ".gitignore", ".env\nnode_modules/\n");
    sb.git(root, "add", ".gitignore");
    sb.git(root, "commit", "-q", "-m", "ignore");
    sb.write(root, ".env", "TOKEN=abc\n");
    sb.write(root, "config/settings.json", "{}\n");
    sb.write(root, "config/node_modules/junk.js", "junk\n");
    expect(sb.ok(root, "which", ".env").trim()).toBe("ignored");

    sb.ok(root, "claim", "keys", ".env", "config");
    expect(sb.ok(root, "commit", "-m", "secrets")).toContain("keys: committed");
    expect(layerFiles(root, "keys")).toEqual([".env", ".sich/keys.paths", "config/settings.json"]);
    expect(sb.ok(root, "which", ".env").trim()).toBe("keys");

    sb.write(root, ".env", "TOKEN=changed\n");
    expect(layerStatus(root, "keys")).toEqual([".env"]);
    expect(sb.ok(root, "commit", "-m", "rotate")).toContain("keys: committed");
  });

  test("a .gitignore negation can't make commit take another layer's file", () => {
    const root = setup("notes", "keys");
    // "!team.local" outranks every repo's info/exclude, so keys sees notes's file.
    sb.write(root, ".gitignore", "*.local\n!team.local\n");
    sb.git(root, "add", ".gitignore");
    sb.git(root, "commit", "-q", "-m", "ignore");
    sb.write(root, "team.local", "notes only\n");
    sb.write(root, "k.env", "K=1\n");
    sb.ok(root, "claim", "notes", "team.local");
    sb.ok(root, "claim", "keys", "k.env");

    const r = sb.sich(root, ["commit", "-m", "both"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("keys: left out 1 file it doesn't own: team.local");
    expect(layerFiles(root, "keys")).toEqual([".sich/keys.paths", "k.env"]);
    expect(layerFiles(root, "notes")).toEqual([".sich/notes.paths", "team.local"]);
  });
});

/** Base + notes + keys pushed to bare remotes; returns the remote paths. */
function published() {
  const baseRemote = sb.bare("proj.git");
  const notesRemote = sb.bare("proj-notes.git");
  const keysRemote = sb.bare("proj-keys.git");
  const root = sb.repo("proj");
  sb.git(root, "remote", "add", "origin", baseRemote);
  sb.write(root, ".gitignore", ".env\n");
  sb.git(root, "add", ".gitignore");
  sb.git(root, "commit", "-q", "-m", "gitignore");
  sb.ok(root, "init");
  sb.ok(root, "new", "notes", "--remote", notesRemote);
  sb.ok(root, "new", "keys", "--remote", keysRemote);
  sb.write(root, "NOTES.md", "my notes\n");
  sb.write(root, "roadmap/q1.md", "q1\n");
  sb.write(root, "docs/guide.md", "guide\n");
  sb.write(root, "docs/api.env", "KEY=1\n");
  sb.write(root, ".env", "TOKEN=1\n");
  sb.ok(root, "claim", "keys", ".env", "docs/api.env");
  sb.ok(root, "claim", "notes", "NOTES.md", "roadmap", "docs/guide.md");
  sb.ok(root, "commit", "-m", "private stuff");
  const pushed = sb.ok(root, "push");
  expect(pushed).toContain("push -u origin main");
  return { root, baseRemote, notesRemote, keysRemote };
}

function attachClone(name: string, r: ReturnType<typeof published>): string {
  sb.git(sb.dir, "clone", "-q", r.baseRemote, name);
  const clone = sb.path(name);
  expect(existsSync(join(clone, "NOTES.md"))).toBe(false);
  sb.ok(clone, "init");
  sb.ok(clone, "attach", "notes", r.notesRemote);
  sb.ok(clone, "attach", "keys", r.keysRemote);
  return clone;
}

describe("6. collaborator flow", () => {
  test("commit + push, then clone + attach reproduces layers and excludes", () => {
    const r = published();
    // The public repo never saw private file names.
    const publicFiles = sb.git(r.baseRemote, "ls-tree", "-r", "--name-only", "main");
    expect(publicFiles.split("\n").filter(Boolean).sort()).toEqual([".gitignore", "README.md"]);
    expect(sb.git(r.baseRemote, "log", "--all", "--format=%s")).not.toContain("private");

    const clone = attachClone("clone", r);
    for (const f of ["NOTES.md", "roadmap/q1.md", "docs/guide.md", "docs/api.env", ".env"]) {
      expect(sb.read(clone, f)).toBe(sb.read(r.root, f));
    }
    for (const repo of [".git", ".sich/notes", ".sich/keys"]) {
      expect(managedBlock(sb.read(clone, `${repo}/info/exclude`))).toEqual(
        managedBlock(sb.read(r.root, `${repo}/info/exclude`)),
      );
    }
    expect(baseStatus(clone)).toEqual([]);
    expect(layerStatus(clone, "notes")).toEqual([]);
    expect(layerStatus(clone, "keys")).toEqual([]);
    expect(sb.layerGit(clone, "notes", "rev-parse", "--abbrev-ref", "@{u}").trim()).toBe("origin/main");
    expect(sb.ok(clone, "check")).toContain("ok");
    const status = sb.ok(clone, "status");
    expect(status).toMatch(/^base\s+main\s+origin\/main up to date\s+clean$/m);
    expect(status).toMatch(/^notes\s+main\s+origin\/main up to date\s+clean$/m);
  });

  test("attach refuses to overwrite existing files", () => {
    const r = published();
    sb.git(sb.dir, "clone", "-q", r.baseRemote, "clone");
    const clone = sb.path("clone");
    sb.write(clone, "NOTES.md", "local\n");
    expect(sb.bad(clone, "attach", "notes", r.notesRemote)).toContain("NOTES.md");
    expect(sb.read(clone, "NOTES.md")).toBe("local\n");
    expect(existsSync(join(clone, ".sich/notes"))).toBe(false);
  });

  test("attach checks out the remote's default branch; a relative URL is taken from the current directory", () => {
    const remote = sb.bare("notes.git");
    const root = setup("notes");
    sb.write(root, "NOTES.md", "n\n");
    sb.ok(root, "claim", "notes", "NOTES.md");
    sb.ok(root, "commit", "-m", "notes");
    sb.ok(root, "notes", "branch", "-m", "trunk");
    sb.ok(root, "notes", "push", "-q", remote, "trunk");
    sb.git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");

    const other = sb.repo("other");
    sb.write(other, "src/app.ts", "code\n");
    const out = sb.ok(join(other, "src"), "attach", "notes", "../../remotes/notes.git");
    expect(out).toContain("(branch trunk)");
    expect(sb.read(other, "NOTES.md")).toBe("n\n");
    expect(sb.layerGit(other, "notes", "remote", "get-url", "origin").trim()).toBe(remote);
    expect(sb.layerGit(other, "notes", "rev-parse", "--abbrev-ref", "@{u}").trim()).toBe("origin/trunk");
    expect(baseStatus(other)).toEqual(["src/app.ts"]);
  });

  test("attach fails cleanly for an empty remote and warns about a wrong layer name", () => {
    const r = published();
    const clone = sb.repo("clone");
    const empty = sb.bare("empty.git");
    expect(sb.bad(clone, "attach", "notes", empty)).toContain("has no branch 'main'");
    expect(existsSync(join(clone, ".sich/notes"))).toBe(false);
    expect(sb.bad(clone, "attach", "notes", sb.path("missing.git"))).toContain("cannot fetch");
    expect(existsSync(join(clone, ".sich/notes"))).toBe(false);

    const wrong = sb.sich(clone, ["attach", "jotter", r.notesRemote]);
    expect(wrong.code).toBe(0);
    expect(wrong.stderr).toContain("has no .sich/jotter.paths; is the layer name right?");
  });
});

describe("7. pull", () => {
  test("pull brings in another clone's new claims and regenerates excludes", () => {
    const r = published();
    const a = attachClone("a", r);
    const b = attachClone("b", r);

    sb.write(b, "ideas/one.md", "idea\n");
    sb.write(b, "TODO.md", "todo\n");
    sb.ok(b, "claim", "notes", "ideas", "TODO.md");
    sb.ok(b, "commit", "notes", "-m", "ideas");
    sb.ok(b, "push", "notes");

    expect(sb.read(a, ".git/info/exclude")).not.toContain("/ideas/");
    const out = sb.ok(a, "pull");
    expect(out).toContain("notes: git pull --rebase --autostash");
    expect(sb.read(a, "ideas/one.md")).toBe("idea\n");
    expect(managedBlock(sb.read(a, ".git/info/exclude"))).toContain("/ideas/");
    expect(baseStatus(a)).toEqual([]);
    expect(layerStatus(a, "notes")).toEqual([]);

    // sync = pull + push, per repo.
    sb.write(a, "ideas/two.md", "two\n");
    sb.ok(a, "commit", "-m", "two");
    sb.ok(a, "sync");
    sb.ok(b, "pull", "notes");
    expect(sb.read(b, "ideas/two.md")).toBe("two\n");
  });

  test("pull refuses to overwrite files the repo doesn't track (git would, since they're ignored)", () => {
    const r = published();
    const a = attachClone("a", r);
    const b = attachClone("b", r);

    // A teammate claims TODO.md; here TODO.md is a local, untracked file.
    sb.write(b, "TODO.md", "theirs\n");
    sb.ok(b, "claim", "notes", "TODO.md");
    sb.ok(b, "commit", "notes", "-m", "todo");
    sb.ok(b, "push", "notes");
    sb.write(a, "TODO.md", "mine\n");
    const refused = sb.bad(a, "pull");
    expect(refused).toContain("notes: pull would overwrite 1 local path it doesn't track: TODO.md");
    expect(refused).toContain("pull failed in notes (would overwrite local files)");
    expect(sb.read(a, "TODO.md")).toBe("mine\n");
    renameSync(join(a, "TODO.md"), join(a, "TODO.mine.md"));
    sb.ok(a, "pull");
    expect(sb.read(a, "TODO.md")).toBe("theirs\n");

    // Someone commits a public file at a path a layer owns here: base must not clobber it.
    sb.write(a, "NOTES.md", "uncommitted private edit\n");
    sb.git(sb.dir, "clone", "-q", r.baseRemote, "plain");
    const plain = sb.path("plain");
    sb.write(plain, "NOTES.md", "public\n");
    sb.git(plain, "add", "NOTES.md");
    sb.git(plain, "commit", "-q", "-m", "public notes");
    sb.git(plain, "push", "-q");
    expect(sb.bad(a, "pull", "base")).toContain("base: pull would overwrite 1 local path it doesn't track: NOTES.md (notes)");
    expect(sb.read(a, "NOTES.md")).toBe("uncommitted private edit\n");
    expect(sb.git(a, "log", "-1", "--format=%s")).toBe("gitignore\n");
  });

  test("status --fetch shows commits waiting on the remotes; a failed fetch only warns", () => {
    const r = published();
    const a = attachClone("a", r);
    const b = attachClone("b", r);
    sb.write(b, "NOTES.md", "edited\n");
    sb.ok(b, "commit", "-m", "edit");
    sb.ok(b, "push", "notes");

    expect(sb.ok(a, "status")).toMatch(/^notes\s+main\s+origin\/main up to date\s+clean$/m);
    const fetched = sb.ok(a, "status", "--fetch");
    expect(fetched).toMatch(/^notes\s+main\s+origin\/main behind 1\s+clean$/m);
    expect(fetched).toMatch(/^base\s+main\s+origin\/main up to date\s+clean$/m);

    sb.layerGit(a, "keys", "remote", "set-url", "origin", sb.path("gone.git"));
    const warned = sb.sich(a, ["status", "--fetch"]);
    expect(warned.code).toBe(0);
    expect(warned.stderr).toContain("warning: keys: fetch failed");
    expect(warned.stdout).toMatch(/^keys\s+main/m);
  });

  test("repos without a remote are skipped; failures stop with the repo name", () => {
    const root = setup("notes", "keys");
    expect(sb.ok(root, "pull")).toContain("base: no remote, skipped");
    sb.layerGit(root, "notes", "remote", "add", "origin", sb.path("does-not-exist.git"));
    const r = sb.sich(root, ["push"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("push failed in notes");
    expect(sb.bad(root, "push", "nope")).toContain("no such layer");
  });
});

describe("8. check and the pre-commit hook", () => {
  test("check detects conflicts and stale excludes; --fix repairs excludes", () => {
    const root = setup("notes", "keys");
    sb.write(root, "a.md", "a\n");
    sb.ok(root, "claim", "notes", "a.md");
    expect(sb.ok(root, "check")).toContain("ok");

    // Same path claimed by two layers (hand-edited manifest).
    sb.write(root, ".sich/keys.paths", "a.md\n");
    expect(sb.bad(root, "check")).toContain("a.md is claimed by more than one layer: keys, notes");
    sb.write(root, ".sich/keys.paths", "");

    // Base tracking a claimed path.
    sb.git(root, "add", "-f", "a.md");
    sb.git(root, "commit", "-q", "--no-verify", "-m", "leak");
    expect(sb.bad(root, "check")).toContain("base tracks a.md, which is claimed by notes");
    sb.git(root, "rm", "-q", "--cached", "a.md");
    sb.git(root, "commit", "-q", "--no-verify", "-m", "unleak");

    // Base tracking .sich/.
    sb.git(root, "add", "-f", ".sich/notes.paths");
    expect(sb.bad(root, "check")).toContain("under .sich/");
    sb.git(root, "rm", "-q", "--cached", ".sich/notes.paths");

    // Stale exclude block (check itself does not regenerate).
    const excl = join(".sich", "notes", "info", "exclude");
    sb.write(root, excl, sb.read(root, excl).replace("!/a.md\n", ""));
    expect(sb.bad(root, "check")).toContain("stale exclude rules of notes in .sich/notes/info/exclude");
    expect(sb.ok(root, "check", "--fix")).toContain("rewrote: notes ignores everything except its claims -> .sich/notes/info/exclude");
    expect(sb.read(root, excl)).toContain("!/a.md\n");
    expect(sb.ok(root, "check")).toContain("ok");
  });

  test("the hook blocks committing a claimed file to base, but allows normal commits", () => {
    const root = setup("notes");
    sb.write(root, "secret.md", "s\n");
    sb.write(root, "public.md", "p\n");
    sb.ok(root, "claim", "notes", "secret.md");
    sb.ok(root, "commit", "notes", "-m", "secret");
    sb.git(root, "add", "public.md");
    sb.git(root, "commit", "-q", "--no-verify", "-m", "public");

    const PATH = `${sb.sichOnPath()}:${process.env.PATH}`;
    sb.git(root, "add", "-f", "secret.md");
    const blocked = sb.run(["git", "commit", "-m", "leak"], root, { PATH });
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("staged change to private path secret.md");
    expect(blocked.stdout + blocked.stderr).toContain("git restore --staged -- secret.md");
    expect(sb.git(root, "log", "--format=%s")).toBe("public\ninit\n");

    // A partial commit (git commit -- <path>) uses a temporary index passed via
    // GIT_INDEX_FILE: only what is actually committed counts, so this passes
    // although secret.md is still staged in the real index.
    sb.write(root, "public.md", "p1\n");
    const partial = sb.run(["git", "commit", "-q", "-m", "partial", "--", "public.md"], root, { PATH });
    expect(partial.stdout + partial.stderr).toBe("");
    expect(partial.code).toBe(0);
    expect(sb.git(root, "show", "--name-only", "--format=", "HEAD")).toBe("public.md\n");

    sb.git(root, "restore", "--staged", "secret.md");
    sb.write(root, "public.md", "p2\n");
    sb.git(root, "add", "public.md");
    const allowed = sb.run(["git", "commit", "-q", "-m", "public2"], root, { PATH });
    expect(allowed.stdout + allowed.stderr).toBe("");
    expect(allowed.code).toBe(0);

    // Without sich on PATH, SICH_BIN tells the hook where sich is.
    const noPath = { PATH: "/usr/bin:/bin", SICH_BIN: join(sb.sichOnPath(), "sich") };
    sb.git(root, "add", "-f", "secret.md");
    const blockedNoPath = sb.run(["git", "commit", "-m", "leak"], root, noPath);
    expect(blockedNoPath.code).not.toBe(0);
    expect(blockedNoPath.stdout + blockedNoPath.stderr).toContain("staged change to private path secret.md");
    sb.git(root, "restore", "--staged", "secret.md");
    sb.write(root, "public.md", "p3\n");
    sb.git(root, "add", "public.md");
    const allowedNoPath = sb.run(["git", "commit", "-q", "-m", "p3"], root, noPath);
    expect(allowedNoPath.stdout + allowedNoPath.stderr).toBe("");
    expect(allowedNoPath.code).toBe(0);
  });

  test("the hook blocks commits when sich can't be found (fail closed)", () => {
    const root = setup("notes");
    sb.write(root, "public.md", "p\n");
    sb.git(root, "add", "public.md");
    const noSich = { PATH: "/usr/bin:/bin", SICH_BIN: "" };
    const blocked = sb.run(["git", "commit", "-q", "-m", "public"], root, noSich);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("commit blocked: 'sich' not found");
    expect(blocked.stderr).toContain("SICH_BIN");
    expect(blocked.stderr).toContain("--no-verify");
    expect(sb.git(root, "log", "--format=%s")).toBe("init\n");

    const wrongBin = { PATH: "/usr/bin:/bin", SICH_BIN: "/nonexistent/sich" };
    const blocked2 = sb.run(["git", "commit", "-q", "-m", "public"], root, wrongBin);
    expect(blocked2.code).not.toBe(0);
    expect(blocked2.stderr).toContain("'/nonexistent/sich' not found");
  });

  test("the hook blocks on ambiguous ownership but only warns about stale excludes", () => {
    const root = setup("notes", "team");
    sb.write(root, "public.md", "p\n");
    sb.write(root, "about-teammates.md", "private\n");
    sb.ok(root, "claim", "notes", "about-teammates.md");

    const excl = join(".sich", "notes", "info", "exclude");
    sb.write(root, excl, sb.read(root, excl).replace("!/about-teammates.md\n", ""));
    sb.git(root, "add", "public.md");
    const warned = sb.run(["git", "commit", "-q", "-m", "public"], root);
    expect(warned.code).toBe(0);
    expect(warned.stderr).toContain("stale exclude rules of notes in .sich/notes/info/exclude");
    expect(warned.stderr).toContain("not blocking this commit");

    // Two layers claiming the same file could leak personal notes into a shared layer.
    sb.write(root, ".sich/team.paths", "about-teammates.md\n");
    sb.write(root, "public.md", "p2\n");
    sb.git(root, "add", "public.md");
    const blocked = sb.run(["git", "commit", "-q", "-m", "public2"], root);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("about-teammates.md is claimed by more than one layer: notes, team");
    expect(sb.git(root, "log", "--format=%s")).toBe("public\ninit\n");
  });

  test("init updates a hook written by an older sich", () => {
    const root = setup();
    const hookRel = ".git/hooks/pre-commit";
    const old = "#!/bin/sh\n# Installed by sich: old version\nexec sich check --staged\n";
    sb.write(root, hookRel, old);
    expect(sb.ok(root, "init")).toContain("updated pre-commit hook");
    expect(sb.read(root, hookRel)).toContain("SICH_BIN");
    expect(sb.ok(root, "init")).not.toContain("updated pre-commit hook");
  });

  test("the hook lets base commit the removal of a moved path", () => {
    const root = setup("notes");
    sb.write(root, "plan.md", "p\n");
    sb.git(root, "add", "plan.md");
    sb.git(root, "commit", "-q", "-m", "plan");
    sb.ok(root, "claim", "notes", "plan.md", "--move");
    const PATH = `${sb.sichOnPath()}:${process.env.PATH}`;
    const r = sb.run(["git", "commit", "-q", "-m", "move plan out"], root, { PATH });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  test("with core.ignorecase the hook catches a claimed path staged under another spelling", () => {
    const root = setup("notes");
    sb.write(root, "Docs/NOTES.md", "n\n");
    sb.ok(root, "claim", "notes", "Docs");
    // What `git add -f docs` can produce on a case-insensitive filesystem.
    const blob = sb.git(root, "hash-object", "-w", "Docs/NOTES.md").trim();
    sb.git(root, "update-index", "--add", "--cacheinfo", `100644,${blob},docs/NOTES.md`);
    sb.git(root, "config", "core.ignorecase", "true");
    const blocked = sb.run(["git", "commit", "-q", "-m", "leak"], root);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("staged change to private path docs/NOTES.md (claimed by notes)");
  });

  test("the hook passes in a linked worktree, which has no .sich/", () => {
    const root = setup("notes");
    sb.git(root, "worktree", "add", "-q", sb.path("wt"));
    const wt = sb.path("wt");
    sb.write(wt, "x.md", "x\n");
    sb.git(wt, "add", "x.md");
    const r = sb.run(["git", "commit", "-q", "-m", "from worktree"], wt);
    expect(r.stdout + r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(sb.bad(wt, "check")).toContain("not initialized");
  });
});

describe("9. which / ls / unclaim / passthrough / names / --gh", () => {
  test("which, ls and unclaim", () => {
    const root = setup("notes");
    sb.write(root, ".gitignore", "*.log\n");
    sb.git(root, "add", ".gitignore");
    sb.git(root, "commit", "-q", "-m", "ignore");
    sb.write(root, "NOTES.md", "n\n");
    sb.write(root, "roadmap/q1.md", "q\n");
    sb.write(root, "debug.log", "x\n");
    sb.write(root, "loose.txt", "x\n");
    sb.ok(root, "claim", "notes", "NOTES.md", "roadmap");
    sb.ok(root, "commit", "notes", "-m", "notes");

    expect(sb.ok(root, "which", "NOTES.md").trim()).toBe("notes");
    expect(sb.ok(root, "which", "roadmap/q1.md").trim()).toBe("notes");
    expect(sb.ok(root, "which", "roadmap/later.md").trim()).toBe("notes (claimed, not yet committed)");
    expect(sb.ok(root, "which", "README.md").trim()).toBe("base");
    expect(sb.ok(root, "which", "debug.log").trim()).toBe("ignored");
    expect(sb.ok(root, "which", "loose.txt").trim()).toBe("untracked");
    expect(sb.ok(join(root, "roadmap"), "which", "q1.md").trim()).toBe("notes");

    const ls = sb.ok(root, "ls");
    expect(ls).toContain("notes\n  claims:\n    NOTES.md\n    roadmap/\n  tracked:\n");
    expect(ls).toContain("    roadmap/q1.md\n");
    expect(sb.bad(root, "ls", "nope")).toContain("no such layer");

    expect(sb.bad(root, "unclaim", "notes", "roadmap/q1.md")).toContain("inside the claim roadmap/");
    const rm = sb.ok(root, "unclaim", "notes", "NOTES.md");
    expect(rm).toContain("untracked in base");
    expect(existsSync(join(root, "NOTES.md"))).toBe(true);
    expect(sb.read(root, ".sich/notes.paths")).not.toContain("NOTES.md");
    expect(baseStatus(root)).toEqual(["NOTES.md", "loose.txt"]);
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "NOTES.md"]);
    sb.ok(root, "commit", "notes", "-m", "release");
    expect(layerFiles(root, "notes")).toEqual([".sich/notes.paths", "roadmap/q1.md"]);
    expect(sb.ok(root, "which", "NOTES.md").trim()).toBe("untracked");
  });

  test("add and rm are aliases of claim and unclaim; <layer> add/rm stay plain git", () => {
    const root = setup("notes");
    const help = sb.ok(root, "--help");
    expect(help).toMatch(/^  claim <layer> <path\.\.\.> \[--move\]/m);
    expect(help).toMatch(/^  unclaim <layer> <path\.\.\.>/m);
    expect(help).not.toMatch(/^  (add|rm) /m);
    expect(sb.ok(root, "add", "--help")).toContain("usage: sich claim");
    expect(sb.ok(root, "add", "--help")).toContain("Alias: sich add.");
    expect(sb.ok(root, "help", "rm")).toContain("usage: sich unclaim");

    sb.write(root, "a.md", "a\n");
    sb.write(root, "b.md", "b\n");
    // Passthrough is git add: the layer ignores what it hasn't claimed.
    const gitAdd = sb.sich(root, ["notes", "add", "a.md"]);
    expect(gitAdd.code).not.toBe(0);
    expect(gitAdd.stderr).toContain("ignored");
    expect(sb.read(root, ".sich/notes.paths")).not.toContain("a.md");

    expect(sb.ok(root, "add", "notes", "a.md")).toContain("claimed a.md for notes");
    expect(sb.ok(root, "claim", "notes", "b.md")).toContain("claimed b.md for notes");
    expect(sb.read(root, ".sich/notes.paths")).toContain("a.md\nb.md\n");
    expect(layerStatus(root, "notes")).toEqual([".sich/notes.paths", "a.md", "b.md"]);
    sb.ok(root, "commit", "notes", "-m", "a and b");

    expect(sb.ok(root, "rm", "notes", "a.md")).toContain("released a.md from notes");
    expect(sb.ok(root, "unclaim", "notes", "b.md")).toContain("released b.md from notes");
    expect(existsSync(join(root, "a.md")) && existsSync(join(root, "b.md"))).toBe(true);
    expect(baseStatus(root)).toEqual(["a.md", "b.md"]);
    expect(sb.bad(root, "unclaim", "notes", "a.md")).toContain("a.md is not claimed by notes");
    expect(sb.bad(root, "claim", "notes")).toContain("usage: sich claim");

    // Passthrough rm is git rm, which deletes the file.
    sb.ok(root, "claim", "notes", "a.md");
    sb.ok(root, "commit", "notes", "-m", "a again");
    expect(sb.sich(root, ["notes", "rm", "-q", "a.md"]).code).toBe(0);
    expect(existsSync(join(root, "a.md"))).toBe(false);
  });

  test("passthrough runs git against the layer and returns git's exit code", () => {
    const root = setup("notes");
    const log = sb.sich(root, ["notes", "log", "--format=%s"]);
    expect(log.code).toBe(0);
    expect(log.stdout).toBe("sich: create layer notes\n");
    expect(sb.sich(root, ["notes", "rev-parse", "--verify", "-q", "nope"]).code).toBe(1);
    expect(sb.sich(root, ["notes", "no-such-subcommand"]).code).not.toBe(0);
    expect(sb.sich(root, ["base", "log", "--format=%s"]).stdout).toBe("init\n");
    expect(sb.bad(root, "nosuchlayer", "status")).toContain("unknown command or layer");
  });

  test("reserved and invalid layer names are rejected", () => {
    const root = setup();
    for (const name of ["base", "status", "claim", "unclaim", "add", "rm", "help"]) {
      expect(sb.bad(root, "new", name)).toContain("reserved");
    }
    for (const name of ["Notes", "-x", "a/b", "_x", "with space"]) {
      expect(sb.bad(root, "new", name, "--remote", "x")).toMatch(/invalid layer name|unknown option/);
    }
    sb.ok(root, "new", "my-notes.v2");
    expect(sb.bad(root, "new", "my-notes.v2")).toContain("already exists");
  });

  test("--gh creates a private repo with the (fake) gh CLI and sets origin", () => {
    const root = setup();
    sb.git(root, "remote", "add", "origin", "git@github.com:me/myproj.git");
    const log = sb.path("gh.log");
    const gh = sb.script(
      "fake-gh",
      `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$2" = view ]; then echo "git@github.com:me/$3.git"; fi\n`,
    );
    const r = sb.sich(root, ["new", "notes", "--gh"], { SICH_GH: gh });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(
      "repo create myproj-notes --private\nrepo view myproj-notes --json sshUrl -q .sshUrl\n",
    );
    expect(sb.layerGit(root, "notes", "remote", "get-url", "origin").trim()).toBe("git@github.com:me/myproj-notes.git");

    const r2 = sb.sich(root, ["new", "keys", "--gh", "custom-name"], { SICH_GH: gh });
    expect(r2.code).toBe(0);
    expect(sb.layerGit(root, "keys", "remote", "get-url", "origin").trim()).toBe("git@github.com:me/custom-name.git");

    const failing = sb.script("failing-gh", "#!/bin/sh\nexit 3\n");
    expect(sb.sich(root, ["new", "x", "--gh"], { SICH_GH: failing }).code).toBe(1);
    expect(existsSync(join(root, ".sich/x"))).toBe(false);
  });
});

describe("cli basics", () => {
  test("--help, <cmd> --help, --version, -C, uninitialized repo", () => {
    const root = sb.repo("proj");
    expect(sb.ok(root, "--help")).toContain("usage: sich");
    expect(sb.ok(root, "claim", "--help")).toContain("usage: sich claim");
    expect(sb.ok(root, "--version")).toMatch(/^sich \d+\.\d+\.\d+/);
    expect(sb.bad(root, "status")).toContain("not initialized");
    sb.ok(sb.dir, "-C", "proj", "init");
    expect(sb.ok(sb.dir, "-C", root, "status")).toMatch(/^base\s+main/m);
    expect(sb.bad(sb.dir, "status")).toContain("not inside a git repository");
    expect(sb.bad(root, "status", "--bogus")).toContain("unknown option");
    expect(sb.bad(root, "commit")).toContain("usage");
    expect(sb.bad(root, "commit", "nope", "-m", "x")).toContain("no such layer");
  });

  test("--version is plain by default and -dev for a SICH_DEV=true build", () => {
    const root = sb.repo("proj");
    expect(sb.ok(root, "--version")).toBe(`sich ${pkg.version}\n`);

    // Same build as `SICH_DEV=true pnpm run build` (what install:global does), into the sandbox.
    const devCli = sb.path("dev/cli.js");
    const src = join(dirname(CLI), "../src/cli.ts");
    const build = ["bun", "build", src, "--target", "node", "--outfile", devCli, "--define", "SICH_DEV=true"];
    expect(sb.run(build, sb.dir).code).toBe(0);
    expect(sb.run(["node", devCli, "--version"], root).stdout).toBe(`sich ${pkg.version}-dev\n`);
  });

  test("commit covers base too: everything by default, or only the named repos", () => {
    const root = setup("notes");
    sb.write(root, "public.md", "p\n");
    sb.write(root, "NOTES.md", "n\n");
    sb.ok(root, "claim", "notes", "NOTES.md");
    const both = sb.ok(root, "commit", "-m", "both");
    expect(both).toMatch(/^base: committed \w+ \(1 file\): public\.md$/m);
    expect(both).toMatch(/^notes: committed \w+ \(2 files\): \.sich\/notes\.paths, NOTES\.md$/m);
    expect(sb.git(root, "ls-files")).not.toContain("NOTES.md");

    sb.write(root, "public.md", "p2\n");
    sb.write(root, "NOTES.md", "n2\n");
    expect(sb.ok(root, "commit", "base", "-m", "only base")).toMatch(/^base: committed/m);
    expect(sb.git(root, "log", "--format=%s", "-1")).toBe("only base\n");
    expect(layerStatus(root, "notes")).toEqual(["NOTES.md"]);
  });

  test("status counts and -v", () => {
    const root = setup("notes");
    sb.write(root, "NOTES.md", "n\n");
    sb.write(root, "extra.md", "e\n");
    sb.ok(root, "claim", "notes", "NOTES.md");
    const out = sb.ok(root, "status", "-v");
    expect(out).toMatch(/^base\s+main\s+no upstream\s+1 untracked$/m);
    expect(out).toMatch(/^notes\s+main\s+no upstream\s+2 staged$/m);
    expect(out).toContain("    A  NOTES.md");
    expect(out).toContain("    ?? extra.md");
  });
});
