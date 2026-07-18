import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLaunchCommand } from "../src/launcher";
import { GluevaStore } from "../src/store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("interactive launchers", () => {
  test("Codex launcher maps new, picker, latest, and crash recovery commands", () => {
    const endpoint = "ws://127.0.0.1:1234";
    const cwd = "/project";
    expect(codexLaunchCommand("new", endpoint, cwd, null, false, false)).toEqual([
      "codex", "--remote", endpoint, "-C", cwd,
    ]);
    expect(codexLaunchCommand("resume", endpoint, cwd, null, true, false)).toEqual([
      "codex", "resume", "--dangerously-bypass-approvals-and-sandbox", "--remote", endpoint, "-C", cwd,
    ]);
    expect(codexLaunchCommand("continue", endpoint, cwd, null, false, true)).toEqual([
      "codex", "resume", "--last", "--no-alt-screen", "--remote", endpoint, "-C", cwd,
    ]);
    expect(codexLaunchCommand("new", endpoint, cwd, "thread-id", false, false)).toEqual([
      "codex", "resume", "--remote", endpoint, "-C", cwd, "thread-id",
    ]);
  });

  test("launcher aliases reject conflicting session modes", () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    for (const peer of ["codex", "claude"]) {
      for (const aliases of [["--resume", "--continue"], ["--r", "--c"], ["-r", "-c"]]) {
        const result = Bun.spawnSync(["bun", cli, peer, ...aliases]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("choose either --resume or --continue, not both");
      }
    }
  });

  test("Claude launcher resolves state from --cwd and forwards flags directly", () => {
    const root = mkdtempSync(join(tmpdir(), "glueva-launcher-"));
    roots.push(root);
    const project = join(root, "project");
    const bin = join(root, "bin");
    const argumentsPath = join(root, "claude-arguments.json");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(bin);

    const store = new GluevaStore(join(project, ".glueva"));
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
      "--cwd",
      project,
      "--yolo",
      "--r",
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
    const launchArguments = JSON.parse(readFileSync(argumentsPath, "utf8")) as string[];
    expect(launchArguments).toEqual([
      "--resume",
      "--dangerously-skip-permissions",
      "--add-dir=/tmp/one",
      "--add-dir=/tmp/two",
      "--",
      "Complete Glueva startup quietly using the installed Glueva skill. Do not narrate commands, explain routine state, " +
        "or show a checklist. Drain pending envelopes, waiting for the Codex-origin startup check if needed. Reply once as " +
        "requested, keep `glueva wait` armed as a harness-tracked background task, and claim success only if the reply was " +
        "delivered or delivered-merged. Output nothing until then; afterward tell the user only `Glueva paired. Ready.` If " +
        "pairing cannot be confirmed, report the failure in one short line.",
    ]);
    const pending = readdirSync(join(project, ".glueva", "queues", "claude", "pending"));
    expect(pending).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(project, ".glueva", "queues", "claude", "pending", pending[0]), "utf8")))
      .toMatchObject({
        from: "codex",
        to: "claude",
        status: "continue",
        maxHop: 1,
        body: "Glueva startup pairing check. Reply once with `--status done` and body exactly " +
          "`Glueva paired. Ready.` Keep ingress armed and tell the user only `Glueva paired. Ready.`",
      });
    expect(readFileSync(join(project, ".glueva", ".gitignore"), "utf8")).toBe("*\n");
    expect(store.readClaudePeer()).toBeNull();
    expect(store.readClaudeLauncher()).toBeNull();

    const continued = Bun.spawnSync(["bun", cli, "claude", "--cwd", project, "-c"], {
      cwd: root,
      env: {
        ...environment,
        PATH: `${bin}:${environment.PATH ?? ""}`,
        GLUEVA_CLI_SOURCE: cli,
        GLUEVA_TEST_ARGS: argumentsPath,
      },
    });
    expect(continued.stderr.toString()).toBe("");
    expect(continued.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(argumentsPath, "utf8"))).toEqual([
      "--continue",
      "--",
      launchArguments.at(-1),
    ]);
  });

  test("Claude launcher rejects non-interactive modes and loose positional tokens before spawning Claude", () => {
    const root = mkdtempSync(join(tmpdir(), "glueva-launcher-mode-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const store = new GluevaStore(join(project, ".glueva"));
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
      "--cwd",
      project,
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
      "--cwd",
      project,
      "--resume",
      "session-id",
    ], { cwd: root });

    expect(looseValue.exitCode).toBe(1);
    expect(looseValue.stderr.toString()).toContain("long-form --option=value");
    expect(store.readClaudeLauncher()).toBeNull();
  });
});
