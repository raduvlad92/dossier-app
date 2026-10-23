import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch } from "@/lib/ai/test-http";
import { MockProvider } from "@/lib/ai/providers/mock";
import { agentExclusionsSchema } from "@/lib/agent/exclusion-settings";
import { clearJobSearchCache } from "@/lib/job-search/cache";
import * as source from "@/lib/job-search/find";
import { fullText } from "@/lib/job-search/find";
import { EMPTY_QUERY, type FoundPosting } from "@/lib/job-search/search";
import * as postingFetch from "@/lib/posting-fetch";
import { savePosting } from "@/lib/postings";
import { encryptSecret, JOB_SOURCE_KEY } from "@/lib/secrets";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";
import { jsearchV2LastPage, jsearchV2Page } from "@/test/job-search-fixtures";

import { countSearches, listSearches, loadSearch, recheckSearch, removeSearch, runSearch, showMoreFor } from "./posting-searches";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
const provider = vi.hoisted(() => ({ current: undefined as unknown, load: vi.fn() }));
vi.mock("@/lib/ai", () => ({ getAiProvider: async () => { provider.load(); return provider.current; } }));
const prisma = () => db.client!;

const query = { ...EMPTY_QUERY, keywords: "product designer", place: "Hamburg", country: "de" };
const useJSearch = () => saveSettings({ jobSource: "JSEARCH", jsearchKeyEnc: encryptSecret(JOB_SOURCE_KEY, "ak_test") });

beforeEach(async () => {
  await resetDatabase(prisma());
  // These legacy cases exercise search storage, independently of eligibility.
  await saveSettings({ agentExclusions: { englishOnly: false, allowedLanguages: [], excludeConsultancies: false, companies: [] } });
  provider.load.mockClear();
  provider.current = new MockProvider({ reply: () => ({
    contentComplete: true, postingLanguage: "english", postingLanguageEvidence: englishBody,
    languageRequirementsCertain: true, languageRequirements: [], employerIsConsultancy: "no",
    consultancyEvidence: "We build fleet scheduling software for our customers.",
  }) });
  clearJobSearchCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => prisma().$disconnect());

describe("runSearch", () => {
  it("is off until a source is chosen, and needs a country and a key", async () => {
    expect(await runSearch(query)).toEqual({ ok: false, problem: "off", message: "Choose where to search in Settings → Job search first." });
    await saveSettings({ jobSource: "JSEARCH" });
    expect(await runSearch({ ...query, country: "" })).toMatchObject({ ok: false, problem: "no-country" });
    expect(await runSearch(query)).toEqual({ ok: false, problem: "no-key", message: "Add your JSearch key in Settings → Job search first." });
    expect(await countSearches()).toBe(0);
  });

  it("keeps the search with its first page", async () => {
    await useJSearch();
    const requests = stubFetch(() => json(jsearchV2Page));
    const result = await runSearch(query);
    expect(result).toEqual({ ok: true, id: expect.any(String) });
    expect(requests[0].headers.get("x-api-key")).toBe("ak_test");
    const kept = await prisma().postingSearch.findUniqueOrThrow({ where: { id: result.ok ? result.id : "" } });
    expect(kept).toMatchObject({ source: "JSEARCH", query, found: 2, next: "cursor:CURSOR-PAGE-2" });
  });

  it("keeps nothing when the source says no", async () => {
    await useJSearch();
    stubFetch(() => json({}, { status: 429 }));
    expect(await runSearch(query)).toMatchObject({ ok: false, problem: "quota" });
    expect(await countSearches()).toBe(0);
  });

  it("treats a request that fails as the source not answering", async () => {
    await useJSearch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => {
      throw new Error("boom");
    });
    expect(await runSearch(query)).toMatchObject({ ok: false, problem: "unavailable" });
  });
});

