# sich

Keep private files right next to your public code, in the same folder, without
them ever touching the public repo.

`sich` lets one folder hold a normal git repo (the **base**, usually public on
GitHub) plus any number of private **layers**: extra git repos that share the
same working tree, each with its own private remote and its own access list.

```
myproject/
├── .git/            base repo (public)       src/, README.md, ...
├── .sich/notes/     layer "notes" (only me)  NOTES.md, roadmap/
├── .sich/keys/      layer "keys" (me + team) .env
├── NOTES.md
├── roadmap/
├── .env
└── src/
```

Plain `git` only ever sees base files. Private file names never appear in the
public repo: not in commits, not in `.gitignore`.

**The name** is a nod to the *sietch*, the hidden cave communities of the Fremen
in Frank Herbert's *Dune*, where only the tribe knows the way in (the word itself
echoes the Zaporozhian Sich, a Cossack stronghold). It's also German for
"oneself", which suits private notes.

## Why

- Notes, plans and scratch files you want versioned and synced, but not public.
- Secrets or local config shared with a few collaborators, but not the world.
- No submodules, no symlinks, no second checkout. Files stay where they belong.

## Install

Requires Node ≥ 18 and git ≥ 2.28.

```sh
pnpm add -g sich        # or: npm install -g sich
```

`sich` has to be on your `PATH` (or `SICH_BIN` set to it) for the pre-commit
guard to work; see **Guard** below.

## Quickstart

```sh
cd myproject                          # an existing git repo
sich init                             # .sich/, base excludes, pre-commit guard
sich new notes --gh                   # private GitHub repo myproject-notes
sich add notes NOTES.md roadmap/      # claim paths (staged in the layer)
sich commit -m "my notes"             # commits every layer with changes
sich push                             # pushes base + every layer
git status                            # NOTES.md and roadmap/ are invisible here
```

## Commands

Global: `-C <dir>` (run as if in `<dir>`), `-h/--help` (also `sich <cmd> --help`),
`-V/--version`.

| Command | What it does |
| --- | --- |
| `sich init` | Creates `.sich/`, writes the base exclude block, installs the base pre-commit hook. If a `pre-commit` hook already exists or `core.hooksPath` is set, it prints the one line to add instead. Idempotent. |
| `sich new <layer> [--remote <url> \| --gh [name]]` | Creates a layer with an empty manifest and an initial commit. `--gh` runs `gh repo create <name> --private` (default name `<base-repo>-<layer>`) and sets `origin` to its SSH URL. `SICH_GH` overrides the `gh` binary. |
| `sich attach <layer> <url>` | Collaborator flow: fetches the layer and checks out its default branch into the working tree (setting up `.sich/` if needed). Refuses to overwrite existing files. |
| `sich add <layer> <path...> [--move]` | Claims files or directories (relative to the current directory) and stages them in the layer. Refuses paths tracked by base or owned by another layer; `--move` untracks them from the old owner first (including that layer's claims inside a claimed folder) and warns, listing what it dropped. Claims can't nest across layers: a path inside another layer's claimed folder is always refused. |
| `sich rm <layer> <path...>` | Drops exact claims and untracks them in the layer. Files stay on disk and now show as untracked in base. |
| `sich which <path>` | Prints the owner: a layer (`(claimed, not yet committed)` if not tracked yet), `base`, `ignored`, or `untracked`. |
| `sich ls [layer]` | Each layer's claims and tracked files. |
| `sich status [-v] [--fetch]` | One row per repo (base first): branch, upstream ahead/behind, staged/modified/untracked counts. `-v` lists files, `--fetch` fetches first. |
| `sich commit [layer...] -m <msg>` | `git add -A` + commit in each target layer (default: every layer with changes). Files the layer doesn't own are left out with a warning. Use plain `git commit` for base. |
| `sich pull \| push \| sync [repo...]` | Base + all layers, or the named ones (`base` allowed). `pull` = `git pull --rebase --autostash`, `push` = `git push` (`-u origin <branch>` if no upstream yet), `sync` = pull then push. Repos without a remote are skipped. Stops at the first failure, and before a pull that would overwrite a file the repo doesn't track (see **Shared working tree**). |
| `sich check [--fix] [--staged]` | Reports leaks into base (claimed paths or `.sich/` tracked by base), ambiguous ownership (claims overlapping or nested across layers, files tracked by the wrong layer or by two layers) and stale exclude blocks (`--fix` rewrites them). `--staged` also checks what base is about to commit; it's what the pre-commit hook runs, and there stale excludes only warn. Exit 1 on any blocking issue. |
| `sich <layer> <git args...>` | Runs git against a layer, e.g. `sich notes log`, `sich keys diff`. Exits with git's code. |
| `sich base <git args...>` | Runs git against the base repo. |

Layer names match `^[a-z0-9][a-z0-9._-]*$`; `base` and command names are reserved.

## Collaborator flow

You (owner):

```sh
sich new keys --gh                    # private repo myproject-keys
sich add keys .env
sich commit keys -m "shared env" && sich push keys
# on GitHub: add collaborators to myproject-keys only
```

A collaborator (with `sich` installed):

```sh
git clone git@github.com:you/myproject.git && cd myproject
sich attach keys git@github.com:you/myproject-keys.git
```

They now have `.env` in place, invisible to the base repo. Everyone can
`sich pull`, edit, `sich commit -m ...`, `sich push`. When a teammate claims new
paths, `sich pull` picks up their manifest and regenerates the excludes. Layers
they have no access to never show up for them, not even by name.

## How it works

**Layers.** Layer `L` is a regular, non-bare git dir at `.sich/L/` with
`core.worktree = ../..`, so its working tree is the project root. sich always
runs git with explicit `--git-dir`/`--work-tree`, and strips `GIT_DIR`,
`GIT_INDEX_FILE` and friends from the environment.

**Manifests.** `.sich/L.paths` lists what `L` owns: one root-relative path per
line, directories end with `/`, `#` comments allowed. The manifest is tracked by
layer `L` itself, so collaborators get it on `attach`/`pull`. It is the single
source of truth for ownership; sich keeps it sorted (comments move to the top).
Paths that a line can't hold (starting with `#`, starting or ending with
whitespace, containing line breaks) can't be claimed.

