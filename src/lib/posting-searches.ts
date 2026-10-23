import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { daysBetween, formatDay, formatTime } from "@/lib/dates";
import { assessPostings, currentPostingRules, storedPostings, visiblePostings } from "@/lib/job-search/eligibility";
import { askSource } from "@/lib/job-search/find";
import {
  EMPTY_QUERY,
  postingKey,
  searchQuerySchema,
  type FoundPosting,
  type PastSearchDay,
  type PostingFiltering,
  type SearchProblem,
  type SearchQuery,
  type ShownPosting,
  type StoredSearch,
} from "@/lib/job-search/search";
import { postingStates } from "@/lib/postings";
import { prisma } from "@/lib/prisma";

// Searches kept with what they found (E14-10), until the user removes them,
// so going back to one costs no searches from the source's plan.

const queryOf = (value: Prisma.JsonValue): SearchQuery => searchQuerySchema.catch(EMPTY_QUERY).parse(value);

/** Postings with where each stands for the user now. */
async function withStates(postings: FoundPosting[]): Promise<ShownPosting[]> {
  const states = await postingStates(postings);
  return postings.map((posting) => ({ ...posting, state: states.get(postingKey(posting))! }));
}

/** "today at 14:32", "yesterday at 09:05" or "on Thu 1 Oct at 18:20". */
function ranAtLabel(date: Date, timeZone?: string, now = new Date()): string {
  const days = daysBetween(date, now, timeZone);
  const day = days === 0 ? "today" : days === 1 ? "yesterday" : `on ${formatDay(date, timeZone, now)}`;
  return `${day} at ${formatTime(date, timeZone)}`;
}

/** Runs a search on the chosen source and keeps it with its first page. */
export async function runSearch(query: SearchQuery): Promise<{ ok: true; id: string } | SearchProblem> {
  const answer = await askSource(query);
  if (!answer.ok) return answer;
  // Raw source caching happens below askSource. Eligibility always uses the
  // current global rules, independently of the recurring agent's enabled flag.
  const postings = await assessPostings(answer.postings, await currentPostingRules());
  const search = await prisma.postingSearch.create({
    data: { source: answer.source, query, postings, found: postings.length, next: answer.next },
    select: { id: true },
  });
  return { ok: true, id: search.id };
}

/** A kept search, the latest one without an id; null when there's none. */
export async function loadSearch(id?: string, { timeZone, now = new Date() }: { timeZone?: string; now?: Date } = {}): Promise<StoredSearch | null> {
  const search = id
    ? await prisma.postingSearch.findUnique({ where: { id } })
    : await prisma.postingSearch.findFirst({ orderBy: { createdAt: "desc" } });
  if (!search) return null;
  // GET never enriches or checks a posting. Legacy, changed or expired evidence
  // stays in history and can only be refreshed by the explicit recheck action.
  const visible = visiblePostings(storedPostings(search.postings), await currentPostingRules());
  return {
    id: search.id,
    source: search.source,
    query: queryOf(search.query),
    ranAt: ranAtLabel(search.createdAt, timeZone, now),
    postings: await withStates(visible.postings),
    next: search.next,
    filtering: visible.filtering,
  };
}

/** "Show more": the next page from the search's own source, added to the kept search. */
export async function showMoreFor(id: string): Promise<{ ok: true; postings: ShownPosting[]; next: string | null; filtering?: PostingFiltering } | SearchProblem> {
  const search = await prisma.postingSearch.findUnique({ where: { id } });
  if (!search) return { ok: false, problem: "changed", message: "That search is no longer kept. Search again." };
  const rules = await currentPostingRules();
  if (!search.next) return { ok: true, postings: [], next: null, filtering: visiblePostings(storedPostings(search.postings), rules).filtering };
  const answer = await askSource(queryOf(search.query), { source: search.source, next: search.next });
  if (!answer.ok) return answer;
  const seen = new Set(storedPostings(search.postings).map(postingKey));
  const added = answer.postings.filter((posting) => {
    if (seen.has(postingKey(posting))) return false;
    seen.add(postingKey(posting));
    return true;
  });
  const checked = await assessPostings(added, rules);
  // A recheck or another Show more may have changed this whole JSON column.
  // Merge against the latest snapshot and compare before replacing it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await prisma.postingSearch.findUnique({ where: { id } });
    if (!latest) return { ok: false, problem: "changed", message: "That search is no longer kept. Search again." };
    const kept = storedPostings(latest.postings);
    if (latest.next !== search.next) return { ok: true, postings: [], next: latest.next, filtering: visiblePostings(kept, rules).filtering };
    const keys = new Set(kept.map(postingKey));
    const appended = checked.filter((posting) => !keys.has(postingKey(posting)));
    const postings = [...kept, ...appended];
    const updated = await prisma.postingSearch.updateMany({
      where: { id, next: search.next, postings: { equals: latest.postings as Prisma.InputJsonValue } },
      data: { postings, found: postings.length, next: answer.next },
    });
    if (updated.count) return {
      ok: true,
      postings: await withStates(visiblePostings(appended, rules).postings),
      next: answer.next,
      filtering: visiblePostings(postings, rules).filtering,
    };
  }
  return { ok: false, problem: "changed", message: "That search changed while loading more. Open it again." };
}

/** Explicitly recheck retained raw postings; never sends another source search. */
export async function recheckSearch(id: string): Promise<{ ok: true; postings: ShownPosting[]; next: string | null; filtering: PostingFiltering } | SearchProblem> {
  const search = await prisma.postingSearch.findUnique({ where: { id } });
  if (!search) return { ok: false, problem: "changed", message: "That search is no longer kept. Search again." };
  const rules = await currentPostingRules();
  const postings = await assessPostings(storedPostings(search.postings), rules);
  const updated = await prisma.postingSearch.updateMany({
    where: { id, postings: { equals: search.postings as Prisma.InputJsonValue } },
    data: { postings },
  });
  if (!updated.count) return { ok: false, problem: "changed", message: "That search changed while checking. Open it and check again." };
  const visible = visiblePostings(postings, rules);
  return { ok: true, postings: await withStates(visible.postings), next: search.next, filtering: visible.filtering };
}

/** Every kept search, newest first, grouped by the day it ran in the user's time zone. */
export async function listSearches({ timeZone, now = new Date() }: { timeZone?: string; now?: Date } = {}): Promise<PastSearchDay[]> {
  const searches = await prisma.postingSearch.findMany({
    select: { id: true, source: true, query: true, found: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const days: PastSearchDay[] = [];
  for (const search of searches) {
    const ago = daysBetween(search.createdAt, now, timeZone);
    const day = ago === 0 ? "Today" : ago === 1 ? "Yesterday" : formatDay(search.createdAt, timeZone, now);
    if (days.at(-1)?.day !== day) days.push({ day, searches: [] });
    days.at(-1)!.searches.push({ id: search.id, source: search.source, query: queryOf(search.query), found: search.found, time: formatTime(search.createdAt, timeZone) });
  }
  return days;
}

export const countSearches = () => prisma.postingSearch.count();

export async function removeSearch(id: string): Promise<void> {
  await prisma.postingSearch.deleteMany({ where: { id } });
}