describe("loadSearch", () => {
  it("opens a kept search without asking the source, with where each posting stands now", async () => {
    await useJSearch();
    stubFetch(() => json(jsearchV2Page));
    const run = await runSearch(query);
    const requests = stubFetch(() => json(jsearchV2Page));

    const now = new Date();
    const search = await loadSearch(run.ok ? run.id : "", { now });
    expect(requests).toHaveLength(0);
    expect(search).toMatchObject({ source: "JSEARCH", query, next: "cursor:CURSOR-PAGE-2", ranAt: expect.stringMatching(/^today at \d\d:\d\d$/) });
    expect(search!.postings.map((posting) => [posting.title, posting.state.saved])).toEqual([
      ["Senior Product Designer, Payments", false],
      ["UX Researcher", false],
    ]);

    const { state, ...ledgerly } = search!.postings[0];
    void state;
    await savePosting(ledgerly);
    expect((await loadSearch(search!.id))!.postings[0].state.saved).toBe(true);
  });

  it("opens the latest search without an id, and nothing when there's none or it's gone", async () => {
    expect(await loadSearch()).toBeNull();
    await prisma().postingSearch.create({ data: { source: "JSEARCH", query, postings: [], createdAt: new Date("2026-10-01T10:00:00Z") } });
    const latest = await prisma().postingSearch.create({ data: { source: "JSEARCH", query: { ...query, keywords: "researcher" }, postings: [] } });
    expect((await loadSearch())?.id).toBe(latest.id);
    expect(await loadSearch("gone")).toBeNull();
  });

  it("reads past an old posting that no longer fits, and a damaged search", async () => {
    const search = await prisma().postingSearch.create({
      data: { source: "ADZUNA", query: { keywords: 1 }, postings: [{ title: "No id" }, ...jsearchV2LastPage.data.jobs.map(() => ({ ...EMPTY_POSTING }))] },
      select: { id: true },
    });
    expect(await loadSearch(search.id, { now: new Date() })).toMatchObject({ query: EMPTY_QUERY, postings: [], filtering: { total: 1, unchecked: 1 } });
    await prisma().postingSearch.update({ where: { id: search.id }, data: { postings: { not: "a list" } } });
    expect((await loadSearch(search.id))!.postings).toEqual([]);
  });

  it("says when it ran: yesterday, or the day", async () => {
    const yesterday = await prisma().postingSearch.create({ data: { source: "JSEARCH", query, postings: [], createdAt: new Date("2026-10-02T16:20:00Z") } });
    const older = await prisma().postingSearch.create({ data: { source: "JSEARCH", query, postings: [], createdAt: new Date("2026-09-28T08:05:00Z") } });
    const now = new Date("2026-10-03T12:00:00Z");
    expect((await loadSearch(yesterday.id, { timeZone: "Europe/Berlin", now }))!.ranAt).toBe("yesterday at 18:20");
    expect((await loadSearch(older.id, { timeZone: "Europe/Berlin", now }))!.ranAt).toBe("on Mon 28 Sep at 10:05");
  });
});

const EMPTY_POSTING = {
  source: "JSEARCH",
  externalId: "kept",
  title: "Kept",
  company: "",
  place: "",
  remote: null,
  salary: "",
  postedAt: null,
  url: "",
  via: "",
  description: "",
  complete: false,
};

describe("showMoreFor", () => {
  it("adds the next page to the kept search, once each, from the search's own source", async () => {
    await useJSearch();
    stubFetch(() => json(jsearchV2Page));
    const run = await runSearch(query);
    const id = run.ok ? run.id : "";
    // The user switched sources meanwhile: the search goes on with its own.
    await saveSettings({ jobSource: "ARBEITSAGENTUR" });

    const requests = stubFetch(() => json(jsearchV2LastPage));
    const more = await showMoreFor(id);
    expect(requests[0].url.searchParams.get("cursor")).toBe("CURSOR-PAGE-2");
    // UX Researcher was on the first page already.
    expect(more).toMatchObject({ ok: true, postings: [], next: null, filtering: { total: 2, eligible: 2 } });
    expect(await prisma().postingSearch.findUniqueOrThrow({ where: { id } })).toMatchObject({ found: 2, next: null });

    // The last page: nothing more to ask.
    expect(await showMoreFor(id)).toMatchObject({ ok: true, postings: [], next: null, filtering: { total: 2, eligible: 2 } });
    expect(requests).toHaveLength(1);
  });

  it("adds new postings with where they stand", async () => {
    await useJSearch();
    stubFetch(() => json(jsearchV2LastPage));
    const run = await runSearch({ ...query, keywords: "researcher" });
    const id = run.ok ? run.id : "";
    await prisma().postingSearch.update({ where: { id }, data: { next: "cursor:MORE" } });
    stubFetch(() => json(jsearchV2Page));
    const more = await showMoreFor(id);
    expect(more).toMatchObject({ ok: true, next: "cursor:CURSOR-PAGE-2", postings: [expect.objectContaining({ title: "Senior Product Designer, Payments", state: expect.objectContaining({ saved: false }) })] });
    expect((await prisma().postingSearch.findUniqueOrThrow({ where: { id } })).found).toBe(2);
  });

  it("says when the search is gone, or the source says no", async () => {
    expect(await showMoreFor("gone")).toMatchObject({ ok: false, message: "That search is no longer kept. Search again." });
    await useJSearch();
    stubFetch(() => json(jsearchV2Page));
    const run = await runSearch(query);
    stubFetch(() => json({}, { status: 429 }));
    expect(await showMoreFor(run.ok ? run.id : "")).toMatchObject({ ok: false, problem: "quota" });
  });
});

