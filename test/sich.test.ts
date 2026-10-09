// Integration tests: run the CLI as a subprocess against temp repos with local bare remotes.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
    for (const name of ["pre-commit", "pre-merge-commit"]) {
      expect(first).toContain(`installed ${name} hook -> .git/hooks/${name}`);
      const hook = join(root, ".git/hooks", name);
      expect(readFileSync(hook, "utf8")).toContain('exec "$sich" check --staged');
      expect(statSync(hook).mode & 0o111).not.toBe(0);
    }

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
    expect(out2).toContain(`core.hooksPath is set (.githooks); add this line to its pre-commit hook:\n  ${line}`);
    expect(out2).toContain(
      'core.hooksPath is set (.githooks); add this line to its pre-merge-commit hook:\n  "${SICH_BIN:-sich}" check --staged --merge || exit 1',
    );
    for (const hook of ["pre-commit", "pre-merge-commit"]) {
      expect(existsSync(join(other, ".githooks", hook))).toBe(false);
      expect(existsSync(join(other, ".git/hooks", hook))).toBe(false);
    }
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
    // attach guards the layer like new does.
    expect(sb.read(clone, ".sich/notes/hooks/pre-commit")).toContain("# Installed by sich for layer notes:");
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

describe("8. check and the guard hooks", () => {
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
    expect(warned.stderr).toContain("(fix: sich check --fix); not blocking\n");

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

  test("a layer's hook blocks committing a file it doesn't own, staged via the passthrough", () => {
    const root = setup("personal");
    expect(sb.read(root, ".sich/personal/hooks/pre-commit")).toContain('exec "$sich" check --staged\n');
    sb.write(root, "marin.md", "m\n");

    // `sich personal add` is plain git add: refused, since personal hasn't claimed it...
    expect(sb.sich(root, ["personal", "add", "marin.md"]).code).not.toBe(0);
    // ...but -f gets it staged anyway, and the layer's hook catches it.
    expect(sb.sich(root, ["personal", "add", "-f", "marin.md"]).code).toBe(0);
    const blocked = sb.sich(root, ["personal", "commit", "-m", "notes"]);
    expect(blocked.code).not.toBe(0);
    const out = blocked.stdout + blocked.stderr;
    expect(out).toContain("personal has a staged change to marin.md, which none of its claims cover");
    expect(out).toContain("claim with: sich claim personal marin.md");
    expect(out).toContain("or untrack with: sich personal rm --cached -- marin.md");
    expect(out).not.toContain("personal tracks marin.md"); // reported once
    expect(sb.layerGit(root, "personal", "log", "--format=%s")).toBe("sich: create layer personal\n");

    // Claiming it is one fix; then the same commit goes through, silently.
    sb.ok(root, "claim", "personal", "marin.md");
    const allowed = sb.sich(root, ["personal", "commit", "-q", "-m", "notes"]);
    expect(allowed.stdout + allowed.stderr).toBe("");
    expect(allowed.code).toBe(0);
    expect(sb.layerGit(root, "personal", "show", "--name-only", "--format=", "HEAD")).toBe(
      ".sich/personal.paths\nmarin.md\n",
    );
    expect(sb.ok(root, "check")).toContain("ok");
  });

  test("a layer's hook blocks other layers' files and .sich/, checks only what is committed", () => {
    const root = setup("personal", "team");
    sb.write(root, "team.md", "t\n");
    sb.write(root, "mine.md", "m\n");
    sb.ok(root, "claim", "team", "team.md");
    sb.ok(root, "claim", "personal", "mine.md");
    sb.ok(root, "commit", "-m", "both");

    sb.layerGit(root, "personal", "add", "-f", "team.md", ".sich/team.paths");
    const blocked = sb.run(["git", "commit", "-m", "leak"], root, {
      GIT_DIR: join(root, ".sich/personal"),
      GIT_WORK_TREE: root,
    });
    expect(blocked.code).not.toBe(0);
    const out = blocked.stdout + blocked.stderr;
    expect(out).toContain("personal has a staged change to team.md, which is claimed by team");
    expect(out).toContain("personal has a staged change to .sich/team.paths, which is under .sich/");
    expect(out).toContain("untrack with: sich personal rm --cached -- .sich/team.paths team.md");
    expect(out).not.toContain("claim with");
    expect(out).not.toContain("tracked by more than one layer"); // reported once

    // A partial commit uses a temporary index (GIT_INDEX_FILE): only what is
    // actually committed counts, so this passes although team.md is still staged.
    sb.write(root, "mine.md", "m2\n");
    const partial = sb.sich(root, ["personal", "commit", "-q", "-m", "partial", "--", "mine.md"]);
    expect(partial.stdout + partial.stderr).toBe("");
    expect(partial.code).toBe(0);
    expect(sb.layerGit(root, "personal", "show", "--name-only", "--format=", "HEAD")).toBe("mine.md\n");

    sb.ok(root, "personal", "rm", "-q", "--cached", "--", "team.md", ".sich/team.paths");
    expect(sb.ok(root, "check")).toContain("ok");
  });

  test("untracking a file a layer doesn't own (the check fix) can be committed", () => {
    const root = setup("personal");
    sb.write(root, "marin.md", "m\n");
    sb.sich(root, ["personal", "add", "-f", "marin.md"]);
    // What a layer without the hook (or --no-verify) let through.
    sb.ok(root, "personal", "commit", "-q", "--no-verify", "-m", "oops");
    expect(sb.bad(root, "check")).toContain(
      "personal tracks marin.md but none of its claims cover it (fix: sich personal rm --cached -- marin.md)",
    );
    // An unrelated layer commit is blocked while the layer tracks it.
    expect(sb.sich(root, ["personal", "commit", "--allow-empty", "-m", "x"]).code).not.toBe(0);

    sb.ok(root, "personal", "rm", "--cached", "-q", "--", "marin.md");
    const fixed = sb.sich(root, ["personal", "commit", "-q", "-m", "untrack marin.md"]);
    expect(fixed.stdout + fixed.stderr).toBe("");
    expect(fixed.code).toBe(0);
    expect(layerFiles(root, "personal")).toEqual([".sich/personal.paths"]);
    expect(sb.read(root, "marin.md")).toBe("m\n");
    expect(sb.ok(root, "check")).toContain("ok");
  });

  test("a layer's hook fails closed when sich can't be found", () => {
    const root = setup("notes");
    sb.write(root, "n.md", "n\n");
    sb.ok(root, "claim", "notes", "n.md");
    const blocked = sb.sich(root, ["notes", "commit", "-q", "-m", "n"], { PATH: "/usr/bin:/bin", SICH_BIN: "" });
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("commit blocked: 'sich' not found");
    expect(blocked.stderr).toContain("skip once: sich notes commit --no-verify");
    expect(sb.layerGit(root, "notes", "log", "--format=%s")).toBe("sich: create layer notes\n");
    expect(sb.bad(root, "check", "--repo", "notes")).toContain("--repo only applies with --staged");
    expect(sb.bad(root, "check", "--staged", "--repo", "nope")).toContain("no such layer");
  });

  test("init installs or refreshes hooks in existing layers, leaving user-written hooks alone", () => {
    const root = setup("notes", "team");
    const notesHook = ".sich/notes/hooks/pre-commit";
    const teamHook = ".sich/team/hooks/pre-commit";
    // A layer created before layers had hooks, and one with an older sich hook.
    rmSync(join(root, notesHook));
    sb.write(root, teamHook, "#!/bin/sh\n# Installed by sich for layer team: old version\nexec sich check --staged\n");
    const out = sb.ok(root, "init");
    expect(out).toContain("installed pre-commit hook of notes -> .sich/notes/hooks/pre-commit");
    expect(out).toContain("updated pre-commit hook of team -> .sich/team/hooks/pre-commit");
    expect(out).not.toContain("pre-commit hook ->"); // base's is current
    expect(sb.read(root, notesHook)).toContain("# Installed by sich for layer notes:");
    expect(sb.read(root, teamHook)).toContain("skip once: sich team commit --no-verify");
    expect(statSync(join(root, notesHook)).mode & 0o111).not.toBe(0);
    expect(sb.ok(root, "init")).not.toContain("pre-commit hook");

    // A hook the user wrote stays as is; init prints the line to add.
    const custom = "#!/bin/sh\necho custom\n";
    sb.write(root, notesHook, custom);
    const asked = sb.ok(root, "init");
    const line = '"${SICH_BIN:-sich}" check --staged || exit 1';
    expect(asked).toContain(`pre-commit hook of notes exists (${notesHook}); add this line to it:\n  ${line}`);
    expect(asked).not.toContain("of team");
    expect(sb.read(root, notesHook)).toBe(custom);

    // Once the line is in, init stops asking and the user's hook guards the layer.
    sb.write(root, notesHook, `${custom}${line}\n`);
    chmodSync(join(root, notesHook), 0o755);
    expect(sb.ok(root, "init")).not.toContain("add this line");
    sb.write(root, "stray.md", "s\n");
    sb.layerGit(root, "notes", "add", "-f", "stray.md");
    const blocked = sb.sich(root, ["notes", "commit", "-m", "stray"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("custom");
    expect(blocked.stdout + blocked.stderr).toContain("notes has a staged change to stray.md");
  });

  test("one hook line guards base and every layer, even in a core.hooksPath shared by projects", () => {
    const line = '"${SICH_BIN:-sich}" check --staged || exit 1';
    const shared = sb.script("shared-hooks/pre-commit", `#!/bin/sh\n${line}\n`);
    const mergeLine = '"${SICH_BIN:-sich}" check --staged --merge || exit 1';
    sb.script("shared-hooks/pre-merge-commit", `#!/bin/sh\n${mergeLine}\n`);
    sb.git(sb.dir, "config", "--global", "core.hooksPath", dirname(shared));

    // The shared hook already runs sich, so init and new leave it be.
    const a = sb.repo("a");
    expect(sb.ok(a, "init")).not.toContain("hook");
    // The layer's initial commit already runs the shared hook, as that layer.
    expect(sb.ok(a, "new", "notes")).not.toContain("hook");
    expect(existsSync(join(a, ".git/hooks/pre-commit"))).toBe(false);
    expect(existsSync(join(a, ".sich/notes/hooks/pre-commit"))).toBe(false);
    const b = sb.repo("b");
    sb.ok(b, "init");
    sb.ok(b, "new", "team"); // a has notes, b doesn't: the hook names no layer
    expect(sb.sich(a, ["check"]).stderr).toBe("");

    sb.write(a, "n.md", "n\n");
    sb.ok(a, "claim", "notes", "n.md");
    const layerOk = sb.sich(a, ["notes", "commit", "-q", "-m", "n"]);
    expect(layerOk.stdout + layerOk.stderr).toBe("");
    expect(layerOk.code).toBe(0);

    // In a layer it checks that layer, however git was pointed at it.
    sb.write(a, "stray.md", "s\n");
    sb.layerGit(a, "notes", "add", "-f", "stray.md");
    const layerBlocked = sb.run(["git", "--git-dir=.sich/notes", "--work-tree=.", "commit", "-m", "stray"], a);
    expect(layerBlocked.code).not.toBe(0);
    expect(layerBlocked.stdout + layerBlocked.stderr).toContain("notes has a staged change to stray.md");
    sb.layerGit(a, "notes", "rm", "-q", "--cached", "stray.md");

    // In base it checks base, in each project.
    sb.git(a, "add", "-f", "n.md");
    const baseBlocked = sb.run(["git", "commit", "-m", "leak"], a);
    expect(baseBlocked.code).not.toBe(0);
    expect(baseBlocked.stdout + baseBlocked.stderr).toContain("staged change to private path n.md");
    sb.write(b, "public.md", "p\n");
    sb.git(b, "add", "public.md");
    const baseOk = sb.run(["git", "commit", "-q", "-m", "public"], b);
    expect(baseOk.stdout + baseOk.stderr).toBe("");
    expect(baseOk.code).toBe(0);

    // A shared hooks directory guarding commits but not merges: init asks for the
    // missing hook (without writing into it) and check warns about it.
    rmSync(sb.path("shared-hooks/pre-merge-commit"));
    expect(sb.ok(a, "init")).toContain(
      `core.hooksPath is set (${dirname(shared)}); add this line to its pre-merge-commit hook:\n  ${mergeLine}`,
    );
    expect(existsSync(sb.path("shared-hooks/pre-merge-commit"))).toBe(false);
    expect(sb.sich(a, ["check"]).stderr).toContain(
      `warning: notes has no pre-merge-commit hook running sich check --staged (../shared-hooks/pre-merge-commit)`,
    );
  });

  test("a layer's hook checks the claims list being committed, not only the one on disk", () => {
    const root = setup("notes");
    sb.write(root, "x.md", "x\n");
    sb.ok(root, "claim", "notes", "x.md");
    // A partial commit without the claims list would publish x.md unclaimed.
    const partial = sb.sich(root, ["notes", "commit", "-m", "x", "--", "x.md"]);
    expect(partial.code).not.toBe(0);
    const out = partial.stdout + partial.stderr;
    expect(out).toContain("notes has a staged change to x.md, which .sich/notes.paths as committed doesn't claim");
    expect(out).toContain("commit .sich/notes.paths along with it");
    expect(sb.layerGit(root, "notes", "log", "--format=%s")).toBe("sich: create layer notes\n");

    const both = sb.sich(root, ["notes", "commit", "-q", "-m", "x", "--", "x.md", ".sich/notes.paths"]);
    expect(both.stdout + both.stderr).toBe("");
    expect(both.code).toBe(0);
    expect(sb.layerGit(root, "notes", "show", "HEAD:.sich/notes.paths")).toContain("x.md\n");
  });

  test("the claim hint uses --move for a path base tracks", () => {
    const root = setup("notes");
    sb.ok(root, "notes", "add", "-f", "README.md");
    const blocked = sb.sich(root, ["notes", "commit", "-m", "readme"]);
    expect(blocked.code).not.toBe(0);
    const out = blocked.stdout + blocked.stderr;
    expect(out).toContain("claim with (base tracks README.md): sich claim notes README.md --move");
    expect(out).not.toContain("claim with: sich claim notes README.md");
    sb.ok(root, "claim", "notes", "README.md", "--move");
    expect(sb.sich(root, ["notes", "commit", "-q", "-m", "readme"]).code).toBe(0);
  });

  test("check warns (without failing) about a repo whose pre-commit hook doesn't run sich", () => {
    const root = setup("notes");
    expect(sb.sich(root, ["check"]).stderr).toBe("");
    rmSync(join(root, ".sich/notes/hooks/pre-commit"));
    const missing = sb.sich(root, ["check"]);
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain("sich check: ok");
    expect(missing.stderr).toContain(
      "warning: notes has no pre-commit hook running sich check --staged (.sich/notes/hooks/pre-commit); fix: sich init",
    );
    expect(missing.stderr).not.toContain("base has");
    sb.write(root, ".git/hooks/pre-commit", "#!/bin/sh\necho custom\n");
    expect(sb.sich(root, ["check"]).stderr).toContain("warning: base has no pre-commit hook running sich check");
    // The hook itself stays quiet about it.
    sb.git(root, "add", "README.md");
    expect(sb.sich(root, ["check", "--staged"]).stderr).toBe("");
    sb.ok(root, "init");
    sb.write(root, ".git/hooks/pre-commit", '#!/bin/sh\necho custom\n"${SICH_BIN:-sich}" check --staged || exit 1\n');
    expect(sb.sich(root, ["check"]).stderr).toBe("");
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

  /** A SICH_BIN that logs each run's arguments before running sich: proves a hook ran, and how. */
  function loggingSich(): { env: Record<string, string>; runs: () => string } {
    const log = sb.path("sich-runs.log");
    const bin = sb.script("bin/logging-sich", `#!/bin/sh\necho "$*" >> "${log}"\nexec "${sb.env.SICH_BIN}" "$@"\n`);
    return { env: { SICH_BIN: bin }, runs: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
  }

  /** Base pushed to a local bare remote, and a plain-git clone of it: a teammate without sich. */
  function withTeammate(root: string): string {
    const remote = sb.bare("base.git");
    sb.git(root, "remote", "add", "origin", remote);
    sb.git(root, "push", "-q", "-u", "origin", "main");
    const mate = sb.path("mate");
    sb.git(sb.dir, "clone", "-q", remote, mate);
    return mate;
  }

  const MERGE_LINE = '"${SICH_BIN:-sich}" check --staged --merge || exit 1';

  test("the generated hooks, byte for byte", () => {
    const root = setup("notes");
    const body = (header: string, op: string, skip: string, check: string) =>
      [
        "#!/bin/sh",
        header,
        'sich="${SICH_BIN:-sich}"',
        'if ! command -v "$sich" >/dev/null 2>&1; then',
        `  echo "sich: ${op} blocked: '$sich' not found; put sich on PATH or set SICH_BIN (skip once: ${skip} ${op} --no-verify)" >&2`,
        "  exit 1",
        "fi",
        `exec "$sich" ${check}`,
        "",
      ].join("\n");
    const base = "# Installed by sich: stop private (layer-claimed) files from being committed to base.";
    const notes = "# Installed by sich for layer notes: stop files notes doesn't own from being committed to it.";
    expect(sb.read(root, ".git/hooks/pre-commit")).toBe(body(base, "commit", "git", "check --staged"));
    expect(sb.read(root, ".git/hooks/pre-merge-commit")).toBe(body(base, "merge", "git", "check --staged --merge"));
    expect(sb.read(root, ".sich/notes/hooks/pre-commit")).toBe(body(notes, "commit", "sich notes", "check --staged"));
    expect(sb.read(root, ".sich/notes/hooks/pre-merge-commit")).toBe(
      body(notes, "merge", "sich notes", "check --staged --merge"),
    );
    expect(sb.bad(root, "check", "--merge")).toContain("--merge only applies with --staged");
  });

  test("base's pre-merge-commit hook blocks a merge bringing in a private file, passes a clean one", () => {
    const root = setup("notes");
    const { env, runs } = loggingSich();
    sb.write(root, "secret.md", "s\n");
    sb.ok(root, "claim", "notes", "secret.md");
    // A side branch that let a claimed file into base with --no-verify.
    sb.git(root, "switch", "-q", "-c", "leaky");
    sb.git(root, "add", "-f", "secret.md");
    sb.git(root, "commit", "-q", "--no-verify", "-m", "leak");
    sb.git(root, "switch", "-q", "main");
    // A conflict-free merge commit runs pre-merge-commit, not pre-commit.
    const blocked = sb.run(["git", "merge", "--no-ff", "-m", "merge leaky", "leaky"], root, env);
    expect(blocked.code).not.toBe(0);
    expect(runs()).toBe("check --staged --merge\n");
    const out = blocked.stdout + blocked.stderr;
    expect(out).toContain("base has a staged change to private path secret.md (claimed by notes)");
    expect(out).toContain("this merge isn't committed; back it out with: git merge --abort");
    expect(out).toContain("don't unstage them and commit the merge: that drops the other side's changes to them");
    expect(out).toContain("sich pull refuses up front to overwrite such files");
    expect(out).not.toContain("unstage with");
    expect(sb.git(root, "log", "--format=%s")).toBe("init\n");
    sb.git(root, "merge", "--abort");

    // git pull without --rebase merges the same way.
    const pulled = sb.run(["git", "pull", "--no-rebase", "--no-ff", "-q", ".", "leaky"], root, env);
    expect(pulled.code).not.toBe(0);
    expect(pulled.stdout + pulled.stderr).toContain("staged change to private path secret.md");
    expect(sb.git(root, "log", "--format=%s")).toBe("init\n");
    sb.git(root, "merge", "--abort");

    // A clean merge passes, silently, although the hook ran.
    sb.git(root, "switch", "-q", "-c", "clean");
    sb.write(root, "public.md", "p\n");
    sb.git(root, "add", "public.md");
    sb.git(root, "commit", "-q", "-m", "public");
    sb.git(root, "switch", "-q", "main");
    const merged = sb.run(["git", "merge", "-q", "--no-ff", "-m", "merge clean", "clean"], root, env);
    expect(merged.stdout + merged.stderr).toBe("");
    expect(merged.code).toBe(0);
    expect(runs()).toBe("check --staged --merge\n".repeat(3));
    expect(sb.git(root, "log", "--format=%s", "--first-parent")).toBe("merge clean\ninit\n");
  });

  test("a blocked merge that overwrote a private file says to abort, then restore it", () => {
    const root = setup("notes");
    const mate = withTeammate(root);
    // A teammate commits foo.md to base, which is private here.
    sb.write(mate, "foo.md", "theirs\n");
    sb.git(mate, "add", "foo.md");
    sb.git(mate, "commit", "-q", "-m", "foo");
    sb.git(mate, "push", "-q");
    sb.write(root, "foo.md", "mine\n");
    sb.ok(root, "claim", "notes", "foo.md");
    sb.ok(root, "commit", "notes", "-m", "foo");
    sb.write(root, "README.md", "# project, local\n");
    sb.git(root, "commit", "-q", "-am", "local");

    const blocked = sb.run(["git", "pull", "-q", "--no-rebase", "origin", "main"], root);
    expect(blocked.code).not.toBe(0);
    const out = blocked.stdout + blocked.stderr;
    expect(out).toContain("base has a staged change to private path foo.md (claimed by notes)");
    expect(out).toContain(
      "  this merge isn't committed; back it out with: git merge --abort\n" +
        "  the merge may have overwritten foo.md (tracked by notes); after aborting, restore with: " +
        "sich notes restore -- foo.md\n" +
        "  don't unstage them and commit the merge: that drops the other side's changes to them\n",
    );
    // git already wrote their version over the private one.
    expect(sb.read(root, "foo.md")).toBe("theirs\n");

    // Following the hints, in that order, gets the private file back.
    sb.git(root, "merge", "--abort");
    expect(existsSync(join(root, "foo.md"))).toBe(false);
    sb.ok(root, "notes", "restore", "--", "foo.md");
    expect(sb.read(root, "foo.md")).toBe("mine\n");
    expect(sb.git(root, "log", "--format=%s")).toBe("local\ninit\n");
    expect(layerStatus(root, "notes")).toEqual([]);
  });

  test("finishing a conflicted merge with git commit also gets the merge hints", () => {
    const root = setup("notes");
    const mate = withTeammate(root);
    sb.write(mate, "README.md", "# theirs\n");
    sb.write(mate, "foo.md", "theirs\n");
    sb.git(mate, "add", "README.md", "foo.md");
    sb.git(mate, "commit", "-q", "-m", "theirs");
    sb.git(mate, "push", "-q");
    sb.write(root, "foo.md", "mine\n");
    sb.ok(root, "claim", "notes", "foo.md");
    sb.ok(root, "commit", "notes", "-m", "foo");
    sb.write(root, "README.md", "# mine\n");
    sb.git(root, "commit", "-q", "-am", "local");

    // Stops on the README conflict; git commit then runs pre-commit, with MERGE_HEAD in place.
    expect(sb.run(["git", "pull", "-q", "--no-rebase", "origin", "main"], root).code).not.toBe(0);
    sb.write(root, "README.md", "# both\n");
    sb.git(root, "add", "README.md");
    const blocked = sb.run(["git", "commit", "--no-edit"], root);
    expect(blocked.code).not.toBe(0);
    const out = blocked.stdout + blocked.stderr;
    expect(out).toContain("base has a staged change to private path foo.md (claimed by notes)");
    expect(out).toContain("back it out with: git merge --abort");
    expect(out).toContain("restore with: sich notes restore -- foo.md");
    expect(out).not.toContain("unstage with");
    sb.git(root, "merge", "--abort");
    sb.ok(root, "notes", "restore", "--", "foo.md");
    expect(sb.read(root, "foo.md")).toBe("mine\n");
  });

  test("a layer's pre-merge-commit hook checks what the merge brings in", () => {
    const root = setup("notes");
    const { env, runs } = loggingSich();
    const log = () => sb.layerGit(root, "notes", "log", "--format=%s", "--first-parent");

    // A side branch that let an unclaimed file into the layer with --no-verify.
    sb.ok(root, "notes", "switch", "-q", "-c", "stray");
    sb.write(root, "stray.md", "s\n");
    sb.layerGit(root, "notes", "add", "-f", "stray.md");
    sb.ok(root, "notes", "commit", "-q", "--no-verify", "-m", "stray");
    sb.ok(root, "notes", "switch", "-q", "main");
    // Merged with plain git and a relative --git-dir...
    const blocked = sb.run(
      ["git", "--git-dir=.sich/notes", "--work-tree=.", "merge", "--no-ff", "-m", "merge stray", "stray"],
      root,
      env,
    );
    expect(blocked.code).not.toBe(0);
    let out = blocked.stdout + blocked.stderr;
    expect(out).toContain("notes has a staged change to stray.md, which none of its claims cover");
    expect(out).toContain("this merge isn't committed; back it out with: sich notes merge --abort");
    expect(out).toContain("don't untrack them and commit the merge");
    expect(out).toContain("fix them where they come from (claim or untrack them on that branch), then merge again");
    expect(out).not.toContain("claim with:");
    expect(out).not.toContain("may have overwritten"); // no other repo tracks stray.md
    expect(log()).toBe("sich: create layer notes\n");
    sb.ok(root, "notes", "merge", "--abort");
    // ...or through the passthrough (absolute --git-dir).
    const viaSich = sb.sich(root, ["notes", "merge", "--no-ff", "-m", "merge stray", "stray"], env);
    expect(viaSich.code).not.toBe(0);
    out = viaSich.stdout + viaSich.stderr;
    expect(out).toContain("notes has a staged change to stray.md, which none of its claims cover");
    expect(log()).toBe("sich: create layer notes\n");
    sb.ok(root, "notes", "merge", "--abort");

    // A branch that claims a file and commits it along with the claims list.
    sb.ok(root, "notes", "switch", "-q", "-c", "plan");
    sb.write(root, "plan.md", "p\n");
    sb.ok(root, "claim", "notes", "plan.md");
    sb.ok(root, "notes", "commit", "-q", "-m", "plan");
    sb.ok(root, "notes", "switch", "-q", "main");
    const merged = sb.sich(root, ["notes", "merge", "-q", "--no-ff", "-m", "merge plan", "plan"], env);
    expect(merged.stdout).toBe("");
    // The merge changes notes' claims, so both exclude blocks are stale: one warning.
    expect(merged.stderr).toBe(
      "warning: stale exclude rules of base in .git/info/exclude, notes in .sich/notes/info/exclude " +
        "(fix: sich check --fix); not blocking\n",
    );
    expect(merged.code).toBe(0);
    expect(runs()).toBe("check --staged --merge\n".repeat(3));
    expect(log()).toBe("merge plan\nsich: create layer notes\n");
    expect(layerFiles(root, "notes")).toEqual([".sich/notes.paths", "plan.md"]);
    expect(sb.ok(root, "check")).toContain("ok");
  });

  test("a layer's pre-merge-commit hook lets a merge untrack a stray file", () => {
    const root = setup("notes");
    const { env, runs } = loggingSich();
    sb.write(root, "stray.md", "s\n");
    sb.layerGit(root, "notes", "add", "-f", "stray.md");
    sb.ok(root, "notes", "commit", "-q", "--no-verify", "-m", "oops");
    sb.ok(root, "notes", "switch", "-q", "-c", "fix");
    sb.ok(root, "notes", "rm", "-q", "--cached", "--", "stray.md");
    sb.ok(root, "notes", "commit", "-q", "--no-verify", "-m", "untrack stray.md");
    sb.ok(root, "notes", "switch", "-q", "main");
    // While main still tracks it, an unrelated merge is blocked...
    sb.ok(root, "notes", "switch", "-q", "-c", "other");
    sb.ok(root, "notes", "commit", "-q", "--no-verify", "--allow-empty", "-m", "other");
    sb.ok(root, "notes", "switch", "-q", "main");
    const blocked = sb.sich(root, ["notes", "merge", "-q", "--no-ff", "-m", "merge other", "other"], env);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("notes tracks stray.md but none of its claims cover it");
    sb.ok(root, "notes", "merge", "--abort");
    // ...and the merge that untracks it goes through.
    const merged = sb.sich(root, ["notes", "merge", "-q", "--no-ff", "-m", "merge fix", "fix"], env);
    expect(merged.stdout + merged.stderr).toBe("");
    expect(merged.code).toBe(0);
    expect(runs()).toBe("check --staged --merge\n".repeat(2));
    expect(layerFiles(root, "notes")).toEqual([".sich/notes.paths"]);
  });

  test("fast-forward merges run no hook; plain sich check flags what they bring in", () => {
    const root = setup("notes");
    const { env, runs } = loggingSich();
    sb.write(root, "secret.md", "s\n");
    sb.ok(root, "claim", "notes", "secret.md");
    sb.git(root, "switch", "-q", "-c", "leaky");
    sb.git(root, "add", "-f", "secret.md");
    sb.git(root, "commit", "-q", "--no-verify", "-m", "leak");
    sb.git(root, "switch", "-q", "main");
    expect(sb.run(["git", "merge", "-q", "leaky"], root, env).code).toBe(0);
    expect(sb.git(root, "log", "--format=%s")).toBe("leak\ninit\n");

    sb.ok(root, "notes", "switch", "-q", "-c", "stray");
    sb.write(root, "stray.md", "s\n");
    sb.layerGit(root, "notes", "add", "-f", "stray.md");
    sb.ok(root, "notes", "commit", "-q", "--no-verify", "-m", "stray");
    sb.ok(root, "notes", "switch", "-q", "main");
    expect(sb.sich(root, ["notes", "merge", "-q", "stray"], env).code).toBe(0);

    expect(runs()).toBe("");
    const out = sb.bad(root, "check");
    expect(out).toContain("base tracks secret.md, which is claimed by notes");
    expect(out).toContain("notes tracks stray.md but none of its claims cover it");
  });

  test("init adds pre-merge-commit hooks to repos that only have pre-commit, leaving user-written ones alone", () => {
    const root = setup("notes");
    // Set up by a sich that only installed pre-commit hooks.
    rmSync(join(root, ".git/hooks/pre-merge-commit"));
    rmSync(join(root, ".sich/notes/hooks/pre-merge-commit"));
    const check = sb.sich(root, ["check"]);
    expect(check.code).toBe(0);
    expect(check.stderr).toContain(
      "warning: base has no pre-merge-commit hook running sich check --staged (.git/hooks/pre-merge-commit); fix: sich init",
    );
    expect(check.stderr).toContain("warning: notes has no pre-merge-commit hook running sich check --staged");
    const out = sb.ok(root, "init");
    expect(out).toContain("installed pre-merge-commit hook -> .git/hooks/pre-merge-commit");
    expect(out).toContain("installed pre-merge-commit hook of notes -> .sich/notes/hooks/pre-merge-commit");
    expect(out).not.toContain("pre-commit hook");
    expect(statSync(join(root, ".sich/notes/hooks/pre-merge-commit")).mode & 0o111).not.toBe(0);
    expect(sb.sich(root, ["check"]).stderr).toBe("");

    // Missing both: one warning per repo.
    rmSync(join(root, ".sich/notes/hooks/pre-commit"));
    rmSync(join(root, ".sich/notes/hooks/pre-merge-commit"));
    expect(sb.sich(root, ["check"]).stderr).toBe(
      "warning: notes has no pre-commit and pre-merge-commit hooks running sich check --staged " +
        "(.sich/notes/hooks/pre-commit, .sich/notes/hooks/pre-merge-commit); fix: sich init\n",
    );
    sb.ok(root, "init");

    // A pre-merge-commit hook the user wrote stays as is; init prints its line to add.
    const custom = "#!/bin/sh\necho custom\n";
    sb.write(root, ".git/hooks/pre-merge-commit", custom);
    const asked = sb.ok(root, "init");
    expect(asked).toContain(
      `pre-merge-commit hook exists (.git/hooks/pre-merge-commit); add this line to it:\n  ${MERGE_LINE}`,
    );
    expect(asked).not.toContain("pre-commit hook");
    expect(sb.read(root, ".git/hooks/pre-merge-commit")).toBe(custom);
    expect(sb.sich(root, ["check"]).stderr).toContain("warning: base has no pre-merge-commit hook");
    // With the line in, it guards merges.
    sb.write(root, ".git/hooks/pre-merge-commit", `${custom}${MERGE_LINE}\n`);
    chmodSync(join(root, ".git/hooks/pre-merge-commit"), 0o755);
    expect(sb.sich(root, ["check"]).stderr).toBe("");
    sb.write(root, "secret.md", "s\n");
    sb.ok(root, "claim", "notes", "secret.md");
    sb.git(root, "switch", "-q", "-c", "leaky");
    sb.git(root, "add", "-f", "secret.md");
    sb.git(root, "commit", "-q", "--no-verify", "-m", "leak");
    sb.git(root, "switch", "-q", "main");
    const blocked = sb.run(["git", "merge", "--no-ff", "-m", "m", "leaky"], root);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain("custom");
    expect(blocked.stdout + blocked.stderr).toContain("back it out with: git merge --abort");
  });

  test("a merge hook fails closed when sich can't be found", () => {
    const root = setup("notes");
    sb.git(root, "switch", "-q", "-c", "side");
    sb.git(root, "commit", "-q", "--allow-empty", "-m", "side");
    sb.git(root, "switch", "-q", "main");
    const env = { PATH: "/usr/bin:/bin", SICH_BIN: "" };
    const blocked = sb.run(["git", "merge", "--no-ff", "-m", "merge side", "side"], root, env);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("merge blocked: 'sich' not found");
    expect(blocked.stderr).toContain("skip once: git merge --no-verify");
    expect(sb.git(root, "log", "--format=%s")).toBe("init\n");
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

describe("10. detach", () => {
  test("removes the layer but keeps its files and remote; changes to files don't block it", () => {
    const r = published();
    sb.write(r.root, "NOTES.md", "edited, not committed\n");
    rmSync(join(r.root, "roadmap/q1.md"));
    const out = sb.ok(r.root, "detach", "notes", "--yes");
    expect(out).toContain("detached layer notes: deleted git data -> .sich/notes/, claims list -> .sich/notes.paths");
    expect(out).toContain("no longer hidden from base -> .git/info/exclude");
    expect(out).toContain("updated the excludes of keys -> .sich/keys/info/exclude");
    expect(out).toContain("warning: base now sees NOTES.md, docs/guide.md as untracked");
    expect(out).toContain(`to attach again: move its files away, then sich attach notes ${r.notesRemote}`);
    expect(existsSync(join(r.root, ".sich/notes"))).toBe(false);
    expect(existsSync(join(r.root, ".sich/notes.paths"))).toBe(false);
    expect(sb.read(r.root, "NOTES.md")).toBe("edited, not committed\n");

    // Base sees the files now; keys keeps its own and stops excluding notes' claims.
    expect(managedBlock(sb.read(r.root, ".git/info/exclude"))).toEqual(["/.sich/", "/.env", "/docs/api.env"]);
    expect(managedBlock(sb.read(r.root, ".sich/keys/info/exclude"))).not.toContain("/NOTES.md");
    expect(baseStatus(r.root)).toEqual(["NOTES.md", "docs/guide.md"]);
    expect(layerStatus(r.root, "keys")).toEqual([]);
    expect(sb.ok(r.root, "status")).not.toMatch(/^notes/m);
    expect(sb.ok(r.root, "check")).toContain("sich check: ok");
    expect(sb.git(r.notesRemote, "log", "--format=%s", "main")).toContain("private stuff");

    rmSync(join(r.root, "NOTES.md"));
    rmSync(join(r.root, "docs/guide.md"));
    sb.ok(r.root, "attach", "notes", r.notesRemote);
    expect(sb.read(r.root, "NOTES.md")).toBe("my notes\n");
    expect(baseStatus(r.root)).toEqual([]);
  });

  test("refuses to lose what exists only in the layer's git dir; --force discards it", () => {
    const r = published();
    const blocked = (...expected: string[]) => {
      const out = sb.bad(r.root, "detach", "notes");
      expect(out).toContain("detaching notes would lose what exists only in .sich/notes/");
      for (const e of expected) expect(out).toContain(e);
      expect(existsSync(join(r.root, ".sich/notes/HEAD"))).toBe(true);
    };

    sb.write(r.root, "NOTES.md", "v2\n");
    sb.ok(r.root, "commit", "notes", "-m", "v2");
    blocked("✗ 1 commit on main not on any remote (fix: sich push notes)");
    sb.ok(r.root, "push", "notes");

    sb.ok(r.root, "notes", "switch", "-q", "-c", "draft");
    sb.write(r.root, "NOTES.md", "draft\n");
    sb.ok(r.root, "notes", "commit", "-q", "-am", "draft");
    sb.ok(r.root, "notes", "switch", "-q", "main");
    blocked("✗ 1 commit on draft not on any remote (fix: sich notes push -u origin draft)");
    sb.ok(r.root, "notes", "tag", "v1", "draft");
    sb.ok(r.root, "notes", "branch", "-q", "-D", "draft");
    blocked("✗ 1 commit only on tag v1 (fix: sich notes push origin v1)");
    sb.ok(r.root, "notes", "tag", "-d", "v1");

    sb.write(r.root, "NOTES.md", "stashed\n");
    sb.ok(r.root, "notes", "stash", "-q");
    blocked("✗ 1 stash entry (fix: sich notes stash pop, then commit)");
    sb.ok(r.root, "notes", "stash", "pop", "-q");

    // A staged version is lost only once the file on disk differs from it.
    sb.ok(r.root, "notes", "add", "NOTES.md");
    sb.write(r.root, "NOTES.md", "changed after staging\n");
    blocked(
      "✗ staged versions of NOTES.md that differ from what is on disk (fix: sich notes commit -m <msg>, then sich push notes)",
    );

    const forced = sb.sich(r.root, ["detach", "notes", "--force", "--yes"]);
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain("warning: discarding staged versions of NOTES.md");
    expect(existsSync(join(r.root, ".sich/notes"))).toBe(false);
    expect(sb.read(r.root, "NOTES.md")).toBe("changed after staging\n");
  });

  test("pushed tags and notes don't block; detached HEADs and linked worktrees do; staging alone doesn't", () => {
    const r = published();
    const blocked = (expected: string) => expect(sb.bad(r.root, "detach", "notes")).toContain(expected);

    sb.ok(r.root, "notes", "switch", "-q", "-c", "draft");
    sb.write(r.root, "NOTES.md", "draft\n");
    sb.ok(r.root, "notes", "commit", "-q", "-am", "draft");
    sb.ok(r.root, "notes", "tag", "-a", "-m", "v1", "v1");
    sb.ok(r.root, "notes", "switch", "-q", "main");
    sb.ok(r.root, "notes", "branch", "-q", "-D", "draft");
    blocked("✗ 1 commit only on tag v1 (fix: sich notes push origin v1)");
    sb.ok(r.root, "notes", "push", "-q", "origin", "v1");

    sb.ok(r.root, "notes", "notes", "add", "-m", "a note", "HEAD");
    blocked("✗ 1 commit only on refs/notes/commits (fix: sich notes push origin refs/notes/commits)");
    sb.ok(r.root, "notes", "push", "-q", "origin", "refs/notes/commits");

    sb.ok(r.root, "notes", "switch", "-q", "--detach");
    sb.write(r.root, "NOTES.md", "detached\n");
    sb.ok(r.root, "notes", "commit", "-q", "-am", "detached");
    blocked("✗ 1 commit only on the detached HEAD (fix: sich notes switch -c <branch>)");
    sb.ok(r.root, "notes", "switch", "-q", "-f", "main");

    sb.ok(r.root, "notes", "worktree", "add", "-q", "--detach", "../wt", "main");
    blocked(`✗ 1 linked worktree: ${sb.path("wt")} (fix: sich notes worktree remove <path>)`);
    sb.ok(r.root, "notes", "worktree", "remove", "../wt");

    // Staged versions that match the disk, and staged deletions, survive detaching.
    sb.write(r.root, "NOTES.md", "staged\n");
    sb.ok(r.root, "notes", "add", "NOTES.md");
    sb.ok(r.root, "notes", "rm", "-q", "--cached", "docs/guide.md");
    expect(sb.ok(r.root, "detach", "notes", "-y")).toContain("detached layer notes");
    expect(sb.read(r.root, "NOTES.md")).toBe("staged\n");
    expect(sb.read(r.root, "docs/guide.md")).toBe("guide\n");
  });

  test("refuses a layer without a remote; --force detaches it anyway", () => {
    const root = setup("notes");
    expect(sb.bad(root, "detach", "notes")).toContain(
      "✗ 1 commit with no remote to push to (fix: sich notes remote add origin <url>, then sich push notes)",
    );
    const forced = sb.ok(root, "detach", "notes", "--force", "--yes");
    expect(forced).toContain("warning: discarding 1 commit with no remote to push to");
    expect(forced).not.toContain("to attach again");
  });

  test("refuses while a merge, rebase or similar is in progress", () => {
    const r = published();
    sb.ok(r.root, "notes", "switch", "-q", "-c", "draft");
    sb.write(r.root, "NOTES.md", "draft\n");
    sb.ok(r.root, "notes", "commit", "-q", "-am", "draft");
    sb.ok(r.root, "notes", "push", "-q", "-u", "origin", "draft");
    sb.ok(r.root, "notes", "switch", "-q", "main");
    sb.write(r.root, "NOTES.md", "main\n");
    sb.ok(r.root, "commit", "notes", "-m", "main");
    sb.ok(r.root, "push", "notes");
    expect(sb.sich(r.root, ["notes", "cherry-pick", "draft"]).code).not.toBe(0);
    const out = sb.bad(r.root, "detach", "notes");
    expect(out).toContain("✗ a cherry-pick in progress (fix: finish it, or sich notes cherry-pick --abort)");
    expect(out).not.toContain("staged versions");
  });

  test("lists what it deletes and keeps, then asks; only y/yes detaches", () => {
    const r = published();
    const ask = (input?: string) => sb.sich(r.root, ["detach", "notes"], {}, input);

    const no = ask("n\n");
    expect(no.code).toBe(1);
    expect(no.stdout).toBe(
      [
        "detaching notes:",
        "  deletes   .sich/notes/ (its git data: local history, index, hooks, config)",
        "  deletes   .sich/notes.paths (claims list: NOTES.md, docs/guide.md, roadmap/)",
        "  keeps     NOTES.md, docs/guide.md, roadmap/ on disk, no longer hidden from base",
        `  keeps     remote origin (${r.notesRemote}) and everything pushed to it`,
        "",
      ].join("\n"),
    );
    expect(no.stderr).toContain("Detach notes? [y/N]");
    expect(no.stderr).toContain("sich: not detached");
    expect(existsSync(join(r.root, ".sich/notes/HEAD"))).toBe(true);

    const silent = ask();
    expect(silent.code).toBe(1);
    expect(silent.stderr).toContain("not detached (no answer on stdin; --yes skips the question)");
    expect(existsSync(join(r.root, ".sich/notes/HEAD"))).toBe(true);

    // With --force it also lists what it discards.
    sb.write(r.root, "NOTES.md", "stashed\n");
    sb.ok(r.root, "notes", "stash", "-q");
    expect(sb.bad(r.root, "detach", "notes", "--force")).toContain("  discards  1 stash entry\n");

    const yes = sb.sich(r.root, ["detach", "notes", "--force"], {}, "yes\n");
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain("detached layer notes");
    expect(existsSync(join(r.root, ".sich/notes"))).toBe(false);
  });

  test("usage, help and wrong names", () => {
    const root = setup("notes");
    expect(sb.ok(root, "--help")).toMatch(/^  detach <layer> \[--force\] \[--yes\] +remove a layer here; files and remote stay$/m);
    expect(sb.ok(root, "detach", "--help")).toContain("usage: sich detach <layer> [--force] [--yes]");
    expect(sb.bad(root, "detach")).toContain("usage: sich detach");
    expect(sb.bad(root, "detach", "base")).toContain("'base' is the public repo, not a layer");
    expect(sb.bad(root, "detach", "nope")).toContain("no such layer 'nope'");
    expect(sb.bad(root, "new", "detach")).toContain("reserved");
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
