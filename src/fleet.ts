/**
 * Fleet-level primitives: read-only SSH fan-out over the local crew DB's
 * `machines` table. Each machine's local crew DB is the authoritative
 * source for what's running ON that machine; crew-fleet unions per-machine
 * results without any persistent cross-machine coordination.
 *
 * Transport is plain SSH + `sqlite3` over stdin. We deliberately DO NOT
 * import `@agiterra/wire-tools` — crew-fleet is a new leg on the
 * crew/wire/knowledge stool, composed through conventions (SSH, sqlite3
 * on the remote side, wire-ipc MCP calls at handoff time), not through
 * cross-imports.
 */

import { CrewStore, type Agent, type Machine } from "@agiterra/crew-tools";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_DB = join(process.env.HOME ?? homedir(), ".wire", "crews.db");
const DEFAULT_TIMEOUT_MS = 5000;

/** Agent row annotated with the machine it came from. */
export type FleetAgent = Agent & { machine: string; reachable: true };

/** Health-check row for a single machine. */
export type FleetMachineStatus = {
  machine: string;
  ssh_host: string;
  reachable: boolean;
  last_probed_at: number;
  crew_version?: string;
  agent_count?: number;
  error?: string;
};

type RunOpts = {
  /** Path to the local crew DB (defaults to ~/.wire/crews.db). */
  dbPath?: string;
  /** Subset of machine names to fan out to. Defaults to all registered. */
  machines?: string[];
  /** Per-host SSH timeout in ms. Default 5000. */
  timeoutMs?: number;
  /**
   * SSH runner — injectable for tests. Default shells out to `ssh`
   * with BatchMode=yes.
   */
  runSsh?: SshRunner;
};

export type SshRunner = (args: {
  sshHost: string;
  sshPort: number | null;
  remoteCommand: string;
  timeoutMs: number;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultSshRunner: SshRunner = async ({ sshHost, sshPort, remoteCommand, timeoutMs }) => {
  const portArg = sshPort ? ["-p", String(sshPort)] : [];
  const proc = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", `ConnectTimeout=${Math.max(1, Math.floor(timeoutMs / 1000))}`, ...portArg, sshHost, remoteCommand],
    { stdout: "pipe", stderr: "pipe" },
  );
  // Hard timeout — kill if we exceed the budget.
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* ignore */ }
  }, timeoutMs);
  try {
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode: exitCode ?? -1 };
  } finally {
    clearTimeout(timer);
  }
};

/** Decide which machines to fan out to for a given run. */
function resolveMachines(store: CrewStore, filter?: string[]): Machine[] {
  const all = store.listMachines();
  if (!filter || filter.length === 0) return all;
  const wanted = new Set(filter);
  return all.filter((m) => wanted.has(m.name));
}

/** Agents table columns we read remotely. Matches the Agent type. */
const AGENT_COLUMNS = [
  "id", "display_name", "runtime", "screen_name", "screen_pid",
  "cc_session_id", "pane", "status_name", "status_desc", "badge",
  "launched_at", "last_seen", "ttl_idle_minutes", "spawn_manifest",
  "machine_name",
] as const;

/**
 * Fan out to every registered machine and union their agents rows.
 * Failures per machine are non-fatal — reachable:false rows annotate
 * which ones failed.
 */
export async function fleetList(opts: RunOpts = {}): Promise<{
  agents: FleetAgent[];
  unreachable: FleetMachineStatus[];
}> {
  const store = new CrewStore(opts.dbPath ?? DEFAULT_DB);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runSsh = opts.runSsh ?? defaultSshRunner;
  const machines = resolveMachines(store, opts.machines);
  const localName = store.localMachineName();

  const agents: FleetAgent[] = [];
  const unreachable: FleetMachineStatus[] = [];

  await Promise.all(machines.map(async (m) => {
    // Local machine: read the DB directly — no SSH hop needed.
    if (m.name === localName || m.ssh_host === "localhost") {
      const rows = store.listAgents();
      for (const r of rows) agents.push({ ...r, machine: m.name, reachable: true });
      return;
    }
    const cols = AGENT_COLUMNS.join(",");
    const remoteDb = "~/.wire/crews.db";
    // JSON mode keeps the wire format trivial to parse.
    const cmd = `sqlite3 -json ${remoteDb} 'SELECT ${cols} FROM agents'`;
    const res = await runSsh({
      sshHost: m.ssh_host,
      sshPort: m.ssh_port,
      remoteCommand: cmd,
      timeoutMs,
    });
    if (res.exitCode !== 0) {
      unreachable.push({
        machine: m.name,
        ssh_host: m.ssh_host,
        reachable: false,
        last_probed_at: Date.now(),
        error: (res.stderr || `exit ${res.exitCode}`).trim(),
      });
      return;
    }
    // sqlite3 -json emits "[]" for an empty table, or nothing at all on some builds.
    const raw = res.stdout.trim();
    if (!raw || raw === "[]") return;
    try {
      const rows = JSON.parse(raw) as Agent[];
      for (const r of rows) agents.push({ ...r, machine: m.name, reachable: true });
    } catch (e) {
      unreachable.push({
        machine: m.name,
        ssh_host: m.ssh_host,
        reachable: false,
        last_probed_at: Date.now(),
        error: `malformed sqlite3 JSON: ${(e as Error).message}`,
      });
    }
  }));

  return { agents, unreachable };
}

/**
 * Lightweight reachability check per machine. Runs `hostname` + an
 * agents-count query. Useful before a handoff to confirm the
 * destination is actually reachable.
 */
export async function fleetStatus(opts: RunOpts = {}): Promise<FleetMachineStatus[]> {
  const store = new CrewStore(opts.dbPath ?? DEFAULT_DB);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runSsh = opts.runSsh ?? defaultSshRunner;
  const machines = resolveMachines(store, opts.machines);
  const localName = store.localMachineName();

  return Promise.all(machines.map(async (m): Promise<FleetMachineStatus> => {
    const probedAt = Date.now();
    if (m.name === localName || m.ssh_host === "localhost") {
      return {
        machine: m.name,
        ssh_host: m.ssh_host,
        reachable: true,
        last_probed_at: probedAt,
        agent_count: store.listAgents().length,
        crew_version: m.crew_version ?? undefined,
      };
    }
    const cmd =
      `hostname; sqlite3 ~/.wire/crews.db 'SELECT COUNT(*) FROM agents'; ` +
      `cat ~/.claude/plugins/cache/agiterra/crew/*/package.json 2>/dev/null | grep '"version"' | head -1 || true`;
    const res = await runSsh({ sshHost: m.ssh_host, sshPort: m.ssh_port, remoteCommand: cmd, timeoutMs });
    if (res.exitCode !== 0) {
      return {
        machine: m.name,
        ssh_host: m.ssh_host,
        reachable: false,
        last_probed_at: probedAt,
        error: (res.stderr || `exit ${res.exitCode}`).trim(),
      };
    }
    const lines = res.stdout.trim().split("\n");
    const count = parseInt(lines[1] ?? "0", 10);
    const versionLine = lines[2] ?? "";
    const versionMatch = versionLine.match(/"version":\s*"([^"]+)"/);
    return {
      machine: m.name,
      ssh_host: m.ssh_host,
      reachable: true,
      last_probed_at: probedAt,
      agent_count: Number.isNaN(count) ? undefined : count,
      crew_version: versionMatch?.[1],
    };
  }));
}
