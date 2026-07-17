import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type Envelope,
  type EnvelopeStatus,
  type Peer,
  SCHEMA_VERSION,
  parseEnvelope,
  serializeEnvelope,
  uuidV7,
  uuidV7After,
  validateEnvelope,
} from "./protocol";

export type QueueState = "pending" | "inflight" | "delivered";
export type DeliveryState = "delivered" | "delivered-merged";
export const CLI_PROTOCOL_VERSION = 1;

export interface ClaudePeerRecord {
  schemaVersion: 1;
  peer: "claude";
  sessionId: string;
  cwd: string;
  pid: number;
  launcherToken: string;
  startedAt: string;
}

export interface ClaudeLauncherLease {
  schemaVersion: 1;
  peer: "claude";
  cwd: string;
  pid: number;
  token: string;
  startedAt: string;
}

export interface CodexPeerRecord {
  schemaVersion: 1;
  peer: "codex";
  threadId: string;
  endpoint: string;
  cwd: string;
  tuiPid: number;
  appServerPid: number;
  startedAt: string;
}

export interface WatcherLease {
  schemaVersion: 1;
  peer: "claude";
  sessionId: string;
  pid: number;
  token: string;
  armedAt: string;
}

export interface DeliveryReceipt {
  schemaVersion: 1;
  envelopeId: string;
  to: Peer;
  state: DeliveryState;
  transport: "claude-inbox" | "codex-app-server";
  requestedTurnId: string | null;
  observedTurnId: string | null;
  deliveredAt: string;
}

export interface LedgerEntry {
  schemaVersion: 1;
  envelopeId: string;
  peer: Peer;
  state: "reply-reserved" | "processed";
  replyId: string | null;
  processedAt: string | null;
}

export interface BridgeStatus {
  protocol: 1;
  bridgeActive: boolean;
  unread: number;
  watcherLive: boolean;
  sessionId: string | null;
}

interface LocatedEnvelope {
  envelope: Envelope;
  path: string;
  state: QueueState;
  serialized: string;
}

const QUEUE_STATES: QueueState[] = ["pending", "inflight", "delivered"];
const PEERS: Peer[] = ["claude", "codex"];
const DEFAULT_LOCK_TTL_MS = 120_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function isProcessLive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return Boolean(
      error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EPERM",
    );
  }
}

function findNearestGitRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveBridgeDir(cwd = process.cwd(), environment = process.env): string {
  const override = environment.GLUEVA_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("GLUEVA_DIR must be an absolute path");
    return resolve(override);
  }
  const gitRoot = findNearestGitRoot(cwd);
  return join(gitRoot ?? resolve(cwd), ".glueva");
}

export class BridgeStore {
  readonly root: string;

