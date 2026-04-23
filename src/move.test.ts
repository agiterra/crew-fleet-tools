import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock screen so the fleetMove flow can wait for 'exit' without real screen sessions.
const screenState = { isAliveResult: false };
mock.module("@agiterra/crew-tools/src/screen", () => ({
  isAlive: async () => screenState.isAliveResult,
}));

import { CrewStore } from "@agiterra/crew-tools";
import { fleetMove } from "./move";

type ShellCall = { cmd: string; stdin?: string };

let tmpDir: string;
let dbPath: string;
let store: InstanceType<typeof CrewStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-move-"));
  dbPath = join(tmpDir, "crews.db");
  store = new CrewStore(dbPath);
  screenState.isAliveResult = false;
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

/** Stub Orchestrator surface: we only need interrupt / send / stop / store. */
function stubOrchestrator(s: CrewStore) {
  const log: string[] = [];
  return {
    store: s,
    async interruptAgent(id: string) { log.push(`interrupt:${id}`); return { method: "background", output: "" }; },
    async sendToAgent(id: string, text: string) { log.push(`send:${id}:${text.replace(/\r/g, "\\r")}`); },
    async stopAgent(id: string) { log.push(`stop:${id}`); /* mimic tombstone + delete */ s["db"].prepare("DELETE FROM agents WHERE id=?").run(id); },
    log,
  };
}

function makeShell(responses: Array<{ match: RegExp; stdout?: string; stderr?: string; exitCode?: number }>, captured: ShellCall[]) {
  return async ({ cmd, stdin, timeoutMs }: { cmd: string; stdin?: string; timeoutMs: number }) => {
    captured.push({ cmd, stdin });
    for (const r of responses) {
      if (r.match.test(cmd)) {
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
      }
    }
    return { stdout: "", stderr: `unmatched: ${cmd}`, exitCode: 1 };
  };
}

function seedAgentAndDest(s: CrewStore) {
  s.createMachine({
    name: "home-mini",
    hostname: "home-mini",
    ssh_host: "tim@home-mini.local",
  });
  // Launch puts the row with machine_name = local.
  s.createAgent({
    id: "move-me",
    display_name: "MoveMe",
    runtime: "claude-code",
    screen_name: "wire-move-me",
    cc_session_id: "session-abc",
    spawn_manifest: JSON.stringify({
      env: { AGENT_ID: "move-me", AGENT_NAME: "MoveMe" },
      runtime: "claude-code",
      project_dir: "/tmp/move-wd",
      display_name: "MoveMe",
    }),
  });
}

