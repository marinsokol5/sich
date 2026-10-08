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

## Why

- Notes, plans and scratch files you want versioned and synced, but not public.
- Secrets or local config shared with a few collaborators, but not the world.
- No submodules, no symlinks, no second checkout. Files stay where they belong.

## Install

Runs on Node ≥ 18 with git ≥ 2.28. Building from source also needs pnpm, plus
[Bun](https://bun.sh) for bundling and tests.

```sh
git clone <this repo> sich && cd sich
pnpm install
pnpm run install:global        # build, pack and install as the global `sich`
```

`install:global` packs the checkout as it would be published and installs that
with `pnpm add -g`, built with `SICH_DEV=true` so `sich --version` prints
`0.1.0-dev`. A copy installed from npm prints plain `0.1.0` (publishing always
rebuilds without the flag). Once sich is on npm, use `pnpm add -g sich` instead.

The pre-commit guard needs `sich` on `PATH`, or `SICH_BIN` set to its path (see **Guard** below).

## Development

- `pnpm run build` bundles `src/` with Bun into one Node script, `dist/cli.js` (~50 KB).
  Try changes with `node dist/cli.js <command>`; the global `sich` stays the
  installed version.
- To have the pre-commit hook use your build for one commit:
  `SICH_BIN=$PWD/dist/cli.js git commit …`
- `pnpm test` rebuilds and runs the suite (with `bun test`) against `dist/cli.js`;
  `pnpm run typecheck` checks types.

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
| `sich attach <layer> <url>` | Collaborator flow: fetches the layer and checks out its default branch into the working tree. Refuses to overwrite existing files. |
| `sich add <layer> <path...> [--move]` | Claims files or directories (relative to the current directory) and stages them in the layer. Refuses paths tracked by base or owned by another layer; `--move` untracks them from the old owner first. |
| `sich rm <layer> <path...>` | Drops exact claims and untracks them in the layer. Files stay on disk (they now show as untracked in base). |
| `sich which <path>` | Prints the owner: a layer (`(claimed, not yet committed)` if not tracked yet), `base`, `ignored`, or `untracked`. |
| `sich ls [layer]` | Each layer's claims and tracked files. |
| `sich status [-v] [--fetch]` | One row per repo (base first): branch, upstream ahead/behind, staged/modified/untracked counts. `-v` lists files, `--fetch` fetches first. |
| `sich commit [layer...] -m <msg>` | `git add -A` + commit in each target layer (default: every layer with changes). Use plain `git commit` for base. |
| `sich pull \| push \| sync [repo...]` | Base + all layers, or the named ones (`base` allowed). `pull` = `git pull --rebase --autostash`, `push` = `git push` (`-u origin <branch>` if no upstream yet), `sync` = pull then push. Repos without a remote are skipped. Stops at the first failure. |
| `sich check [--fix] [--staged]` | Reports paths claimed or tracked by two layers, base tracking claimed paths or `.sich/`, layers tracking files they don't own, and stale exclude blocks (`--fix` rewrites them). `--staged` also fails if base's index stages a claimed path or anything in `.sich/`. Exit 1 on any issue. |
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

A collaborator:

```sh
git clone git@github.com:you/myproject.git && cd myproject
sich init
sich attach keys git@github.com:you/myproject-keys.git
```

They now have `.env` in place, invisible to the base repo. Everyone can
`sich pull`, edit, `sich commit -m ...`, `sich push`. When a teammate claims new
paths, `sich pull` picks up their manifest and regenerates the excludes.

## How it works

**Layers.** Layer `L` is a regular, non-bare git dir at `.sich/L/` with
`core.worktree = ../..`, so its working tree is the project root. sich always
runs git with explicit `--git-dir`/`--work-tree`, and strips `GIT_DIR`,
`GIT_INDEX_FILE` and friends from the environment.

**Manifests.** `.sich/L.paths` lists what `L` owns: one root-relative path per
line, directories end with `/`, `#` comments allowed. The manifest is tracked by
layer `L` itself, so collaborators get it on `attach`/`pull`. It is the single
source of truth for ownership; sich keeps it sorted (comments move to the top).

**Generated excludes.** sich owns a marked block in each repo's `info/exclude`
(`# >>> sich: managed, do not edit >>>` … `# <<< sich <<<`; anything outside the
block is left alone) and regenerates it on every command:

- base: `/.sich/` plus every claim of every layer.
- layer `L`: a whitelist. `/*` ignores everything, then each claim is re-included
  along with its parent chain (git can't re-include a file inside an excluded
  directory), e.g. `a/b/c.md` becomes `!/a/` `/a/*` `!/a/b/` `/a/b/*` `!/a/b/c.md`.
  Then other layers' claims are appended as plain excludes, so nested claims
  work: if `notes` owns `docs/` and `keys` owns `docs/api.env`, the most
  specific claim wins.

Because each layer only "sees" its claims, `git add -A` in a layer is safe, and
new files created inside a claimed directory automatically belong to that layer.

**Guard.** The base `pre-commit` hook runs `sich check --staged`, which refuses
a base commit that stages a claimed path or anything under `.sich/` (e.g. after
`git add -f`). The hook runs `$SICH_BIN` if set, else `sich` on `PATH`; if it
can't find either it blocks the commit (fail closed). Skip the check once with
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
- **`main` only.** Layers are created on `main` and sich doesn't manage layer
  branches. (`attach` checks out the remote's default branch.)
- **Shared working tree.** Operations that rewrite the working tree in one repo
  (`checkout`, `reset --hard`, `clean -x`) can affect files owned by another.
  `git clean -fdx` in base would delete every layer's files; don't.
