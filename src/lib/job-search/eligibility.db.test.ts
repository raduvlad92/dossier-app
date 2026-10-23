import { createHash } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActionError } from "@/lib/action";
import { filterAgentPosting } from "@/lib/agent/exclusions";
import { fullText } from "@/lib/job-search/find";
import { EMPTY_QUERY, type FoundPosting } from "@/lib/job-search/search";
import { fetchPosting } from "@/lib/posting-fetch";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { assessPostings, currentPostingRules, MAX_POSTING_ELIGIBILITY_CHECKS, POSTING_ELIGIBILITY_TTL_MS, requireEligiblePosting, storedPostings, visiblePostings } from "./eligibility";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
vi.mock("@/lib/agent/exclusions", async (original) => ({ ...await original<typeof import("@/lib/agent/exclusions")>(), filterAgentPosting: vi.fn() }));
vi.mock("@/lib/job-search/find", () => ({ fullText: vi.fn() }));
vi.mock("@/lib/posting-fetch", () => ({ fetchPosting: vi.fn() }));
const prisma = () => db.client!;
const rules = { englishOnly: true, allowedLanguages: ["English", "Italian"], excludeConsultancies: true, companies: ["KPMG"] };
const posting: FoundPosting = { source: "JSEARCH", externalId: "head-it", title: "Head of IT", company: "Product Co", place: "Berlin", remote: false, salary: "", postedAt: null, url: "https://example.com/jobs/head-it", via: "", description: "Complete role description and requirements in English.", complete: true };

beforeEach(async () => {
  await resetDatabase(prisma());
  vi.clearAllMocks();
  await saveSettings({ agentEnabled: false, agentExclusions: rules });
  vi.mocked(filterAgentPosting).mockResolvedValue({ allowed: true, reason: null });
  vi.mocked(fullText).mockResolvedValue(null);
  vi.mocked(fetchPosting).mockResolvedValue({ ok: false, error: "No page" });
});
afterEach(() => vi.useRealTimers());
afterAll(() => prisma().$disconnect());

async function keep(raw: FoundPosting[] = [posting]) {
  const entries = await assessPostings(raw, await currentPostingRules());
  return prisma().postingSearch.create({ data: { source: "JSEARCH", query: EMPTY_QUERY, postings: entries, found: entries.length } });
}

