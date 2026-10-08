# AGENTS.md

Guidance for AI coding agents working on sich. Read [README.md](README.md) for
what sich does and [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the caveats
every change has to respect.

## Layout

- `src/cli.ts`: entry point, command dispatch, `--version`.
- `src/commands/`: one file per command group (`init`, `layer` = new/attach,
  `add` = add/rm, `inspect` = which/ls, `status`, `commit`, `sync` =
  pull/push/sync, `check`).
- `src/git.ts`: the only way sich runs git (explicit `--git-dir`/`--work-tree`,
  scrubbed environment, literal pathspecs).
- `src/claims.ts`: claims and manifests (`.sich/<layer>.paths`).
- `src/excludes.ts`: the generated `info/exclude` blocks.
- `src/context.ts`: root discovery, layers, ownership helpers.
- `src/help.ts`: all help text. `src/ui.ts`: output helpers.
- `test/sich.test.ts`: integration tests via the `Sandbox` helper in
  `test/helpers.ts`. `test/excludes.test.ts`: unit tests for exclude generation.

## Commands

- `pnpm install`, `pnpm run typecheck`, `pnpm test` (rebuilds `dist/` first),
  `pnpm run build`.
- Before finishing: `pnpm run typecheck` and `pnpm test` must pass, and leave
  `dist/` as a default build (`pnpm run build`).
- Don't run `pnpm run install:global`, `pnpm publish`, or anything that pushes
  or creates remote repos unless asked.

## Rules

- **Runtime:** zero runtime dependencies; only Node ≥ 18 built-ins in `src/`.
  Bun is for bundling and tests only, so no Bun APIs in `src/`.
- **Git calls:** always through `src/git.ts`.
- **Ownership:** manifests are the single source of truth. Exclude blocks are
  generated, never edited by hand. Claims never nest across layers.
- **Guard:** the pre-commit hook runs `${SICH_BIN:-sich} check --staged` and
  fails closed. It blocks on leaks into base and on ambiguous ownership between
  layers, and only warns about stale excludes.
- **Version:** the dev marker is a build-time define (`SICH_DEV`), set by
  `install:global` only.
- **Messages:** anything that changes a file names it with `-> path`. Errors
  via `fail()`, warnings via `warn()`, hints via `note()`.
- **Help:** keep `sich --help` lines within 80 columns. The README's CLI
  section is a copy of `sich --help`; update it when the help changes.
- **Tests:** every behavior change gets a test in `test/sich.test.ts`. Tests use
  temp repos, isolated git config and local bare remotes; never touch real
  remotes or the real `gh` (use a fake via `SICH_GH`).
