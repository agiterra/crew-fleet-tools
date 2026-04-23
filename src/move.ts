/**
 * fleet_move — cross-machine agent handoff.
 *
 * v0.2.0 scope: source must be the LOCAL machine; destination is any
 * registered remote. That covers the operator-initiated "move my agent
 * from laptop to home Mini" flow. Remote-to-remote handoffs (source !=
 * local) are a future extension.
 *
 * Sequence:
 *   1. Snapshot source agent + manifest (includes cc_session_id +
 *      sanitized env). No tombstone migration needed later because we
 *      pass the manifest inline to crew-resume on dest.
 *   2. Interrupt the source agent (Ctrl-B Ctrl-B — backgrounds the
 *      current tool call without losing state) so the JSONL state
 *      settles.
 *   3. Send /exit\r to the source screen. Wait for the screen process
 *      to exit (poll with a timeout; force-kill if needed).
 *   4. rsync the CC session JSONL from local to dest. At this point
 *      CC has written its final state.
 *   5. Stop source (writes source-side tombstone, releases DB row).
 *   6. SSH dest: `crew resume --json -` with the resume payload
 *      (stdin — keeps secrets out of argv / ssh audit logs).
 *   7. Optional: kickoff_prompt — `crew agent-send <id> <prompt>\r`
 *      so the resumed agent picks up a follow-up context rather than
 *      resuming cold at the just-interrupted state.
 *
 * Wire identity: this tool does NOT rotate AGENT_PRIVATE_KEY. If the
 * agent needs a fresh key on dest (because e.g. Wire identity rotation
 * is desired), the caller must pre-call wire-ipc's register_agent and
 * pass the returned key via `envOverrides.AGENT_PRIVATE_KEY`. Keeping
 * this out of fleet_move preserves the three-legged stool — crew-fleet
 * composes wire-ipc's MCP tool at the caller's level, not via import.
 */

import { CrewStore, Orchestrator, screen, createBackend, type Agent, type Machine } from "@agiterra/crew-tools";
import { homedir } from "os";
import { join } from "path";
import type { SshRunner } from "./fleet.js";

const DEFAULT_DB = join(process.env.HOME ?? homedir(), ".wire", "crews.db");
const DEFAULT_SSH_TIMEOUT_MS = 10_000;
const SCREEN_EXIT_TIMEOUT_MS = 15_000;

export type FleetMoveOpts = {
  /** Agent ID to move. Must be running on the local machine. */
  id: string;
  /** Destination machine name (must exist in the local machines table). */
  destination: string;
  /** Extra env merged on top of the manifest env before resume. Use this to inject a rotated AGENT_PRIVATE_KEY. */
  envOverrides?: Record<string, string>;
  /** After resume, send this text followed by \r to the destination screen to kick the agent into its next turn. */
  kickoffPrompt?: string;
  /** Path to the local crew DB. Default: ~/.wire/crews.db. */
  dbPath?: string;
  /** SSH per-call timeout. Default 10s. */
  sshTimeoutMs?: number;
  /** Injectable SSH runner — for tests. */
  runSsh?: SshRunner;
  /** Injectable orchestrator — for tests. Defaults to a real Orchestrator backed by the local DB. */
  orchestrator?: Pick<Orchestrator, "interruptAgent" | "sendToAgent" | "stopAgent" | "store">;
};

export type FleetMoveResult = {
  moved_to: string;
  source_machine: string;
  cc_session_id: string | null;
  destination_agent: unknown;
  steps: string[];
  kicked_off: boolean;
};

type ShellRunner = (args: {
  cmd: string;
  stdin?: string;
  timeoutMs: number;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultShellRunner: ShellRunner = async ({ cmd, stdin, timeoutMs }) => {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdin: stdin ? "pipe" : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  try {
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode: exitCode ?? -1 };
  } finally {
    clearTimeout(killTimer);
  }
};

/** Turn /Users/tim/Projects/X into the CC projects-dir encoding (-Users-tim-Projects-X). */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

async function waitForScreenExit(screenName: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await screen.isAlive(screenName))) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

