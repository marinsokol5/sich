# sich

CLI for maganing multiple tit repositories within a single base tit repo. 

Useful for:
- version tracking private files alongside your public files in the same folder
- access control per file, so certain files might be public, while others belong to Org1, and another to Org2; all living alongside each other

`sich` allows a normal git repo (**base**, contained in `.git`) co-exist smoothly with any number of other git repos (**layers**, contained in `.sich/X`). They share the same working tree, each with their own separate commit history and remote.

Working with GitHub out of the box, where every new layer can automatically become a new private repo, where GitHub can then handle access control for it.

Plain `git` commands only ever see **base** files. Files from other layers never appear in the
**base** repo: not in commits, not in `.gitignore`. No other contributor ever even knows about `sich` being used nor about the other repositories, everything works for them as usual.

**The name** is a shortened (easier-to-type) version of *sietch*, the hidden cave communities of the Fremen in Frank Herbert's *Dune*, where only the tribe knows the way in. Such are the layer of `sich`, only visible to those with access to them.

## Why

- Notes, LLM conversations, roadmaps, or random scratch files you want versioned and synced, but not public.
- Secrets or local config shared with a few collaborators or your GitHub org, but not the world.
- No submodules, no symlinks, no separate folders. Files stay where they belong.

## Install

Requires Node ≥ 18 and git ≥ 2.28.
Optionally Github CLI (`gh`) of 2.X.

```sh
npm install -g sich
```

## Quickstart

```sh
cd myproject                          # an existing git repo, called base from now on, let's imagine it has a public remote on git@github.com:user/myproject.git 
sich init                             # creates empty .sich folder and excludes it from base repo (.git/info/exclude)
sich new personal --gh                # creates a sich layer (or sietch) called "personal" (.sich/personal is created, defining "personal" as a separate Git repo, same format as top-level .git defining base) 
# because of --gh flag it also automatically creates user/myproject-personal private GitHub repo and sets the remote to be git@github.com:user/myproject-personal.git 
sich add personal my-notes.md         # personal layer claims my-notes.md file, it automatically gets ignored by base
sich personal commit -m "adding notes" # commits in personal repo or `sich commit -m "initial commit"` to commit to base + all layers at once
sich personal push # pushes local personal state to the remote, or "sich push" to push base + all layers

sich new team --gh # creates another layer, called "team", and user/myproject-team that you could give access to collaborators from your team, personal's exclude gets my-notes.md 
sich add roadmap.md api-keys.env llm-transcripts/ # claims these files for team layer, so all 3 are added to base exclude and to personal exclude
# ...

# A collaborator with sich installed and access to user/myproject-team
git clone git@github.com:user/myproject.git && cd myproject
sich attach team git@github.com:user/myproject-team.git
```

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
  init                              set up .sich/, base excludes, commit guard
  new <layer> [--remote <url> | --gh [name]]
                                    create a layer (--gh: private GitHub repo)
  attach <layer> <url>              join an existing layer (collaborators)

ownership
  add <layer> <path...> [--move]    claim files/folders for a layer, stage them
                                    (--move: take them from base/another layer)
  rm <layer> <path...>              release claims; files stay on disk
  which <path>                      show who owns a path
  ls [layer]                        list claims and tracked files

everyday
  status [-v] [--fetch]             per repo: branch, ahead/behind, changes
  commit [layer...] -m <msg>        commit changed layers (base: use git commit)
  pull [repo...]                    pull --rebase base + all layers (or named)
  push [repo...]                    push base + all layers (or named)
  sync [repo...]                    pull, then push
  check [--fix] [--staged]          find leaks and ownership problems
                                    (--staged: what the pre-commit hook runs)

passthrough
  <layer> <git args...>             run git in a layer, e.g. sich notes log
  base <git args...>                run git in the base repo

options
  -C <dir>                          run as if started in <dir>
  -h, --help                        show help (also: sich <command> --help)
  -V, --version                     print version

environment
  SICH_BIN                          sich binary the pre-commit hook runs
                                    (default: sich on PATH)
  SICH_GH                           gh binary for new --gh (default: gh)
  NO_COLOR                          disable colors

Layer names match ^[a-z0-9][a-z0-9._-]*$; base and command names are reserved.
Claims can't nest across layers.
```

## How it works

Basic git all the way down, `sich` is just a very tiny wrapper on top.

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
Skip the check with `git commit --no-verify`. 

## FAQ

**Why not just keep private files gitignored?** 
Then they aren't versioned, synced between your machines or sharable with collaborators.

**Why not a second Private GitHub repo?**
Well this is essentially that, but files stay in the same folder as main repo, next to the code that uses them or context that explains them, and it easily scales to N different layers/repos. 

**Why not a git submodule?**
Other than same benefit from above (files staying next to the place that uses them), changing a layer doesn't need a commit in base (main repo), since their commit histories are fully separate, nor does the submodule's repo name ever appear in the main repo, it's like it doesn't exist from outside. 

This being said, this might not be beneficial for some cases, because sometimes a base commit pinning a submodule version is beneficial, such as when they need to be moved together, cause they are only compatible with specific versions of each other. Such as another version package/library/API-spec within your own package, and they just need to co-exist together at all times, and you cannot move base to HEAD-1 without moving the other as well.

**Can't GitHub do per-file permissions?**
No. Visibility is set per repo, and anyone who can clone a repo gets every file in it. 
They do have great repo access control, which this takes advantage of!

**Is this like git-crypt or sops?**
No. sich doesn't encrypt anything; it relies on who can access each repo. You can combine the two for real secrets.

## Caveats and contributing

[CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