describe("fleetMove", () => {
  test("runs the full handoff sequence and returns the dest agent row", async () => {
    seedAgentAndDest(store);
    const orch = stubOrchestrator(store);
    const calls: ShellCall[] = [];
    const shell = makeShell([
      { match: /mkdir -p/, exitCode: 0 },
      { match: /rsync/, exitCode: 0 },
      {
        match: /crew resume/,
        stdout: JSON.stringify({ id: "move-me", screen_name: "wire-move-me", machine_name: "home-mini" }),
        exitCode: 0,
      },
    ], calls);

    const res = await fleetMove({ id: "move-me", destination: "home-mini", dbPath, orchestrator: orch as any }, shell);

    expect(res.moved_to).toBe("home-mini");
    expect(res.source_machine).toBe(store.localMachineName());
    expect(res.cc_session_id).toBe("session-abc");
    // Orchestrator ops were invoked in order.
    expect(orch.log).toEqual([
      "interrupt:move-me",
      "send:move-me:/exit\\r",
      "stop:move-me",
    ]);
    // The three SSH calls happened: mkdir, rsync, resume.
    expect(calls.some((c) => /mkdir -p/.test(c.cmd))).toBe(true);
    expect(calls.some((c) => /rsync/.test(c.cmd))).toBe(true);
    const resumeCall = calls.find((c) => /crew resume/.test(c.cmd))!;
    expect(resumeCall).toBeDefined();
    // Resume payload went via stdin, not argv.
    expect(resumeCall.stdin).toContain("\"id\":\"move-me\"");
    expect(resumeCall.stdin).toContain("\"projectDir\":\"/tmp/move-wd\"");
    // Source row is gone (stopAgent stub deleted it).
    expect(store.getAgent("move-me")).toBeNull();
  });

  test("refuses unknown destination", async () => {
    seedAgentAndDest(store);
    const orch = stubOrchestrator(store);
    await expect(
      fleetMove({ id: "move-me", destination: "nope", dbPath, orchestrator: orch as any }, async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    ).rejects.toThrow(/not registered/);
  });

  test("refuses to move to the local machine", async () => {
    seedAgentAndDest(store);
    // Register the local machine with a non-local alias so the guard trips.
    store.createMachine({ name: store.localMachineName() + "-alt", hostname: "x", ssh_host: "localhost" });
    const orch = stubOrchestrator(store);
    await expect(
      fleetMove({ id: "move-me", destination: store.localMachineName(), dbPath, orchestrator: orch as any }, async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    ).rejects.toThrow(/nothing to move/);
  });

  test("refuses if agent has no spawn_manifest (legacy row)", async () => {
    store.createMachine({ name: "home-mini", hostname: "home-mini", ssh_host: "tim@home-mini.local" });
    // Create an agent with NULL spawn_manifest
    store["db"].prepare(
      `INSERT INTO agents (id, display_name, runtime, screen_name, launched_at, last_seen, machine_name)
       VALUES ('legacy', 'L', 'claude-code', 'wire-legacy', 0, 0, ?)`
    ).run(store.localMachineName());
    const orch = stubOrchestrator(store);
    await expect(
      fleetMove({ id: "legacy", destination: "home-mini", dbPath, orchestrator: orch as any }, async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    ).rejects.toThrow(/no spawn_manifest/);
  });

  test("envOverrides win over manifest env in the resume payload", async () => {
    seedAgentAndDest(store);
    const orch = stubOrchestrator(store);
    const calls: ShellCall[] = [];
    const shell = makeShell([
      { match: /mkdir -p|rsync/, exitCode: 0 },
      { match: /crew resume/, stdout: "{}", exitCode: 0 },
    ], calls);
    await fleetMove({
      id: "move-me",
      destination: "home-mini",
      envOverrides: { AGENT_PRIVATE_KEY: "rotated-key" },
      dbPath,
      orchestrator: orch as any,
    }, shell);
    const resume = calls.find((c) => /crew resume/.test(c.cmd))!;
    const payload = JSON.parse(resume.stdin!);
    expect(payload.env.AGENT_PRIVATE_KEY).toBe("rotated-key");
    expect(payload.env.AGENT_NAME).toBe("MoveMe");
  });

  test("kickoffPrompt sends a follow-up agent-send on the dest", async () => {
    seedAgentAndDest(store);
    const orch = stubOrchestrator(store);
    const calls: ShellCall[] = [];
    const shell = makeShell([
      { match: /mkdir -p|rsync/, exitCode: 0 },
      { match: /crew resume/, stdout: "{}", exitCode: 0 },
      { match: /crew agent-send/, stdout: "", exitCode: 0 },
    ], calls);
    const res = await fleetMove({
      id: "move-me",
      destination: "home-mini",
      kickoffPrompt: "Continue from where you left off.",
      dbPath,
      orchestrator: orch as any,
    }, shell);
    expect(res.kicked_off).toBe(true);
    expect(calls.some((c) => /crew agent-send/.test(c.cmd) && /Continue from/.test(c.cmd))).toBe(true);
  });

  test("rsync failure aborts the move", async () => {
    seedAgentAndDest(store);
    const orch = stubOrchestrator(store);
    const calls: ShellCall[] = [];
    const shell = makeShell([
      { match: /mkdir -p/, exitCode: 0 },
      { match: /rsync/, exitCode: 23, stderr: "rsync: permission denied" },
    ], calls);
    await expect(
      fleetMove({ id: "move-me", destination: "home-mini", dbPath, orchestrator: orch as any }, shell),
    ).rejects.toThrow(/rsync failed.*permission denied/);
    // Source is still present (we didn't reach the stop step).
    expect(store.getAgent("move-me")).not.toBeNull();
  });

  test("skips rsync when agent has no cc_session_id", async () => {
    store.createMachine({ name: "home-mini", hostname: "home-mini", ssh_host: "tim@home-mini.local" });
    store.createAgent({
      id: "no-session",
      display_name: "NS",
      runtime: "claude-code",
      screen_name: "wire-no-session",
      spawn_manifest: JSON.stringify({
        env: { AGENT_ID: "no-session" },
        runtime: "claude-code",
        project_dir: "/tmp/ns",
        display_name: "NS",
      }),
    });
    const orch = stubOrchestrator(store);
    const calls: ShellCall[] = [];
    const shell = makeShell([
      { match: /crew resume/, stdout: "{}", exitCode: 0 },
    ], calls);
    const res = await fleetMove({ id: "no-session", destination: "home-mini", dbPath, orchestrator: orch as any }, shell);
    expect(res.steps.some((s) => /skip rsync/.test(s))).toBe(true);
    expect(calls.some((c) => /rsync/.test(c.cmd))).toBe(false);
  });
});
