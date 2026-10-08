export const MAIN_HELP = `sich - private git layers that share one working tree with a normal repo

usage: sich [-C <dir>] <command> [args]
       sich [-C <dir>] <layer|base> <git args...>

setup
  init                         set up .sich/, base excludes and the pre-commit guard
  new <layer> [--remote <url> | --gh [name]]
                               create a private layer
  attach <layer> <url>         join an existing layer (collaborators)

ownership
  add <layer> <path...> [--move]   claim paths for a layer (stages them)
  rm <layer> <path...>             release claims (files stay on disk)
  which <path>                     show who owns a path
  ls [layer]                       list claims and tracked files

everyday
  status [-v] [--fetch]        one line per repo: branch, ahead/behind, changes
  commit [layer...] -m <msg>   commit layers that have changes
  pull | push | sync [repo...] pull --rebase / push / both, base + all layers
  check [--fix] [--staged]     find ownership problems (the pre-commit hook runs this)

passthrough
  <layer> <git args...>        run git against a layer, e.g. sich notes log
  base <git args...>           run git against the base repo

options
  -C <dir>        run as if started in <dir>
  -h, --help      show help (also: sich <command> --help)
  -V, --version   print version
`;

export const COMMAND_HELP: Record<string, string> = {
  init: `usage: sich init

Creates .sich/, writes the managed block in the base repo's info/exclude, and
installs a pre-commit hook that runs 'sich check --staged'. If a pre-commit hook
already exists or core.hooksPath is set, prints the line to add instead.
The hook runs $SICH_BIN (default: sich on PATH) and blocks the commit if it
can't be found. Safe to run again.`,

  new: `usage: sich new <layer> [--remote <url> | --gh [name]]

Creates layer <layer> (.sich/<layer>/ git dir sharing this working tree) with an
empty claims manifest .sich/<layer>.paths and an initial commit.
  --remote <url>   set origin
  --gh [name]      create a private GitHub repo with gh (default name:
                   <base-repo>-<layer>) and set origin to its SSH URL.
                   The gh binary can be overridden with SICH_GH.`,

  attach: `usage: sich attach <layer> <url>

Joins an existing layer: fetches <url> and checks out its default branch into
this working tree. Refuses to overwrite existing files.`,

  add: `usage: sich add <layer> <path...> [--move]

Claims paths (files or directories, relative to the current directory) for a
layer, then stages them and the manifest in that layer (no commit).
Refuses paths tracked by base or owned by another layer unless --move is given;
--move untracks them from the previous owner (old versions stay in its history).
Claims can't nest across layers: a path inside another layer's claimed directory
is always refused (move the whole directory instead).`,

  rm: `usage: sich rm <layer> <path...>

Removes exact claims from a layer and untracks them there. The files stay on
disk and show up as untracked in base (or, if another layer's directory claim
contains them, now belong to that layer).`,

  which: `usage: sich which <path>

Prints the owner of a path: a layer name, 'base', 'ignored' or 'untracked'.`,

  ls: `usage: sich ls [layer]

Lists each layer's claims and tracked files.`,

  status: `usage: sich status [-v] [--fetch]

One row per repo (base first): branch, ahead/behind upstream, and counts of
staged / modified / untracked files.
  -v, --verbose   list the files
  --fetch         fetch every repo with a remote first`,

  commit: `usage: sich commit [layer...] -m <msg>

Stages everything in each target layer (git add -A; the layer's whitelist keeps
this safe) and commits. Files the layer doesn't own (e.g. let in by a '!' rule
in a .gitignore) are left out with a warning. Defaults to every layer with
changes. Use plain 'git commit' for base.`,

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

  check: `usage: sich check [--fix] [--staged]

Reports: paths claimed or tracked by two layers, base tracking claimed paths or
.sich/, layers tracking files they don't own, and stale exclude blocks.
  --fix      rewrite stale exclude blocks
  --staged   also fail if base's index stages claimed paths or .sich/
             (this is what the pre-commit hook runs; silent when all is well,
             stale excludes only warn, and a no-op where sich isn't set up,
             e.g. a linked worktree)
Exits 1 if any issue remains.`,

  help: `usage: sich help [command]`,
};
