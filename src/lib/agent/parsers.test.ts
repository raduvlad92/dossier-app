import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoundPosting } from "@/lib/job-search/search";

import { parserSettingsSchema, type ParserSettings } from "./parser-settings";
import { enrichAgentPosting, parserText, publicParserUrl, remoteParserText } from "./parsers";

const fake = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  fetch: vi.fn<typeof fetch>(),
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
  fullText: vi.fn<() => Promise<string | null>>(async () => null),
  fetchPosting: vi.fn(async () => ({ ok: false as const, error: "The job site could not be reached." })),
  config: { provider: "off", taskId: "", datasetId: "", inputTemplate: "", textField: "", maxChargeUsd: 0.25, key: null } as ParserSettings & { key: string | null },
}));
vi.mock("node:dns/promises", () => ({ lookup: fake.lookup }));
vi.mock("@/lib/prisma", () => ({
  prisma: { setting: {
    findUnique: vi.fn(async ({ where }: { where: { key: string } }) => fake.rows.has(where.key) ? { key: where.key, value: fake.rows.get(where.key)! } : null),
    create: vi.fn(async ({ data }: { data: { key: string; value: string } }) => {
      if (fake.rows.has(data.key)) throw new Error("Unique constraint");
      fake.rows.set(data.key, data.value);
      return data;
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
      const value = fake.rows.has(where.key) ? update.value : create.value;
      fake.rows.set(where.key, value);
      return { key: where.key, value };
    }),
  } },
}));
vi.mock("@/lib/job-search/find", () => ({ fullText: fake.fullText }));
vi.mock("@/lib/posting-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/posting-fetch")>()),
  fetchPosting: fake.fetchPosting,
}));
vi.mock("./parser-config", () => ({ loadParserConfig: async () => fake.config }));

const url = "https://jobs.example/it-manager";
const description = "Lead our IT operations, support and workplace technology team. ".repeat(6);
const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers });
const config = (provider: "apify" | "brightdata" = "apify") => ({ ...parserSettingsSchema.parse({ provider, taskId: "owner~task", datasetId: "gd_test" }), key: "private-parser-key" });
const journal = () => JSON.parse([...fake.rows.values()][0]);
const posting: FoundPosting = { source: "JSEARCH", externalId: "1", title: "IT Manager", company: "Example", place: "Berlin", remote: false, salary: "", postedAt: null, url, via: "", description: "Short excerpt.", complete: false };

