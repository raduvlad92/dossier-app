import { describe, expect, it } from "vitest";

import { parserInput, parserSettingsSchema } from "./parser-settings";

describe("optional parser settings", () => {
  it("starts disabled and bounds provider identifiers, charges and input size", () => {
    expect(parserSettingsSchema.parse({})).toEqual({ provider: "off", taskId: "", datasetId: "", inputTemplate: "", textField: "", maxChargeUsd: 0.25 });
    for (const changes of [{ maxChargeUsd: 0 }, { maxChargeUsd: 5.01 }, { taskId: "../other/task" }, { datasetId: "not a scraper" }, { inputTemplate: "x".repeat(10001) }]) {
      expect(parserSettingsSchema.safeParse(changes).success).toBe(false);
    }
  });

  it("substitutes only the posting URL as data, including quotes and query parameters", () => {
    const settings = parserSettingsSchema.parse({ provider: "apify", inputTemplate: '{"nested":{"urls":["{{url}}"]},"literal":"{{cv}}"}' });
    const url = 'https://jobs.example/role?q="IT"&tag=$x';
    expect(parserInput(settings, url)).toEqual({ nested: { urls: [url] }, literal: "{{cv}}" });
  });

  it("provides single-posting defaults for each provider and rejects malformed templates", () => {
    const url = "https://jobs.example/role";
    expect(parserInput(parserSettingsSchema.parse({ provider: "apify" }), url)).toEqual({ startUrls: [{ url }], maxCrawlPages: 1 });
    expect(parserInput(parserSettingsSchema.parse({ provider: "brightdata" }), url)).toEqual({ input: [{ url }], limit_per_input: 1 });
    expect(() => parserInput(parserSettingsSchema.parse({ inputTemplate: '{"url":"fixed"}' }), url)).toThrow("needs {{url}}");
    expect(() => parserInput(parserSettingsSchema.parse({ inputTemplate: '{"url": {{url}}}' }), url)).toThrow();
  });

  it("keeps Bright Data to one posting and one requested result with custom inputs", () => {
    const settings = (inputTemplate: string) => parserSettingsSchema.parse({ provider: "brightdata", inputTemplate });
    expect(parserInput(settings('{"input":[{"url":"{{url}}","custom":true}],"limit_per_input":100}'), "https://jobs.example/role")).toEqual({ input: [{ url: "https://jobs.example/role", custom: true }], limit_per_input: 1 });
    expect(() => parserInput(settings('{"input":[{"url":"{{url}}"},{"url":"https://other.example"}]}'), "https://jobs.example/role")).toThrow("exactly one");
    expect(() => parserInput(settings('["{{url}}"]'), "https://jobs.example/role")).toThrow("input object");
  });
});
