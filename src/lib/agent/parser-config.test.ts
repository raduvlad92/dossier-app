import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadParserConfig, saveParserConfig } from "./parser-config";
import { parserSettingsSchema } from "./parser-settings";

const fake = vi.hoisted(() => ({ rows: new Map<string, string>() }));
vi.mock("@/lib/prisma", () => {
  const setting = {
    findMany: async () => [...fake.rows].map(([key, value]) => ({ key, value })),
    upsert: async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
      fake.rows.set(where.key, fake.rows.has(where.key) ? update.value : create.value);
    },
    deleteMany: async ({ where }: { where: { key: string } }) => { fake.rows.delete(where.key); },
  };
  return { prisma: { setting, $transaction: async (operation: (tx: { setting: typeof setting }) => Promise<void>) => operation({ setting }) } };
});
vi.mock("@/lib/secrets", () => ({
  JOB_SOURCE_KEY: "job-key",
  encryptSecret: (_purpose: unknown, value: string) => `encrypted:${value}`,
  decryptSecret: (_purpose: unknown, value: string) => value.replace(/^encrypted:/, ""),
}));

beforeEach(() => fake.rows.clear());

describe("optional parser configuration", () => {
  it("clears rejected-text cache when parsing settings change and preserves the paid-run journal", async () => {
    fake.rows.set("agentExclusionHistory", "cached rejections");
    fake.rows.set("agent-parser:existing-run", "ambiguous paid request");
    const settings = parserSettingsSchema.parse({ provider: "apify", taskId: "owner~task" });
    await saveParserConfig(settings, "parser-key");
    expect(fake.rows.has("agentExclusionHistory")).toBe(false);
    expect(fake.rows.get("agent-parser:existing-run")).toBe("ambiguous paid request");
    expect(fake.rows.get("agentParserKeyEnc")).toBe("encrypted:parser-key");
    expect(await loadParserConfig()).toMatchObject({ ...settings, key: "parser-key" });
  });

  it("clears the token when requested and leaves parsing disabled for invalid saved settings", async () => {
    fake.rows.set("agentParserKeyEnc", "encrypted:old-token");
    await saveParserConfig(parserSettingsSchema.parse({}), undefined, true);
    expect(fake.rows.has("agentParserKeyEnc")).toBe(false);
    fake.rows.set("agentParserConfig", "invalid JSON");
    expect(await loadParserConfig()).toMatchObject({ provider: "off", key: null });
  });
});