describe("listSearches and removeSearch", () => {
  it("lists kept searches newest first, grouped by the day they ran in the user's time zone", async () => {
    const at = (iso: string, keywords: string) =>
      prisma().postingSearch.create({ data: { source: "JSEARCH", query: { ...query, keywords }, postings: [], found: 3, createdAt: new Date(iso) } });
    await at("2026-10-03T09:30:00Z", "designer");
    await at("2026-10-02T22:30:00Z", "researcher"); // Already the 3rd in Berlin.
    await at("2026-10-02T10:00:00Z", "writer");
    await at("2026-09-28T08:00:00Z", "nurse");

    const days = await listSearches({ timeZone: "Europe/Berlin", now: new Date("2026-10-03T12:00:00Z") });
    expect(days.map((day) => [day.day, day.searches.map((search) => [search.time, search.query.keywords, search.found])])).toEqual([
      ["Today", [["11:30", "designer", 3], ["00:30", "researcher", 3]]],
      ["Yesterday", [["12:00", "writer", 3]]],
      ["Mon 28 Sep", [["10:00", "nurse", 3]]],
    ]);
    expect(await countSearches()).toBe(4);
  });

  it("removes a search, and leaves saved postings alone", async () => {
    const search = await prisma().postingSearch.create({ data: { source: "JSEARCH", query, postings: [EMPTY_POSTING] } });
    await savePosting({ ...EMPTY_POSTING, source: "JSEARCH" });
    await removeSearch(search.id);
    await removeSearch("gone");
    expect(await countSearches()).toBe(0);
    expect(await prisma().posting.count()).toBe(1);
  });
});

describe("fullText", () => {
  it("returns a complete posting's own text, and asks the posting's own source for the rest", async () => {
    await useJSearch();
    stubFetch(() => json(jsearchV2Page));
    const run = await runSearch(query);
    const { state, ...posting } = (await loadSearch(run.ok ? run.id : ""))!.postings[0];
    void state;
    expect(await fullText(posting)).toBe(posting.description);
    expect(await fullText({ ...posting, complete: false })).toBe(posting.description);
  });

  it("gives up quietly without the source's key", async () => {
    expect(await fullText({ ...EMPTY_POSTING, source: "JSEARCH", complete: false })).toBeNull();
  });
});

const englishBody = "We build fleet scheduling software for our customers. You will lead our internal IT operations.";
const germanBody = "Als Leiter IT übernehmen Sie die Verantwortung für unsere interne IT und führen ein Team von acht Mitarbeitenden. Sie entwickeln unsere IT-Strategie weiter, steuern externe Dienstleister und stellen den zuverlässigen Betrieb unserer Systeme sicher.";
const spanishBody = "Como responsable de tecnología, dirigirás nuestro equipo de sistemas y garantizarás el funcionamiento de los servicios internos. Buscamos una persona con experiencia en gestión de proyectos, seguridad informática y desarrollo de estrategias para nuestra empresa.";
const rawPosting = (externalId: string, description: string): FoundPosting => ({ ...EMPTY_POSTING, source: "JSEARCH", externalId, title: "Head of IT", company: "Fleet Software Ltd", description, complete: true });
const sourcePage = (entries: FoundPosting[], cursor: string | null = null) => ({ data: { jobs: entries.map((entry) => ({ job_id: entry.externalId, job_title: entry.title, employer_name: entry.company, job_description: entry.description })), cursor } });
const enablePolicy = () => saveSettings({ agentEnabled: false, agentExclusions: agentExclusionsSchema.parse({}) });

