# Codex homes: P0 per-session `CODEX_HOME`

## What is supported now

Codex executions can select a persistent home independently of the runner's
default `~/.codex`:

- Host API / web spawn field: `codexHome` (absolute path)
- CLI: `hapi codex --codex-home /home/me/.codex-ipads`
- Omitted or empty = existing behavior (`CODEX_HOME` of the runner, else
  `~/.codex`)

The runner passes the path to the Codex CLI; `runSharedRuntime` starts the
app-server with `CODEX_HOME` set to that home, and the session records
`metadata.codexHome`. Resume reads the stored path and refuses to switch an
existing session to another home.

The New Session form exposes the field for Codex. It is a plain path input when
the runner advertises no presets.

## Persisted registry (P1)

The runner now also stores homes in `$HAPI_HOME/codex-homes.json`:

- `GET/POST /api/machines/:id/codex-homes`
- `DELETE /api/machines/:id/codex-homes/:homeId`

Machine settings exposes a Codex homes panel; the New Session form merges
these entries with the environment presets. The built-in `default` home is
always official and cannot be deleted. Adding a second `official` home is
rejected because the existing Codex account switcher owns `~/.codex`.

Account switching is now restricted to the official/default home. Selecting a
Codex account together with an isolated home fails before the child starts,
instead of copying the global auth into that home.

## Runner presets (P1)

A runner can advertise a read-only home allowlist:

```sh
export HAPI_CODEX_HOMES='[
  {"id":"official","label":"Official","path":"/home/me/.codex","official":true},
  {"id":"ipads","label":"IPADS","path":"/home/me/.codex-ipads"}
]'
```

The runner includes the parsed list in machine metadata; the New Session form
renders a selector when more than one home is advertised. IDs are runner-local
and only used for the picker and diagnostics; the selected path is what P0
passes to Codex. An official home is required for the existing account switcher;
isolated homes use their own config and `env_key`.

## Isolation rules

- A custom home must already exist and be a directory.
- A custom home may not start with the working directory set to the user's
  `$HOME`. Codex can discover `~/.codex` as project config there and merge the
  default provider into an isolated home (openai/codex#54599). Start the
  session from the actual project directory instead.
- Custom homes drop inherited `CODEX_SQLITE_HOME`, `CODEX_API_KEY`, and
  `CODEX_ACCESS_TOKEN` so a shared store/key cannot bridge homes.
- If a Codex account is selected together with a custom home, the runner copies
  the just-activated `auth.json` into that home with mode `0600`.
- Gateway providers keep their `env_key` in the runner environment. The Hub
  stores only the home path and never receives provider secrets.

## Gateway key profiles

A gateway key is a credential inside the same home, not a new home. Configure
labels and environment values on the runner:

```sh
export HAPI_CODEX_KEY_PROFILES='[
  {"id":"key-a","label":"IPADS A","homeId":"ipads","env":{"IPADS_API_KEY":"..."}},
  {"id":"key-b","label":"IPADS B","homeId":"ipads","env":{"IPADS_API_KEY":"..."}}
]'
```

The machine advertises only `{id,label,homeId}`. `codexKeyProfileId` travels
from New Session to the runner, which injects the selected `env` into the Codex
child process and records the id in session metadata. The Hub never receives
the secret. A Profile is fixed for the lifetime of one execution; rotating it
requires a new execution. Concurrent executions may use different keys while
sharing the same home and history.

## Not in P0

- A persisted `CodexHome` registry with stable IDs, labels, discovery, and
  delete/rename guards.
- Per-home account binding. The existing account switcher is still global.
- Cross-home history search/import.
- Home-scoped shared resources (`AGENTS.md`, skills, rules).

## Native thread migration (P0)

`POST /api/machines/:id/codex-thread-migrate` calls the runner's
`migrateCodexThread` RPC with:

```json
{
  "sourceHome": "/home/me/.codex",
  "targetHome": "/home/me/.codex-ipads",
  "threadId": "01a...",
  "targetProvider": "ipads"
}
```

The runner refuses while its own runtime registry still has an active session
for that thread. The migration is a staged, per-thread online import:

1. read-only schema/migration/conflict preflight;
2. copy the current rollout and any `history_base` ancestors to staging;
3. write `thread_turns`/`thread_items`/realtime/projection rows in one
   `BEGIN IMMEDIATE` transaction;
4. write the `threads` row last with an absolute target `rollout_path`;
5. verify row counts and rollout existence.

The target home is not stopped. Only SQLite's database-level write lock is
taken for the short import transactions; other Codex sessions can keep reading.
A failure before publish removes the rows and files created by this transfer.
After publish, failures are left in the journal for repair instead of deleting
data that the target app-server may already have observed.

After publish the runner starts a temporary app-server against the target
home and verifies `thread/read` (falling back to `thread/resume`). If the request
includes `sessionId`, the Hub also rebinds that HAPI session's `codexHome`,
`codexStoreId`, and optional `codexHomeId`; the next resume uses the target
home. The original source rollout is left in place as a rollback copy.

Known P0 limits:

- same Codex schema/version is required;
- cross-provider migration is supported for a single current rollout when `targetProvider` and `targetModel` are supplied; it relies on `thread/resume` model/provider overrides because the source provider stays in persisted history;
- cross-provider migration of paginated/multi-rollout history is rejected; encrypted reasoning compatibility is not guaranteed;
- `targetProvider` is accepted for future work but currently only the source provider is allowed;
- thread attachments and spawn edges are not migrated;
- encrypted reasoning across providers and reverse migration are not solved;
- a real `thread/resume` and new turn must still be validated after import;
- session menu now has a one-click **Migrate Codex home** action: it stops the source session, migrates the thread, rebinds the session, and keeps the target home online; the machine settings form remains for manual runs;
- real Codex app-server tests cover legacy, `.zst`, paginated revert, fork, and cross-provider resume override plus new target turns.
