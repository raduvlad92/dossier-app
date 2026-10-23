"use client";

import Link from "next/link";
import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { useAutosave } from "@/hooks/use-autosave";
import { agentExclusionsSchema, type AgentExclusions } from "@/lib/agent/exclusion-settings";
import type { Country } from "@/lib/job-search/countries";
import { searchHref, type JobSource, type SearchQuery } from "@/lib/job-search/search";

import { saveAgentSettings } from "../agent/actions";
import { RemoteOnlyField, SearchFields, type SearchFieldErrors } from "../jobs/search-fields";
import { AgentCvField } from "./agent-cv-field";
import { SettingsSectionIntro } from "./settings-screen";

export type AgentSettings = {
  enabled: boolean;
  query: SearchQuery;
  hour: number;
  minScore: number;
  maxScores: number;
  maxDrafts: number;
  autoDraft: boolean;
  queries?: SearchQuery[];
  intervalHours?: 3 | 6 | 12 | 24;
  maxPages?: number;
  exclusions?: AgentExclusions;
  cvSource?: "profile" | "uploaded" | "generated";
};
type ResolvedSettings = AgentSettings & Required<Pick<AgentSettings, "queries" | "intervalHours" | "maxPages" | "exclusions" | "cvSource">>;

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MIN_SCORES = [50, 55, 60, 65, 70, 75, 80, 85, 90];
const SCORE_COUNTS = Array.from({ length: 30 }, (_, index) => index + 1);
const DRAFT_COUNTS = Array.from({ length: 11 }, (_, index) => index);
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const list = (value: string) => [...new Set(value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean))];

function initialSettings(initial: AgentSettings): ResolvedSettings {
  return {
    ...initial,
    queries: initial.queries?.length ? initial.queries : initial.query.keywords.trim()
      ? [initial.query] : ["Head of IT", "TechOps Lead", "IT Manager"].map((keywords) => ({ ...initial.query, keywords })),
    intervalHours: initial.intervalHours ?? 3,
    maxPages: initial.maxPages ?? 1,
    exclusions: initial.exclusions ?? agentExclusionsSchema.parse({}),
    cvSource: initial.cvSource ?? "profile",
  };
}