export async function fleetMove(opts: FleetMoveOpts, runShell: ShellRunner = defaultShellRunner): Promise<FleetMoveResult> {
  const steps: string[] = [];
  const sshTimeoutMs = opts.sshTimeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
  const store = new CrewStore(opts.dbPath ?? DEFAULT_DB);
  const orch = opts.orchestrator ?? new Orchestrator(await createBackend(), opts.dbPath ?? DEFAULT_DB);
  const sourceMachine = store.localMachineName();

  // 0. Validate inputs.
  const dest: Machine | null = store.getMachine(opts.destination);
  if (!dest) throw new Error(`fleetMove: destination '${opts.destination}' not registered in local machines table`);
  if (dest.name === sourceMachine) throw new Error(`fleetMove: destination is the local machine; nothing to move`);

  const agent: Agent | null = store.getAgent(opts.id);
  if (!agent) throw new Error(`fleetMove: agent '${opts.id}' not found on local machine`);
  if (agent.machine_name !== sourceMachine) {
    throw new Error(
      `fleetMove: agent '${opts.id}' is on machine '${agent.machine_name}', not the local machine. ` +
      `v0.2.0 only supports moving from local; remote-to-remote is a future extension.`,
    );
  }
  if (!agent.spawn_manifest) {
    throw new Error(
      `fleetMove: agent '${opts.id}' has no spawn_manifest. Was it launched with crew-tools < v2.3.0? ` +
      `Re-launch with a newer crew to capture the manifest before moving.`,
    );
  }

  const manifest = JSON.parse(agent.spawn_manifest) as {
    env: Record<string, string>;
    runtime: string;
    project_dir: string;
    extra_flags?: string;
    badge?: string;
    display_name: string;
    ttl_idle_minutes?: number;
    channels?: string[];
  };
  const ccSessionId = agent.cc_session_id;
  steps.push(`snapshot: id='${opts.id}' cc_session_id='${ccSessionId ?? "(none)"}' project_dir='${manifest.project_dir}'`);

  // 1. Interrupt (background current tool call) — leaves conversation state intact.
  try {
    await orch.interruptAgent(opts.id, true);
    steps.push("interrupted source (Ctrl-B Ctrl-B)");
  } catch (e) {
    // Non-fatal: the agent may already be idle.
    steps.push(`interrupt skipped: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, 500));

  // 2. /exit\r → wait for screen to exit.
  try {
    await orch.sendToAgent(opts.id, "/exit\r");
    steps.push("sent /exit to source screen");
  } catch (e) {
    steps.push(`/exit send failed: ${(e as Error).message}`);
  }
  const exited = await waitForScreenExit(agent.screen_name, SCREEN_EXIT_TIMEOUT_MS);
  if (exited) {
    steps.push("source screen exited cleanly");
  } else {
    // Force-kill: stopAgent below will issue screen -X quit, but we log the slow path.
    steps.push(`source screen didn't exit within ${SCREEN_EXIT_TIMEOUT_MS}ms — will force-kill via stopAgent`);
  }

  // 3. rsync JSONL local → dest (ONLY if we have a cc_session_id).
  if (ccSessionId) {
    const encoded = encodeProjectDir(manifest.project_dir);
    const localPath = `${process.env.HOME ?? homedir()}/.claude/projects/${encoded}/${ccSessionId}.jsonl`;
    const destDir = `.claude/projects/${encoded}`;
    const destSpec = dest.ssh_host;
    const portArg = dest.ssh_port ? ` -p ${dest.ssh_port}` : "";
    const sshOpts = `ssh -o BatchMode=yes -o ConnectTimeout=${Math.max(1, Math.floor(sshTimeoutMs / 1000))}${portArg}`;
    // Create the dest projects subdir first, then rsync.
    const mkdir = await runShell({
      cmd: `${sshOpts} ${destSpec} "mkdir -p ~/${destDir}"`,
      timeoutMs: sshTimeoutMs,
    });
    if (mkdir.exitCode !== 0) {
      throw new Error(`fleetMove: remote mkdir failed (${mkdir.exitCode}): ${mkdir.stderr.trim()}`);
    }
    steps.push(`created dest dir ~/${destDir}`);
    const rsync = await runShell({
      cmd: `rsync -av --chmod=u+rw -e "${sshOpts}" '${localPath}' '${destSpec}:~/${destDir}/'`,
      timeoutMs: sshTimeoutMs * 3,
    });
    if (rsync.exitCode !== 0) {
      throw new Error(`fleetMove: rsync failed (${rsync.exitCode}): ${rsync.stderr.trim()}`);
    }
    steps.push(`rsync'd JSONL to dest`);
  } else {
    steps.push("skip rsync — no cc_session_id (agent never booted CC)");
  }

  // 4. Stop source (writes tombstone, releases row).
  try {
    await orch.stopAgent(opts.id, agent.cc_session_id ?? undefined);
    steps.push("stopped source agent (tombstone written on source)");
  } catch (e) {
    steps.push(`source stop failed: ${(e as Error).message}`);
  }

  // 5. ssh dest: `crew resume --json -` with inline payload.
  const resumePayload = {
    id: opts.id,
    ccSessionId: ccSessionId,
    projectDir: manifest.project_dir,
    env: { ...manifest.env, ...(opts.envOverrides ?? {}) },
    channels: manifest.channels,
    runtime: manifest.runtime,
    displayName: manifest.display_name,
    extraFlags: manifest.extra_flags,
    badge: manifest.badge,
  };
  const destPortArg = dest.ssh_port ? ` -p ${dest.ssh_port}` : "";
  const destSshOpts = `ssh -o BatchMode=yes -o ConnectTimeout=${Math.max(1, Math.floor(sshTimeoutMs / 1000))}${destPortArg}`;
  const resume = await runShell({
    cmd: `${destSshOpts} ${dest.ssh_host} "crew resume --json -"`,
    stdin: JSON.stringify(resumePayload),
    timeoutMs: sshTimeoutMs * 3,
  });
  if (resume.exitCode !== 0) {
    throw new Error(`fleetMove: remote resume failed (${resume.exitCode}): ${resume.stderr.trim()}`);
  }
  let destinationAgent: unknown;
  try {
    destinationAgent = JSON.parse(resume.stdout.trim());
  } catch {
    destinationAgent = resume.stdout.trim();
  }
  steps.push(`resumed on dest '${dest.name}'`);

  // 6. Optional kickoff_prompt.
  let kickedOff = false;
  if (opts.kickoffPrompt) {
    const kickoff = await runShell({
      cmd: `${destSshOpts} ${dest.ssh_host} crew agent-send ${JSON.stringify(opts.id)} ${JSON.stringify(opts.kickoffPrompt + "\r")}`,
      timeoutMs: sshTimeoutMs,
    });
    if (kickoff.exitCode !== 0) {
      steps.push(`kickoff send failed (${kickoff.exitCode}): ${kickoff.stderr.trim()}`);
    } else {
      steps.push("kickoff prompt sent");
      kickedOff = true;
    }
  }

  return {
    moved_to: dest.name,
    source_machine: sourceMachine,
    cc_session_id: ccSessionId,
    destination_agent: destinationAgent,
    steps,
    kicked_off: kickedOff,
  };
}
