import "server-only";

import { getAiProvider } from "@/lib/ai";
import { classifyAgentPosting, MAX_AGENT_CLASSIFICATION_CHARACTERS } from "@/lib/ai/tasks/classify-agent-posting";
import type { FoundPosting } from "@/lib/job-search/search";

import { agentExclusionsSchema, type AgentExclusions } from "./exclusion-settings";
import { checkEnglishPostingLanguage } from "./posting-language";

export { agentExclusionsSchema, DEFAULT_EXCLUDED_COMPANIES, type AgentExclusions } from "./exclusion-settings";

type FilterResult = { allowed: boolean; reason: string | null; cacheable?: boolean };
const reject = (reason: string, cacheable = false): FilterResult => ({ allowed: false, reason, cacheable });
const allow = (): FilterResult => ({ allowed: true, reason: null });

const companyAliases = [
  ["KPMG", "K P M G"],
  ["PwC", "P W C", "PricewaterhouseCoopers", "Pricewaterhouse Coopers", "Price Waterhouse Coopers"],
  ["EY", "E Y", "Ernst & Young", "Ernst and Young", "Ernst Young"],
  ["McKinsey", "McKinsey & Company", "McKinsey and Company"],
  ["Boston Consulting Group", "BCG", "B C G"],
  ["Bain", "Bain & Company", "Bain and Company"],
  ["Booz Allen", "Booz Allen Hamilton"],
  ["TCS", "T C S", "Tata Consultancy Services"],
  ["NTT DATA", "N T T DATA"],
];

function normalizeCompany(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Whole name tokens prevent EY from matching Honeywell or Bain from matching Bainbridge. */
export function excludedEmployer(company: string, exclusions: readonly string[]): string | null {
  const employer = ` ${normalizeCompany(company)} `;
  for (const exclusion of exclusions) {
    const normalized = normalizeCompany(exclusion);
    if (!normalized) continue;
    const group = companyAliases.find((aliases) => aliases.some((alias) => normalizeCompany(alias) === normalized));
    const aliases = group ?? [exclusion];
    if (aliases.some((alias) => employer.includes(` ${normalizeCompany(alias)} `))) return exclusion;
  }
  return null;
}

const languageAliases: Record<string, string> = {
  en: "english", eng: "english", english: "english", inglese: "english",
  it: "italian", ita: "italian", italian: "italian", italiano: "italian",
  de: "german", deu: "german", ger: "german", german: "german", deutsch: "german",
  fr: "french", fra: "french", french: "french", francais: "french",
  es: "spanish", spa: "spanish", spanish: "spanish", espanol: "spanish",
  nl: "dutch", nld: "dutch", dutch: "dutch", nederlands: "dutch",
};

function normalizeLanguage(value: string): string {
  const name = normalizeCompany(value);
  return languageAliases[name] ?? name;
}

/** Accept whitespace differences only; model evidence still has to occur in the source text. */
function hasEvidence(text: string, quote: string | null): boolean {
  return Boolean(quote && text.replace(/\s+/g, " ").includes(quote.trim().replace(/\s+/g, " ")));
}

/** Exclusions run before scoring/drafting; uncertainty is kept out of the candidate queue. */
export async function filterAgentPosting(posting: FoundPosting, exclusions: AgentExclusions, signal?: AbortSignal): Promise<FilterResult> {
  const parsed = agentExclusionsSchema.safeParse(exclusions);
  if (!parsed.success) return reject("The exclusion settings could not be checked.");
  const rules = parsed.data;
  const employer = excludedEmployer(posting.company, rules.companies);
  if (employer) return reject(`Employer is on your exclusion list (${employer}).`, true);
  const checkLanguages = rules.allowedLanguages.length > 0;
  if (!rules.englishOnly && !checkLanguages && !rules.excludeConsultancies) return allow();
  if (signal?.aborted) return reject("The exclusion check was cancelled.");
  const description = posting.description.trim();
  if (!posting.complete || !description) return reject("The complete job description is needed to check your exclusions.");
  if (description.length > MAX_AGENT_CLASSIFICATION_CHARACTERS) return reject("The job description is too long to check in full; it needs a manual review.");
  if (rules.englishOnly) {
    const language = checkEnglishPostingLanguage(description);
    if (!language.allowed) return reject(language.reason, language.cacheable);
  }

  try {
    const assessment = await classifyAgentPosting(await getAiProvider(), posting, signal);
    if (signal?.aborted) return reject("The exclusion check was cancelled.");
    if (!assessment.contentComplete) return reject("The full job requirements could not be confirmed.");
    if (rules.englishOnly) {
      if (assessment.postingLanguage === "unknown" || !hasEvidence(description, assessment.postingLanguageEvidence)) {
        return reject("The job description's language could not be confirmed.");
      }
      if (assessment.postingLanguage !== "english") return reject("The job description is not entirely in English.", true);
    }
    if (checkLanguages) {
      if (!assessment.languageRequirementsCertain) return reject("The mandatory language requirements could not be confirmed.");
      const allowed = new Set(rules.allowedLanguages.map(normalizeLanguage));
      for (const requirement of assessment.languageRequirements) {
        if (!hasEvidence(description, requirement.evidence) || requirement.obligation === "unknown") {
          return reject("A language requirement needs a manual review.");
        }
        if (requirement.obligation !== "required") continue;
        const matches = requirement.languages.map((language) => allowed.has(normalizeLanguage(language)));
        const satisfied = requirement.match === "any" ? matches.some(Boolean) : matches.every(Boolean);
        if (!satisfied) return reject("The posting requires a language outside your allowed languages.", true);
      }
    }
    if (rules.excludeConsultancies) {
      if (assessment.employerIsConsultancy === "unknown" || !hasEvidence(`${posting.company}\n${description}`, assessment.consultancyEvidence)) {
        return reject("The employer's consultancy status could not be confirmed.");
      }
      if (assessment.employerIsConsultancy === "yes") return reject("The hiring employer is a consultancy or outsourcing group.", true);
    }
    return allow();
  } catch {
    // Provider messages can contain credentials, URLs or job text. Never surface them here.
    return reject(signal?.aborted ? "The exclusion check was cancelled." : "The exclusions could not be verified; the posting needs a manual review.");
  }
}
