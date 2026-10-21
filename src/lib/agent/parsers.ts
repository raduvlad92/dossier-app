import "server-only";

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

import { ActionError } from "@/lib/action";
import { fullText } from "@/lib/job-search/find";
import { linkKey, type FoundPosting } from "@/lib/job-search/search";
import { plainText } from "@/lib/job-search/text";
import { fetchPosting, isPublicAddress } from "@/lib/posting-fetch";
import { prisma } from "@/lib/prisma";
import { loadParserConfig } from "./parser-config";
import { parserInput, type ParserSettings } from "./parser-settings";

type ParserRun = { phase: "triggering" | "running" | "ready" | "failed"; id?: string; datasetId?: string; text?: string; at: string };
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Remote providers receive only public posting links, never credentials or local URLs. */
export async function publicParserUrl(value: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let url: URL;
  try { url = new URL(value); } catch { throw new ActionError("The parser needs a public web address for this posting."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new ActionError("The parser needs a public web address without embedded credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try { addresses = await lookup(host, { all: true }); } catch { throw new ActionError("The posting address could not be checked before using the parser."); }
  signal?.throwIfAborted();
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) throw new ActionError("The parser cannot fetch addresses on your own network.");
  url.hash = "";
  return url.toString();
}

async function vendorJson(url: string, key: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]), redirect: "error" });
  if (!response.ok) throw new ActionError("The optional parser could not complete this posting. Check its connection and quota.");
  if (Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES) throw new ActionError("The parser response was too large.");
  const reader = response.body?.getReader();
  if (!reader) throw new ActionError("The parser returned no data.");
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ActionError("The parser response was too large."); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally { reader.releaseLock(); }
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export function parserText(value: unknown, field: string): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  const fields = field ? [field] : ["text", "markdown", "job_description", "job_description_formatted", "description", "content"];
  for (const path of fields) {
    let found: unknown = first;
    for (const name of path.split(".")) found = object(found)[name];
    if (typeof found !== "string") continue;
    const text = plainText(found);
    if (text.length >= 200 && text.length <= 100_000) return text;
  }
  return null;
}

