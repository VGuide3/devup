# devup — fix → validate → launch any repo

One file, zero dependencies (just `node`). Point it at any project — static
site, Node backend, TypeScript, monorepo, Rust, Go, Python, Solidity — and it
repairs what it can, verifies the rest, and boots the project.

## Install

```bash
git clone <this-repo> && cd devup && ./install.sh   # adds commands to .zshrc/.bashrc
```

## Commands

```bash
validate            # check the current dir — prints every problem, exit 1 on failure
validate ~/repo     # check a specific path
validate --fix      # auto-repair: npm install missing deps, strip JSONC, create .env
devup               # --fix + validate + migrate + launch (port conflicts auto-retry)
devup <git-url>     # clone to ~/repos/<name>, then all of the above
validate-all        # + npm test, eslint, knip dead-code scan
```

## What it checks (auto-detected, whole tree, per-subtree)

| Found | Check |
|---|---|
| `*.json` | parses; `--fix` strips comments/trailing commas |
| `package.json` | `node_modules` present when deps declared; `--fix` installs |
| `*.js/.ts` | syntax + **relative imports resolve** (broken wiring) |
| `tsconfig.json` | `tsc --noEmit` per package |
| `.env.example` | every `process.env.X` used in code is declared; `--fix` materializes `.env` with generated secrets |
| `*.html` | links, anchors, ids, asset refs |
| `foundry.toml` | `forge build` · `hardhat.config.*` → `hardhat compile` |
| `Cargo.toml` | `cargo check` · `go.mod` → `go vet` · `*.py` → `compileall` |
| `docker-compose.yml` | `docker compose config` |

Missing tools warn, never fail (`STRICT=1` to hard-fail).

## Global env

`~/.env` and `~/Desktop/devinscript/global.env` are loaded automatically:
launched processes inherit them, and vars satisfied globally downgrade from
error to warning. `GLOBAL_ENV=/path/file` overrides.

## Env vars

`VALIDATE_TESTS=1` `VALIDATE_LINT=1` `VALIDATE_DEAD=1` `VALIDATE_OFFLINE=1`
`STRICT=1` `VALIDATE_ROOT=/path` `VALIDATE_FIX=1` `VALIDATE_LAUNCH=1` `GLOBAL_ENV=path`

## Behavior

- FAIL → terminal bell + macOS notification. Errors needing judgment are
  listed; everything else self-repairs.
- Launch prefers the shallowest runnable target (root orchestrator wins),
  runs `npm run migrate` first if declared, retries once on a free port
  if the port is busy.
