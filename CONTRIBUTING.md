# Contributing to sich

Issues and pull requests are welcome. This file covers the development setup,
how to test and release, and the caveats every change has to respect.

## Development

Building from source needs pnpm, plus [Bun](https://bun.sh) for bundling and
tests. Running sich itself only needs Node ≥ 18 and git ≥ 2.28.

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

## Tests

Most tests are integration tests in `test/sich.test.ts`: each builds throwaway
repos (and local bare remotes) with the `Sandbox` helper and drives the built
CLI. Add a test there with any behavior change, and make sure
`pnpm run typecheck` and `pnpm test` pass.

## Releasing

Bump `version` in `package.json`, then `pnpm publish`. `prepublishOnly` runs the
typecheck and the full test suite, then rebuilds `dist/` without the dev marker.

## Caveats

These are properties of sharing one working tree between several git repos.
Keep them in mind when using sich, and don't break the safeguards when changing it.

- **No encryption.** Privacy comes only from who can access each layer's
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
  branches. (`attach` checks out the remote's default branch.) Branches still
  work through the passthrough, e.g. `sich notes switch -c draft`.
- **Shared working tree.** Operations that rewrite the working tree in one repo
  (`checkout`, `reset --hard`, `clean -x`) can affect files owned by another:
  git treats ignored files, which every other repo's files are, as expendable.
  `git clean -fdx` (or `git stash --all`) in base would remove every layer's
  files; don't. `sich pull` checks first and stops rather than overwrite a file
  the pulled repo doesn't track; plain `git pull` doesn't.