/** The job watch: saved searches, strict exclusions, a schedule and bounded per-run work. */
export function AgentSection({ initial, source, aiReady, countries, timeZone, uploadedCvName = null }: {
  initial: AgentSettings;
  source: JobSource | null;
  aiReady: boolean;
  countries: readonly Country[];
  timeZone: string;
  uploadedCvName?: string | null;
}) {
  const track = useTrackSave();
  const [settings, setSettings] = useState(() => initialSettings(initial));
  const [errors, setErrors] = useState<SearchFieldErrors[]>([]);
  const [exclusionDraft, setExclusionDraft] = useState(() => ({
    companies: settings.exclusions.companies.join("\n"),
    allowedLanguages: settings.exclusions.allowedLanguages.join(", "),
  }));
  const change = (next: Partial<ResolvedSettings>) => {
    const previous = settings;
    setSettings((current) => ({ ...current, ...next }));
    void track(saveAgentSettings(next)).then((result) => {
      if (!toastResult(result).ok) setSettings(previous);
    });
  };
  const { flush: flushQueries } = useAutosave(settings.queries, (queries) => {
    // An unfinished new row is an editor draft while the existing watch keeps running.
    if (settings.enabled && queries.some((query) => !query.keywords.trim() || !query.country)) return Promise.resolve();
    return track(saveAgentSettings({ queries, query: queries[0] }));
  });
  const currentExclusions = (patch: Partial<AgentExclusions> = {}): AgentExclusions => ({
    ...settings.exclusions,
    companies: list(exclusionDraft.companies),
    allowedLanguages: list(exclusionDraft.allowedLanguages),
    ...patch,
  });
  const { flush: flushExclusions } = useAutosave(exclusionDraft, (draft) =>
    track(saveAgentSettings({ exclusions: { ...settings.exclusions, companies: list(draft.companies), allowedLanguages: list(draft.allowedLanguages) } })),
  );
  const setQuery = (index: number, patch: Partial<SearchQuery>) => {
    setErrors([]);
    setSettings((current) => {
      const queries = current.queries.map((query, position) => (position === index ? { ...query, ...patch } : query));
      return { ...current, queries, query: queries[0] };
    });
  };
  const turnOn = (on: boolean) => {
    if (!on) return change({ enabled: false });
    const problems = settings.queries.map((query) => ({
      keywords: query.keywords.trim() ? undefined : "Type what the agent should look for.",
      country: query.country ? undefined : "Choose a country.",
    }));
    setErrors(problems);
    if (problems.some((problem) => problem.keywords || problem.country)) return;
    change({ enabled: true, query: settings.queries[0], queries: settings.queries, intervalHours: settings.intervalHours,
      maxPages: settings.maxPages, exclusions: currentExclusions(), cvSource: settings.cvSource });
  };

  return (
    <>
      <SettingsSectionIntro title="Job agent">
        Keep several job searches running on a schedule. The agent excludes postings that break your rules, then scores the rest against your chosen CV. Drafts wait for your review; it never sends or applies.
      </SettingsSectionIntro>
      {(!source || !aiReady) && (
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          {!source ? "The agent searches the source you choose in " : "The agent scores postings with the AI provider in "}
          <Link href={!source ? "/settings?section=jobs" : "/settings?section=ai"} className="font-medium text-warning underline underline-offset-2">
            {!source ? "Settings → Job search" : "Settings → AI provider"}
          </Link>
          {!source ? ", which is off. Choose one first." : ", which isn't set up yet. Choose one first."}
        </p>
      )}
      <Card padding="none" className="px-5 py-4 sm:px-7">
        <Toggle label="Run the job agent" description={settings.enabled
          ? settings.intervalHours === 24
            ? `On. It runs daily after ${clock(settings.hour)} your time (${timeZone}). You can also run it on the Agent screen.`
            : `On. It checks your saved searches every ${settings.intervalHours} hours. You can also run it on the Agent screen.`
          : "Off. Scheduled searches and scoring are paused. Your search rules still apply to Find jobs."} checked={settings.enabled} onCheckedChange={turnOn} />
      </Card>

      <Card padding="none" className="flex flex-col gap-5 px-5 py-[26px] sm:px-7">
        <div className="flex flex-col gap-1">
          <h3 className="text-field font-medium">Jobs to track</h3>
          <p className="text-meta text-muted">Add up to 10 titles or searches. Each run checks them all, follows more result pages within your limit, and skips duplicates and postings you already saved, dismissed or applied for.</p>
        </div>
        {settings.queries.map((query, index) => (
          <fieldset key={index} className="min-w-0 border-t border-line pt-4" onBlur={flushQueries}>
            <legend className="px-1 text-sm font-medium">Search {index + 1}</legend>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Link href={searchHref(query)} className="text-meta text-muted underline underline-offset-2 hover:text-ink">Preview in Find jobs</Link>
              {settings.queries.length > 1 && <Button variant="danger-text" size="sm" aria-label={`Remove search ${index + 1}`} onClick={() => {
                setErrors([]);
                setSettings((current) => {
                  const queries = current.queries.filter((_, position) => position !== index);
                  return { ...current, queries, query: queries[0] };
                });
              }}>Remove</Button>}
            </div>
            <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
              <SearchFields value={query} onChange={(patch) => setQuery(index, patch)} source={source} countries={countries} errors={errors[index]} />
              <div className="sm:col-span-2"><RemoteOnlyField value={query} onChange={(patch) => setQuery(index, patch)} source={source} /></div>
            </div>
          </fieldset>
        ))}
        <Button variant="secondary" className="self-start" disabled={settings.queries.length >= 10} onClick={() => setSettings((current) => ({
          ...current, queries: [...current.queries, { ...current.queries[0], keywords: "" }],
        }))}>Add another search</Button>
        {settings.enabled && settings.queries.some((query) => !query.keywords.trim() || !query.country) && <p role="status" className="text-meta text-muted">Complete every search to save these changes. Your previous saved searches keep running until then.</p>}
      </Card>

      <Card padding="none" className="flex flex-col gap-5 px-5 py-[26px] sm:px-7">
        <div className="flex flex-col gap-1">
          <h3 className="text-field font-medium">Exclusions</h3>
          <p className="text-meta text-muted">These rules apply to manual Find jobs searches and scheduled Job agent searches, even when the agent is off. Scoring and starting an application also check the current rules. Saved and dismissed postings remain in your history.</p>
        </div>
        <Toggle label="Only postings written in English" description="Exclude non-English ads. Unclear or incomplete descriptions stay unchecked until they can be verified against your language rules." checked={settings.exclusions.englishOnly} onCheckedChange={(englishOnly) => change({ exclusions: currentExclusions({ englishOnly }) })} />
        <Input label="Allowed required languages" hint="Separate languages with commas. A requirement outside this list excludes the job; a language that is only optional is fine. Leave empty to allow any required language." value={exclusionDraft.allowedLanguages} onChange={(event) => setExclusionDraft((current) => ({ ...current, allowedLanguages: event.target.value }))} onBlur={flushExclusions} />
        <Toggle label="Exclude consultancy groups" description="Skip consultancy, professional services and outsourcing employers, including groups beyond your named exclusions." checked={settings.exclusions.excludeConsultancies} onCheckedChange={(excludeConsultancies) => change({ exclusions: currentExclusions({ excludeConsultancies }) })} />
        <Textarea label="Excluded companies" hint="One company per line, or separate names with commas. Named companies are always excluded, even if the consultancy filter is off." rows={6} value={exclusionDraft.companies} onChange={(event) => setExclusionDraft((current) => ({ ...current, companies: event.target.value }))} onBlur={flushExclusions} />
      </Card>

      <Card padding="none" className="flex flex-col gap-4 px-5 py-[26px] sm:px-7">
        <h3 className="text-field font-medium">CV for matching and drafts</h3>
        <Select label="Use as my CV" value={settings.cvSource} onChange={(event) => change({ cvSource: event.target.value as ResolvedSettings["cvSource"] })}>
          <option value="profile">My Dossier profile</option><option value="uploaded">My uploaded CV</option><option value="generated">Dossier base CV</option>
        </Select>
        <p className="text-meta text-muted">
          {settings.cvSource === "profile" ? <>Uses your structured experience, skills and education. Keep them current in <Link href="/profile" className="text-ink underline underline-offset-2">Your profile</Link>.</>
            : settings.cvSource === "generated" ? <>Uses the current base CV created from your profile. Review it in <Link href="/resume" className="text-ink underline underline-offset-2">Base resume</Link>.</>
              : "Uses the text from your uploaded CV as the factual source for matching and drafts. The extracted text is stored encrypted on your server; the original file is not retained."}
        </p>
        <div hidden={settings.cvSource !== "uploaded"} className={settings.cvSource === "uploaded" ? "flex flex-col gap-4" : undefined}>
          <AgentCvField initialName={uploadedCvName} />
        </div>
      </Card>

      <Card padding="none" className="grid gap-x-[18px] gap-y-5 px-5 py-[26px] sm:grid-cols-2 sm:px-7">
        <Select label="Check for new jobs" value={String(settings.intervalHours)} onChange={(event) => change({ intervalHours: Number(event.target.value) as ResolvedSettings["intervalHours"] })}>
          {[3, 6, 12, 24].map((hours) => <option key={hours} value={hours}>{hours === 24 ? "Every day" : `Every ${hours} hours`}</option>)}
        </Select>
        {settings.intervalHours === 24 && <Select label="Runs after" hint={`Your time (${timeZone})`} value={String(settings.hour)} onChange={(event) => change({ hour: Number(event.target.value) })}>{HOURS.map((hour) => <option key={hour} value={hour}>{clock(hour)}</option>)}</Select>}
        <Select label="Result pages per search, at most" hint="Follows available pages in each saved search." value={String(settings.maxPages)} onChange={(event) => change({ maxPages: Number(event.target.value) })}>{[1, 2, 3].map((count) => <option key={count} value={count}>{count}</option>)}</Select>
        <Select label="Minimum score" hint="Postings scored lower stay out of the queue." value={String(settings.minScore)} onChange={(event) => change({ minScore: Number(event.target.value) })}>{[...new Set([...MIN_SCORES, settings.minScore])].sort((a, b) => a - b).map((score) => <option key={score} value={score}>{score} of 100</option>)}</Select>
        <Select label="Postings checked per run" hint="Shared across all searches. Each check may read, filter and score a posting." value={String(settings.maxScores)} onChange={(event) => change({ maxScores: Number(event.target.value) })}>{SCORE_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}</Select>
        <Select label="Drafts per run, at most" value={String(settings.maxDrafts)} disabled={!settings.autoDraft} hint={settings.autoDraft ? undefined : "Turn on Prepare drafts on its own first"} onChange={(event) => change({ maxDrafts: Number(event.target.value) })}>{DRAFT_COUNTS.map((count) => <option key={count} value={count}>{count}</option>)}</Select>
        <Toggle className="sm:col-span-2" label="Prepare drafts on its own" description={settings.autoDraft ? `For the best new postings of each run, up to ${plural(settings.maxDrafts, "draft", "drafts")}: a tailored resume and cover letter, waiting for your review.` : "Off. You choose which postings get a draft with Prepare draft."} checked={settings.autoDraft} onCheckedChange={(autoDraft) => change({ autoDraft })} />
      </Card>
      <p className="text-meta text-muted">
        Each run searches up to {plural(settings.queries.length * settings.maxPages, "result page", "result pages")} across {plural(settings.queries.length, "search", "searches")} and checks up to {plural(settings.maxScores, "posting", "postings")}{settings.autoDraft ? ` and prepares up to ${plural(settings.maxDrafts, "draft", "drafts")}` : ""}. The agent allows at most 12 runs in 24 hours, including manual runs. Language and consultancy checks also use your AI provider. Your chosen CV goes to that provider for matching and drafts; job sources only get the searches.
      </p>
    </>
  );
}
