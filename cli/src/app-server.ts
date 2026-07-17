import {
  type Envelope,
  envelopeTextFromUserItem,
  injectedEnvelopeText,
  injectedTextContainsEnvelope,
} from "./protocol";
import { GluevaStore, type CodexPeerRecord, type DeliveryReceipt, type DeliveryState } from "./store";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface Observation {
  turnId: string;
}

interface DeliveryResult extends Observation {
  requestedTurnId: string | null;
  state: DeliveryState;
}

class CodexBecameBusyError extends Error {}

function numericEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function asText(data: unknown): Promise<string> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data).toString("utf8"));
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return Promise.resolve(String(data));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

class AppServerClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: JsonRpcMessage[] = [];
  private nextId = 1;
  private closedError: Error | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => void this.onMessage(event.data));
    socket.addEventListener("close", () => this.failAll(new Error("Codex App Server connection closed")));
    socket.addEventListener("error", () => this.failAll(new Error("Codex App Server connection failed")));
  }

  static async connect(endpoint: string): Promise<AppServerClient> {
    if (!endpoint.startsWith("ws://") && !endpoint.startsWith("wss://")) {
      throw new Error(`unsupported Codex endpoint ${endpoint}; Glueva v1 requires ws:// or wss://`);
    }
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error(`timed out connecting to ${endpoint}`)), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        rejectOpen(new Error(`cannot connect to ${endpoint}`));
      }, { once: true });
    });
    return new AppServerClient(socket);
  }

  private failAll(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }

  private async onMessage(data: unknown): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(await asText(data)) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(`App Server ${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) this.notifications.push(message);
  }

  request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timeout,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string): void {
    this.socket.send(JSON.stringify({ method }));
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "glueva",
        title: "Glueva",
        version: "0.6.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
  }

  takeObservation(envelope: Envelope): Observation | null {
    for (let index = 0; index < this.notifications.length; index += 1) {
      const notification = this.notifications[index];
      if (notification.method !== "item/started") continue;
      const params = notification.params as { item?: unknown; turnId?: unknown } | undefined;
      const text = envelopeTextFromUserItem(params?.item);
      if (!injectedTextContainsEnvelope(text, envelope) || typeof params?.turnId !== "string") continue;
      this.notifications.splice(index, 1);
      return { turnId: params.turnId };
    }
    return null;
  }

  async waitForObservation(envelope: Envelope, timeoutMs: number): Promise<Observation | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const observation = this.takeObservation(envelope);
      if (observation) return observation;
      if (this.closedError) throw this.closedError;
      await delay(25);
    }
    return null;
  }

  close(): void {
    this.socket.close();
  }
}

function findPersistedObservation(thread: unknown, envelope: Envelope): Observation | null {
  if (!thread || typeof thread !== "object") return null;
  const turns = (thread as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return null;
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const turnId = (turn as { id?: unknown }).id;
    const items = (turn as { items?: unknown }).items;
    if (typeof turnId !== "string" || !Array.isArray(items)) continue;
    for (const item of items) {
      if (injectedTextContainsEnvelope(envelopeTextFromUserItem(item), envelope)) return { turnId };
    }
  }
  return null;
}

async function readThread(client: AppServerClient, threadId: string, includeTurns: boolean): Promise<unknown> {
  const response = await client.request<{ thread?: unknown }>("thread/read", { threadId, includeTurns });
  return response.thread;
}

async function persistedObservation(
  client: AppServerClient,
  threadId: string,
  envelope: Envelope,
): Promise<Observation | null> {
  try {
    return findPersistedObservation(await readThread(client, threadId, true), envelope);
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not materialized yet")) return null;
    throw error;
  }
}

function threadStatusType(thread: unknown): string | null {
  if (!thread || typeof thread !== "object") return null;
  const status = (thread as { status?: unknown }).status;
  if (!status || typeof status !== "object") return null;
  const type = (status as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

// Bounded on purpose. The wait is outside codex.delivery.lock, but an unbounded
// caller still cannot return `queued` while Codex is busy. Deferring is safe:
// `glueva codex` supervises the durable queue and retries after idle.
async function waitUntilIdle(client: AppServerClient, peer: CodexPeerRecord): Promise<void> {
  const timeoutMs = numericEnvironment("GLUEVA_IDLE_TIMEOUT_MS", 30_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const thread = await readThread(client, peer.threadId, false);
    const status = threadStatusType(thread);
    if (status === "idle") return;
    if (status === "systemError" || status === "notLoaded") {
      throw new Error(`Codex thread is not deliverable: ${status}`);
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for the Codex thread to become idle");
    await delay(250);
  }
}

async function subscribeToThread(client: AppServerClient, peer: CodexPeerRecord): Promise<boolean> {
  try {
    const resumed = await client.request<{ thread?: unknown }>("thread/resume", {
      threadId: peer.threadId,
      excludeTurns: true,
    });
    if (!resumed.thread) throw new Error(`Codex thread was not found: ${peer.threadId}`);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("no rollout found")) throw error;
    const loaded = await client.request<{ data?: unknown }>("thread/loaded/list", {});
    if (!Array.isArray(loaded.data) || !loaded.data.includes(peer.threadId)) {
      throw new Error(`Codex thread was not found: ${peer.threadId}`);
    }
    return false;
  }
}

async function waitForCodexIdle(peer: CodexPeerRecord): Promise<void> {
  const client = await AppServerClient.connect(peer.endpoint);
  try {
    await client.initialize();
    await subscribeToThread(client, peer);
    await waitUntilIdle(client, peer);
  } finally {
    client.close();
  }
}

async function deliverOne(peer: CodexPeerRecord, envelope: Envelope): Promise<DeliveryResult> {
  const client = await AppServerClient.connect(peer.endpoint);
  try {
    await client.initialize();
    const subscribed = await subscribeToThread(client, peer);

    const prior = await persistedObservation(client, peer.threadId, envelope);
    if (prior) return { requestedTurnId: null, turnId: prior.turnId, state: "delivered" };

    const thread = await readThread(client, peer.threadId, false);
    const status = threadStatusType(thread);
    if (status !== "idle") {
      if (status === "systemError" || status === "notLoaded") {
        throw new Error(`Codex thread is not deliverable: ${status}`);
      }
      throw new CodexBecameBusyError("Codex thread became busy before delivery");
    }
    const start = await client.request<{ turn?: { id?: unknown } }>("turn/start", {
      threadId: peer.threadId,
      clientUserMessageId: envelope.id,
      input: [{ type: "text", text: injectedEnvelopeText(envelope), text_elements: [] }],
    });
    const requestedTurnId = typeof start.turn?.id === "string" ? start.turn.id : null;
    const observeTimeoutMs = subscribed
      ? numericEnvironment("GLUEVA_OBSERVE_TIMEOUT_MS", 15_000)
      : 250;
    const live = await client.waitForObservation(envelope, observeTimeoutMs);
    const observed = live ?? await persistedObservation(client, peer.threadId, envelope);
    if (!observed) throw new Error(`App Server did not confirm envelope ${envelope.id}`);
    return {
      requestedTurnId,
      turnId: observed.turnId,
      state: requestedTurnId && requestedTurnId !== observed.turnId ? "delivered-merged" : "delivered",
    };
  } finally {
    client.close();
  }
}

export async function drainCodexQueue(store: GluevaStore): Promise<Map<string, DeliveryReceipt>> {
  const receipts = new Map<string, DeliveryReceipt>();
  const peer = store.readCodexPeer();
  if (!store.codexPeerIsLive(peer)) return receipts;
  while (store.hasCodexDeliveryCandidates()) {
    try {
      await waitForCodexIdle(peer);
    } catch (error) {
      if (process.env.GLUEVA_DEBUG === "1") {
        process.stderr.write(
          `glueva: Codex delivery deferred while waiting for idle: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      break;
    }

    const release = await store.acquireLock("codex.delivery.lock");
    if (!release) break;
    let becameBusy = false;
    try {
      const envelope = store.claimNextCodexDelivery();
      if (!envelope) break;
      try {
        const result = await deliverOne(peer, envelope);
        const receipt = store.completeCodexDelivery(
          envelope,
          result.state,
          result.requestedTurnId,
          result.turnId,
        );
        receipts.set(envelope.id, receipt);
      } catch (error) {
        if (error instanceof CodexBecameBusyError) {
          becameBusy = true;
        } else {
          if (process.env.GLUEVA_DEBUG === "1") {
            process.stderr.write(
              `glueva: Codex delivery for ${envelope.id} deferred: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
          return receipts;
        }
      }
    } finally {
      release();
    }
    if (becameBusy) continue;
  }
  return receipts;
}

export async function listLoadedThreads(endpoint: string): Promise<string[]> {
  const client = await AppServerClient.connect(endpoint);
  try {
    await client.initialize();
    const response = await client.request<{ data?: unknown }>("thread/loaded/list", {});
    if (!Array.isArray(response.data) || response.data.some((id) => typeof id !== "string")) {
      throw new Error("App Server returned an invalid loaded-thread list");
    }
    return response.data as string[];
  } finally {
    client.close();
  }
}
