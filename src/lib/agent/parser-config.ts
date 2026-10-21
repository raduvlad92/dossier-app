import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret, JOB_SOURCE_KEY } from "@/lib/secrets";
import { parserSettingsSchema, type ParserSettings, type ParserSettingsView } from "./parser-settings";

const CONFIG = "agentParserConfig";
const KEY = "agentParserKeyEnc";

export async function loadParserConfig(): Promise<ParserSettings & { key: string | null }> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [CONFIG, KEY] } } });
  let settings = parserSettingsSchema.parse({});
  try { settings = parserSettingsSchema.parse(JSON.parse(rows.find((row) => row.key === CONFIG)?.value ?? "{}")); } catch { /* Invalid saved settings leave paid parsing off. */ }
  let key: string | null = null;
  try {
    const stored = rows.find((row) => row.key === KEY)?.value;
    if (stored) key = decryptSecret(JOB_SOURCE_KEY, stored);
  } catch { /* The view asks for a new key. */ }
  return { ...settings, key };
}

export async function parserSettingsView(): Promise<ParserSettingsView> {
  const { key, ...settings } = await loadParserConfig();
  return { ...settings, keySet: Boolean(key) };
}

export async function saveParserConfig(settings: ParserSettings, key?: string, clearKey = false): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const value = JSON.stringify(settings);
    await tx.setting.upsert({ where: { key: CONFIG }, create: { key: CONFIG, value }, update: { value } });
    // A newly configured parser can supply text that was unavailable when filters last ran.
    await tx.setting.deleteMany({ where: { key: "agentExclusionHistory" } });
    if (clearKey) await tx.setting.deleteMany({ where: { key: KEY } });
    else if (key?.trim()) {
      const value = encryptSecret(JOB_SOURCE_KEY, key.trim());
      await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
    }
  });
}
