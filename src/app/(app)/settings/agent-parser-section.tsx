"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { parserSettingsSchema, type ParserSettingsView } from "@/lib/agent/parser-settings";

import { saveAgentParser } from "./parser-actions";

/** Optional full-description parsing, only after the source and normal page fetch fail. */
export function AgentParserSection({ initial }: { initial: ParserSettingsView }) {
  const [settings, setSettings] = useState(initial);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const change = (patch: Partial<ParserSettingsView>) => setSettings((current) => ({ ...current, ...patch }));
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const result = await saveAgentParser({ settings: parserSettingsSchema.parse(settings), key });
      setError(!result.ok);
      setMessage(result.ok ? "Parser settings saved." : result.error);
      if (result.ok) { setSettings((current) => ({ ...current, keySet: current.keySet || Boolean(key.trim()) })); setKey(""); }
    } catch { setError(true); setMessage("The parser settings could not be saved. Check the values and try again."); }
    finally { setBusy(false); }
  };
  return (
    <Card padding="none" className="flex flex-col gap-4 px-7 py-[26px]">
      <details>
        <summary className="cursor-pointer text-field font-medium">Additional posting parsers</summary>
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-meta text-muted">For job pages Dossier cannot read directly. Your chosen parser receives the posting link; your CV stays with Dossier and your AI provider. This adds parsing coverage to your existing job source.</p>
          <Select label="Fallback parser" value={settings.provider} onChange={(event) => change({ provider: event.target.value as ParserSettingsView["provider"] })}>
            <option value="off">Off</option><option value="apify">Apify saved task</option><option value="brightdata">Bright Data scraper</option>
          </Select>
          {settings.provider !== "off" && <>
            <Input label="Parser API key" type="password" autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={settings.keySet ? "Saved securely · leave blank to keep" : "Enter an API key"} />
            {settings.provider === "apify" ? <>
              <Input label="Apify saved task ID" value={settings.taskId} onChange={(event) => change({ taskId: event.target.value })} hint="Use a task configured to extract one complete job description." />
              <Input label="Maximum Apify charge per posting (USD)" type="number" min="0.01" max="5" step="0.01" value={settings.maxChargeUsd} onChange={(event) => change({ maxChargeUsd: Number(event.target.value) })} />
              <a className="text-meta underline underline-offset-2" href="https://docs.apify.com/api/v2/actor-task-runs-post" target="_blank" rel="noreferrer">Apify task API documentation</a>
            </> : <>
              <Input label="Bright Data scraper dataset ID" value={settings.datasetId} onChange={(event) => change({ datasetId: event.target.value })} hint="Choose a scraper that accepts job URLs, with one result per input." />
              <p role="note" className="text-meta text-warning">Bright Data charges follow your provider plan. Dossier requests one result, which is not a spending cap. Set a budget in your Bright Data account before enabling this parser.</p>
              <a className="text-meta underline underline-offset-2" href="https://docs.brightdata.com/api-reference/rest-api/scraper/asynchronous-requests" target="_blank" rel="noreferrer">Bright Data scraper documentation</a>
            </>}
            <label className="flex flex-col gap-2 text-meta">Parser input JSON
              <textarea className="min-h-28 rounded-field border border-line bg-surface px-3 py-2 text-ink" value={settings.inputTemplate} onChange={(event) => change({ inputTemplate: event.target.value })} placeholder={settings.provider === "apify" ? '{"startUrls":[{"url":"{{url}}"}],"maxCrawlPages":1}' : '{"input":[{"url":"{{url}}"}],"limit_per_input":1}'} />
              <span className="text-muted">Leave blank for the shown default. Your task or scraper may need different fields. Use {"{{url}}"} for the job link.</span>
            </label>
            <Input label="Description field in the result" value={settings.textField} onChange={(event) => change({ textField: event.target.value })} placeholder="Auto-detect, or e.g. job_description" />
          </>}
          <div><Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save parser settings"}</Button></div>
          {message && <p role={error ? "alert" : "status"} className={`text-meta ${error ? "text-warning" : "text-muted"}`}>{message}</p>}
        </div>
      </details>
    </Card>
  );
}