**Generated excludes.** sich owns a marked block in each repo's `info/exclude`
(`# >>> sich: managed, do not edit >>>` … `# <<< sich <<<`; anything outside the
block is left alone) and regenerates it on every command:

- base: `/.sich/` plus every claim of every layer.
- layer `L`: a whitelist. `/*` ignores everything, then each claim is re-included
  along with its parent chain (git can't re-include a file inside an excluded
  directory), e.g. `a/b/c.md` becomes `!/a/` `/a/*` `!/a/b/` `/a/b/*` `!/a/b/c.md`.

Claims never nest across layers: if `notes` owns `docs/`, no other layer can
claim `docs/api.env` (and `keys` owning `docs/api.env` stops `notes` from
claiming `docs/` without `--move`, which takes the whole folder). Two files in
the same folder can still belong to different layers.

Because each layer only "sees" its claims, `git add -A` in a layer is safe, and
new files created inside a claimed directory automatically belong to that layer.

**Guard.** The base `pre-commit` hook runs `sich check --staged`. It blocks a
base commit that stages a claimed path or anything under `.sich/` (e.g. after
`git add -f`; on case-insensitive filesystems under any spelling), and it blocks
while ownership between layers is ambiguous (overlapping claims, a file tracked
by the wrong layer), since that could leak one layer's files into another.
Stale exclude rules only warn. Where sich isn't set up (a linked `git worktree`)
it does nothing.

The hook runs `$SICH_BIN` if set, else `sich` on `PATH`; if it can't find either
it blocks the commit (fail closed). Skip the check once with
`git commit --no-verify`. GUI git clients may not see your shell's `PATH` or
`SICH_BIN`; their commits will then be blocked.

## Caveats

- **Not encryption.** Privacy comes only from who can access each layer's
  remote (e.g. a private GitHub repo and its collaborator list). Anyone with
  access to a layer sees its files in plain text. Encrypt real secrets with a
  tool like [sops](https://github.com/getsops/sops) or
  [dotenvx](https://dotenvx.com).
- **History is forever.** Moving a file out of base (`sich add --move`) only
  stops tracking it from now on; old versions remain in base's history, and on
  its remote if already pushed. Rewrite history (e.g. `git filter-repo`) and
  rotate any leaked secrets.
- **`.gitignore` wins.** Worktree `.gitignore` files outrank `info/exclude` and
  apply to every repo in the folder. sich force-adds files you claim explicitly
  (so a `.gitignore`d `.env` works), but inside a claimed directory, ignored
  files (`node_modules/`, `.DS_Store`) stay ignored. A claimed directory that is
  itself ignored can't be staged as a whole; claim its files individually.
  Likewise a `!name` rule makes `name` visible to every repo, even ones that
  don't own it; `sich commit` leaves such files out and the base hook blocks
  them, but plain git in a layer won't.
- **`main` only.** Layers are created on `main` and sich doesn't manage layer
  branches. (`attach` checks out the remote's default branch.)
- **Shared working tree.** Operations that rewrite the working tree in one repo
  (`checkout`, `reset --hard`, `clean -x`) can affect files owned by another:
  git treats ignored files, which every other repo's files are, as expendable.
  `git clean -fdx` (or `git stash --all`) in base would remove every layer's
  files; don't. `sich pull` checks first and stops rather than overwrite a file
  the pulled repo doesn't track; plain `git pull` doesn't.

## Development

Building from source needs pnpm, plus [Bun](https://bun.sh) for bundling and
tests.

```sh
git clone https://github.com/marinsokol5/sich.git && cd sich
pnpm install
pnpm run install:global        # build, pack and install as the global `sich`
```

- `install:global` packs the checkout as it would be published and installs it
  with `pnpm add -g`, built with `SICH_DEV=true`, so `sich --version` prints
  `0.1.0-dev`. A copy installed from npm prints plain `0.1.0` (publishing always
  rebuilds without the flag).
- `pnpm run build` bundles `src/` with Bun into one Node script, `dist/cli.js`
  (~50 KB). Try changes with `node dist/cli.js <command>`; the global `sich`
  stays the installed version.
- To have the pre-commit hook use your build for one commit:
  `SICH_BIN=$PWD/dist/cli.js git commit …`
- `pnpm test` rebuilds and runs the suite (with `bun test`) against
  `dist/cli.js`; `pnpm run typecheck` checks types.

Issues and pull requests are welcome. Most tests are integration tests in
`test/sich.test.ts`: each builds throwaway repos (and local bare remotes) with
the `Sandbox` helper and drives the built CLI, so add a test there with any
behavior change, and make sure `pnpm run typecheck` and `pnpm test` pass.

## License

[MIT](LICENSE)
