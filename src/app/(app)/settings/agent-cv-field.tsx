"use client";

import { useRef, useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Keeps an uploaded CV's extracted text separate from the editable profile. */
export function AgentCvField({ initialName }: { initialName: string | null }) {
  const track = useTrackSave();
  const [name, setName] = useState(initialName);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    const body = new FormData();
    body.set("file", file);
    try {
      const result = await track(fetch("/api/agent/cv", { method: "POST", body }).then((response) => response.json() as Promise<{ ok: true; name: string } | { ok: false; error: string }>));
      if (!result.ok) return setError(result.error);
      setName(result.name);
      setFile(null);
      if (input.current) input.current.value = "";
      toast("Your CV is ready for matching.");
    } catch {
      setError("Couldn't upload your CV. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await track(fetch("/api/agent/cv", { method: "DELETE" }).then((response) => response.json() as Promise<{ ok: true } | { ok: false; error: string }>));
      if (!result.ok) return setError(result.error);
      setName(null);
      toast("Uploaded CV removed.");
    } catch {
      setError("Couldn't remove your CV. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return <>
    {name ? <div className="flex flex-wrap items-center justify-between gap-2"><p className="break-all text-sm">Stored CV: {name}</p><Button variant="danger-text" disabled={busy} onClick={() => void remove()}>Remove uploaded CV</Button></div>
      : <p role="note" className="rounded-control bg-warning-surface px-4 py-3 text-meta text-warning">Upload your CV to use this option. The agent needs it before it can run.</p>}
    <Input ref={input} label={name ? "Replace my CV" : "Upload my CV"} type="file" accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain" hint="PDF, Word (.docx), Markdown or text, up to 5 MB. Its text goes to your AI provider during matching and drafting." disabled={busy} inputClassName="h-auto py-2 text-sm file:mr-3 file:rounded-control file:border-0 file:bg-hover file:px-2 file:py-1" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(null); }} error={error ?? undefined} />
    <Button variant="secondary" className="self-start" disabled={!file || busy} onClick={() => void upload()}>{busy ? "Saving CV…" : "Save uploaded CV"}</Button>
  </>;
}