/** Each remote run is journaled before triggering. Ambiguous POST failures never spend again automatically. */
export async function remoteParserText(postingUrl: string, config: ParserSettings & { key: string | null }, signal?: AbortSignal): Promise<string | null> {
  if (config.provider === "off") return null;
  if (!config.key) throw new ActionError("Add an API key for the optional parser in Settings → Job agent.");
  if (config.provider === "apify" && !config.taskId) throw new ActionError("Choose an Apify saved task first.");
  if (config.provider === "brightdata" && !config.datasetId) throw new ActionError("Choose a Bright Data scraper first.");
  let input: unknown;
  try { input = parserInput(config, postingUrl); } catch { throw new ActionError("Use valid parser input JSON containing {{url}} for the posting link."); }
  const url = await publicParserUrl(postingUrl, signal);
  // Rebuild with the normalized link, after validation, before claiming a paid run.
  input = parserInput(config, url);
  const hash = createHash("sha256").update(JSON.stringify([url, config.provider, config.taskId, config.datasetId, config.inputTemplate, config.textField, config.maxChargeUsd])).digest("hex");
  const key = `agent-parser:${hash}`;
  const stored = await prisma.setting.findUnique({ where: { key } });
  let run: ParserRun | null = null;
  if (stored) { try { run = JSON.parse(stored.value) as ParserRun; } catch { throw new ActionError("The parser journal cannot be read. Check this posting manually."); } }
  const save = async (next: ParserRun) => {
    await prisma.setting.upsert({ where: { key }, create: { key, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
    run = next;
  };
  if (run?.phase === "ready") return run.text ?? null;
  if (run?.phase === "failed") throw new ActionError("The optional parser failed for this posting. Check the saved run in your provider console.");
  if (run?.phase === "triggering") throw new ActionError("The parser request needs review in your provider console before it can be retried.");
  if (!run) {
    // A unique insert claims this URL before a chargeable request, including across restarts.
    const claimed: ParserRun = { phase: "triggering", at: new Date().toISOString() };
    try { await prisma.setting.create({ data: { key, value: JSON.stringify(claimed) } }); } catch { throw new ActionError("This posting is already being parsed. Try again on the next run."); }
    run = claimed;
    if (config.provider === "apify") {
      const result = object(await vendorJson(`https://api.apify.com/v2/actor-tasks/${encodeURIComponent(config.taskId)}/runs?timeout=300&maxItems=1&maxTotalChargeUsd=${config.maxChargeUsd}`, config.key, { method: "POST", body: JSON.stringify(input) }, signal));
      const data = object(result.data);
      const id = string(data.id); const datasetId = string(data.defaultDatasetId);
      if (!id || !datasetId) throw new ActionError("Apify did not return a run identifier. Check its console before retrying.");
      await save({ phase: "running", id, datasetId, at: run.at });
    } else {
      const result = object(await vendorJson(`https://api.brightdata.com/datasets/v3/trigger?dataset_id=${encodeURIComponent(config.datasetId)}&include_errors=true`, config.key, { method: "POST", body: JSON.stringify(input) }, signal));
      const id = string(result.snapshot_id);
      if (!id) throw new ActionError("Bright Data did not return a snapshot identifier. Check its console before retrying.");
      await save({ phase: "running", id, at: run.at });
    }
  }
  const current = run as ParserRun;
  if (!current.id || (config.provider === "apify" && !current.datasetId)) throw new ActionError("The parser journal is incomplete. Check this posting in your provider console.");
  let output: unknown;
  if (config.provider === "apify") {
    const data = object(object(await vendorJson(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(current.id!)}`, config.key, {}, signal)).data);
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(string(data.status))) { await save({ ...current, phase: "failed" }); throw new ActionError("Apify could not parse this posting."); }
    if (data.status !== "SUCCEEDED") return null;
    output = await vendorJson(`https://api.apify.com/v2/datasets/${encodeURIComponent(current.datasetId!)}/items?format=json&limit=1&offset=0`, config.key, {}, signal);
  } else {
    const progress = object(await vendorJson(`https://api.brightdata.com/datasets/v3/progress/${encodeURIComponent(current.id!)}`, config.key, {}, signal));
    if (["failed", "canceled"].includes(string(progress.status))) { await save({ ...current, phase: "failed" }); throw new ActionError("Bright Data could not parse this posting."); }
    if (progress.status !== "ready") return null;
    output = await vendorJson(`https://api.brightdata.com/datasets/v3/snapshot/${encodeURIComponent(current.id!)}?format=json`, config.key, {}, signal);
  }
  const first = object(Array.isArray(output) ? output[0] : output);
  const resultUrl = ["url", "job_url", "jobUrl", "source_url"].map((field) => string(first[field])).find(Boolean);
  if (resultUrl && linkKey(resultUrl) !== linkKey(url)) {
    await save({ ...current, phase: "failed" });
    throw new ActionError("The parser returned a different posting link. Check its saved task or output.");
  }
  const text = parserText(output, config.textField);
  if (!text) { await save({ ...current, phase: "failed" }); throw new ActionError("The parser returned no complete posting text. Check its output field."); }
  await save({ ...current, phase: "ready", text });
  return text;
}

/** Search-source detail first, then the protected page fetch, then a chosen paid parser. */
export async function enrichAgentPosting(posting: FoundPosting, signal?: AbortSignal): Promise<FoundPosting> {
  if (posting.complete) return posting;
  const description = await fullText(posting);
  if (description && description.length >= 200) return { ...posting, description, complete: true };
  if (!posting.url) return posting;
  const fetched = await fetchPosting(posting.url);
  if (fetched.ok) return { ...posting, description: fetched.text, complete: true };
  // Private addresses never leave the app, even through a remote provider.
  if (fetched.error.includes("own network") || fetched.error.includes("web address")) return posting;
  const config = await loadParserConfig();
  if (config.provider === "off") return posting;
  const text = await remoteParserText(posting.url, config, signal);
  if (!text) throw new ActionError("The optional parser is still running. This posting will be checked on the next search.");
  return { ...posting, description: text, complete: true };
}