describe("manual-search eligibility", () => {
  it("stores all raw German/Spanish/English results but exposes only verified English postings", async () => {
    await useJSearch();
    await enablePolicy();
    stubFetch(() => json(sourcePage([rawPosting("de", germanBody), rawPosting("es", spanishBody), rawPosting("en", englishBody)])));
    const run = await runSearch(query);
    const loaded = await loadSearch(run.ok ? run.id : "");
    expect(loaded?.postings.map((posting) => posting.externalId)).toEqual(["en"]);
    expect(loaded?.postings[0]).not.toHaveProperty("eligibility");
    expect(loaded?.filtering).toMatchObject({ active: true, total: 3, eligible: 1, excluded: 2, unchecked: 0, reasons: [{ reason: "The job description is not entirely in English.", count: 2 }] });
    const stored = await prisma().postingSearch.findUniqueOrThrow({ where: { id: loaded!.id } });
    expect(stored.found).toBe(3);
    expect(stored.postings).toEqual(expect.arrayContaining([expect.objectContaining({ externalId: "de", description: germanBody, eligibility: expect.any(Object) })]));
    // Both non-English descriptions were rejected before any provider request.
    expect(provider.load).toHaveBeenCalledTimes(1);
  });

  it("loads accepted cache with zero source/detail/page/provider calls, and hides it after policy changes", async () => {
    await useJSearch();
    await enablePolicy();
    stubFetch(() => json(sourcePage([rawPosting("en", englishBody)])));
    const run = await runSearch(query);
    const requests = stubFetch(() => { throw new Error("GET must not call a source"); });
    const details = vi.spyOn(source, "fullText");
    const page = vi.spyOn(postingFetch, "fetchPosting").mockRejectedValue(new Error("GET must not fetch a page"));
    provider.load.mockClear();
    expect((await loadSearch(run.ok ? run.id : ""))?.filtering).toMatchObject({ eligible: 1, unchecked: 0 });
    await saveSettings({ agentExclusions: { ...agentExclusionsSchema.parse({}), companies: ["Fleet Software"] } });
    expect(await loadSearch(run.ok ? run.id : "")).toMatchObject({ query, postings: [], filtering: { eligible: 0, excluded: 0, unchecked: 1 } });
    expect(requests).toHaveLength(0);
    expect(details).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    expect(provider.load).not.toHaveBeenCalled();
  });

  it("hides legacy records and explicitly rechecks their raw postings without searching or deleting history", async () => {
    await enablePolicy();
    const raw = [rawPosting("en", englishBody), rawPosting("de", germanBody)];
    const kept = await prisma().postingSearch.create({ data: { source: "JSEARCH", query, postings: raw, found: 2, next: "cursor:KEEP", createdAt: new Date("2026-10-01T10:00:00Z") } });
    const requests = stubFetch(() => { throw new Error("No new search"); });
    expect(await loadSearch(kept.id)).toMatchObject({ query, postings: [], filtering: { total: 2, unchecked: 2 } });
    expect(provider.load).not.toHaveBeenCalled();
    expect(await recheckSearch(kept.id)).toMatchObject({ ok: true, postings: [expect.objectContaining({ externalId: "en" })], next: "cursor:KEEP", filtering: { total: 2, eligible: 1, excluded: 1, unchecked: 0 } });
    expect(await prisma().postingSearch.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ found: 2, createdAt: kept.createdAt, next: "cursor:KEEP" });
    expect(await countSearches()).toBe(1);
    expect(requests).toHaveLength(0);
    expect(await recheckSearch("gone")).toMatchObject({ ok: false, problem: "changed" });
  });

  it("keeps the cursor on an entirely excluded page and checks only newly deduplicated next-page results", async () => {
    await useJSearch();
    await enablePolicy();
    const german = rawPosting("de", germanBody);
    const english = rawPosting("en", englishBody);
    const requests = stubFetch(({ url }) => json(url.searchParams.has("cursor") ? sourcePage([german, english, english], "LATER") : sourcePage([german], "MORE")));
    const run = await runSearch(query);
    const id = run.ok ? run.id : "";
    expect(await loadSearch(id)).toMatchObject({ postings: [], next: "cursor:MORE", filtering: { total: 1, excluded: 1 } });
    expect(requests).toHaveLength(1);
    expect(await showMoreFor(id)).toMatchObject({ ok: true, next: "cursor:LATER", postings: [expect.objectContaining({ externalId: "en" })], filtering: { total: 2, eligible: 1, excluded: 1 } });
    expect(requests).toHaveLength(2);
    expect(provider.load).toHaveBeenCalledTimes(1);
    expect((await prisma().postingSearch.findUniqueOrThrow({ where: { id } })).found).toBe(2);
  });

  it("keeps failed/uncertain checks hidden and lets explicit recheck recover without another search", async () => {
    await useJSearch();
    await enablePolicy();
    provider.current = new MockProvider({ reply: () => { throw new Error("private provider URL/token"); } });
    const requests = stubFetch(() => json(sourcePage([rawPosting("en", englishBody)])));
    const run = await runSearch(query);
    const id = run.ok ? run.id : "";
    expect(await loadSearch(id)).toMatchObject({ postings: [], filtering: { excluded: 0, unchecked: 1, reasons: [{ reason: "The exclusions could not be verified; the posting needs a manual review.", count: 1 }] } });
    provider.current = new MockProvider({ reply: () => ({ contentComplete: true, postingLanguage: "english", postingLanguageEvidence: englishBody, languageRequirementsCertain: true, languageRequirements: [], employerIsConsultancy: "no", consultancyEvidence: "We build fleet scheduling software for our customers." }) });
    expect(await recheckSearch(id)).toMatchObject({ ok: true, filtering: { eligible: 1, unchecked: 0 } });
    expect(requests).toHaveLength(1);
  });
});
