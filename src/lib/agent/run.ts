import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { getAiProvider } from "@/lib/ai";
import { isAiConfigured } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { scorePosting } from "@/lib/ai/tasks";
import { searchPostings } from "@/lib/job-search";
import { credentialsFor, loadJobSearchConfig, requestContext } from "@/lib/job-search/config";
import { JobSearchError } from "@/lib/job-search/errors";
import { postingKey, postingText, type FoundPosting, type SearchPage, type SearchQuery } from "@/lib/job-search/search";
import { startJob, type JobContext } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { saveScore } from "@/lib/posting-scores";
import { postingStates } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import type { SettingsData } from "@/lib/settings";
import { loadSettings, saveSettings } from "@/lib/settings-data";

import { agentDedupeKey, candidateData } from "./candidates";
import { agentDraftJob, draftJobKey } from "./draft";
import { loadAgentProfile } from "./cv";
import { excludedEmployer, filterAgentPosting } from "./exclusions";
import { enrichAgentPosting } from "./parsers";
import { recordRunEnd, recordRunStart, runLimitProblem } from "./runs";

// One run of the job agent (E16-3): one search, the postings seen before
// dropped, and a score for the newest of the rest. It never sends anything.
// Adapted from avinashbatchala's fork of Dossier.

export const agentScanResultSchema = z.object({
  /** Postings the source returned. */
  found: z.number().int().min(0),
  /** Of those, the ones not seen before. */
  fresh: z.number().int().min(0),
  scored: z.number().int().min(0),
  drafted: z.number().int().min(0),
  /** Found but seen before: saved, dismissed or applied for in Find jobs, or a candidate already. */
  skipped: z.number().int().min(0),
  /** Fresh postings rejected by exclusions before scoring. */
  excluded: z.number().int().min(0).default(0),
  /** Fresh postings left for another run because the inspection budget was used. */
  deferred: z.number().int().min(0).default(0),
  /** What to tell the user. */
  message: z.string(),
});
export type AgentScanResult = z.infer<typeof agentScanResultSchema>;

const stopped = (message: string): AgentScanResult => ({ found: 0, fresh: 0, scored: 0, drafted: 0, skipped: 0, excluded: 0, deferred: 0, message });

/** Whether a search is complete enough to run: keywords and a country. */
export const agentQueryReady = (query: SearchQuery) => Boolean(query.keywords.trim() && query.country);

/** Existing installs keep their single search until a list is configured. */
export const agentQueriesFor = (settings: Pick<SettingsData, "agentQueries" | "agentQuery">): SearchQuery[] =>
  settings.agentQueries.length > 0 ? settings.agentQueries : [settings.agentQuery];

/** Why the agent can't run at all, in words, or null when it's set up. */
export async function agentSetupProblem(query: SearchQuery | readonly SearchQuery[]): Promise<string | null> {
  const queries = Array.isArray(query) ? query : [query as SearchQuery];
  if (queries.length === 0 || queries.some((entry) => !entry.keywords.trim())) return "Add what to look for in Settings → Job agent first.";
  if (queries.some((entry) => !entry.country)) return "Choose a country for the search in Settings → Job agent first.";
  if (!(await isAiConfigured())) return "Choose an AI provider in Settings → AI provider first.";
  const config = await loadJobSearchConfig();
  if (!config.source) return "Choose a job source in Settings → Job search first.";
  try {
    credentialsFor(config, config.source);
  } catch (error) {
    if (error instanceof JobSearchError) return error.message;
    throw error;
  }
  try {
    await loadAgentProfile();
  } catch (error) {
    if (error instanceof ActionError) return error.message;
    throw error;
  }
  return null;
}

/** The postings from a page that are new to the agent: not saved, dismissed or applied for, and not a candidate already. */
export async function newPostings(postings: readonly FoundPosting[]): Promise<FoundPosting[]> {
  if (postings.length === 0) return [];
  const states = await postingStates(postings);
  const unseen = postings.filter((posting) => {
    const state = states.get(postingKey(posting));
    return !state?.saved && !state?.dismissed && !state?.applicationId;
  });
  const keys = unseen.map(agentDedupeKey);
  const known = await prisma.agentCandidate.findMany({
    where: { OR: [...unseen.map(({ source, externalId }) => ({ source, externalId })), { dedupeKey: { in: keys } }] },
    select: { source: true, externalId: true, dedupeKey: true },
  });
  const seen = new Set(known.flatMap((candidate) => [postingKey(candidate), candidate.dedupeKey]));
  // The same job twice in one page counts once too.
  return unseen.filter((posting, index) => {
    const fresh = !seen.has(postingKey(posting)) && !seen.has(keys[index]);
    seen.add(postingKey(posting));
    seen.add(keys[index]);
    return fresh;
  });
}