  constructor(root = resolveBridgeDir()) {
    this.root = resolve(root);
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  ensureRuntime(): void {
    const directories = [
      "peers",
      "receipts/claude",
      "receipts/codex",
      "ledger/claude",
      "ledger/codex",
      "locks",
      "run/launchers",
      "run/watchers",
      "tmp",
    ];
    for (const directory of directories) {
      mkdirSync(this.path(directory), { recursive: true, mode: 0o700 });
      chmodSync(this.path(directory), 0o700);
    }
    chmodSync(this.root, 0o700);
    for (const peer of PEERS) {
      for (const state of QUEUE_STATES) {
        const directory = this.path("queues", peer, state);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
      }
    }
    const ignorePath = this.path(".gitignore");
    if (!existsSync(ignorePath)) {
      try {
        writeFileSync(ignorePath, "*\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : null;
        if (code !== "EEXIST") throw error;
      }
    }
    if (readFileSync(ignorePath, "utf8") !== "*\n") {
      writeFileSync(ignorePath, "*\n", { encoding: "utf8", mode: 0o600 });
    }
    chmodSync(ignorePath, 0o600);
  }

  private readJson<T>(path: string): T | null {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return null;
      }
      throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private atomicWrite(path: string, contents: string, replace: boolean): void {
    this.ensureRuntime();
    if (!replace && existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (current === contents) return;
      throw new Error(`conflicting existing state at ${path}`);
    }
    const tempPath = this.path("tmp", `${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      renameSync(tempPath, path);
    } catch (error) {
      if (existsSync(tempPath)) unlinkSync(tempPath);
      throw error;
    }
  }

  private atomicJson(path: string, value: unknown, replace = false): void {
    this.atomicWrite(path, `${JSON.stringify(value)}\n`, replace);
  }

  readClaudePeer(): ClaudePeerRecord | null {
    const record = this.readJson<ClaudePeerRecord>(this.path("peers", "claude.json"));
    if (!record) return null;
    if (
      record.schemaVersion !== SCHEMA_VERSION ||
      record.peer !== "claude" ||
      typeof record.sessionId !== "string" ||
      !Number.isInteger(record.pid) ||
      typeof record.launcherToken !== "string"
    ) {
      throw new Error("invalid Claude peer record");
    }
    return record;
  }

  readClaudeLauncher(): ClaudeLauncherLease | null {
    const lease = this.readJson<ClaudeLauncherLease>(this.path("run", "launchers", "claude.json"));
    if (!lease) return null;
    if (
      lease.schemaVersion !== SCHEMA_VERSION ||
      lease.peer !== "claude" ||
      typeof lease.cwd !== "string" ||
      !Number.isInteger(lease.pid) ||
      typeof lease.token !== "string"
    ) {
      throw new Error("invalid Claude launcher lease");
    }
    return lease;
  }

  readCodexPeer(): CodexPeerRecord | null {
    const record = this.readJson<CodexPeerRecord>(this.path("peers", "codex.json"));
    if (!record) return null;
    if (
      record.schemaVersion !== SCHEMA_VERSION ||
      record.peer !== "codex" ||
      typeof record.threadId !== "string" ||
      typeof record.endpoint !== "string"
    ) {
      throw new Error("invalid Codex peer record");
    }
    return record;
  }

  codexPeerIsLive(record = this.readCodexPeer()): record is CodexPeerRecord {
    return Boolean(record && isProcessLive(record.tuiPid) && isProcessLive(record.appServerPid));
  }

  claudeLauncherIsLive(lease = this.readClaudeLauncher()): lease is ClaudeLauncherLease {
    return Boolean(lease && isProcessLive(lease.pid));
  }

  claudePeerIsLive(record = this.readClaudePeer()): record is ClaudePeerRecord {
    const launcher = this.readClaudeLauncher();
    return Boolean(
      record &&
      launcher &&
      record.pid === launcher.pid &&
      record.launcherToken === launcher.token &&
      this.claudeLauncherIsLive(launcher),
    );
  }

  async beginClaudeLaunch(cwd: string, pid = process.pid): Promise<ClaudeLauncherLease> {
    if (!this.codexPeerIsLive()) throw new Error("a live Codex peer is required before launching Claude");
    if (!isProcessLive(pid)) throw new Error(`Claude launcher pid is not live: ${pid}`);
    const release = await this.acquireLock("claude.launch.lock");
    if (!release) throw new Error("timed out acquiring Claude launcher lock");
    try {
      const current = this.readClaudeLauncher();
      if (this.claudeLauncherIsLive(current)) {
        throw new Error(`a Claude launcher already owns this bridge: pid ${current.pid}`);
      }
      const lease: ClaudeLauncherLease = {
        schemaVersion: SCHEMA_VERSION,
        peer: "claude",
        cwd: realpathSync(resolve(cwd)),
        pid,
        token: uuidV7(),
        startedAt: new Date().toISOString(),
      };
      const stalePeerPath = this.path("peers", "claude.json");
      if (existsSync(stalePeerPath)) unlinkSync(stalePeerPath);
      const staleWatcherPath = this.path("run", "watchers", "claude.json");
      if (existsSync(staleWatcherPath)) unlinkSync(staleWatcherPath);
      this.atomicJson(this.path("run", "launchers", "claude.json"), lease, true);
      return lease;
    } finally {
      release();
    }
  }

  registerClaude(
    sessionId: string,
    cwd: string,
    ownerPid: number,
    launcherToken: string,
  ): ClaudePeerRecord {
    if (!sessionId) throw new Error("Claude session id is required");
    const launcher = this.readClaudeLauncher();
    if (
      !launcher ||
      launcher.pid !== ownerPid ||
      launcher.token !== launcherToken ||
      !this.claudeLauncherIsLive(launcher)
    ) {
      throw new Error("Claude registration does not match a live explicit launcher");
    }
    const registeredCwd = realpathSync(resolve(cwd));
    if (registeredCwd !== launcher.cwd) {
      throw new Error("Claude registration cwd does not match its explicit launcher");
    }
    if (!this.codexPeerIsLive()) throw new Error("the registered Codex peer is not live");
    const record: ClaudePeerRecord = {
      schemaVersion: SCHEMA_VERSION,
      peer: "claude",
      sessionId,
      cwd: registeredCwd,
      pid: ownerPid,
      launcherToken,
      startedAt: new Date().toISOString(),
    };
    this.atomicJson(this.path("peers", "claude.json"), record, true);
    return record;
  }

  endClaudeLaunch(token: string): void {
    const launcherPath = this.path("run", "launchers", "claude.json");
    const launcher = this.readClaudeLauncher();
    if (!launcher || launcher.token !== token) return;
    const peerPath = this.path("peers", "claude.json");
    const peer = this.readClaudePeer();
    if (peer?.launcherToken === token && existsSync(peerPath)) unlinkSync(peerPath);
    const watcherPath = this.path("run", "watchers", "claude.json");
    const watcher = this.watcherLease();
    if (peer && watcher?.sessionId === peer.sessionId && existsSync(watcherPath)) unlinkSync(watcherPath);
    if (existsSync(launcherPath)) unlinkSync(launcherPath);
  }

  registerCodex(input: Omit<CodexPeerRecord, "schemaVersion" | "peer" | "startedAt">): CodexPeerRecord {
    if (!input.threadId || !input.endpoint) throw new Error("Codex thread id and endpoint are required");
    if (!isProcessLive(input.tuiPid)) throw new Error(`Codex TUI pid is not live: ${input.tuiPid}`);
    if (!isProcessLive(input.appServerPid)) {
      throw new Error(`Codex App Server pid is not live: ${input.appServerPid}`);
    }
    const record: CodexPeerRecord = {
      schemaVersion: SCHEMA_VERSION,
      peer: "codex",
      threadId: input.threadId,
      endpoint: input.endpoint,
      cwd: realpathSync(resolve(input.cwd)),
      tuiPid: input.tuiPid,
      appServerPid: input.appServerPid,
      startedAt: new Date().toISOString(),
    };
    this.atomicJson(this.path("peers", "codex.json"), record, true);
    return record;
  }

  private watcherLease(): WatcherLease | null {
    return this.readJson<WatcherLease>(this.path("run", "watchers", "claude.json"));
  }

  private unreadIds(peer: Peer): string[] {
    const ids = new Set<string>();
    for (const state of QUEUE_STATES) {
      const directory = this.path("queues", peer, state);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (this.readLedger(peer, id)?.state !== "processed") ids.add(id);
      }
    }
    return [...ids].sort();
  }

  status(sessionId: string | null | undefined = undefined): BridgeStatus {
    const claude = this.readClaudePeer();
    let callerSessionId = sessionId;
    if (callerSessionId === undefined) {
      const ownerPid = process.env.GLUEVA_OWNER_PID;
      const launcherToken = process.env.GLUEVA_LAUNCH_TOKEN;
      callerSessionId = (
        claude &&
        ownerPid &&
        Number(ownerPid) === claude.pid &&
        launcherToken === claude.launcherToken
      ) ? claude.sessionId : null;
    }
    const sessionMatches = Boolean(callerSessionId && claude && claude.sessionId === callerSessionId);
    const bridgeActive = sessionMatches && this.claudePeerIsLive(claude);
    const lease = bridgeActive ? this.watcherLease() : null;
    const watcherLive = Boolean(
      lease && lease.schemaVersion === SCHEMA_VERSION && lease.peer === "claude" &&
        lease.sessionId === callerSessionId && isProcessLive(lease.pid),
    );
    return {
      protocol: CLI_PROTOCOL_VERSION,
      bridgeActive,
      unread: bridgeActive ? this.unreadIds("claude").length : 0,
      watcherLive,
      sessionId: claude?.sessionId ?? null,
    };
  }

  async acquireLock(
    name: string,
    waitMs = 5_000,
    staleMs = DEFAULT_LOCK_TTL_MS,
  ): Promise<(() => void) | null> {
    this.ensureRuntime();
    const lockPath = this.path("locks", name);
    const deadline = Date.now() + waitMs;
    while (true) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        const token = randomUUID();
        this.atomicJson(join(lockPath, "owner.json"), {
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        });
        return () => {
          const owner = this.readJson<{ pid?: number; token?: string }>(join(lockPath, "owner.json"));
          if (owner?.pid === process.pid && owner.token === token && existsSync(lockPath)) {
            rmSync(lockPath, { recursive: true });
          }
        };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : null;
        if (code !== "EEXIST") throw error;
        const owner = this.readJson<{ pid?: number; token?: string; createdAt?: string }>(
          join(lockPath, "owner.json"),
        );
        let lockAge: number;
        try {
          lockAge = Date.now() - statSync(lockPath).mtimeMs;
        } catch (statError) {
          const statCode = statError && typeof statError === "object" && "code" in statError
            ? (statError as { code?: unknown }).code
            : null;
          if (statCode === "ENOENT") continue;
          throw statError;
        }
        const createdAt = owner?.createdAt ? Date.parse(owner.createdAt) : Number.NaN;
        const expired = owner && Number.isFinite(createdAt) && Date.now() - createdAt >= staleMs;
        const dead = owner && !isProcessLive(owner.pid);
        if ((!owner && lockAge >= 1_000) || dead || expired) {
          const confirmed = this.readJson<{ pid?: number; token?: string; createdAt?: string }>(
            join(lockPath, "owner.json"),
          );
          if (
            (owner === null && confirmed !== null) ||
            (owner && (
              confirmed?.pid !== owner.pid ||
              confirmed.token !== owner.token ||
              confirmed.createdAt !== owner.createdAt
            ))
          ) {
            continue;
          }
          process.stderr.write(
            `glueva: reclaiming stale lock ${name} (${dead ? `owner pid ${owner?.pid} is dead` : expired ? "lease expired" : "owner record missing"})\n`,
          );
          rmSync(lockPath, { recursive: true });
          continue;
        }
        if (Date.now() >= deadline) return null;
        await sleep(25);
      }
    }
  }

  private allEnvelopeIds(): string[] {
    const ids = new Set<string>();
    for (const peer of PEERS) {
      for (const state of QUEUE_STATES) {
        const directory = this.path("queues", peer, state);
        if (!existsSync(directory)) continue;
        for (const name of readdirSync(directory)) {
          if (name.endsWith(".json")) ids.add(name.slice(0, -5));
        }
      }
    }
    return [...ids].sort();
  }

  nextEnvelopeId(): string {
    const ids = this.allEnvelopeIds();
    return uuidV7After(ids.at(-1) ?? null);
  }

  locateEnvelope(id: string): LocatedEnvelope | null {
    let located: LocatedEnvelope | null = null;
    for (const peer of PEERS) {
      for (const state of QUEUE_STATES) {
        const path = this.path("queues", peer, state, `${id}.json`);
        if (!existsSync(path)) continue;
        const serialized = readFileSync(path, "utf8");
        const envelope = parseEnvelope(serialized);
        if (envelope.id !== id || envelope.to !== peer) throw new Error(`misfiled envelope ${id}`);
        if (located && located.serialized !== serialized) throw new Error(`conflicting copies of envelope ${id}`);
        located = { envelope, path, state, serialized };
      }
    }
    return located;
  }

  private publishEnvelope(envelope: Envelope): void {
    const validated = validateEnvelope(envelope);
    const serialized = serializeEnvelope(validated);
    const existing = this.locateEnvelope(validated.id);
    if (existing) {
      if (existing.serialized !== serialized) throw new Error(`envelope id conflict: ${validated.id}`);
      return;
    }
    this.atomicWrite(this.path("queues", validated.to, "pending", `${validated.id}.json`), serialized, false);
  }

  async createRootEnvelope(
    to: Peer,
    body: string,
    status: EnvelopeStatus,
    maxHop: number,
  ): Promise<Envelope> {
    const release = await this.acquireLock(`${to}.enqueue.lock`);
    if (!release) throw new Error(`timed out acquiring ${to} enqueue lock`);
    try {
      const id = this.nextEnvelopeId();
      const envelope: Envelope = {
        schemaVersion: SCHEMA_VERSION,
        id,
        conversationId: id,
        from: to === "codex" ? "claude" : "codex",
        to,
        replyTo: null,
        hop: 0,
        maxHop,
        status,
        body,
      };
      this.publishEnvelope(envelope);
      return envelope;
    } finally {
      release();
    }
  }

  private ledgerPath(peer: Peer, id: string): string {
    return this.path("ledger", peer, `${id}.json`);
  }

  readLedger(peer: Peer, id: string): LedgerEntry | null {
    return this.readJson<LedgerEntry>(this.ledgerPath(peer, id));
  }

  async reply(parentId: string, body: string, status: EnvelopeStatus): Promise<Envelope> {
    const initialParent = this.locateEnvelope(parentId);
    if (!initialParent) throw new Error(`unknown parent envelope: ${parentId}`);
    const processor = initialParent.envelope.to;
    const releaseProcess = await this.acquireLock(`${processor}.process.lock`);
    if (!releaseProcess) throw new Error(`timed out acquiring ${processor} process lock`);
    try {
      const parent = this.locateEnvelope(parentId)?.envelope;
      if (!parent) throw new Error(`unknown parent envelope: ${parentId}`);
      if (parent.status === "done") throw new Error(`cannot reply to done envelope: ${parentId}`);
      if (parent.hop >= parent.maxHop) throw new Error(`cannot reply past maxHop: ${parentId}`);

      let ledger = this.readLedger(processor, parentId);
      if (ledger?.state === "processed") {
        if (!ledger.replyId) throw new Error(`envelope ${parentId} was already acknowledged without a reply`);
        const existingReply = this.locateEnvelope(ledger.replyId)?.envelope;
        if (!existingReply) throw new Error(`processed reply ${ledger.replyId} is missing`);
        const expected = {
          ...existingReply,
          status,
          body,
        };
        if (serializeEnvelope(existingReply) !== serializeEnvelope(expected)) {
          throw new Error(`reply transaction conflict for ${parentId}`);
        }
        return existingReply;
      }

      const target = parent.from;
      const releaseEnqueue = await this.acquireLock(`${target}.enqueue.lock`);
      if (!releaseEnqueue) throw new Error(`timed out acquiring ${target} enqueue lock`);
      try {
        const replyId = ledger?.replyId ?? this.nextEnvelopeId();
        if (!ledger) {
          ledger = {
            schemaVersion: SCHEMA_VERSION,
            envelopeId: parentId,
            peer: processor,
            state: "reply-reserved",
            replyId,
            processedAt: null,
          };
          this.atomicJson(this.ledgerPath(processor, parentId), ledger);
        }
        if (!replyId) throw new Error(`reply reservation for ${parentId} has no reply id`);
        const reply: Envelope = {
          schemaVersion: SCHEMA_VERSION,
          id: replyId,
          conversationId: parent.conversationId,
          from: parent.to,
          to: parent.from,
          replyTo: parent.id,
          hop: parent.hop + 1,
          maxHop: parent.maxHop,
          status,
          body,
        };
        this.publishEnvelope(reply);
        this.atomicJson(
          this.ledgerPath(processor, parentId),
          {
            ...ledger,
            state: "processed",
            processedAt: new Date().toISOString(),
          } satisfies LedgerEntry,
          true,
        );
        return reply;
      } finally {
        releaseEnqueue();
      }
    } finally {
      releaseProcess();
    }
  }

  async ack(id: string): Promise<void> {
    const initial = this.locateEnvelope(id);
    if (!initial) {
      for (const peer of PEERS) {
        const ledger = this.readLedger(peer, id);
        if (ledger?.state === "processed" && ledger.replyId === null) return;
      }
      throw new Error(`unknown envelope: ${id}`);
    }
    const peer = initial.envelope.to;
    const release = await this.acquireLock(`${peer}.process.lock`);
    if (!release) throw new Error(`timed out acquiring ${peer} process lock`);
    try {
      const ledger = this.readLedger(peer, id);
      if (ledger) {
        if (ledger.state === "processed" && ledger.replyId === null) return;
        throw new Error(`envelope ${id} already has a reply transaction`);
      }
      this.atomicJson(this.ledgerPath(peer, id), {
        schemaVersion: SCHEMA_VERSION,
        envelopeId: id,
        peer,
        state: "processed",
        replyId: null,
        processedAt: new Date().toISOString(),
      } satisfies LedgerEntry);
    } finally {
      release();
    }
  }

  private moveEnvelope(id: string, peer: Peer, from: QueueState, to: QueueState): LocatedEnvelope {
    const source = this.path("queues", peer, from, `${id}.json`);
    const destination = this.path("queues", peer, to, `${id}.json`);
    if (!existsSync(source)) {
      const existing = this.locateEnvelope(id);
      if (!existing) throw new Error(`missing envelope ${id}`);
      return existing;
    }
    if (existsSync(destination)) {
      if (readFileSync(source, "utf8") !== readFileSync(destination, "utf8")) {
        throw new Error(`conflicting queue states for ${id}`);
      }
      unlinkSync(source);
    } else {
      renameSync(source, destination);
    }
    const moved = this.locateEnvelope(id);
    if (!moved) throw new Error(`failed to move envelope ${id}`);
    return moved;
  }

  private writeReceipt(receipt: DeliveryReceipt): DeliveryReceipt {
    const path = this.path("receipts", receipt.to, `${receipt.envelopeId}.json`);
    const existing = this.readJson<DeliveryReceipt>(path);
    if (existing) return existing;
    this.atomicJson(path, receipt);
    return receipt;
  }

  readReceipt(peer: Peer, id: string): DeliveryReceipt | null {
    return this.readJson<DeliveryReceipt>(this.path("receipts", peer, `${id}.json`));
  }

  async receiveClaude(sessionId: string | null | undefined = undefined): Promise<Envelope[]> {
    if (!this.status(sessionId).bridgeActive) throw new Error("bridge is inactive for this Claude session");
    const release = await this.acquireLock("claude.receive.lock");
    if (!release) throw new Error("timed out acquiring Claude receive lock");
    try {
      const envelopes: Envelope[] = [];
      for (const id of this.unreadIds("claude")) {
        let located = this.locateEnvelope(id);
        if (!located) continue;
        if (located.state === "pending") located = this.moveEnvelope(id, "claude", "pending", "inflight");
        if (located.state === "inflight") located = this.moveEnvelope(id, "claude", "inflight", "delivered");
        this.writeReceipt({
          schemaVersion: SCHEMA_VERSION,
          envelopeId: id,
          to: "claude",
          state: "delivered",
          transport: "claude-inbox",
          requestedTurnId: null,
          observedTurnId: null,
          deliveredAt: new Date().toISOString(),
        });
        envelopes.push(located.envelope);
      }
      return envelopes.sort((left, right) => left.id.localeCompare(right.id));
    } finally {
      release();
    }
  }

  private codexUndeliveredIds(): string[] {
    const ids = new Set<string>();
    for (const state of ["inflight", "pending"] as QueueState[]) {
      const directory = this.path("queues", "codex", state);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory).sort()) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (!this.readReceipt("codex", id)) ids.add(id);
      }
    }
    return [...ids].sort();
  }

  claimNextCodexDelivery(): Envelope | null {
    const id = this.codexUndeliveredIds().at(0);
    if (!id) return null;
    const located = this.locateEnvelope(id);
    if (!located) return null;
    if (located.state === "pending") this.moveEnvelope(id, "codex", "pending", "inflight");
    return located.envelope;
  }

  hasCodexDeliveryCandidates(): boolean {
    return this.codexUndeliveredIds().length > 0;
  }

  completeCodexDelivery(
    envelope: Envelope,
    state: DeliveryState,
    requestedTurnId: string | null,
    observedTurnId: string,
  ): DeliveryReceipt {
    const located = this.locateEnvelope(envelope.id);
    if (!located) throw new Error(`missing delivered envelope ${envelope.id}`);
    if (located.state === "pending") this.moveEnvelope(envelope.id, "codex", "pending", "inflight");
    const inflight = this.locateEnvelope(envelope.id);
    if (inflight?.state === "inflight") this.moveEnvelope(envelope.id, "codex", "inflight", "delivered");
    return this.writeReceipt({
      schemaVersion: SCHEMA_VERSION,
      envelopeId: envelope.id,
      to: "codex",
      state,
      transport: "codex-app-server",
      requestedTurnId,
      observedTurnId,
      deliveredAt: new Date().toISOString(),
    });
  }

  private removeWatcherLease(token: string): void {
    const path = this.path("run", "watchers", "claude.json");
    const current = this.watcherLease();
    if (current?.token === token && existsSync(path)) unlinkSync(path);
  }

  async waitForClaude(
    sessionId: string | null | undefined = undefined,
  ): Promise<"mail" | "inactive" | "interrupted" | "already-armed"> {
    const initialStatus = this.status(sessionId);
    const activeSessionId = initialStatus.sessionId;
    if (!activeSessionId || !initialStatus.bridgeActive) return "inactive";
    const token = uuidV7();
    let interrupted = false;
    const onSignal = () => {
      interrupted = true;
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const release = await this.acquireLock("claude.drain.lock");
      if (!release) throw new Error("timed out acquiring Claude watcher lease lock");
      try {
        const existing = this.watcherLease();
        if (existing && existing.pid !== process.pid && isProcessLive(existing.pid)) {
          if (existing.sessionId !== activeSessionId) {
            throw new Error(`watcher belongs to another live Claude session: ${existing.sessionId}`);
          }
          return "already-armed";
        }
        this.atomicJson(
          this.path("run", "watchers", "claude.json"),
          {
            schemaVersion: SCHEMA_VERSION,
            peer: "claude",
            sessionId: activeSessionId,
            pid: process.pid,
            token,
            armedAt: new Date().toISOString(),
          } satisfies WatcherLease,
          true,
        );
      } finally {
        release();
      }
      while (true) {
        if (interrupted) return "interrupted";
        const status = this.status(activeSessionId);
        if (!status.bridgeActive) return "inactive";
        if (status.unread > 0) return "mail";
        await sleep(250);
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      this.removeWatcherLease(token);
    }
  }

}
