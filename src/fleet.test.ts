import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CrewStore } from "@agiterra/crew-tools";
import { fleetList, fleetStatus, type SshRunner } from "./fleet";

let tmpDir: string;
let dbPath: string;
let store: InstanceType<typeof CrewStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crew-fleet-"));
  dbPath = join(tmpDir, "crews.db");
  store = new CrewStore(dbPath);
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

/** Mock SSH runner — programmable response per ssh_host. */
function makeSsh(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>): SshRunner {
  return async ({ sshHost }) => {
    const r = responses[sshHost] ?? { exitCode: 255, stderr: `unconfigured host: ${sshHost}` };
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
}

describe("fleetList", () => {
  test("returns local agents only when no remote machines registered", async () => {
    store.createAgent({ id: "local-agent", display_name: "Local", runtime: "claude-code", screen_name: "wire-local-agent" });
    const res = await fleetList({ dbPath });
    expect(res.unreachable).toHaveLength(0);
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0]!.id).toBe("local-agent");
    expect(res.agents[0]!.machine).toBe(store.localMachineName());
  });

  test("unions local + remote agents via SSH", async () => {
    store.createAgent({ id: "local-agent", display_name: "Local", runtime: "claude-code", screen_name: "wire-local-agent" });
    store.createMachine({ name: "home-mini", hostname: "home-mini", ssh_host: "tim@home-mini.local" });

    const ssh = makeSsh({
      "tim@home-mini.local": {
        stdout: JSON.stringify([
          {
            id: "remote-agent",
            display_name: "Remote",
            runtime: "claude-code",
            screen_name: "wire-remote-agent",
            screen_pid: 123,
            cc_session_id: null,
            pane: null,
            status_name: null,
            status_desc: null,
            badge: null,
            launched_at: 0,
            last_seen: 0,
            ttl_idle_minutes: null,
            spawn_manifest: null,
            machine_name: "home-mini",
          },
        ]),
        exitCode: 0,
      },
    });

    const res = await fleetList({ dbPath, runSsh: ssh });
    expect(res.unreachable).toHaveLength(0);
    expect(res.agents.map((a) => a.id).sort()).toEqual(["local-agent", "remote-agent"]);
    const remote = res.agents.find((a) => a.id === "remote-agent")!;
    expect(remote.machine).toBe("home-mini");
  });

  test("reports unreachable machines without failing the whole call", async () => {
    store.createMachine({ name: "broken", hostname: "broken", ssh_host: "tim@broken.local" });
    store.createMachine({ name: "good", hostname: "good", ssh_host: "tim@good.local" });

    const ssh = makeSsh({
      "tim@broken.local": { exitCode: 255, stderr: "ssh: connect refused" },
      "tim@good.local": { stdout: "[]", exitCode: 0 },
    });

    const res = await fleetList({ dbPath, runSsh: ssh });
    expect(res.unreachable.map((u) => u.machine)).toContain("broken");
    expect(res.unreachable[0]!.error).toContain("connect refused");
    // 'good' returned an empty agents array — not unreachable, just empty.
    expect(res.unreachable.find((u) => u.machine === "good")).toBeUndefined();
  });

  test("malformed remote JSON annotated as unreachable, not thrown", async () => {
    store.createMachine({ name: "corrupt", hostname: "corrupt", ssh_host: "tim@corrupt.local" });
    const ssh = makeSsh({ "tim@corrupt.local": { stdout: "not-json", exitCode: 0 } });
    const res = await fleetList({ dbPath, runSsh: ssh });
    expect(res.unreachable.map((u) => u.machine)).toEqual(["corrupt"]);
    expect(res.unreachable[0]!.error).toMatch(/malformed/);
  });

  test("machines filter narrows to a subset", async () => {
    store.createMachine({ name: "a", hostname: "a", ssh_host: "tim@a" });
    store.createMachine({ name: "b", hostname: "b", ssh_host: "tim@b" });
    const ssh = makeSsh({ "tim@a": { stdout: "[]" }, "tim@b": { stdout: "[]" } });
    let calls = 0;
    const countingSsh: SshRunner = async (args) => {
      calls++;
      return ssh(args);
    };
    await fleetList({ dbPath, machines: ["a"], runSsh: countingSsh });
    expect(calls).toBe(1); // b was skipped
  });
});

describe("fleetStatus", () => {
  test("returns reachable + agent_count for local and reachable remote", async () => {
    store.createAgent({ id: "local", display_name: "L", runtime: "claude-code", screen_name: "wire-local" });
    store.createMachine({ name: "home-mini", hostname: "home-mini", ssh_host: "tim@home-mini.local" });

    const ssh = makeSsh({
      "tim@home-mini.local": {
        stdout: "home-mini\n3\n  \"version\": \"2.4.0\"\n",
        exitCode: 0,
      },
    });

    const res = await fleetStatus({ dbPath, runSsh: ssh });
    const localRow = res.find((r) => r.machine === store.localMachineName())!;
    expect(localRow.reachable).toBe(true);
    expect(localRow.agent_count).toBe(1);

    const remote = res.find((r) => r.machine === "home-mini")!;
    expect(remote.reachable).toBe(true);
    expect(remote.agent_count).toBe(3);
    expect(remote.crew_version).toBe("2.4.0");
  });

  test("marks SSH failure as reachable=false", async () => {
    store.createMachine({ name: "offline", hostname: "offline", ssh_host: "tim@offline" });
    const ssh = makeSsh({ "tim@offline": { exitCode: 255, stderr: "ssh: no route" } });
    const res = await fleetStatus({ dbPath, runSsh: ssh });
    const row = res.find((r) => r.machine === "offline")!;
    expect(row.reachable).toBe(false);
    expect(row.error).toContain("no route");
  });
});
