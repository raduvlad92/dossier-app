import { describe, expect, it, vi } from "vitest";

import { EMPTY_QUERY, type SearchQuery } from "@/lib/job-search/search";

import { loadAgentSearchDefaults } from "./search-defaults";

const saved: SearchQuery = { keywords: "", place: "Berlin", country: "de", radiusKm: 50, remoteOnly: true, postedWithin: "week" };
const latest: SearchQuery = { keywords: "IT Manager", place: "Milano", country: "it", radiusKm: 100, remoteOnly: false, postedWithin: "3days" };
const fallbacks = (history: SearchQuery | null = latest) => ({
  latestSearch: vi.fn(async () => history),
  profileLocation: vi.fn(async () => ({ city: "Hamburg", country: "Deutschland" })),
});

describe("job-agent search defaults", () => {
  it("preserves saved location, remote, radius and recency preferences when the role is blank", async () => {
    const fallback = fallbacks();
    expect(await loadAgentSearchDefaults(saved, fallback)).toEqual(saved);
    expect(fallback.latestSearch).not.toHaveBeenCalled();
    expect(fallback.profileLocation).not.toHaveBeenCalled();
  });

  it.each([
    { keywords: "Head of IT" },
    { place: "Rome" },
    { country: "it" },
    { remoteOnly: true },
    { radiusKm: 100 as const },
    { postedWithin: "day" as const },
  ])("preserves independently saved criteria: %o", async (criterion) => {
    const query = { ...EMPTY_QUERY, ...criterion };
    expect(await loadAgentSearchDefaults(query, fallbacks())).toEqual(query);
  });

  it("preserves an intentionally saved all-default query instead of restoring old location or remote preferences", async () => {
    const fallback = fallbacks({ ...latest, remoteOnly: true });
    expect(await loadAgentSearchDefaults({ ...EMPTY_QUERY }, fallback)).toEqual(EMPTY_QUERY);
    expect(fallback.latestSearch).not.toHaveBeenCalled();
    expect(fallback.profileLocation).not.toHaveBeenCalled();
  });

  it("uses the latest Find jobs search intact before consulting the profile", async () => {
    const fallback = fallbacks();
    const query = await loadAgentSearchDefaults(null, fallback);
    expect(query).toEqual(latest);
    expect(fallback.latestSearch).toHaveBeenCalledTimes(1);
    expect(fallback.profileLocation).not.toHaveBeenCalled();
    query.place = "Changed in the agent editor";
    expect(latest.place).toBe("Milano");
  });

  it("does not fill or reset a kept search even when it has blank keywords or default filters", async () => {
    const history = { ...EMPTY_QUERY };
    const fallback = fallbacks(history);
    expect(await loadAgentSearchDefaults(null, fallback)).toEqual(history);
    expect(fallback.profileLocation).not.toHaveBeenCalled();
  });

  it("falls back to the profile's city and normalized country only without saved criteria or history", async () => {
    const fallback = fallbacks(null);
    expect(await loadAgentSearchDefaults(null, fallback)).toEqual({ ...EMPTY_QUERY, place: "Hamburg", country: "de" });
    expect(fallback.profileLocation).toHaveBeenCalledTimes(1);
  });

  it("leaves an unknown profile country for the user to choose and bounds long profile city names", async () => {
    const fallback = fallbacks(null);
    fallback.profileLocation.mockResolvedValue({ city: ` ${"x".repeat(250)} `, country: "Unknown place" });
    expect(await loadAgentSearchDefaults(null, fallback)).toEqual({ ...EMPTY_QUERY, place: "x".repeat(200) });
  });
});
