import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainCodexQueue } from "../src/app-server";
import { injectedEnvelopeText } from "../src/protocol";
import { GluevaStore } from "../src/store";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

interface MockState {
  observedTurnId: string;
  persistOnly: boolean;
  persisted: Array<{ envelopeText: string; turnId: string }>;
  starts: string[];
  activeReadsRemaining: number;
}

function mockAppServer(state: MockState): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (bunServer.upgrade(request)) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: any };
        if (message.id === undefined) return;
        const respond = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
        if (message.method === "initialize") return respond({ userAgent: "mock" });
        if (message.method === "thread/resume") {
          return respond({ thread: { id: message.params.threadId, status: { type: "idle" }, turns: [] } });
        }
        if (message.method === "thread/read") {
          const status = state.activeReadsRemaining > 0 ? "active" : "idle";
          if (state.activeReadsRemaining > 0) state.activeReadsRemaining -= 1;
          return respond({
            thread: {
              id: message.params.threadId,
              status: { type: status, ...(status === "active" ? { activeFlags: [] } : {}) },
              turns: state.persisted.map((entry) => ({
                id: entry.turnId,
                items: [{ type: "userMessage", id: "user", clientId: null, content: [
                  { type: "text", text: entry.envelopeText, text_elements: [] },
                ] }],
              })),
            },
          });
        }
        if (message.method === "turn/start") {
          const envelopeText = message.params.input[0].text as string;
          state.starts.push(envelopeText);
          respond({ turn: { id: "requested-turn", status: "inProgress", items: [] } });
          if (!state.persistOnly) {
            socket.send(JSON.stringify({
              method: "item/started",
              params: {
                threadId: message.params.threadId,
                turnId: state.observedTurnId,
                startedAtMs: Date.now(),
                item: { type: "userMessage", id: "user", clientId: null, content: message.params.input },
              },
            }));
            state.persisted.push({ envelopeText, turnId: state.observedTurnId });
          }
          return;
        }
        socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "unknown" } }));
      },
    },
  });
  servers.push(server);
  return server;
}

function makeStore(server: ReturnType<typeof Bun.serve>): GluevaStore {
  const root = mkdtempSync(join(tmpdir(), "glueva-app-server-"));
  roots.push(root);
  const store = new GluevaStore(root);
  store.registerCodex({
    threadId: "018f4e1a-2b3c-7abc-8def-0123456789ab",
    endpoint: `ws://127.0.0.1:${server.port}`,
    cwd: process.cwd(),
    tuiPid: process.pid,
    appServerPid: process.pid,
  });
  return store;
}

