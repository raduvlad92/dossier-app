"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { saveParserConfig, loadParserConfig } from "@/lib/agent/parser-config";
import { parserInput, parserSettingsSchema } from "@/lib/agent/parser-settings";

export const saveAgentParser = action(
  z.object({ settings: parserSettingsSchema, key: z.string().max(500).optional(), clearKey: z.boolean().default(false) }),
  async ({ settings, key, clearKey }) => {
    if (settings.provider !== "off") {
      if (settings.provider === "apify" && !settings.taskId) throw new ActionError("Enter your Apify saved task ID.");
      if (settings.provider === "brightdata" && !settings.datasetId) throw new ActionError("Enter your Bright Data scraper dataset ID.");
      const current = await loadParserConfig();
      if (clearKey || (!key?.trim() && !current.key)) throw new ActionError("Add the parser API key first.");
      try { parserInput(settings, "https://example.com/job"); } catch { throw new ActionError("Use valid JSON containing {{url}} for the posting link."); }
    }
    await saveParserConfig(settings, key, clearKey);
  },
);
