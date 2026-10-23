import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "@/lib/settings-data";

import { JobsScreen, type JobsScreenProps } from "./jobs-screen";
import JobsPage from "./page";

vi.mock("./jobs-screen", () => ({ JobsScreen: vi.fn(({ filterRules }: JobsScreenProps) => <p>{filterRules?.join(" · ")}</p>) }));
vi.mock("@/lib/job-search/config", () => ({ loadJobSearchConfig: vi.fn(async () => ({ source: "JSEARCH" })) }));
vi.mock("@/lib/settings-data", () => ({ loadSettings: vi.fn(async () => ({
  agentEnabled: false,
  apiKeyEnc: "private-ai-credential",
  jsearchKeyEnc: "private-source-credential",
  agentExclusions: { englishOnly: true, allowedLanguages: ["English", "Italian"], excludeConsultancies: true, companies: ["KPMG", "Deloitte"] },
})) }));
vi.mock("@/lib/time-zone", () => ({ userTimeZone: vi.fn(async () => "Europe/Berlin") }));
vi.mock("@/lib/postings", () => ({ countPostings: vi.fn(async () => ({ saved: 0, dismissed: 0 })), listPostings: vi.fn() }));
vi.mock("@/lib/posting-searches", () => ({
  countSearches: vi.fn(async () => 1),
  listSearches: vi.fn(),
  loadSearch: vi.fn(async () => ({
    id: "run-1", source: "JSEARCH", ranAt: "today", postings: [], next: null,
    query: { keywords: "Head of IT", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" },
  })),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { profileField: { findMany: vi.fn() }, experience: { findMany: vi.fn() } } }));

beforeEach(() => vi.clearAllMocks());

describe("Find jobs rule labels from server settings", () => {
  it("passes only display labels to the client, including when the schedule is off", async () => {
    render(await JobsPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ search: "run-1" }) }));
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText("English-only postings · Required languages limited to English or Italian · No consultancy groups · 2 excluded companies")).toBeInTheDocument();
    const props = vi.mocked(JobsScreen).mock.calls[0][0];
    expect(props).not.toHaveProperty("settings");
    expect(props).not.toHaveProperty("agentEnabled");
    expect(JSON.stringify(props)).not.toContain("private-ai-credential");
    expect(JSON.stringify(props)).not.toContain("private-source-credential");
    expect(props.filterRules).toHaveLength(4);
  });
});
