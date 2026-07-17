import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeStore } from "../src/store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("interactive launchers", () => {
  test("Claude launcher resolves state from --cwd and forwards arguments after --", () => {
    const root = mkdtempSync(join(tmpdir(), "glueva-launcher-"));
    roots.push(root);
    const project = join(root, "project");
    const bin = join(root, "bin");
    const argumentsPath = join(root, "claude-arguments.json");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(bin);

    const store = new BridgeStore(join(project, ".glueva"));
    store.registerCodex({
      threadId: "018f4e1a-2b3c-7abc-8def-0123456789ab",
      endpoint: "ws://127.0.0.1:1",
      cwd: project,
      tuiPid: process.pid,
      appServerPid: process.pid,
    });

    const fakeClaude = join(bin, "claude");
    writeFileSync(fakeClaude, `#!/usr/bin/env bun
await Bun.write(process.env.GLUEVA_TEST_ARGS!, JSON.stringify(process.argv.slice(2)));
const registration = Bun.spawnSync([
  "bun", process.env.GLUEVA_CLI_SOURCE!, "register",
  "--peer", "claude",
  "--session-id", "claude-launcher-test",
  "--cwd", process.cwd(),
  "--owner-pid", process.env.GLUEVA_OWNER_PID!,
  "--launcher-token", process.env.GLUEVA_LAUNCH_TOKEN!,
  "--json",
], { env: process.env, stdout: "ignore", stderr: "pipe" });
if (registration.exitCode !== 0) {
  process.stderr.write(registration.stderr.toString());
  process.exit(registration.exitCode);
}
await Bun.sleep(150);
`);
    chmodSync(fakeClaude, 0o755);

    const { GLUEVA_DIR: _ignored, ...environment } = process.env;
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const result = Bun.spawnSync([
      "bun",
      cli,
      "claude",
      "launch",
      "--cwd",
      project,
      "--",
      "--dangerously-skip-permissions",
      "--resume=session-id",
      "--add-dir=/tmp/one",
      "--add-dir=/tmp/two",
    ], {
      cwd: root,
      env: {
        ...environment,
        PATH: `${bin}:${environment.PATH ?? ""}`,
        GLUEVA_CLI_SOURCE: cli,
        GLUEVA_TEST_ARGS: argumentsPath,
      },
    });

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(argumentsPath, "utf8"))).toEqual([
      "--dangerously-skip-permissions",
      "--resume=session-id",
      "--add-dir=/tmp/one",
      "--add-dir=/tmp/two",
      "--",
      "Initialize Glueva for this live interactive session. Follow the Glueva SOP: " +
        "run `glueva receive --json`, handle and close every pending envelope with `glueva reply` or `glueva ack`, " +
        "then launch `glueva wait` as a harness-tracked background task and go idle. " +
        "If the bridge is inactive, report that clearly instead of arming.",
    ]);
    expect(readFileSync(join(project, ".glueva", ".gitignore"), "utf8")).toBe("*\n");
    expect(store.readClaudePeer()).toBeNull();
    expect(store.readClaudeLauncher()).toBeNull();
  });

  test("Claude launcher rejects non-interactive modes and loose positional tokens before spawning Claude", () => {
    const root = mkdtempSync(join(tmpdir(), "glueva-launcher-mode-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const store = new BridgeStore(join(project, ".glueva"));
    store.registerCodex({
      threadId: "018f4e1a-2b3c-7abc-8def-0123456789ab",
      endpoint: "ws://127.0.0.1:1",
      cwd: project,
      tuiPid: process.pid,
      appServerPid: process.pid,
    });

    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const result = Bun.spawnSync([
      "bun",
      cli,
      "claude",
      "launch",
      "--cwd",
      project,
      "--",
      "--print",
      "hello",
    ], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("requires a real interactive session");
    expect(store.readClaudeLauncher()).toBeNull();

    const looseValue = Bun.spawnSync([
      "bun",
      cli,
      "claude",
      "launch",
      "--cwd",
      project,
      "--",
      "--resume",
      "session-id",
    ], { cwd: root });

    expect(looseValue.exitCode).toBe(1);
    expect(looseValue.stderr.toString()).toContain("long-form --option=value");
    expect(store.readClaudeLauncher()).toBeNull();
  });
});
