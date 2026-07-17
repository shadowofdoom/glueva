import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  injectedEnvelopeText,
  isUuidV7,
  parseEnvelope,
  serializeEnvelope,
  uuidV7,
  uuidV7After,
  validateEnvelope,
} from "../src/protocol";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("frozen envelope contract", () => {
  test("root and reply fixtures are canonical", () => {
    for (const name of ["envelope-root.json", "envelope-reply.json"]) {
      const fixture = readFileSync(join(FIXTURES, name), "utf8");
      expect(serializeEnvelope(parseEnvelope(fixture))).toBe(fixture);
    }
  });

  test("injected text embeds the exact envelope id and canonical JSON", () => {
    const envelope = parseEnvelope(readFileSync(join(FIXTURES, "envelope-root.json"), "utf8"));
    expect(injectedEnvelopeText(envelope)).toBe(readFileSync(join(FIXTURES, "injected-root.txt"), "utf8"));
  });

  test("generated UUIDv7 ids are lowercase and sortable", () => {
    const first = uuidV7(1_700_000_000_000);
    const second = uuidV7After(first);
    expect(isUuidV7(first)).toBe(true);
    expect(isUuidV7(second)).toBe(true);
    expect(second > first).toBe(true);
  });

  test("rejects extra fields and invalid root semantics", () => {
    const root = parseEnvelope(readFileSync(join(FIXTURES, "envelope-root.json"), "utf8"));
    expect(() => validateEnvelope({ ...root, unexpected: true })).toThrow("exactly");
    expect(() => validateEnvelope({ ...root, conversationId: uuidV7() })).toThrow("conversationId must equal id");
    expect(() => validateEnvelope({ ...root, from: "codex", to: "codex" })).toThrow("must differ");
  });
});
