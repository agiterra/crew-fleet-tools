/**
 * fleet_launch — spawn a fresh agent on a registered remote machine.
 *
 * Symmetric with fleet_move for the first-spawn case: today, to
 * launch a NEW agent on the Mini you'd SSH in and run agent_launch
 * locally. fleet_launch collapses that to one MCP call.
 *
 * Wire identity rotation is the caller's concern (same convention as
 * fleet_move): if the agent should appear on a peer Wire instance,
 * pre-call wire-ipc's register_agent on the destination's Wire
 * (whichever Wire that is) and pass the returned key via
 * `env.AGENT_PRIVATE_KEY`.
 *
 * Sequence:
 *   1. Resolve destination machine from local crew DB. Refuse local
 *      destination — that's just agent_launch.
 *   2. Build a launch payload from the caller's opts.
 *   3. SSH dest: `crew launch --json -` with the payload via stdin
 *      (keeps env secrets out of argv / SSH audit logs).
 *   4. Return the destination-side agent row.
 */

import { CrewStore, type Machine } from "@agiterra/crew-tools";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_DB = join(process.env.HOME ?? homedir(), ".wire", "crews.db");
const DEFAULT_SSH_TIMEOUT_MS = 15_000;

export type FleetLaunchOpts = {
  destination: string;
  env: Record<string, string>;
  projectDir?: string;
  prompt?: string;
  runtime?: string;
  extraFlags?: string;
  badge?: string;
  ttlIdleMinutes?: number;
  dbPath?: string;
  sshTimeoutMs?: number;
  runShell?: ShellRunner;
};

export type FleetLaunchResult = {
  launched_on: string;
  destination_agent: unknown;
  steps: string[];
};

type ShellRunner = (args: { cmd: string; stdin?: string; timeoutMs: number }) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

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

export async function fleetLaunch(opts: FleetLaunchOpts): Promise<FleetLaunchResult> {
  const steps: string[] = [];
  const sshTimeoutMs = opts.sshTimeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
  const runShell = opts.runShell ?? defaultShellRunner;
  const store = new CrewStore(opts.dbPath ?? DEFAULT_DB);

  // 0. Validate inputs.
  if (!opts.env || !opts.env.AGENT_ID) {
    throw new Error("fleetLaunch: opts.env.AGENT_ID is required");
  }
  const dest: Machine | null = store.getMachine(opts.destination);
  if (!dest) {
    throw new Error(`fleetLaunch: destination '${opts.destination}' not registered in local machines table`);
  }
  if (dest.name === store.localMachineName()) {
    throw new Error(
      `fleetLaunch: destination '${opts.destination}' is the local machine. ` +
      `Use crew's agent_launch directly for local spawns.`,
    );
  }
  steps.push(`destination: ${dest.name} (${dest.ssh_host})`);

  // 1. Build the launch payload — mirrors Orchestrator.launchAgent's opts shape.
  const payload = {
    env: opts.env,
    projectDir: opts.projectDir,
    prompt: opts.prompt,
    runtime: opts.runtime,
    extraFlags: opts.extraFlags,
    badge: opts.badge,
    ttlIdleMinutes: opts.ttlIdleMinutes,
  };

  // 2. SSH dest + 'crew launch --json -' < payload.
  const portArg = dest.ssh_port ? ` -p ${dest.ssh_port}` : "";
  const sshOpts = `ssh -o BatchMode=yes -o ConnectTimeout=${Math.max(1, Math.floor(sshTimeoutMs / 1000))}${portArg}`;
  const launch = await runShell({
    cmd: `${sshOpts} ${dest.ssh_host} "crew launch --json -"`,
    stdin: JSON.stringify(payload),
    timeoutMs: sshTimeoutMs * 3,
  });
  if (launch.exitCode !== 0) {
    throw new Error(`fleetLaunch: remote launch failed (${launch.exitCode}): ${launch.stderr.trim()}`);
  }
  let destinationAgent: unknown;
  try {
    destinationAgent = JSON.parse(launch.stdout.trim());
  } catch {
    destinationAgent = launch.stdout.trim();
  }
  steps.push(`launched on dest`);

  return {
    launched_on: dest.name,
    destination_agent: destinationAgent,
    steps,
  };
}