const newestFirst = (a: FoundPosting, b: FoundPosting) => (b.postedAt ? Date.parse(b.postedAt) : 0) - (a.postedAt ? Date.parse(a.postedAt) : 0);

const globalForScan = globalThis as unknown as { agentScanActive?: boolean };
const EXCLUSION_HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One bounded pass through all searches. The installation runs one instance. */
export async function runAgentScan({ manual }: { manual: boolean }, context: JobContext, now = new Date()): Promise<AgentScanResult> {
  if (globalForScan.agentScanActive) return stopped("A job agent scan is already running.");
  globalForScan.agentScanActive = true;
  try {
    return await scan({ manual }, context, now);
  } finally {
    globalForScan.agentScanActive = false;
  }
}

async function scan({ manual }: { manual: boolean }, context: JobContext, now: Date): Promise<AgentScanResult> {
  const settings = await loadSettings();
  if (!settings.agentEnabled && !manual) return stopped("The job agent is off.");
  const queries = agentQueriesFor(settings);
  const setup = await agentSetupProblem(queries);
  if (setup) return stopped(setup);
  const limit = runLimitProblem(settings.agentRuns, now, { manual: false });
  if (limit) return stopped(limit);

  const run = await recordRunStart(now, manual);
  const finish = async (result: AgentScanResult) => {
    await recordRunEnd(run, result.message);
    return result;
  };

  await context.step("Searching for new postings");
  const config = await loadJobSearchConfig();
  const source = config.source!;
  const postings: FoundPosting[] = [];
  const searchProblems: string[] = [];
  for (const query of queries) {
    let next: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < settings.agentMaxPages; page += 1) {
      if (context.signal.aborted) break;
      try {
        const result: SearchPage = await searchPostings(source, credentialsFor(config, source), query, next, requestContext(source));
        postings.push(...result.postings);
        if (!result.next || cursors.has(result.next)) break;
        cursors.add(result.next);
        next = result.next;
      } catch (error) {
        if (!context.signal.aborted) {
          const detail = error instanceof JobSearchError ? error.message : "The source could not complete this search. Try again.";
          searchProblems.push(`${query.keywords}: ${detail}`);
          if (!(error instanceof JobSearchError)) logServerError("job agent search", error);
        }
        break;
      }
    }
  }

  const fresh = await newPostings(postings);
  const counts = { found: postings.length, fresh: fresh.length, skipped: postings.length - fresh.length, drafted: 0, excluded: 0, deferred: 0 };
  const reasons = new Map<string, number>();
  const reject = (reason: string) => {
    counts.excluded += 1;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  };
  const summary = (message: string) => [
    message,
    counts.excluded ? `Excluded ${counts.excluded}: ${[...reasons].map(([reason, count]) => `${reason} (${count})`).join("; ")}` : "",
    counts.deferred ? `${counts.deferred} new ${counts.deferred === 1 ? "posting was" : "postings were"} left for a later run by your inspection limit.` : "",
    searchProblems.length ? `Some searches did not complete: ${searchProblems.join("; ")}` : "",
  ].filter(Boolean).join(" ");
  if (fresh.length === 0) return finish({ ...counts, scored: 0, message: summary(postings.length === 0 ? "The search found no postings this time." : "No new postings this time.") });

  const filtersFingerprint = fingerprint(settings.agentExclusions);
  const history = settings.agentExclusionHistory.filter((entry) => now.getTime() - Date.parse(entry.checkedAt) < EXCLUSION_HISTORY_MS);
  const cached = new Map(history.map((entry) => [`${entry.key}:${entry.fingerprint}`, entry]));
  const cacheFingerprint = (posting: FoundPosting) => fingerprint([filtersFingerprint, posting.title, posting.company, posting.description, posting.complete]);
  const eligible = fresh.filter((posting) => {
    const entry = cached.get(`${agentDedupeKey(posting)}:${cacheFingerprint(posting)}`);
    if (!entry) return true;
    reject(entry.reason);
    return false;
  });
  const inspections = new Map(settings.agentInspectionHistory.map(({ key, at }) => [key, at]));
  const leastRecentlyInspected = (a: FoundPosting, b: FoundPosting) => {
    const aAt = inspections.get(agentDedupeKey(a));
    const bAt = inspections.get(agentDedupeKey(b));
    if (!aAt && bAt) return -1;
    if (aAt && !bAt) return 1;
    return (aAt && bAt ? Date.parse(aAt) - Date.parse(bAt) : 0) || newestFirst(a, b);
  };
  // Parsing, classification and scoring share this cap across every role and page.
  // Try unseen ads first, then rotate earlier attempts, so uncertain ads cannot starve later roles.
  const toScore = eligible.toSorted(leastRecentlyInspected).slice(0, settings.agentMaxScores);
  counts.deferred = eligible.length - toScore.length;
  if (toScore.length === 0) return finish({ ...counts, scored: 0, message: summary("No postings passed your exclusions this time.") });
  await context.step(`Scoring ${toScore.length} ${toScore.length === 1 ? "posting" : "postings"}`);
  const [provider, options, profile] = await Promise.all([getAiProvider(), loadTaskOptions(), loadAgentProfile(settings.agentCvSource)]);
  let scored = 0;
  let queued = 0;
  const kept: string[] = [];
  let problem: string | null = null;
  for (const original of toScore) {
    if (context.signal.aborted) break;
    inspections.set(agentDedupeKey(original), now.toISOString());
    try {
      const employer = excludedEmployer(original.company, settings.agentExclusions.companies);
      if (employer) {
        const reason = `Employer is on your exclusion list (${employer}).`;
        reject(reason);
        history.unshift({ key: agentDedupeKey(original), fingerprint: cacheFingerprint(original), reason, checkedAt: now.toISOString() });
        continue;
      }
      const posting = await enrichAgentPosting(original, context.signal);
      const decision = await filterAgentPosting(posting, settings.agentExclusions, context.signal);
      if (!decision.allowed) {
        const reason = decision.reason ?? "Excluded by your filters.";
        reject(reason);
        if (decision.cacheable !== false) history.unshift({ key: agentDedupeKey(original), fingerprint: cacheFingerprint(original), reason, checkedAt: now.toISOString() });
        continue;
      }
      const { data, promptVersion } = await scorePosting(
        provider,
        { posting: postingText(posting), title: posting.title, company: posting.company, place: posting.place, remote: posting.remote, salary: posting.salary, profile },
        { ...options, signal: context.signal },
      );
      const candidate = await prisma.agentCandidate.create({ data: candidateData(posting, data), select: { id: true } });
      // Find jobs uses the editable profile; an uploaded agent CV has separate facts.
      if (settings.agentCvSource !== "uploaded") await saveScore(posting, data, promptVersion);
      kept.push(candidate.id);
      scored += 1;
      if (data.score >= settings.agentMinScore) queued += 1;
    } catch (error) {
      // Another run kept it first: it's seen either way.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      // One posting that fails doesn't stop the rest.
      if (error instanceof AiError || error instanceof ActionError) problem = error.message;
      else if (!context.signal.aborted) {
        problem = "Some postings could not be read or scored. They will be tried again.";
        logServerError("job agent scoring", error);
      }
    }
  }
  // Keep recent rejections independently of disposable background Job rows.
  const historyKeys = new Set<string>();
  await saveSettings({
    agentExclusionHistory: history.filter((entry) => {
      const key = `${entry.key}:${entry.fingerprint}`;
      if (historyKeys.has(key)) return false;
      historyKeys.add(key);
      return true;
    }).slice(0, 1000),
    agentInspectionHistory: [...inspections].map(([key, at]) => ({ key, at })).toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 1000),
  });

  // Auto-draft (#197, off by default): the best of this run's, one job each.
  let drafted = 0;
  if (settings.agentAutoDraft && settings.agentMaxDrafts > 0 && !context.signal.aborted) {
    const best = await prisma.agentCandidate.findMany({
      where: { id: { in: kept }, status: AgentCandidateStatus.SCORED, score: { gte: settings.agentMinScore } },
      orderBy: { score: "desc" },
      take: settings.agentMaxDrafts,
      select: { id: true },
    });
    for (const { id } of best) await startJob(agentDraftJob, { candidateId: id }, { key: draftJobKey(id) });
    drafted = best.length;
  }

  const waiting = `${queued} new ${queued === 1 ? "posting is" : "postings are"} waiting for a look.`;
  const message =
    scored === 0
      ? (problem ?? (counts.excluded ? "No postings passed your exclusions this time." : "No postings could be scored this time."))
      : queued === 0
        ? `Scored ${scored} new ${scored === 1 ? "posting" : "postings"}; none reached your minimum score of ${settings.agentMinScore}.`
        : drafted > 0
          ? `${waiting} Preparing ${drafted === 1 ? "a draft for the best one" : `drafts for the best ${drafted}`}.`
          : waiting;
  return finish({ ...counts, scored, drafted, message: summary(scored > 0 && problem ? `${message} ${problem}` : message) });
}
