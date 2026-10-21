import { defaultSearch, type SearchQuery } from "@/lib/job-search/search";

type SearchDefaults = {
  latestSearch: () => Promise<SearchQuery | null>;
  profileLocation: () => Promise<{ city: string; country: string }>;
};

/** Null means unsaved; even a saved blank query is an explicit choice to preserve. */
export async function loadAgentSearchDefaults(query: SearchQuery | null, fallback: SearchDefaults): Promise<SearchQuery> {
  if (query) return { ...query };
  const latest = await fallback.latestSearch();
  if (latest) return { ...latest };
  return defaultSearch({ role: "", ...await fallback.profileLocation() });
}