beforeEach(() => {
  fake.rows.clear();
  fake.fetch.mockReset();
  fake.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  fake.fullText.mockReset().mockResolvedValue(null);
  fake.fetchPosting.mockReset().mockResolvedValue({ ok: false, error: "The job site could not be reached." });
  fake.config = { ...parserSettingsSchema.parse({}), key: null };
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("remote parser journal", () => {
  it("resumes an Apify run after a restart and caches its normalized text without another paid POST", async () => {
    fake.fetch.mockResolvedValueOnce(json({ data: { id: "run-1", defaultDatasetId: "dataset-1" } })).mockResolvedValueOnce(json({ data: { status: "RUNNING" } }));
    expect(await remoteParserText(url, config())).toBeNull();
    expect(journal()).toMatchObject({ phase: "running", id: "run-1", datasetId: "dataset-1" });

    vi.resetModules();
    const resumed = await import("./parsers");
    fake.fetch.mockResolvedValueOnce(json({ data: { status: "SUCCEEDED" } })).mockResolvedValueOnce(json([{ url, description: `<p>${description}</p>` }]));
    expect(await resumed.remoteParserText(url, config())).toBe(description.trim());
    expect(journal()).toMatchObject({ phase: "ready", text: description.trim() });
    expect(await resumed.remoteParserText(url, config())).toBe(description.trim());
    expect(fake.fetch).toHaveBeenCalledTimes(4);
    const posts = fake.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toContain("maxItems=1&maxTotalChargeUsd=0.25");
    expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ startUrls: [{ url }], maxCrawlPages: 1 });
    expect(posts[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer private-parser-key" } });
    expect(fake.fetch.mock.calls.at(-1)![0]).toContain("items?format=json&limit=1&offset=0");
  });

  it("never repeats a trigger when the paid POST had an ambiguous network failure", async () => {
    fake.fetch.mockRejectedValueOnce(new TypeError("socket closed after sending"));
    await expect(remoteParserText(url, config())).rejects.toThrow("socket closed");
    expect(journal().phase).toBe("triggering");
    await expect(remoteParserText(url, config())).rejects.toThrow("needs review in your provider console");
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  });

  it("claims a posting once when two scans try to trigger it concurrently", async () => {
    fake.fetch.mockResolvedValueOnce(json({ data: { id: "run-1", defaultDatasetId: "dataset-1" } })).mockResolvedValueOnce(json({ data: { status: "RUNNING" } }));
    const results = await Promise.allSettled([remoteParserText(url, config()), remoteParserText(url, config())]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(fake.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["FAILED", "ABORTED", "TIMED-OUT"])("keeps an Apify %s terminal state and does not trigger it again", async (status) => {
    fake.fetch.mockResolvedValueOnce(json({ data: { id: "run-1", defaultDatasetId: "dataset-1" } })).mockResolvedValueOnce(json({ data: { status } }));
    await expect(remoteParserText(url, config())).rejects.toThrow("Apify could not parse");
    expect(journal().phase).toBe("failed");
    await expect(remoteParserText(url, config())).rejects.toThrow("Check the saved run");
    expect(fake.fetch).toHaveBeenCalledTimes(2);
  });

  it("polls the saved Bright Data snapshot and sends only the posting URL with its configured input limit", async () => {
    fake.fetch.mockResolvedValueOnce(json({ snapshot_id: "snapshot-1" })).mockResolvedValueOnce(json({ status: "running" }));
    expect(await remoteParserText(url, config("brightdata"))).toBeNull();
    fake.fetch.mockResolvedValueOnce(json({ status: "ready" })).mockResolvedValueOnce(json([{ job_url: url, job_description: description }]));
    expect(await remoteParserText(url, config("brightdata"))).toBe(description.trim());
    const posts = fake.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toContain("dataset_id=gd_test&include_errors=true");
    expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ input: [{ url }], limit_per_input: 1 });
    expect(fake.fetch.mock.calls.at(-1)![0]).toContain("/snapshot/snapshot-1?format=json");
  });

  it("rejects unrelated posting output and incomplete journal rows without a second charge", async () => {
    fake.fetch.mockResolvedValueOnce(json({ data: { id: "run-1", defaultDatasetId: "dataset-1" } })).mockResolvedValueOnce(json({ data: { status: "SUCCEEDED" } })).mockResolvedValueOnce(json([{ url: "https://jobs.example/other-job", text: description }]));
    await expect(remoteParserText(url, config())).rejects.toThrow("different posting link");
    expect(journal().phase).toBe("failed");
    const [key] = fake.rows.keys();
    fake.rows.set(key, JSON.stringify({ phase: "running", at: new Date().toISOString() }));
    await expect(remoteParserText(url, config())).rejects.toThrow("journal is incomplete");
    expect(fake.fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["header", "stream"])("bounds %s response data at two megabytes", async (mode) => {
    const oversized = mode === "header" ? json({}, { "content-length": String(2 * 1024 * 1024 + 1) }) : new Response("x".repeat(2 * 1024 * 1024 + 1));
    fake.fetch.mockResolvedValueOnce(oversized);
    await expect(remoteParserText(url, config())).rejects.toThrow("response was too large");
    await expect(remoteParserText(url, config())).rejects.toThrow("needs review");
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("parser input and enrichment boundaries", () => {
  it("validates configuration and cancellation before claiming or sending a paid request", async () => {
    await expect(remoteParserText(url, { ...config(), taskId: "" })).rejects.toThrow("saved task");
    await expect(remoteParserText(url, { ...config(), inputTemplate: "broken {{url}}" })).rejects.toThrow("valid parser input JSON");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(remoteParserText(url, config(), cancelled.signal)).rejects.toThrow();
    expect(fake.rows.size).toBe(0);
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it("rejects private DNS answers and embedded credentials before sending the URL to a provider", async () => {
    fake.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(remoteParserText(url, config())).rejects.toThrow("own network");
    await expect(publicParserUrl("https://user:password@jobs.example/job")).rejects.toThrow("embedded credentials");
    await expect(publicParserUrl("file:///etc/passwd")).rejects.toThrow("public web address");
    expect(fake.rows.size).toBe(0);
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it("normalizes nested HTML output and refuses empty or oversized posting text", () => {
    expect(parserText([{ result: { description: `<p>${description}&amp; Benefits</p>` } }], "result.description")).toBe(`${description}& Benefits`.replace(/\s+/g, " ").trim());
    expect(parserText([{ text: "cookie wall" }], "")).toBeNull();
    expect(parserText([{ text: "x".repeat(100001) }], "")).toBeNull();
  });

  it("uses complete source text before any page fetch or paid parser", async () => {
    fake.fullText.mockResolvedValue(description);
    expect(await enrichAgentPosting(posting)).toMatchObject({ description, complete: true });
    expect(fake.fetchPosting).not.toHaveBeenCalled();
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(await enrichAgentPosting({ ...posting, complete: true })).toMatchObject({ complete: true });
    expect(fake.fullText).toHaveBeenCalledTimes(1);
  });

  it("keeps private addresses away from remote providers when the guarded page fetch refuses them", async () => {
    fake.config = config();
    fake.fetchPosting.mockResolvedValue({ ok: false, error: "Dossier doesn't fetch addresses on your own network." });
    expect(await enrichAgentPosting(posting)).toEqual(posting);
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});
