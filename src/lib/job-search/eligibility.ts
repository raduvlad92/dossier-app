import "server-only";

import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { ActionError } from "@/lib/action";
import { excludedEmployer, filterAgentPosting, type AgentExclusions } from "@/lib/agent/exclusions";
import { POSTING_LANGUAGE_GATE_VERSION } from "@/lib/agent/posting-language";
import { env } from "@/lib/env";
import { fetchPosting } from "@/lib/posting-fetch";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";

import { fullText } from "./find";
import { foundPostingSchema, postingKey, type FoundPosting, type PostingFiltering } from "./search";

/** Bump when the policy, classifier, evidence handling, or attestation changes. */
export const GATE_VERSION = `manual-posting-v1:${POSTING_LANGUAGE_GATE_VERSION}`;
export const POSTING_ELIGIBILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_POSTING_ELIGIBILITY_CHECKS = 25;
const RECHECK_REASON = "This posting needs to be rechecked against your current filters.";
const UNCERTAIN_REASON = "The exclusions could not be verified; the posting needs a manual review.";

const assessmentSchema = z.object({
  version: z.string(),
  policyFingerprint: z.string(),
  rawFingerprint: z.string(),
  evidenceFingerprint: z.string(),
  checkedAt: z.iso.datetime(),
  outcome: z.enum(["eligible", "excluded", "unchecked"]),
  reason: z.string().nullable(),
  evidence: foundPostingSchema,
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
type Assessment = z.output<typeof assessmentSchema>;
/** Internal JSON only. Never send the assessment to a browser as a posting DTO. */
export type AssessedPosting = FoundPosting & { eligibility?: Assessment };

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rawPosting = (posting: FoundPosting): FoundPosting => foundPostingSchema.parse(posting);

function signature(assessment: Omit<Assessment, "signature">): string {
  const key = hkdfSync("sha256", env.DOSSIER_SECRET, "", "dossier posting eligibility attestation v1", 32);
  return createHmac("sha256", Buffer.from(key)).update(JSON.stringify(assessment)).digest("hex");
}

/** Scheduler enablement never changes the manual search policy. */
export async function currentPostingRules(): Promise<AgentExclusions> {
  return (await loadSettings()).agentExclusions;
}

function rulesActive(rules: AgentExclusions): boolean {
  return rules.englishOnly || rules.allowedLanguages.length > 0 || rules.excludeConsultancies || rules.companies.length > 0;
}

/** Tolerates legacy JSON without giving old/unattested results an approval. */
export function storedPostings(value: Prisma.JsonValue): AssessedPosting[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const parsed = foundPostingSchema.safeParse(item);
    if (!parsed.success || seen.has(postingKey(parsed.data))) return [];
    seen.add(postingKey(parsed.data));
    const assessment = assessmentSchema.safeParse(item && typeof item === "object" && "eligibility" in item ? item.eligibility : undefined);
    return [{ ...parsed.data, ...(assessment.success ? { eligibility: assessment.data } : {}) }];
  });
}

/** Authentic raw/evidence binding, independent of policy and cache freshness. */
function attestedAssessment(posting: AssessedPosting): Assessment | null {
  const assessment = posting.eligibility;
  if (!assessment) return null;
  const { signature: signed, ...body } = assessment;
  const expected = signature(body);
  if (signed.length !== expected.length || !timingSafeEqual(Buffer.from(signed), Buffer.from(expected))) return null;
  if (assessment.version !== GATE_VERSION || assessment.rawFingerprint !== fingerprint(rawPosting(posting)) ||
    assessment.evidenceFingerprint !== fingerprint(assessment.evidence) || postingKey(posting) !== postingKey(assessment.evidence)) return null;
  return assessment;
}

