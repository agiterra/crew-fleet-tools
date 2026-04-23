# crew-fleet-tools

Runtime-agnostic MCP adapter for cross-machine crew orchestration. SSH fan-out over the local crew DB's `machines` table, reads remote `agents` tables with `sqlite3 -json`, unions the results.

This package ships the library + MCP server. The Claude Code channel plugin is `crew-fleet-claude-code`.

## Design

- Each machine's local crew DB is authoritative for agents on that host.
- No central registry, no sync daemon, no long-lived cross-machine state.
- Every query is a fresh SSH fan-out; per-host failures are non-fatal.
- No import of `@agiterra/wire-tools`. Identity rotation at handoff time lives in `wire-ipc-tools` and is called via MCP composition.

## Tools

- `fleet_list({ machines?, timeout_ms? })` — union agent rows across machines.
- `fleet_status({ machines?, timeout_ms? })` — per-machine health + agent count.

## Machines registry

`machines` is managed by `@agiterra/crew-tools` (≥ v2.4.0) via its `machine_register`, `machine_list`, `machine_remove`, `machine_probe` MCP tools. crew-fleet just reads it.

## Testing

`bun test` — covers local-only, local+remote, unreachable, malformed JSON, and filter paths with an injected mock SSH runner.