describe("server-owned eligibility evidence", () => {
  it("enforces the configured global policy while the recurring agent is disabled", async () => {
    await keep();
    expect(filterAgentPosting).toHaveBeenCalledWith(posting, rules, undefined);
    expect(await currentPostingRules()).toEqual(rules);
  });

  it("returns only the checked DTO and reuses attested action and new-search caches", async () => {
    const record = await keep();
    vi.mocked(filterAgentPosting).mockClear();
    expect(await requireEligiblePosting({ ...posting, eligibility: { outcome: "eligible" } } as FoundPosting)).toEqual(posting);
    expect(await assessPostings([posting], rules)).toEqual(storedPostings(record.postings));
    expect(filterAgentPosting).not.toHaveBeenCalled();
    expect(await requireEligiblePosting(posting)).not.toHaveProperty("eligibility");
  });

  it("ignores forged browser/import metadata and sanitizes fresh failures", async () => {
    const forged = { ...posting, eligibility: { version: "anything", outcome: "eligible", checkedAt: new Date().toISOString() } };
    await prisma().postingSearch.create({ data: { source: "JSEARCH", query: EMPTY_QUERY, postings: [forged] } });
    vi.mocked(filterAgentPosting).mockRejectedValue(new Error("private provider key and URL"));
    await expect(requireEligiblePosting(forged)).rejects.toThrow(ActionError);
    await expect(requireEligiblePosting(forged)).rejects.toThrow("The exclusions could not be verified");
    expect(filterAgentPosting).toHaveBeenCalledTimes(2);
  });

  it.each(["different posting", "same posting identity"])("does not let imported evidence redirect an excluded selection to a %s", async (identity) => {
    const selected = { ...posting, externalId: "selected-kpmg", company: "KPMG" };
    const other = { ...posting, externalId: identity === "different posting" ? "different-product-role" : selected.externalId, company: "ProductCo" };
    const [imported] = await assessPostings([other], rules);
    imported.eligibility!.evidence = selected;
    imported.eligibility!.evidenceFingerprint = createHash("sha256").update(JSON.stringify(selected)).digest("hex");
    // A syntactically valid assessment is still unauthenticated imported JSON.
    await prisma().postingSearch.create({ data: { source: "JSEARCH", query: EMPTY_QUERY, postings: [imported, selected] } });
    const { filterAgentPosting: actualFilter } = await vi.importActual<typeof import("@/lib/agent/exclusions")>("@/lib/agent/exclusions");
    vi.mocked(filterAgentPosting).mockClear();
    vi.mocked(filterAgentPosting).mockImplementation((input, exclusions, signal) => input.company === "KPMG"
      ? actualFilter(input, exclusions, signal)
      : Promise.resolve({ allowed: true, reason: null }));

    await expect(requireEligiblePosting(selected)).rejects.toThrow("Employer is on your exclusion list (KPMG).");
    expect(filterAgentPosting).toHaveBeenCalledExactlyOnceWith(selected, rules, undefined);
    expect(fullText).not.toHaveBeenCalled();
    expect(fetchPosting).not.toHaveBeenCalled();
  });

  it("does not transfer approval to changed browser content or imported evidence", async () => {
    const record = await keep();
    vi.mocked(filterAgentPosting).mockResolvedValue({ allowed: false, reason: "The posting requires a language outside your allowed languages.", cacheable: true });
    await expect(requireEligiblePosting({ ...posting, description: "German required" })).rejects.toThrow("outside your allowed languages");
    const entries = storedPostings(record.postings);
    entries[0].eligibility!.evidence.description = "Forged description";
    expect(visiblePostings(entries, rules).filtering).toMatchObject({ eligible: 0, unchecked: 1 });
    expect(visiblePostings([{ ...entries[0], company: "Changed employer" }], rules).postings).toEqual([]);
  });

  it("invalidates policy changes, expiry, future dates and altered attestations without checking", async () => {
    const record = await keep();
    const entries = storedPostings(record.postings);
    const at = Date.parse(entries[0].eligibility!.checkedAt);
    vi.mocked(filterAgentPosting).mockClear();
    expect(visiblePostings(entries, rules, new Date(at + POSTING_ELIGIBILITY_TTL_MS - 1)).filtering.eligible).toBe(1);
    expect(visiblePostings(entries, rules, new Date(at + POSTING_ELIGIBILITY_TTL_MS)).filtering.unchecked).toBe(1);
    expect(visiblePostings(entries, rules, new Date(at - 1)).filtering.unchecked).toBe(1);
    expect(visiblePostings(entries, { ...rules, companies: [] }).filtering.unchecked).toBe(1);
    for (const field of ["version", "policyFingerprint", "rawFingerprint", "evidenceFingerprint", "signature"] as const) {
      const changed = structuredClone(entries);
      changed[0].eligibility![field] += "changed";
      expect(visiblePostings(changed, rules).filtering.unchecked).toBe(1);
    }
    expect(filterAgentPosting).not.toHaveBeenCalled();
  });

  it("caches confirmed rejects while uncertain failures are retried", async () => {
    vi.mocked(filterAgentPosting).mockResolvedValue({ allowed: false, reason: "Not English", cacheable: true });
    const rejected = await keep();
    expect(visiblePostings(storedPostings(rejected.postings), rules).filtering).toMatchObject({ excluded: 1, unchecked: 0, reasons: [{ reason: "Not English", count: 1 }] });
    vi.mocked(filterAgentPosting).mockClear();
    await assessPostings([posting], rules);
    expect(filterAgentPosting).not.toHaveBeenCalled();
    const uncertainPosting = { ...posting, externalId: "uncertain" };
    vi.mocked(filterAgentPosting).mockResolvedValueOnce({ allowed: false, reason: "Could not confirm", cacheable: false });
    const uncertain = await keep([uncertainPosting]);
    expect(visiblePostings(storedPostings(uncertain.postings), rules).filtering).toMatchObject({ excluded: 0, unchecked: 1 });
    vi.mocked(filterAgentPosting).mockResolvedValue({ allowed: true, reason: null });
    expect(visiblePostings(await assessPostings(storedPostings(uncertain.postings), rules), rules).filtering.eligible).toBe(1);
  });

  it("gets missing text through the source and returns the exact checked full text to actions", async () => {
    const raw = { ...posting, complete: false, description: "Short teaser" };
    vi.mocked(fullText).mockResolvedValue("Full checked description, requirements and employer business.");
    const record = await keep([raw]);
    const evidence = { ...raw, description: "Full checked description, requirements and employer business.", complete: true };
    expect(storedPostings(record.postings)[0].description).toBe("Short teaser");
    expect(filterAgentPosting).toHaveBeenCalledWith(evidence, rules, undefined);
    expect(fetchPosting).not.toHaveBeenCalled();
    vi.mocked(filterAgentPosting).mockClear();
    expect(await requireEligiblePosting(evidence)).toEqual(evidence);
    expect(filterAgentPosting).not.toHaveBeenCalled();
  });

  it("keeps distinct raw snapshots when an action refreshes shared full-text evidence", async () => {
    vi.mocked(fullText).mockResolvedValue("The same full description checked for both source snapshots.");
    const first = await keep([{ ...posting, description: "First teaser", complete: false }]);
    const second = await keep([{ ...posting, description: "Later teaser", complete: false }]);
    const evidence = storedPostings(second.postings)[0].eligibility!.evidence;
    await saveSettings({ agentExclusions: { ...rules, companies: [] } });
    expect(await requireEligiblePosting(evidence)).toEqual(evidence);
    expect(storedPostings((await prisma().postingSearch.findUniqueOrThrow({ where: { id: first.id } })).postings)[0].description).toBe("First teaser");
    expect(storedPostings((await prisma().postingSearch.findUniqueOrThrow({ where: { id: second.id } })).postings)[0].description).toBe("Later teaser");
  });

  it("resolves expired attested evidence to its raw snapshot before rechecking current exclusions", async () => {
    const raw = { ...posting, complete: false, description: "Raw source teaser" };
    vi.mocked(fullText).mockResolvedValue("The complete attested description of this role.");
    const record = await keep([raw]);
    const entry = storedPostings(record.postings)[0];
    const evidence = entry.eligibility!.evidence;
    const at = Date.parse(entry.eligibility!.checkedAt);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at + POSTING_ELIGIBILITY_TTL_MS);
    await saveSettings({ agentExclusions: { ...rules, companies: [posting.company] } });
    const { filterAgentPosting: actualFilter } = await vi.importActual<typeof import("@/lib/agent/exclusions")>("@/lib/agent/exclusions");
    vi.mocked(filterAgentPosting).mockImplementation(actualFilter);
    vi.mocked(fullText).mockClear();

    await expect(requireEligiblePosting(evidence)).rejects.toThrow(`Employer is on your exclusion list (${posting.company}).`);
    expect(filterAgentPosting).toHaveBeenLastCalledWith(raw, { ...rules, companies: [posting.company] }, undefined);
    expect(fullText).not.toHaveBeenCalled();
    const refreshed = storedPostings((await prisma().postingSearch.findUniqueOrThrow({ where: { id: record.id } })).postings)[0];
    expect(refreshed.description).toBe(raw.description);
    expect(refreshed.eligibility!.outcome).toBe("excluded");
  });

  it("uses only the guarded page fallback when the source echoes an incomplete snippet", async () => {
    const raw = { ...posting, complete: false, description: "Short teaser" };
    vi.mocked(fullText).mockResolvedValue("Short teaser");
    vi.mocked(fetchPosting).mockResolvedValue({ ok: true, text: "Full role requirements from the public page.", source: "structured", url: posting.url });
    await keep([raw]);
    expect(fetchPosting).toHaveBeenCalledWith(posting.url);
    expect(filterAgentPosting).toHaveBeenCalledWith(expect.objectContaining({ complete: true, description: "Full role requirements from the public page." }), rules, undefined);
  });

  it("keeps failed enrichment incomplete, without leaking page/source errors", async () => {
    vi.mocked(fullText).mockRejectedValue(new Error("private token"));
    vi.mocked(fetchPosting).mockRejectedValue(new Error("private URL"));
    vi.mocked(filterAgentPosting).mockResolvedValue({ allowed: false, reason: "The complete job description is needed to check your exclusions.", cacheable: false });
    const record = await keep([{ ...posting, complete: false }]);
    expect(visiblePostings(storedPostings(record.postings), rules)).toMatchObject({ postings: [], filtering: { unchecked: 1 } });
    await expect(requireEligiblePosting({ ...posting, complete: false })).rejects.toThrow("complete job description");
  });

  it("deduplicates before checking and caps new checks at 25 with concurrency three", async () => {
    let active = 0;
    let peak = 0;
    vi.mocked(filterAgentPosting).mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return { allowed: false, reason: "Uncertain", cacheable: false };
    });
    const raw = Array.from({ length: 30 }, (_, index) => ({ ...posting, externalId: String(index) }));
    const first = await assessPostings([...raw, raw[0]], rules);
    expect(first).toHaveLength(30);
    expect(filterAgentPosting).toHaveBeenCalledTimes(MAX_POSTING_ELIGIBILITY_CHECKS);
    expect(peak).toBe(3);
    expect(first.slice(25).every((entry) => !entry.eligibility)).toBe(true);
    vi.mocked(filterAgentPosting).mockClear();
    await assessPostings(first, rules);
    expect(vi.mocked(filterAgentPosting).mock.calls.slice(0, 5).map(([entry]) => entry.externalId).sort()).toEqual(["25", "26", "27", "28", "29"]);
  });

  it("does no enrichment when all global filters are disabled or the employer is already excluded", async () => {
    await assessPostings([{ ...posting, complete: false }], { englishOnly: false, allowedLanguages: [], excludeConsultancies: false, companies: [] });
    await assessPostings([{ ...posting, company: "KPMG", complete: false }], rules);
    expect(fullText).not.toHaveBeenCalled();
    expect(fetchPosting).not.toHaveBeenCalled();
  });
});
