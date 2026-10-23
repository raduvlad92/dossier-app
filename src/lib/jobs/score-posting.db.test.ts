import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoundPosting } from "@/lib/job-search/search";
import { postingStates } from "@/lib/postings";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { MockProvider } from "../ai/providers/mock";

import { scoreJobKey, scorePostingJob } from "./score-posting";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
vi.mock("@/lib/profile-data", async () => {
  const { demoProfile } = await import("@/lib/demo-profile");
  return { loadProfile: async () => demoProfile() };
});
const fake = vi.hoisted(() => ({ fullText: null as string | null, sent: [] as string[] }));
vi.mock("@/lib/job-search/find", () => ({ fullText: vi.fn(async () => fake.fullText) }));
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getAiProvider: async () =>
    new MockProvider({
      reply: (call) => {
        fake.sent.push(call.messages[0].content);
        return { score: 78, reasons: ["Built a design system at Northwind."], redFlags: ["Dutch is required."] };
      },
    }),
}));

const prisma = () => db.client!;
const posting: FoundPosting = {
  source: "ADZUNA",
  externalId: "az-1",
  title: "Product Designer",
  company: "Harbour Freight",
  place: "Rotterdam",
  remote: false,
  salary: "",
  postedAt: null,
  url: "https://jobs.example/az-1",
  via: "",
  description: "The start…",
  complete: false,
};
const context = () => {
  const steps: string[] = [];
  return { id: "score-job", steps, step: async (name: string) => void steps.push(name), signal: new AbortController().signal };
};

beforeEach(async () => {
  await resetDatabase(prisma());
  await saveSettings({ agentExclusions: { englishOnly: false, allowedLanguages: [], excludeConsultancies: false, companies: [] } });
  Object.assign(fake, { fullText: null, sent: [] });
});
afterAll(() => prisma().$disconnect());

describe("Score in Find jobs (#208)", () => {
  it("gets the whole posting for a snippet, scores it and keeps the score with it", async () => {
    fake.fullText = "The whole posting: design our freight tools.";
    const run = context();
    expect(await scorePostingJob.run({ posting }, run)).toEqual({ score: 78, reasons: ["Built a design system at Northwind."], redFlags: ["Dutch is required."] });
    expect(run.steps).toEqual(["Checking your posting rules", "Getting the whole posting", "Scoring it against your profile"]);
    expect(fake.sent[0]).toContain("The whole posting: design our freight tools.");

    expect(await prisma().postingScore.findUniqueOrThrow({ where: { source_externalId: { source: "ADZUNA", externalId: "az-1" } } })).toMatchObject({ score: 78, scoredWith: "score-posting@1" });
    expect((await postingStates([posting])).get("ADZUNA:az-1")?.score).toEqual({ score: 78, reasons: ["Built a design system at Northwind."], redFlags: ["Dutch is required."] });
  });

  it("scores the start when the rest can't be had, and replaces an older score", async () => {
    await prisma().postingScore.create({ data: { source: "ADZUNA", externalId: "az-1", score: 20, reasons: [], redFlags: [], scoredWith: "score-posting@1" } });
    const run = context();
    await scorePostingJob.run({ posting }, run);
    expect(fake.sent[0]).toContain("The start…");
    expect(await prisma().postingScore.count()).toBe(1);
    expect((await prisma().postingScore.findFirstOrThrow()).score).toBe(78);
    // A whole posting goes straight to scoring.
    const whole = context();
    await scorePostingJob.run({ posting: { ...posting, complete: true } }, whole);
    expect(whole.steps).toEqual(["Checking your posting rules", "Scoring it against your profile"]);
  });

  it("keys a posting's scoring, so a second click follows the first", () => {
    expect(scoreJobKey(posting)).toBe("posting-score:ADZUNA:az-1");
  });

  it("rejects an old queued German posting before sending the profile to the scoring provider", async () => {
    await saveSettings({ agentExclusions: { englishOnly: true, allowedLanguages: [], excludeConsultancies: false, companies: [] } });
    const german = { ...posting, complete: true, description: "Wir entwickeln sichere Software für Unternehmen. Sie übernehmen die Leitung unserer internen IT und sorgen für einen zuverlässigen Betrieb aller Systeme. Ihre Aufgaben umfassen die Planung der Infrastruktur, die Betreuung unserer Mitarbeitenden und die Zusammenarbeit mit unseren Entwicklungsteams. Wir bieten flexible Arbeitszeiten und langfristige Entwicklungsmöglichkeiten." };
    await expect(scorePostingJob.run({ posting: german }, context())).rejects.toThrow(/English/);
    expect(fake.sent).toEqual([]);
    expect(await prisma().postingScore.count()).toBe(0);
  });

  it("does not publish a score when English-only is enabled while a previously unrestricted job is running", async () => {
    const german = { ...posting, complete: true, description: "Unser Unternehmen entwickelt sichere Software für Geschäftskunden. Sie leiten die interne IT-Abteilung und verantworten die technische Infrastruktur. Dabei arbeiten Sie eng mit unseren Entwicklungsteams zusammen, betreuen unsere Mitarbeitenden und verbessern die internen Abläufe. Wir bieten Ihnen flexible Arbeitszeiten, ein festes Gehalt und langfristige Entwicklungsmöglichkeiten." };
    const run = context();
    const step = async (name: string) => {
      await run.step(name);
      if (name === "Scoring it against your profile") {
        await saveSettings({ agentExclusions: { englishOnly: true, allowedLanguages: [], excludeConsultancies: false, companies: [] } });
      }
    };
    await expect(scorePostingJob.run({ posting: german }, { ...run, step })).rejects.toThrow(/English/);
    expect(fake.sent).toHaveLength(1);
    expect(await prisma().postingScore.count()).toBe(0);
  });
});
