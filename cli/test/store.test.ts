import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GluevaStore } from "../src/store";

const roots: string[] = [];

function makeStore(): GluevaStore {
  const root = mkdtempSync(join(tmpdir(), "glueva-store-"));
  roots.push(root);
  return new GluevaStore(root);
}

async function activate(store: GluevaStore, sessionId = "claude-test-session"): Promise<void> {
  store.registerCodex({
    threadId: "018f4e1a-2b3c-7abc-8def-0123456789ab",
    endpoint: "ws://127.0.0.1:1",
    cwd: process.cwd(),
    tuiPid: process.pid,
    appServerPid: process.pid,
  });
  const launcher = await store.beginClaudeLaunch(process.cwd());
  store.registerClaude(sessionId, process.cwd(), launcher.pid, launcher.token);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("durable store", () => {
  test("installed symlink resolves the repository CLI entrypoint", () => {
    const root = mkdtempSync(join(tmpdir(), "glueva-link-"));
    roots.push(root);
    const link = join(root, "glueva");
    symlinkSync(join(import.meta.dir, "..", "bin", "glueva"), link);
    const result = Bun.spawnSync([link, "status", "--json"], {
      cwd: process.cwd(),
      env: { ...process.env, GLUEVA_DIR: join(root, "runtime") },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      protocol: 2,
      active: false,
      unread: 0,
      watcherLive: false,
      sessionId: null,
    });
    const version = Bun.spawnSync([link, "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toBe("0.8.3\n");
  });

  test("status is session-bound and counts unprocessed mail across queue states", async () => {
    const store = makeStore();
    await activate(store);
    expect(store.status("another-session")).toEqual({
      protocol: 2,
      active: false,
      unread: 0,
      watcherLive: false,
      sessionId: null,
    });

    await store.createRootEnvelope("claude", "hello", "continue", 6);
    expect(store.status("claude-test-session")).toMatchObject({ active: true, unread: 1 });
    const received = await store.receiveClaude("claude-test-session");
    expect(received).toHaveLength(1);
    expect(store.status("claude-test-session").unread).toBe(1);
    await store.ack(received[0].id);
    expect(store.status("claude-test-session").unread).toBe(0);
  });

  test("human status reports the registered pair outside Claude's session", async () => {
    const store = makeStore();
    await activate(store);
    const cli = join(import.meta.dir, "..", "bin", "glueva");
    const environment = { ...process.env, GLUEVA_DIR: store.root };
    const result = Bun.spawnSync([cli, "status"], {
      cwd: process.cwd(),
      env: environment,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe(
      "Claude: active\nCodex: active\nWatcher: not armed\nUnread for Claude: 0\n",
    );
    expect(JSON.parse(Bun.spawnSync([cli, "status", "--json"], { env: environment }).stdout.toString()))
      .toMatchObject({ active: false, watcherLive: false, sessionId: null });
  });

  test("receive recovers delivered but unprocessed envelopes", async () => {
    const store = makeStore();
    await activate(store);
    const envelope = await store.createRootEnvelope("claude", "recover me", "continue", 6);
    const first = await store.receiveClaude("claude-test-session");
    const second = await store.receiveClaude("claude-test-session");
    expect(first.map((item) => item.id)).toEqual([envelope.id]);
    expect(second.map((item) => item.id)).toEqual([envelope.id]);
    expect(store.readReceipt("claude", envelope.id)?.transport).toBe("claude-inbox");
  });

  test("reply transaction is idempotent and reverses the peer direction", async () => {
    const store = makeStore();
    await activate(store);
    const parent = await store.createRootEnvelope("claude", "question", "continue", 6);
    await store.receiveClaude("claude-test-session");
    const reply = await store.reply(parent.id, "answer", "done");
    const repeated = await store.reply(parent.id, "answer", "done");
    expect(repeated.id).toBe(reply.id);
    expect(reply).toMatchObject({
      conversationId: parent.id,
      from: "claude",
      to: "codex",
      replyTo: parent.id,
      hop: 1,
      maxHop: 6,
      status: "done",
    });
    expect(store.readLedger("claude", parent.id)).toMatchObject({
      state: "processed",
      replyId: reply.id,
    });
    await expect(store.reply(parent.id, "different", "done")).rejects.toThrow("conflict");
  });

  test("reply prints delivery feedback", async () => {
    const store = makeStore();
    const parent = await store.createRootEnvelope("codex", "question", "continue", 6);
    const body = join(store.root, "reply.txt");
    writeFileSync(body, "answer\n");
    const result = Bun.spawnSync([
      join(import.meta.dir, "..", "bin", "glueva"),
      "reply", "--to", parent.id, "--body-file", body,
    ], { env: { ...process.env, GLUEVA_DIR: store.root } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      id: store.readLedger("codex", parent.id)?.replyId,
      state: "queued",
    });
  });

  test("an interrupted reply reservation remains unread and resumes idempotently", async () => {
    const store = makeStore();
    await activate(store);
    const parent = await store.createRootEnvelope("claude", "question", "continue", 6);
    await store.receiveClaude("claude-test-session");
    const replyId = store.nextEnvelopeId();
    writeFileSync(join(store.root, "ledger", "claude", `${parent.id}.json`), `${JSON.stringify({
      schemaVersion: 1,
      envelopeId: parent.id,
      peer: "claude",
      state: "reply-reserved",
      replyId,
      processedAt: null,
    })}\n`);

    expect(store.status("claude-test-session").unread).toBe(1);
    expect((await store.receiveClaude("claude-test-session")).map((item) => item.id)).toEqual([parent.id]);
    const reply = await store.reply(parent.id, "answer", "done");
    expect(reply.id).toBe(replyId);
    expect(store.readLedger("claude", parent.id)?.state).toBe("processed");
    expect(store.status("claude-test-session").unread).toBe(0);
  });

  test("a waiting delivery cannot block processing the current envelope", async () => {
    const store = makeStore();
    const parent = await store.createRootEnvelope("codex", "current", "continue", 6);
    const releaseDelivery = await store.acquireLock("codex.delivery.lock");
    expect(releaseDelivery).not.toBeNull();
    try {
      const reply = await store.reply(parent.id, "closed", "done");
      expect(reply.replyTo).toBe(parent.id);
      expect(store.readLedger("codex", parent.id)?.state).toBe("processed");
    } finally {
      releaseDelivery!();
    }
  });

  test("expired lock ownership is reclaimed without an old releaser deleting the new lock", async () => {
    const store = makeStore();
    const first = await store.acquireLock("expiry-test.lock");
    expect(first).not.toBeNull();
    const second = await store.acquireLock("expiry-test.lock", 100, 0);
    expect(second).not.toBeNull();

    first!();
    expect(await store.acquireLock("expiry-test.lock", 0)).toBeNull();
    second!();
    const third = await store.acquireLock("expiry-test.lock", 100);
    expect(third).not.toBeNull();
    third!();
  });

  test("done and max-hop envelopes cannot create conversational loops", async () => {
    const store = makeStore();
    await activate(store);
    const done = await store.createRootEnvelope("claude", "stop", "done", 6);
    await store.receiveClaude("claude-test-session");
    await expect(store.reply(done.id, "no", "done")).rejects.toThrow("done envelope");

    const capped = await store.createRootEnvelope("claude", "cap", "continue", 0);
    await store.receiveClaude("claude-test-session");
    await expect(store.reply(capped.id, "no", "done")).rejects.toThrow("maxHop");
  });

  test("wait publishes its matching lease before blocking and exits on mail", async () => {
    const store = makeStore();
    await activate(store);
    const waiting = store.waitForClaude("claude-test-session");
    const deadline = Date.now() + 2_000;
    while (!store.status("claude-test-session").watcherLive && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(store.status("claude-test-session").watcherLive).toBe(true);
    await store.createRootEnvelope("claude", "wake", "done", 6);
    expect(await waiting).toBe("mail");
    expect(store.status("claude-test-session").watcherLive).toBe(false);
  });

  test("a transient Codex restart does not deactivate or disarm Claude", async () => {
    const store = makeStore();
    await activate(store);
    const waiting = store.waitForClaude("claude-test-session");
    const deadline = Date.now() + 2_000;
    while (!store.status("claude-test-session").watcherLive && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    const codex = store.readCodexPeer()!;
    writeFileSync(join(store.root, "peers", "codex.json"), `${JSON.stringify({
      ...codex,
      tuiPid: 999_999_999,
      appServerPid: 999_999_999,
    })}\n`);
    await Bun.sleep(300);
    expect(store.status("claude-test-session")).toMatchObject({ active: true, watcherLive: true });

    store.registerCodex({
      threadId: codex.threadId,
      endpoint: codex.endpoint,
      cwd: codex.cwd,
      tuiPid: process.pid,
      appServerPid: process.pid,
    });
    await store.createRootEnvelope("claude", "wake after restart", "done", 6);
    expect(await waiting).toBe("mail");
  });

  test("wait distinguishes an existing watcher and interruption from inactivity", async () => {
    const store = makeStore();
    await activate(store);
    expect(await store.waitForClaude()).toBe("inactive");
    const launcher = store.readClaudeLauncher()!;
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const waiting = Bun.spawn(["bun", cli, "wait"], {
      env: {
        ...process.env,
        GLUEVA_DIR: store.root,
        GLUEVA_OWNER_PID: String(launcher.pid),
        GLUEVA_LAUNCH_TOKEN: launcher.token,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = Date.now() + 2_000;
    while (!store.status("claude-test-session").watcherLive && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(store.status("claude-test-session").watcherLive).toBe(true);
    expect(await store.waitForClaude("claude-test-session")).toBe("already-armed");

    waiting.kill("SIGTERM");
    expect(await waiting.exited).toBe(0);
    expect(await new Response(waiting.stdout).text()).toBe("interrupted\n");
    expect(await new Response(waiting.stderr).text()).toBe("");
    expect(store.status("claude-test-session").watcherLive).toBe(false);
  });

  test("queue files are one-line canonical JSON with a final newline and sortable ids", async () => {
    const store = makeStore();
    const first = await store.createRootEnvelope("claude", "one", "continue", 6);
    const second = await store.createRootEnvelope("claude", "two", "continue", 6);
    expect(second.id > first.id).toBe(true);
    const contents = readFileSync(join(store.root, "queues", "claude", "pending", `${first.id}.json`), "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(contents).id).toBe(first.id);
  });

  test("runtime state ignores itself without changing the repository ignore file", () => {
    const store = makeStore();
    writeFileSync(join(store.root, ".gitignore"), "!mail\n", { mode: 0o644 });
    store.ensureRuntime();
    expect(readFileSync(join(store.root, ".gitignore"), "utf8")).toBe("*\n");
    expect(statSync(store.root).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.root, ".gitignore")).mode & 0o777).toBe(0o600);
  });

  test("envelope bodies are owner-readable only", async () => {
    const store = makeStore();
    const envelope = await store.createRootEnvelope("claude", "private body", "done", 6);
    const path = join(store.root, "queues", "claude", "pending", `${envelope.id}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("Claude registration requires one live explicit launcher and cleans up with it", async () => {
    const store = makeStore();
    store.registerCodex({
      threadId: "018f4e1a-2b3c-7abc-8def-0123456789ab",
      endpoint: "ws://127.0.0.1:1",
      cwd: process.cwd(),
      tuiPid: process.pid,
      appServerPid: process.pid,
    });
    expect(() => store.registerClaude("session", process.cwd(), process.pid, "019f5ab3-d534-7278-9ff5-407ead49682e"))
      .toThrow("live explicit launcher");

    const launcher = await store.beginClaudeLaunch(process.cwd());
    await expect(store.beginClaudeLaunch(process.cwd())).rejects.toThrow("already owns");
    store.registerClaude("session", process.cwd(), launcher.pid, launcher.token);
    expect(store.status("session").active).toBe(true);
    const waiting = store.waitForClaude("session");
    const deadline = Date.now() + 2_000;
    while (!store.status("session").watcherLive && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(store.status("session").watcherLive).toBe(true);
    store.endClaudeLaunch(launcher.token);
    expect(await waiting).toBe("inactive");
    expect(store.status("session")).toMatchObject({ active: false, sessionId: null });
  });
});
