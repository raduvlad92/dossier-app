import { NextResponse } from "next/server";

import { getAiProvider } from "@/lib/ai";
import { isAiConfigured } from "@/lib/ai/config";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { extractProfile } from "@/lib/ai/tasks/extract-profile";
import { removeAgentCv, storeAgentCv } from "@/lib/agent/cv";
import { profileFromCv } from "@/lib/agent/cv-profile";
import { RESUME_MAX_BYTES, RESUME_MESSAGES, resumeText } from "@/lib/resume-text";
import { route } from "@/lib/route";

export const POST = route(async (request) => {
  if (Number(request.headers.get("content-length") ?? 0) > RESUME_MAX_BYTES + 64_000) {
    return NextResponse.json({ ok: false, error: RESUME_MESSAGES.tooBig }, { status: 413 });
  }
  if (!(await isAiConfigured())) return NextResponse.json({ ok: false, error: "Choose an AI provider in Settings first: it reads your CV." }, { status: 409 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Choose a CV file." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Choose a CV file." }, { status: 400 });
  if (file.size > RESUME_MAX_BYTES) return NextResponse.json({ ok: false, error: RESUME_MESSAGES.tooBig }, { status: 413 });
  const read = await resumeText(new Uint8Array(await file.arrayBuffer()));
  if (!read.ok) return NextResponse.json({ ok: false, error: read.error }, { status: 400 });
  const [provider, options] = await Promise.all([getAiProvider(), loadTaskOptions()]);
  const result = await extractProfile(provider, { resume: read.text }, { ...options, signal: request.signal });
  const name = file.name.split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) || "My CV";
  await storeAgentCv(profileFromCv(result.data), name);
  return NextResponse.json({ ok: true, name });
});

export const DELETE = route(async () => {
  await removeAgentCv();
  return NextResponse.json({ ok: true });
});