afterEach(() => {
  delete process.env.GLUEVA_OBSERVE_TIMEOUT_MS;
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("Codex App Server delivery", () => {
  test("confirms by envelope id and labels a fold by the observed turn", async () => {
    const state: MockState = {
      observedTurnId: "already-active-turn",
      persistOnly: false,
      persisted: [],
      starts: [],
      activeReadsRemaining: 0,
    };
    const store = makeStore(mockAppServer(state));
    const envelope = await store.createRootEnvelope("codex", "hello codex", "continue", 6);
    await drainCodexQueue(store);
    expect(store.readReceipt("codex", envelope.id)).toMatchObject({
      state: "delivered-merged",
      requestedTurnId: "requested-turn",
      observedTurnId: "already-active-turn",
    });
    expect(state.starts).toEqual([injectedEnvelopeText(envelope)]);
  });

  test("drains multiple envelopes in UUID order", async () => {
    const state: MockState = {
      observedTurnId: "requested-turn",
      persistOnly: false,
      persisted: [],
      starts: [],
      activeReadsRemaining: 0,
    };
    const store = makeStore(mockAppServer(state));
    const first = await store.createRootEnvelope("codex", "first", "continue", 6);
    const second = await store.createRootEnvelope("codex", "second", "continue", 6);
    await drainCodexQueue(store);
    expect(state.starts).toEqual([injectedEnvelopeText(first), injectedEnvelopeText(second)]);
    expect(store.readReceipt("codex", first.id)?.state).toBe("delivered");
    expect(store.readReceipt("codex", second.id)?.state).toBe("delivered");
  });

  test("a concurrent sender waits for the active drain instead of stranding mail", async () => {
    const state: MockState = {
      observedTurnId: "requested-turn",
      persistOnly: false,
      persisted: [],
      starts: [],
      activeReadsRemaining: 0,
    };
    const store = makeStore(mockAppServer(state));
    const first = await store.createRootEnvelope("codex", "first", "continue", 6);
    const release = await store.acquireLock("codex.delivery.lock");
    expect(release).not.toBeNull();

    const draining = drainCodexQueue(store);
    await Bun.sleep(20);
    const second = await store.createRootEnvelope("codex", "second", "continue", 6);
    release!();
    await draining;

    expect(state.starts).toEqual([injectedEnvelopeText(first), injectedEnvelopeText(second)]);
    expect(store.readReceipt("codex", second.id)?.state).toBe("delivered");
  });

  test("the delivery lock is free while waiting for Codex to become idle", async () => {
    const state: MockState = {
      observedTurnId: "requested-turn",
      persistOnly: false,
      persisted: [],
      starts: [],
      activeReadsRemaining: 20,
    };
    const store = makeStore(mockAppServer(state));
    await store.createRootEnvelope("codex", "wait without lock", "continue", 6);
    const draining = drainCodexQueue(store);
    const deadline = Date.now() + 2_000;
    while (state.activeReadsRemaining === 20 && Date.now() < deadline) await Bun.sleep(10);

    const release = await store.acquireLock("codex.delivery.lock", 100);
    expect(release).not.toBeNull();
    release!();
    state.activeReadsRemaining = 0;
    await draining;
    expect(state.starts).toHaveLength(1);
  });

  test("an orphaned inflight envelope recovers after a stale delivery lock", async () => {
    const state: MockState = {
      observedTurnId: "requested-turn",
      persistOnly: false,
      persisted: [],
      starts: [],
      activeReadsRemaining: 0,
    };
    const store = makeStore(mockAppServer(state));
    const envelope = await store.createRootEnvelope("codex", "recover orphan", "continue", 6);
    expect(store.claimNextCodexDelivery()?.id).toBe(envelope.id);
    expect(store.locateEnvelope(envelope.id)?.state).toBe("inflight");

    const lockPath = join(store.root, "locks", "codex.delivery.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: 999_999_999,
      token: "dead-owner",
      createdAt: new Date().toISOString(),
    }));

    await drainCodexQueue(store);
    expect(state.starts).toEqual([injectedEnvelopeText(envelope)]);
    expect(store.readReceipt("codex", envelope.id)?.state).toBe("delivered");
  });

  test("a missing confirmation stays inflight and reconciles without duplicate injection", async () => {
    process.env.GLUEVA_OBSERVE_TIMEOUT_MS = "20";
    const state: MockState = {
      observedTurnId: "persisted-turn",
      persistOnly: true,
      persisted: [],
      starts: [],
      activeReadsRemaining: 0,
    };
    const store = makeStore(mockAppServer(state));
    const envelope = await store.createRootEnvelope("codex", "recover", "continue", 6);
    await drainCodexQueue(store);
    expect(store.readReceipt("codex", envelope.id)).toBeNull();
    expect(store.locateEnvelope(envelope.id)?.state).toBe("inflight");

    state.persisted.push({ envelopeText: injectedEnvelopeText(envelope), turnId: "persisted-turn" });
    await drainCodexQueue(store);
    expect(state.starts).toHaveLength(1);
    expect(store.readReceipt("codex", envelope.id)).toMatchObject({
      state: "delivered",
      requestedTurnId: null,
      observedTurnId: "persisted-turn",
    });
  });

  test("waits for an active thread instead of starting a competing turn", async () => {
    const state: MockState = {
      observedTurnId: "requested-turn",
      persistOnly: false,
      persisted: [],
      starts: [],
      activeReadsRemaining: 3,
    };
    const store = makeStore(mockAppServer(state));
    const envelope = await store.createRootEnvelope("codex", "wait in order", "continue", 6);
    await drainCodexQueue(store);
    expect(state.activeReadsRemaining).toBe(0);
    expect(state.starts).toEqual([injectedEnvelopeText(envelope)]);
    expect(store.readReceipt("codex", envelope.id)?.state).toBe("delivered");
  });

  test("defers instead of blocking forever when the peer never goes idle", async () => {
    // The idle wait happens outside codex.delivery.lock, but it must still be
    // bounded so `glueva send` can return `queued` while the supervisor retries.
    const previous = process.env.GLUEVA_IDLE_TIMEOUT_MS;
    process.env.GLUEVA_IDLE_TIMEOUT_MS = "200";
    try {
      const state: MockState = {
        observedTurnId: "requested-turn",
        persistOnly: false,
        persisted: [],
        starts: [],
        activeReadsRemaining: Number.MAX_SAFE_INTEGER, // never idles
      };
      const store = makeStore(mockAppServer(state));
      const envelope = await store.createRootEnvelope("codex", "peer is busy", "continue", 6);

      await drainCodexQueue(store); // must resolve, not hang

      expect(state.starts).toEqual([]); // never folds into the active turn
      expect(store.readReceipt("codex", envelope.id)).toBeNull(); // stays queued
      expect(store.hasCodexDeliveryCandidates()).toBe(true); // still deliverable later
    } finally {
      if (previous === undefined) delete process.env.GLUEVA_IDLE_TIMEOUT_MS;
      else process.env.GLUEVA_IDLE_TIMEOUT_MS = previous;
    }
  });
});
