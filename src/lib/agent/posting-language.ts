import { francAll } from "franc-min";

/** Include this in eligibility/cache fingerprints whenever the language policy changes. */
export const POSTING_LANGUAGE_GATE_VERSION = "v2:franc-min@6.2.0:body";

export type PostingLanguageGateResult = {
  allowed: true;
  language: "english";
  reason: null;
  cacheable: false;
} | {
  allowed: false;
  language: "other" | "mixed" | "unknown";
  reason: string;
  cacheable: boolean;
};

type SampleLanguage = "english" | "other" | "compatible" | "unknown";

const wordsIn = (text: string): string[] => text.match(/\p{L}+/gu) ?? [];
const lowercaseWords = (words: string[]): number => words.filter((word) => /^\p{Ll}/u.test(word)).length;

function meaningful(text: string, minimumCharacters: number, minimumWords: number): boolean {
  const words = wordsIn(text);
  return text.length >= minimumCharacters && words.length >= minimumWords && lowercaseWords(words) >= 6
    && new Set(words.map((word) => word.toLowerCase())).size >= 8;
}

/** Omit code and metadata/technology lists, which do not establish a human prose language. */
function proseParagraphs(description: string): string[] {
  return description
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "\n\n")
    // Formatting alone is not code: a preformatted/fenced ad can still contain duties.
    .replace(/^[ \t]*(?:```|~~~)[ \t]*[\w+-]*[ \t]*$/gm, "\n\n")
    .replace(/```|~~~|`/g, " ")
    .replace(/<\/?(?:p|div|li|ul|ol|br|pre|code|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+/g, " ")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split(/\n/).filter((line) => {
      // A snippet can resemble French or Swedish to a trigram detector. Never use it as prose.
      if (/^\s*(?:const|let|var|import|export|function|return|class|def|elif|else)\b/.test(line)
        || /^\s*[\w.$]+\s*=(?!=)|^\s*[{}[\],;]+\s*$/.test(line)) return false;
      const words = wordsIn(line);
      // Only a list made entirely of recognized technology names is metadata.
      // Punctuation density alone also matches substantive foreign requirements.
      const technologies = /^(?:Python|Java|JavaScript|TypeScript|C#|C\+\+|SQL|Bash|PowerShell|SAP|AWS|Azure|Microsoft 365|Jira|Okta|Linux|Windows|Docker|Kubernetes|Terraform|Git|HTML|CSS|API|SSO|IAM|SOC|NOC)$/i;
      const items = line.trim().replace(/^[-*•]\s+/, "").replace(/[.]$/, "").split(/[,;]\s*/);
      if (items.length >= 3 && items.every((item) => technologies.test(item.trim()))) return false;
      return words.length > 0;
    }).map((line) => /\p{Lu}/u.test(line) && !/\p{Ll}/u.test(line) ? line.toLowerCase() : line)
      .join(" ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function sampleLanguage(text: string): SampleLanguage {
  const rankings = francAll(text, { minLength: 60 });
  const [winner, runnerUp] = rankings;
  if (!winner || !runnerUp || winner[0] === "und") return "unknown";

  // franc normalizes its winning distance to 1: that is NOT a probability.
  // Its denominator grows with input length and it reads at most 2,048 characters.
  // Scale the distance gap for longer samples rather than treating 1 as certainty.
  const margin = (winner[1] - runnerUp[1]) * Math.max(1, Math.min(text.length, 2048) / 300);
  const englishDistance = rankings.find(([language]) => language === "eng")?.[1];
  const englishGap = englishDistance === undefined ? Infinity : winner[1] - englishDistance;
  // Require a separated English ranking plus diverse prose. Rank separation is a
  // heuristic, so substantive sections are checked independently of the body winner.
  if (winner[0] === "eng" && margin >= 0.025) return "english";
  // Confirmed rejection requires more text and separation than acceptance. Short or
  // closely ranked samples remain uncertain and can be retried with better evidence.
  if (winner[0] !== "eng" && meaningful(text, 100, 14) && margin >= 0.08 && englishGap >= 0.18) return "other";
  // Technical/business prose can rank narrowly behind French on a short sample.
  // It needs a separately confirmed English body/section, and cannot prove English alone.
  if (text.length < 200 && englishGap <= 0.12) return "compatible";
  return "unknown";
}

/**
 * Pure, independent body-language gate. Pass only the description, never title/company.
 * A pass still needs the semantic classifier's completeness, evidence and requirements checks.
 */
export function checkEnglishPostingLanguage(description: string): PostingLanguageGateResult {
  const paragraphs = proseParagraphs(description);
  const body = paragraphs.join(" ");
  const unknown: PostingLanguageGateResult = {
    allowed: false, language: "unknown", cacheable: false,
    reason: "The job description's language could not be confirmed.",
  };
  if (!meaningful(body, 80, 12)) return unknown;

  const samples = new Set([body]);
  let shortParagraphs = "";
  for (const paragraph of paragraphs) {
    // Brief skill statements are unreliable in isolation (even ordinary English
    // can rank as Dutch/Portuguese). Read them in body context; group short bullets.
    if (meaningful(paragraph, 100, 14)) {
      samples.add(paragraph);
      shortParagraphs = "";
    } else {
      if (meaningful(paragraph, 80, 12) && sampleLanguage(paragraph) === "english") samples.add(paragraph);
      shortParagraphs = `${shortParagraphs} ${paragraph}`.trim();
      if (meaningful(shortParagraphs, 100, 14)) {
        samples.add(shortParagraphs);
        shortParagraphs = "";
      }
    }
    for (const sentence of paragraph.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []) {
      if (meaningful(sentence, 100, 14)) samples.add(sentence.trim());
    }
  }
  // Cover unformatted/long ads, including duties beyond franc's 2,048-character limit.
  // Overlap prevents a language switch from always landing on a chunk boundary.
  for (let offset = 0; offset < body.length; offset += 300) {
    const chunk = body.slice(offset, offset + 600).replace(/^\S*\s|\s\S*$/g, "").trim();
    if (meaningful(chunk, 100, 14)) samples.add(chunk);
  }

  const languages = [...samples].map(sampleLanguage);
  if (languages.includes("other")) {
    return {
      allowed: false, language: languages.includes("english") ? "mixed" : "other", cacheable: true,
      reason: "The job description is not entirely in English.",
    };
  }
  if (languages.includes("unknown") || !languages.includes("english")) return unknown;
  return { allowed: true, language: "english", reason: null, cacheable: false };
}