/** Only a server-attested decision about these exact raw/evidence/rules is current. */
function currentAssessment(posting: AssessedPosting, rules: AgentExclusions, now: Date): Assessment | null {
  const assessment = attestedAssessment(posting);
  if (!assessment) return null;
  const age = now.getTime() - Date.parse(assessment.checkedAt);
  if (age < 0 || age >= POSTING_ELIGIBILITY_TTL_MS || assessment.policyFingerprint !== fingerprint(rules)) return null;
  return assessment;
}

/** Pure cache read: no source lookup, page fetch, or AI request. */
export function visiblePostings(postings: AssessedPosting[], rules: AgentExclusions, now = new Date()): { postings: FoundPosting[]; filtering: PostingFiltering } {
  const filtering: PostingFiltering = { active: rulesActive(rules), total: postings.length, eligible: 0, excluded: 0, unchecked: 0, reasons: [] };
  const reasons = new Map<string, number>();
  const visible: FoundPosting[] = [];
  for (const posting of postings) {
    const assessment = currentAssessment(posting, rules, now);
    if (assessment?.outcome === "eligible") {
      filtering.eligible++;
      visible.push(assessment.evidence);
    } else {
      if (assessment?.outcome === "excluded") filtering.excluded++;
      else filtering.unchecked++;
      const reason = assessment?.reason ?? RECHECK_REASON;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  filtering.reasons = [...reasons].map(([reason, count]) => ({ reason, count }));
  return { postings: visible, filtering };
}

async function enriched(posting: FoundPosting, signal?: AbortSignal): Promise<FoundPosting> {
  if (posting.complete && posting.description.trim()) return posting;
  if (signal?.aborted) return posting;
  try {
    const text = await fullText(posting);
    // Some adapters echo the same truncated description. That does not prove
    // completeness, so try the guarded page instead of approving the snippet.
    if (text?.trim() && text.replace(/\s+/g, " ").trim() !== posting.description.replace(/\s+/g, " ").trim() && !signal?.aborted) {
      return rawPosting({ ...posting, description: text, complete: true });
    }
  } catch { /* A source failure still permits the guarded public-page fallback. */ }
  if (!posting.url || signal?.aborted) return posting;
  try {
    // Deliberately no agent parser: those can start optional paid collection jobs.
    const page = await fetchPosting(posting.url);
    if (page.ok && page.text.trim() && !signal?.aborted) return rawPosting({ ...posting, description: page.text, complete: true });
  } catch { /* Failed enrichment is uncertainty, never an approval. */ }
  return posting;
}

async function assessFresh(posting: FoundPosting, rules: AgentExclusions, signal?: AbortSignal): Promise<AssessedPosting> {
  const raw = rawPosting(posting);
  let evidence = raw;
  let outcome: Assessment["outcome"] = "unchecked";
  let reason: string | null = UNCERTAIN_REASON;
  try {
    if (!signal?.aborted) {
      if ((rules.englishOnly || rules.allowedLanguages.length > 0 || rules.excludeConsultancies) && !excludedEmployer(raw.company, rules.companies)) {
        evidence = await enriched(raw, signal);
      }
      const decision = await filterAgentPosting(evidence, rules, signal);
      if (!signal?.aborted) {
        outcome = decision.allowed ? "eligible" : decision.cacheable === true ? "excluded" : "unchecked";
        reason = decision.allowed ? null : decision.reason ?? UNCERTAIN_REASON;
      }
    }
  } catch { /* Provider/source details can contain credentials or posting text. */ }
  const body: Omit<Assessment, "signature"> = {
    version: GATE_VERSION,
    policyFingerprint: fingerprint(rules),
    rawFingerprint: fingerprint(raw),
    evidenceFingerprint: fingerprint(evidence),
    checkedAt: new Date().toISOString(),
    outcome,
    reason,
    evidence,
  };
  return { ...raw, eligibility: { ...body, signature: signature(body) } };
}

async function matchingSearches(posting: FoundPosting) {
  return prisma.postingSearch.findMany({
    where: { source: posting.source, postings: { array_contains: [{ source: posting.source, externalId: posting.externalId }] } },
    select: { id: true, postings: true },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
}

function sameInput(stored: AssessedPosting, input: FoundPosting): boolean {
  if (postingKey(stored) !== postingKey(input)) return false;
  const inputFingerprint = fingerprint(rawPosting(input));
  if (fingerprint(rawPosting(stored)) === inputFingerprint) return true;
  return attestedAssessment(stored)?.evidenceFingerprint === inputFingerprint;
}

/** Deduplicated before any checks, with at most three descriptions/providers in flight. */
export async function assessPostings(postings: AssessedPosting[], rules: AgentExclusions, signal?: AbortSignal): Promise<AssessedPosting[]> {
  const seen = new Set<string>();
  const unique = postings.filter((posting) => {
    if (seen.has(postingKey(posting))) return false;
    seen.add(postingKey(posting));
    return true;
  });
  const results = [...unique];
  const pending = unique.flatMap((posting, index) => {
    const assessment = currentAssessment(posting, rules, new Date());
    if (assessment && assessment.outcome !== "unchecked") return [];
    return [{ posting, index }];
  }).sort((a, b) => {
    // Uninspected results first, then the oldest uncertain/stale attempt. An
    // oversized source page and repeated failures cannot monopolize paid checks.
    const aAt = a.posting.eligibility?.checkedAt;
    const bAt = b.posting.eligibility?.checkedAt;
    return Number(Boolean(aAt)) - Number(Boolean(bAt)) || (aAt && bAt ? Date.parse(aAt) - Date.parse(bAt) : 0);
  }).slice(0, MAX_POSTING_ELIGIBILITY_CHECKS);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    for (let index = next++; index < pending.length; index = next++) {
      const { posting, index: outputIndex } = pending[index];
      const searches = await matchingSearches(posting);
      const cached = searches.flatMap((search) => storedPostings(search.postings)).find((candidate) => {
        const assessment = currentAssessment(candidate, rules, new Date());
        return fingerprint(rawPosting(candidate)) === fingerprint(rawPosting(posting)) && assessment && assessment.outcome !== "unchecked";
      });
      results[outputIndex] = cached ?? await assessFresh(posting, rules, signal);
    }
  }));
  return results;
}

/**
 * Action/worker boundary. Browser metadata is stripped; only matching, attested
 * database evidence may skip a fresh check. The returned DTO includes checked text.
 */
export async function requireEligiblePosting(posting: FoundPosting, signal?: AbortSignal): Promise<FoundPosting> {
  const input = rawPosting(posting);
  const rules = await currentPostingRules();
  const searches = await matchingSearches(input);
  const matching = searches.flatMap((search) => storedPostings(search.postings)).filter((candidate) => sameInput(candidate, input));
  let checked = matching.find((candidate) => {
    const assessment = currentAssessment(candidate, rules, new Date());
    return assessment && assessment.outcome !== "unchecked";
  });
  if (!checked) {
    checked = await assessFresh(matching[0] ?? input, rules, signal);
    const checkedRawFingerprint = fingerprint(rawPosting(checked));
    for (const search of searches) {
      const entries = storedPostings(search.postings);
      const matchesCheckedRaw = (entry: AssessedPosting) => fingerprint(rawPosting(entry)) === checkedRawFingerprint;
      if (!entries.some(matchesCheckedRaw)) continue;
      // Avoid replacing a concurrently extended/rechecked search's JSON snapshot.
      await prisma.postingSearch.updateMany({
        where: { id: search.id, postings: { equals: search.postings as Prisma.InputJsonValue } },
        data: { postings: entries.map((entry) => matchesCheckedRaw(entry) ? checked! : entry) },
      });
    }
  }
  const assessment = currentAssessment(checked, rules, new Date());
  if (signal?.aborted || assessment?.outcome !== "eligible") throw new ActionError(assessment?.reason ?? UNCERTAIN_REASON);
  return assessment.evidence;
}
