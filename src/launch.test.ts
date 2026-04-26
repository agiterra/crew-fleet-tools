import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CrewStore } from "@agiterra/crew-tools";
import { fleetLaunch } from "./launch";

let tmpDir: string;
let dbPath: string;
let store: InstanceType<typeof CrewStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fleet-launch-"));
  dbPath = join(tmpDir, "crews.db");
  store = new CrewStore(dbPath);
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

type ShellCall = { cmd: string; stdin?: string };

describe("fleetLaunch", () => {
  test("validates env.AGENT_ID", async () => {
    store.createMachine({ name: "home-mini", hostname: "home-mini", ssh_host: "tim@home-mini.local" });
    await expect(
      fleetLaunch({ destination: "home-mini", env: {}, dbPath, runShell: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
    ).rejects.toThrow(/AGENT_ID is required/);
  });

  test("refuses unknown destination", async () => {
    await expect(
      fleetLaunch({ destination: "nope", env: { AGENT_ID: "x" }, dbPath, runShell: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
    ).rejects.toThrow(/not registered/);
  });

  test("refuses local-machine destination", async () => {
    await expect(
      fleetLaunch({ destination: store.localMachineName(), env: { AGENT_ID: "x" }, dbPath, runShell: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
    ).rejects.toThrow(/is the local machine/);
  });

  test("SSHes dest, sends payload via stdin, returns parsed agent row", async () => {
    store.createMachine({ name: "home-mini", hostname: "home-mini", ssh_host: "tim@home-mini.local" });
    const calls: ShellCall[] = [];
    const shell = async ({ cmd, stdin }: { cmd: string; stdin?: string; timeoutMs: number }) => {
      calls.push({ cmd, stdin });
      return {
        stdout: JSON.stringify({ id: "test", screen_name: "wire-test", machine_name: "home-mini" }),
        stderr: "",
        exitCode: 0,
      };
    };
    const res = await fleetLaunch({
      destination: "home-mini",
      env: { AGENT_ID: "test", AGENT_PRIVATE_KEY: "secret-key" },
      projectDir: "/tmp/test-wd",
      prompt: "hello",
      badge: "Test",
      dbPath,
      runShell: shell,
    });
    expect(res.launched_on).toBe("home-mini");
    expect((res.destination_agent as { id: string }).id).toBe("test");
    // Single SSH call with the payload via stdin.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toContain("crew launch --json -");
    expect(calls[0]!.cmd).toContain("tim@home-mini.local");
    const sentPayload = JSON.parse(calls[0]!.stdin!);
    expect(sentPayload.env.AGENT_ID).toBe("test");
    expect(sentPayload.env.AGENT_PRIVATE_KEY).toBe("secret-key");
    expect(sentPayload.projectDir).toBe("/tmp/test-wd");
    expect(sentPayload.prompt).toBe("hello");
    expect(sentPayload.badge).toBe("Test");
  });

  test("ssh failure throws with stderr", async () => {
    store.createMachine({ name: "home-mini", hostname: "home-mini", ssh_host: "tim@home-mini.local" });
    const shell = async () => ({ stdout: "", stderr: "ssh: connection refused", exitCode: 255 });
    await expect(
      fleetLaunch({ destination: "home-mini", env: { AGENT_ID: "x" }, dbPath, runShell: shell }),
    ).rejects.toThrow(/connection refused/);
  });
});
