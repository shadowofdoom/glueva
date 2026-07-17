import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeHook } from "../src/claude-hooks";
import { GluevaStore } from "../src/store";

const roots: string[] = [];

function makeStore(): GluevaStore {
  const root = mkdtempSync(join(tmpdir(), "glueva-hooks-"));
  roots.push(root);
  return new GluevaStore(root);
}

function registerCodex(store: GluevaStore): void {
  store.registerCodex({
    threadId: "018f4e1a-2b3c-7abc-8def-0123456789ab",
    endpoint: "ws://127.0.0.1:1",
    cwd: process.cwd(),
    tuiPid: process.pid,
    appServerPid: process.pid,
  });
}

async function activate(store: GluevaStore, sessionId = "claude-hook-session"): Promise<void> {
  registerCodex(store);
  const launcher = await store.beginClaudeLaunch(process.cwd());
  store.registerClaude(sessionId, process.cwd(), launcher.pid, launcher.token);
}

function input(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "claude-hook-session",
    cwd: process.cwd(),
    stop_hook_active: false,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("Claude hook integration", () => {
  test("a normal Claude session is inert", () => {
    const store = makeStore();
    expect(runClaudeHook("session-start", input(), 2, store, {})).toBeNull();
    expect(runClaudeHook("stop", input(), 2, store, {})).toBeNull();
  });

  test("the explicit launcher registers the matching session", async () => {
    const store = makeStore();
    registerCodex(store);
    const launcher = await store.beginClaudeLaunch(process.cwd());
    const output = runClaudeHook("session-start", input(), 2, store, {
      GLUEVA_OWNER_PID: String(launcher.pid),
      GLUEVA_LAUNCH_TOKEN: launcher.token,
    });
    expect(store.readClaudePeer()).toMatchObject({
      sessionId: "claude-hook-session",
      launcherToken: launcher.token,
    });
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });
    expect(JSON.stringify(output)).toContain("No ingress watcher");
  });

  test("incomplete or mismatched launch identity is loud and never registers", async () => {
    const store = makeStore();
    registerCodex(store);
    const launcher = await store.beginClaudeLaunch(process.cwd());
    const incomplete = runClaudeHook("session-start", input(), 2, store, {
      GLUEVA_OWNER_PID: String(launcher.pid),
    });
    expect(JSON.stringify(incomplete)).toContain("registration FAILED");
    expect(store.readClaudePeer()).toBeNull();

    const otherCwd = join(store.root, "other-cwd");
    mkdirSync(otherCwd);
    const wrongCwd = runClaudeHook("session-start", input({ cwd: otherCwd }), 2, store, {
      GLUEVA_OWNER_PID: String(launcher.pid),
      GLUEVA_LAUNCH_TOKEN: launcher.token,
    });
    expect(JSON.stringify(wrongCwd)).toContain("cwd does not match");
    expect(store.readClaudePeer()).toBeNull();
  });

  test("protocol skew is loud but never blocks Stop", () => {
    const store = makeStore();
    const start = runClaudeHook("session-start", "{}", 1, store, {});
    const stop = runClaudeHook("stop", "{}", 1, store, {});
    expect(JSON.stringify(start)).toContain("speaks protocol 2");
    expect(JSON.stringify(start)).toContain("requires 1");
    expect(stop).toMatchObject({ systemMessage: expect.any(String) });
    expect(stop).not.toHaveProperty("decision");
  });

  test("unread mail and a missing watcher block Stop", async () => {
    const store = makeStore();
    await activate(store);
    expect(runClaudeHook("stop", input(), 2, store, {})).toMatchObject({ decision: "block" });

    await store.createRootEnvelope("claude", "pending", "done", 6);
    const output = runClaudeHook("stop", input(), 2, store, {});
    expect(output).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: expect.stringContaining("glueva receive --json"),
      },
    });
    expect(JSON.stringify(output)).toContain("1 unprocessed");

    await store.ack((await store.receiveClaude("claude-hook-session"))[0].id);
    const watcherOutput = runClaudeHook("stop", input(), 2, store, {});
    expect(watcherOutput).toMatchObject({
      decision: "block",
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: expect.stringContaining("run_in_background"),
      },
    });

    const codex = store.readCodexPeer()!;
    writeFileSync(join(store.root, "peers", "codex.json"), `${JSON.stringify({
      ...codex,
      tuiPid: 999_999_999,
      appServerPid: 999_999_999,
    })}\n`);
    expect(runClaudeHook("stop", input(), 2, store, {})).toMatchObject({ decision: "block" });
  });

  test("an armed and drained session may stop", async () => {
    const store = makeStore();
    await activate(store);
    const waiting = store.waitForClaude("claude-hook-session");
    const deadline = Date.now() + 2_000;
    while (!store.status("claude-hook-session").watcherLive && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(runClaudeHook("stop", input(), 2, store, {})).toBeNull();
    await store.createRootEnvelope("claude", "wake", "done", 6);
    expect(await waiting).toBe("mail");
  });

  test("stop_hook_active cannot trap the session in a hook loop", async () => {
    const store = makeStore();
    await activate(store);
    await store.createRootEnvelope("claude", "pending", "done", 6);
    expect(runClaudeHook("stop", input({ stop_hook_active: true }), 2, store, {})).toBeNull();
  });

  test("cold-start mail and corrupt Glueva state are surfaced", async () => {
    const store = makeStore();
    await activate(store);
    await store.createRootEnvelope("claude", "cold", "done", 6);
    const cold = runClaudeHook("session-start", input(), 2, store, {});
    expect(JSON.stringify(cold)).toContain("1 unprocessed");

    writeFileSync(join(store.root, "peers", "claude.json"), "not-json\n");
    const corrupt = runClaudeHook("stop", input(), 2, store, {});
    expect(corrupt).toMatchObject({ systemMessage: expect.any(String) });
    expect(corrupt).not.toHaveProperty("decision");
  });
});
