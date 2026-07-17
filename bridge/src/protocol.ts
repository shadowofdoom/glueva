import { randomBytes } from "node:crypto";

export const SCHEMA_VERSION = 1 as const;
export const MAX_HOP_LIMIT = 6;
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type Peer = "claude" | "codex";
export type EnvelopeStatus = "continue" | "done";

export interface Envelope {
  schemaVersion: 1;
  id: string;
  conversationId: string;
  from: Peer;
  to: Peer;
  replyTo: string | null;
  hop: number;
  maxHop: number;
  status: EnvelopeStatus;
  body: string;
}

const ENVELOPE_KEYS = [
  "schemaVersion",
  "id",
  "conversationId",
  "from",
  "to",
  "replyTo",
  "hop",
  "maxHop",
  "status",
  "body",
] as const;

export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_PATTERN.test(value);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidV7(timestampMs = Date.now()): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs >= 2 ** 48) {
    throw new Error(`invalid UUIDv7 timestamp: ${timestampMs}`);
  }

  const bytes = new Uint8Array(16);
  let timestamp = BigInt(timestampMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  const random = randomBytes(10);
  bytes[6] = 0x70 | (random[0] & 0x0f);
  bytes[7] = random[1];
  bytes[8] = 0x80 | (random[2] & 0x3f);
  bytes.set(random.subarray(3), 9);
  return formatUuid(bytes);
}

function uuidV7Timestamp(id: string): number {
  if (!isUuidV7(id)) throw new Error(`not a lowercase UUIDv7: ${id}`);
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

export function uuidV7After(previous: string | null): string {
  const timestamp = previous
    ? Math.max(Date.now(), uuidV7Timestamp(previous) + 1)
    : Date.now();
  return uuidV7(timestamp);
}

function assertExactKeys(value: Record<string, unknown>): void {
  const actual = Object.keys(value).sort();
  const expected = [...ENVELOPE_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`envelope fields must be exactly: ${ENVELOPE_KEYS.join(", ")}`);
  }
}

export function validateEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("envelope must be an object");
  }

  const envelope = value as Record<string, unknown>;
  assertExactKeys(envelope);
  if (envelope.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported envelope schemaVersion");
  if (!isUuidV7(envelope.id)) throw new Error("envelope id must be a lowercase UUIDv7");
  if (!isUuidV7(envelope.conversationId)) {
    throw new Error("conversationId must be a lowercase UUIDv7");
  }
  if (envelope.from !== "claude" && envelope.from !== "codex") throw new Error("invalid envelope from");
  if (envelope.to !== "claude" && envelope.to !== "codex") throw new Error("invalid envelope to");
  if (envelope.from === envelope.to) throw new Error("envelope from and to must differ");
  if (envelope.replyTo !== null && !isUuidV7(envelope.replyTo)) {
    throw new Error("replyTo must be null or a lowercase UUIDv7");
  }
  if (!Number.isInteger(envelope.hop) || (envelope.hop as number) < 0 || (envelope.hop as number) > MAX_HOP_LIMIT) {
    throw new Error("hop must be an integer from 0 through 6");
  }
  if (
    !Number.isInteger(envelope.maxHop) ||
    (envelope.maxHop as number) < 0 ||
    (envelope.maxHop as number) > MAX_HOP_LIMIT
  ) {
    throw new Error("maxHop must be an integer from 0 through 6");
  }
  if ((envelope.hop as number) > (envelope.maxHop as number)) throw new Error("hop exceeds maxHop");
  if (envelope.status !== "continue" && envelope.status !== "done") throw new Error("invalid envelope status");
  if (typeof envelope.body !== "string" || envelope.body.length === 0) throw new Error("body must be nonempty");

  if (envelope.replyTo === null) {
    if (envelope.hop !== 0) throw new Error("root envelope hop must be zero");
    if (envelope.conversationId !== envelope.id) {
      throw new Error("root envelope conversationId must equal id");
    }
  } else if (envelope.hop === 0) {
    throw new Error("reply envelope hop must be greater than zero");
  }

  return canonicalEnvelope(envelope as unknown as Envelope);
}

function canonicalEnvelope(envelope: Envelope): Envelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: envelope.id,
    conversationId: envelope.conversationId,
    from: envelope.from,
    to: envelope.to,
    replyTo: envelope.replyTo,
    hop: envelope.hop,
    maxHop: envelope.maxHop,
    status: envelope.status,
    body: envelope.body,
  };
}

export function serializeEnvelope(envelope: Envelope): string {
  return `${JSON.stringify(validateEnvelope(envelope))}\n`;
}

export function parseEnvelope(text: string): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid envelope JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateEnvelope(value);
}

export function injectedEnvelopeText(envelope: Envelope): string {
  const canonical = serializeEnvelope(envelope);
  return `GLUEVA/1 id=${envelope.id}\n${canonical}`;
}

export function envelopeTextFromUserItem(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const candidate = item as { type?: unknown; content?: unknown };
  if (candidate.type !== "userMessage" || !Array.isArray(candidate.content)) return null;
  const text = candidate.content
    .filter(
      (input): input is { type: "text"; text: string } =>
        Boolean(input) && typeof input === "object" && (input as { type?: unknown }).type === "text" &&
        typeof (input as { text?: unknown }).text === "string",
    )
    .map((input) => input.text)
    .join("");
  return text || null;
}

export function injectedTextContainsEnvelope(text: string | null, envelope: Envelope): boolean {
  if (!text) return false;
  const header = `GLUEVA/1 id=${envelope.id}\n`;
  if (!text.startsWith(header)) return false;
  try {
    const parsed = parseEnvelope(text.slice(header.length));
    return parsed.id === envelope.id && parsed.to === envelope.to;
  } catch {
    return false;
  }
}
