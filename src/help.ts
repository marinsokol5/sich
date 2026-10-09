export const MAIN_HELP = `sich - private git layers that share one working tree with a normal repo

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
  detach <layer> [--force] [--yes]  remove a layer here; files and remote stay

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
`;

export const COMMAND_HELP: Record<string, string> = {
  init: `usage: sich init

Creates .sich/, writes the managed blocks in each repo's info/exclude, and
installs pre-commit and pre-merge-commit hooks in base and in every layer that
run 'sich check --staged' (git runs pre-merge-commit instead of pre-commit for
a merge commit made without conflicts). Fast-forwards, rebase and cherry-pick
run no hook; plain 'sich check' catches what they bring in afterwards. If such
a hook already exists or core.hooksPath is set, prints the line to add instead
(each line works in base, in every layer and in a core.hooksPath they share).
The hooks run $SICH_BIN (default: sich on PATH) and block the commit if it
can't be found. Safe to run again; refreshes hooks sich wrote and adds missing
ones.`,

  new: `usage: sich new <layer> [--remote <url> | --gh [name]]

Creates layer <layer> (.sich/<layer>/ git dir sharing this working tree) with an
empty claims manifest .sich/<layer>.paths and an initial commit, and installs
its pre-commit and pre-merge-commit hooks (see sich init).
  --remote <url>   set origin
  --gh [name]      create a private GitHub repo with gh (default name:
                   <base-repo>-<layer>) and set origin to its SSH URL.
                   The gh binary can be overridden with SICH_GH.`,

  attach: `usage: sich attach <layer> <url>

Joins an existing layer: fetches <url> and checks out its default branch into
this working tree, and installs its pre-commit and pre-merge-commit hooks (see
sich init). Refuses to overwrite existing files.`,

  detach: `usage: sich detach <layer> [--force] [--yes]

The opposite of attach: removes a layer from this working tree by deleting its
git data (.sich/<layer>/) and claims list (.sich/<layer>.paths). Its files stay
on disk, no longer hidden from base (nothing stops base from committing them
any more), and its remote is left alone: attach it again any time.
Refuses if that would lose what exists only in .sich/<layer>/: commits on no
remote (for branches: as of the last fetch or push), stashes, staged versions
of files that changed again on disk, linked worktrees, submodule repos, or a
merge, rebase or similar in progress. Uncommitted changes to files don't
count, since the files stay.
Lists what it deletes and what it keeps, then asks before doing it (no answer,
e.g. without a terminal, means no).
  --force     detach anyway, discarding all of that
  -y, --yes   don't ask`,

  claim: `usage: sich claim <layer> <path...> [--move]

Claims paths (files or directories, relative to the current directory) for a
layer, then stages them and the manifest in that layer (no commit).
Refuses paths tracked by base or owned by another layer unless --move is given;
--move untracks them from the previous owner (old versions stay in its history).
Claims can't nest across layers: a path inside another layer's claimed directory
is always refused (move the whole directory instead).
Not the same as 'sich <layer> add', which runs plain git add in the layer.
Alias: sich add.`,

  unclaim: `usage: sich unclaim <layer> <path...>

Removes exact claims from a layer and untracks them there. The files stay on
disk and show up as untracked in base (or, if another layer's directory claim
contains them, now belong to that layer).
Not the same as 'sich <layer> rm', which runs plain git rm (deleting files).
Alias: sich rm.`,

  which: `usage: sich which <path>

Prints the owner of a path: a layer name, 'base', 'ignored' or 'untracked'.`,

  ls: `usage: sich ls [layer]

Lists each layer's claims and tracked files.`,

  status: `usage: sich status [-v] [--fetch]

One row per repo (base first): branch, ahead/behind upstream, and counts of
staged / modified / untracked files.
  -v, --verbose   list the files
  --fetch         fetch every repo with a remote first`,

  commit: `usage: sich commit [repo...] -m <msg>

Stages everything (git add -A) and commits, in base and every layer with
changes, or only in the named repos ('base' or layer names). Excludes keep each
repo to its own files; anything a repo doesn't own (e.g. let in by a '!' rule in
a .gitignore) is left out with a warning. Each commit runs that repo's
pre-commit hook.`,

  pull: `usage: sich pull [repo...]

git pull --rebase --autostash in base and every layer (or the named repos,
'base' allowed). Repos without a remote are skipped. Stops at the first failure.
Refuses to pull a repo if that would overwrite a file it doesn't track, such as
another layer's (git would do that silently: to it, those files are ignored).`,

  push: `usage: sich push [repo...]

git push in base and every layer (or the named repos). Sets the upstream
(-u origin <branch>) when there is none. Stops at the first failure.`,

  sync: `usage: sich sync [repo...]

pull then push, repo by repo. Stops at the first failure.`,

  check: `usage: sich check [--fix] [--staged [--merge] [--repo <repo>]]

Reports: paths claimed or tracked by two layers, base tracking claimed paths or
.sich/, layers tracking files they don't own, and stale exclude blocks. Warns
about base or layers whose pre-commit or pre-merge-commit hook doesn't run sich
(fix: sich init).
  --fix          rewrite stale exclude blocks
  --staged       also check the commit in progress (this is what the
                 pre-commit and pre-merge-commit hooks run; for a merge, what
                 it brings in). In base, fail if it stages claimed paths or
                 .sich/. In a layer, fail if it stages a path that none of its
                 claims cover (in the claims list as committed too), another
                 layer's, or .sich/. Staged deletions are fine. The repo is
                 the one whose index git is committing (else base). Silent
                 when all is well, stale excludes only warn, and a no-op where
                 sich isn't set up (e.g. a linked worktree)
  --merge        with --staged: the commit is a merge (the pre-merge-commit
                 hooks pass it; finishing a conflicted merge counts without
                 it). A blocked merge prints how to back out and restore what
                 it overwrote, instead of commit hints
  --repo <repo>  with --staged: check this repo ('base' or a layer) instead
Exits 1 if any issue remains.`,

  help: `usage: sich help [command]`,
};

// Undocumented aliases (the commands' older names) share their help.
COMMAND_HELP.add = COMMAND_HELP.claim!;
COMMAND_HELP.rm = COMMAND_HELP.unclaim!;
