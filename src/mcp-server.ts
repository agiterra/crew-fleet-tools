#!/usr/bin/env bun
/**
 * crew-fleet MCP server — runtime-agnostic adapter.
 *
 * Exposes fleet_list + fleet_status over MCP. Reads the local crew DB's
 * `machines` table (populated via crew's own machine_register tool) and
 * SSHes out to each peer to read their agents table. Read-only today;
 * fleet_move (the handoff skill) lands in a follow-up issue.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fleetList, fleetStatus } from "./fleet.js";
import { fleetMove } from "./move.js";

const mcp = new Server(
  { name: "crew-fleet", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Cross-machine crew query. Each machine's local crew DB is the " +
      "authoritative source for agents on that host; crew-fleet fans out " +
      "over the machines registry (populated via crew's machine_register) " +
      "and unions per-machine results. SSH failures per host are " +
      "non-fatal — they surface as unreachable rows. No persistent " +
      "state; every call is a fresh fan-out.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fleet_list",
      description:
        "List every agent across every machine in the crew's machines " +
        "registry. For each remote machine we SSH + sqlite3 into the " +
        "agents table and union the rows. Local agents are read " +
        "directly. Returns { agents, unreachable } — unreachable is the " +
        "list of machines whose SSH or sqlite3 call failed, so you " +
        "always know what's missing from `agents`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          machines: {
            type: "array",
            items: { type: "string" },
            description: "Optional subset of machine names to query. Default: all registered.",
          },
          timeout_ms: {
            type: "number",
            description: "Per-host SSH timeout in ms. Default 5000.",
          },
        },
      },
    },
    {
      name: "fleet_move",
      description:
        "Move a running agent from the local machine to a registered " +
        "destination machine, preserving its Claude Code conversation " +
        "history via `claude --resume`.\n\n" +
        "Handoff sequence:\n" +
        "  1. Snapshot the source agent + its spawn manifest.\n" +
        "  2. Interrupt (Ctrl-B Ctrl-B) to background any live tool call.\n" +
        "  3. /exit\\r into the source screen; wait up to 15s for clean exit.\n" +
        "  4. rsync the CC session JSONL from local to the destination.\n" +
        "  5. Stop source (writes local tombstone, frees the row).\n" +
        "  6. ssh dest `crew resume --json -` with the inline manifest.\n" +
        "  7. Optional: send `kickoff_prompt` to the destination screen.\n\n" +
        "Wire identity is NOT rotated by this tool. If the agent needs a " +
        "fresh pubkey on Wire, pre-call wire-ipc's `register_agent` and " +
        "pass the returned `private_key_b64` via `env_overrides." +
        "AGENT_PRIVATE_KEY`. Keeping Wire rotation out of fleet_move " +
        "preserves the crew / wire separation (crew-fleet never imports " +
        "wire-tools).\n\n" +
        "v0.2.0 only moves agents FROM the local machine. Remote-to-" +
        "remote moves are a future extension.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID to move." },
          destination: { type: "string", description: "Name of a registered machine (from `machine_list`)." },
          env_overrides: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Env merged on top of the source manifest's env before resume. Use to inject a rotated AGENT_PRIVATE_KEY.",
          },
          kickoff_prompt: {
            type: "string",
            description: "Optional text to send (with trailing \\r) to the destination screen after resume, kicking the agent into its next turn.",
          },
          ssh_timeout_ms: {
            type: "number",
            description: "Per-SSH-call timeout in ms. Default 10000. The rsync step gets 3x this budget.",
          },
        },
        required: ["id", "destination"],
      },
    },
    {
      name: "fleet_status",
      description:
        "Health-check every machine (or a subset). Returns reachability, " +
        "agent counts, and cached crew version per machine. Lighter " +
        "than fleet_list — useful before a handoff to confirm the " +
        "destination is up.",
      inputSchema: {
        type: "object" as const,
        properties: {
          machines: {
            type: "array",
            items: { type: "string" },
            description: "Optional subset of machine names. Default: all registered.",
          },
          timeout_ms: {
            type: "number",
            description: "Per-host SSH timeout in ms. Default 5000.",
          },
        },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (name) {
      case "fleet_list":
        result = await fleetList({
          machines: a.machines as string[] | undefined,
          timeoutMs: a.timeout_ms as number | undefined,
        });
        break;
      case "fleet_status":
        result = await fleetStatus({
          machines: a.machines as string[] | undefined,
          timeoutMs: a.timeout_ms as number | undefined,
        });
        break;
      case "fleet_move":
        result = await fleetMove({
          id: a.id as string,
          destination: a.destination as string,
          envOverrides: a.env_overrides as Record<string, string> | undefined,
          kickoffPrompt: a.kickoff_prompt as string | undefined,
          sshTimeoutMs: a.ssh_timeout_ms as number | undefined,
        });
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: `error: ${e.stack ?? e.message}` }],
      isError: true,
    };
  }
});

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error("[crew-fleet] ready");
}

if (import.meta.main) {
  startServer().catch((e) => {
    console.error("[crew-fleet] fatal:", e);
    process.exit(1);
  });
}
