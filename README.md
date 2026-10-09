# sich

[![npm](https://img.shields.io/npm/v/git-sich)](https://www.npmjs.com/package/git-sich)

CLI for managing multiple git repositories within a single base git repo.

Useful for:
- versioning private files alongside your public files, in the same folder
- access control per file: some files can be public while others belong to Org1 and others to Org2, all living side by side

`sich` lets a normal git repo (**base**, contained in `.git`) coexist smoothly with any number of other git repos (**layers**, contained in `.sich/X`). They share the same working tree, each with its own separate commit history and remote.

Works with GitHub out of the box: every new layer can automatically become a new private repo, and GitHub then handles access control for it.

Plain `git` commands only ever see **base** files. Files from other layers never appear in the
**base** repo: not in commits, not in `.gitignore`. Other contributors never even know that `sich` is in use or that the other repositories exist; everything works for them as usual.

**The name** is a shortened (easier-to-type) version of *sietch*, the hidden cave communities of the Fremen in Frank Herbert's *Dune*, where only the tribe knows the way in. Such are the layers of `sich`: only visible to those with access to them. It's pronounced like *sietch* ("seech").

## Why

- Notes, LLM conversations, roadmaps, or random scratch files you want versioned and synced, but not public.
- Secrets or local config shared with a few collaborators or your GitHub org, but not the world.
- No submodules, no symlinks, no separate folders. Files stay where they belong.

## Install

Requires Node ≥ 22 and git ≥ 2.28.
Optionally the GitHub CLI (`gh`) 2.x, for `sich new --gh`.

```sh
npm install -g git-sich      # the package is git-sich; the command is sich
```

## Quickstart

```sh
# Start in an existing git repo, called base from now on.
# Say it has a public remote at git@github.com:user/myproject.git.
cd myproject

# Create an empty .sich folder, exclude it from base (.git/info/exclude)
# and install the commit guard hooks (every layer gets them too).
sich init

# Create a layer (a sietch) called "personal": .sich/personal is a separate
# git repo, in the same format as the top-level .git that defines base.
# --gh also creates the private GitHub repo user/myproject-personal
# and sets it as the layer's remote.
sich new personal --gh

# The personal layer claims my-notes.md; base now ignores it automatically.
sich claim personal my-notes.md

# Commit in the personal repo.
# (`sich commit -m "..."` commits base + every layer with changes at once.)
sich personal commit -m "adding notes"

# Push personal to its remote, setting its upstream the first time.
# (`sich push` pushes base + all layers.)
sich push personal

# Create another layer, "team", and the private repo user/myproject-team,
# which you can share with your team.
sich new team --gh

# Claim these for the team layer; base's exclude now hides all three.
sich claim team roadmap.md api-keys.env llm-transcripts/

# A collaborator with sich installed and access to user/myproject-team
# clones base, then attaches the team layer.
git clone git@github.com:user/myproject.git && cd myproject
sich attach team git@github.com:user/myproject-team.git
```

To see every file this generates, look at
**[section 4 of the example](docs/example.md#4-the-files-sich-generates)**.

## CLI

```
❯ sich --help
sich - private git layers that share one working tree with a normal repo

  base    your normal repo (.git), usually public
  layer   a private repo in .sich/<layer>/ with its own remote and access list
  claim   a file or folder a layer owns; base and other layers never see it

usage: sich [-C <dir>] <command> [args]
       sich [-C <dir>] <layer|base> <git args...>

setup
  init                              set up .sich/, excludes, commit guards
  new <layer> [--remote <url> | --gh [name]]
                                    create a layer (--gh: private GitHub repo)
  attach <layer> <url>              join an existing layer (collaborators)

ownership
  claim <layer> <path...> [--move]  claim files/folders for a layer, stage them
                                    (--move: take them from base/another layer)
  unclaim <layer> <path...>         release claims; files stay on disk
  which <path>                      show who owns a path
  ls [layer]                        list claims and tracked files

everyday
  status [-v] [--fetch]             per repo: branch, ahead/behind, changes
  commit [repo...] -m <msg>         add -A + commit base + all layers (or named)
  pull [repo...]                    pull --rebase base + all layers (or named)
  push [repo...]                    push base + all layers (or named)
  sync [repo...]                    pull, then push
  check [--fix] [--staged]          find leaks and ownership problems
                                    (--staged: what the commit/merge hooks run)

passthrough
  <layer> <git args...>             run git in a layer, e.g. sich notes log
  base <git args...>                run git in the base repo

options
  -C <dir>                          run as if started in <dir>
  -h, --help                        show help (also: sich <command> --help)
  -V, --version                     print version

environment
  SICH_BIN                          sich binary the commit/merge hooks run
                                    (default: sich on PATH)
  SICH_GH                           gh binary for new --gh (default: gh)
  NO_COLOR                          disable colors

Layer names match ^[a-z0-9][a-z0-9._-]*$; base and command names are reserved.
Claims can't nest across layers.
```

## How it works

It's plain git all the way down; `sich` is a tiny wrapper on top.

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

**Guard.** Base and every layer get a `pre-commit` and a `pre-merge-commit`
hook that run `sich check --staged`, since a layer may be public or shared with
a different audience too. It checks the repo whose index git is committing, so
the same lines also work in a `core.hooksPath` shared by every repo. In base it
blocks a commit that stages a claimed path or anything under `.sich/` (e.g.
after `git add -f`; on case-insensitive filesystems under any spelling). In
layer `L` it blocks a commit that stages a path `L` doesn't own: unclaimed (e.g.
after `sich L add -f`) or not yet in the claims list being committed, claimed by
another layer, or under `.sich/` (other than `L`'s own claims list). Staged
deletions never block, so untracking a stray file (`sich L rm --cached -- <path>`)
can be committed. Every hook also blocks while ownership between layers is
ambiguous (overlapping claims, a file tracked by the wrong layer), since that
could leak one layer's files into another. Stale exclude rules only warn. Where
sich isn't set up (a linked `git worktree`) the hooks do nothing. Skip the check
once with `git commit --no-verify` (in a layer: `sich L commit --no-verify`).

**Merges.** Merge commits are guarded too: git runs `pre-merge-commit` for a
merge commit made without conflicts (`git merge`, `git pull` without
`--rebase`), and `pre-commit` when you finish a conflicted merge with
`git commit`. The check covers what the merge brings in, e.g. a stray file
committed on a branch with `--no-verify`. By then git has already written the
merge result to the working tree, possibly over another repo's copy of an
incoming path, so a blocked merge says how to back out (`git merge --abort`)
and restore that copy afterwards, rather than how to unstage it. Skip the check
once with `git merge --no-verify` (in a layer: `sich L merge --no-verify`).
Fast-forward merges, rebase and cherry-pick run no hook at all, so what they
bring in isn't checked as it arrives; plain `sich check` catches it afterwards.
`sich check` also warns about any repo whose hooks don't run sich, and
`sich init` installs the missing ones.

## FAQ

**Why not just keep private files gitignored?**
Then they aren't versioned, synced between your machines or shareable with collaborators.

**Why not just a second, private GitHub repo?**
That's essentially what a layer is, but its files stay in the same folder as the main repo, next to the code that uses them or the context that explains them, and it scales easily to any number of layers.

**Why not a git submodule?**
Besides the benefit above (files stay next to what uses them), changing a layer never needs a commit in base, since their commit histories are fully separate, and the layer's repo name never appears in the main repo: from the outside, it doesn't exist.

That said, sometimes you do want a base commit to pin a submodule version: when the two only work with specific versions of each other (say, a package, library or API spec inside your own package) and must always move together, so checking out base at `HEAD~1` has to move the other as well. Submodules are the better fit there.

**Can't GitHub do per-file permissions?**
No. Visibility is set per repo, and anyone who can clone a repo gets every file in it.
Their per-repo access control is great, though, and sich builds on it!

**What's the difference between `sich claim notes x` and `sich notes add x`?**
`sich claim` gives `x` to the layer: it records the claim in `.sich/notes.paths`, hides `x` from base and the other layers, and stages it. `sich notes add` is plain `git add` run in the layer, which refuses files the layer hasn't claimed. Likewise `sich unclaim` releases a claim and keeps the file on disk, while `sich notes rm` is plain `git rm` and deletes it.

**Is this like git-crypt or sops?**
No. sich doesn't encrypt anything; it relies on who can access each repo. You can combine the two for real secrets.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
