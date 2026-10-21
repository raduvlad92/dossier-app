import { z } from "zod";

export const parserSettingsSchema = z.object({
  provider: z.enum(["off", "apify", "brightdata"]).default("off"),
  taskId: z.string().trim().max(150).regex(/^[\w~.-]*$/).default(""),
  datasetId: z.string().trim().max(150).regex(/^[\w-]*$/).default(""),
  inputTemplate: z.string().max(10_000).default(""),
  textField: z.string().trim().max(100).regex(/^[\w.]*$/).default(""),
  maxChargeUsd: z.number().min(0.01).max(5).default(0.25),
});
export type ParserSettings = z.infer<typeof parserSettingsSchema>;
export type ParserSettingsView = ParserSettings & { keySet: boolean };

export function parserInput(settings: ParserSettings, url: string): unknown {
  const template = settings.inputTemplate.trim() || (settings.provider === "apify" ? '{"startUrls":[{"url":"{{url}}"}],"maxCrawlPages":1}' : '{"input":[{"url":"{{url}}"}],"limit_per_input":1}');
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") return value.replaceAll("{{url}}", url);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
    return value;
  };
  if (!template.includes("{{url}}")) throw new Error("The parser input needs {{url}} for the posting link.");
  const input = replace(JSON.parse(template));
  if (settings.provider === "brightdata") {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Bright Data needs one input object.");
    const body = input as Record<string, unknown>;
    if (!Array.isArray(body.input) || body.input.length !== 1) throw new Error("Bright Data needs exactly one posting input.");
    return { ...body, limit_per_input: 1 };
  }
  return input;
}
