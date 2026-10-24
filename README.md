# Lithe Database plugin

The database tool window for [Lithe](https://github.com/1lck/Lithe-IDEA), a
community plugin (`io.github.lithe-idea.database`) listed in
[Lithe Store](https://github.com/Lithe-IDEA/Lithe-store):
connections to MySQL, MariaDB, PostgreSQL, SQLite, SQL Server, MongoDB, Redis,
and Nacos, with a SQL console, table data editing, structure editing,
CSV/JSON/SQL import and export, SQL history, and DBX connection import.

Lithe ships without a database module. Install this plugin from Lithe Store
in **Settings → Plugins → Marketplace**; Lithe moves the connections,
folders, SQL history, and saved passwords of its former built-in module into
the plugin on first start. The package carries no Lithe signature, so Lithe
moves that data only into a copy installed from Lithe Store whose listing
names this repository; a copy installed from disk or another source gets
none of it.

## How it is built

The plugin uses [plugin contract v1](https://github.com/Lithe-IDEA/lithe-plugin-docs/blob/main/contract/v1/README.md)
(`pluginAPIVersion` 3) and needs a Lithe whose web bridge is version 2 or
newer, for the host's file dialogs.

| Part | What it is |
| --- | --- |
| `plugin.json` | One bottom tool window whose page is `ui/index.html`, and one plugin backend. Permissions: `backend.launch`, `credentials.store`, `ui.contribute`, `ui.web`. |
| `ui/` | The page: Preact and CodeMirror, bundled by esbuild into `index.html`, `main.js`, and `style.css`. Lithe's content security policy allows only the package's own scripts and no network, so the page reaches databases only through the backend. Colors and fonts come from the host's `--lithe-*` variables. |
| `backend/crates/engine` | The database engine: one adapter per database kind, SSH tunnels, and the write guards (read-only and production protection). |
| `backend/crates/backend` | The plugin backend, built with the official [Rust SDK](https://github.com/Lithe-IDEA/lithe-plugin-docs/tree/main/sdk/rust): the functions the page calls, the saved connections, and DBX import. |

Lithe starts one backend process for the plugin when the page first calls a
function. What it keeps where:

| Data | Where |
| --- | --- |
| Connections and folders | `${stateDir}/connections.json` |
| SQL history (newest 100) | `${stateDir}/sql-history.json` |
| Passwords kept forever | The host's credential store (the Keychain on macOS), key `connection:<id>:password` |
| Passwords kept until restart | Backend memory only |
| Exports and imports | The file the user chose in Lithe's file dialog, read and written by the backend |

The installed package is never written to. A function result is limited to
1 MiB of JSON, so a result drops the rows past that and says so; files never
cross to the page.

### Write protection

The engine decides, not the page. A read-only connection refuses every
statement that writes, also when it is sent as a query or an export: the
statement is lexed, and only statements that start with a reading verb and
hold no writing keyword run (`WITH d AS (DELETE …)`, `SELECT … INTO`, and
`EXPLAIN ANALYZE` are refused). A connection with production protection
answers `confirmation_required` for dangerous statements (drops, truncates,
`UPDATE`/`DELETE` without `WHERE`, restores) and for Redis and Nacos writes;
the page asks the user and repeats the request with `confirmed: true`.

### Differences from Lithe's former built-in module

- Recovery points and backup schedules are not carried over. The built-in
  module exported the whole database before each table edit, but no screen
  ever listed or restored those exports. Use **Back Up as SQL…** and
  **Restore SQL Backup…** instead.
- Running statements can be cancelled.
- Masked columns are read-only in the table editor.
- Explain, diagnostics, and schema diff had no screen in the built-in module
  and have none here yet.

## Developing

Requirements: macOS, Node.js 24, and Rust 1.87 or newer through rustup with
the `aarch64-apple-darwin` and `x86_64-apple-darwin` targets.

```sh
npm ci --prefix ui
npm --prefix ui run check            # TypeScript
npm --prefix ui test                 # SQL helpers, values, translations
cargo test --locked --manifest-path backend/Cargo.toml
cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
```

`node scripts/package.mjs` builds `dist/io.github.lithe-idea.database/` and
`dist/database-<version>-darwin.zip` with a universal backend;
`--host-only` builds only this Mac's architecture. Install the folder or
the zip in Lithe with **Install from Disk** to try it.

`node scripts/e2e.mjs` runs `e2e/database_plugin.rs` against Lithe's Rust
Core at the commit `e2e/lithe-core.json` pins: Core launches the packaged
backend as a host does, and the test answers its credential requests and
drives a SQLite connection through every page function. `--source <path>`
uses a local Lithe checkout instead of cloning.

Every message the page shows goes through `t()` and needs a Simplified
Chinese translation in `ui/src/zh-Hans.ts`; `ui/src/i18n.test.ts` fails
otherwise.

## Releasing

1. Bump `version` in `plugin.json` and merge it to `main`. Every release
   needs a new version; published archives are never replaced.
2. A maintainer tags the merge commit `v<version>` and pushes the tag (a
   ruleset lets only organization admins create `v*` tags).
3. The release workflow tests, builds the universal package, runs the
   end-to-end check, verifies the archive, and publishes a GitHub release
   with `database-<version>-darwin.zip` and its SHA-256.
4. The first release is listed in Lithe Store with a pull request to
   `lithe-plugin-index.json`. After that, Lithe Store's release tracker
   opens the pull request for each new version; a maintainer reviews it
   like code, since the plugin receives database passwords.

## License

Apache-2.0
