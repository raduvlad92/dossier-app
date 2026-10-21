import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { removeAgentCv, storeAgentCv } from "@/lib/agent/cv";
import { isAiConfigured } from "@/lib/ai/config";
import { extractProfile } from "@/lib/ai/tasks/extract-profile";
import { getSession } from "@/lib/auth/session";
import { messages } from "@/lib/messages";
import { RESUME_MAX_BYTES, RESUME_MESSAGES } from "@/lib/resume-text";
import { docxWith } from "@/test/resume-files";

import { DELETE, POST } from "./route";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/ai/config", () => ({ isAiConfigured: vi.fn(async () => true) }));
vi.mock("@/lib/ai", () => ({ getAiProvider: vi.fn(async () => ({ kind: "MOCK" })) }));
vi.mock("@/lib/ai/task-options", () => ({ loadTaskOptions: vi.fn(async () => ({ creativity: "FAITHFUL", strict: true, language: null })) }));
vi.mock("@/lib/ai/tasks/extract-profile", () => ({ extractProfile: vi.fn() }));
vi.mock("@/lib/agent/cv", () => ({ storeAgentCv: vi.fn(async () => {}), removeAgentCv: vi.fn(async () => {}) }));

const resume = docxWith(["CV Candidate", "Head of IT, CV Company, 2020 – present", "Led internal technology operations and infrastructure for a distributed team."]);
const formWith = (bytes = resume, name = "my-cv.docx") => {
  const form = new FormData();
  form.set("file", new File([Buffer.from(bytes)], name));
  return form;
};
const request = (method: "POST" | "DELETE", body?: BodyInit, headers: Record<string, string> = {}) => new NextRequest("http://localhost:3000/api/agent/cv", {
  method, body, headers: { origin: "http://localhost:3000", host: "localhost:3000", ...headers },
});
const post = (body = formWith(), headers: Record<string, string> = {}) => POST(request("POST", body, headers), undefined);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ persistent: false, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
  vi.mocked(isAiConfigured).mockResolvedValue(true);
  vi.mocked(extractProfile).mockResolvedValue({
    data: { basics: { name: "CV Candidate", headline: "Head of IT" }, skills: [], languages: [], experience: [], projects: [], education: [], references: [] },
    promptVersion: "test",
  });
});

describe("POST /api/agent/cv", () => {
  it("reads a file, stores a separate factual CV and returns only its sanitized name", async () => {
    const response = await post(formWith(resume, "C:\\private\\my-cv.docx"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, name: "my-cv.docx" });
    expect(extractProfile).toHaveBeenCalledWith(expect.anything(), { resume: expect.stringContaining("Head of IT, CV Company") }, expect.objectContaining({ strict: true, signal: expect.any(AbortSignal) }));
    expect(storeAgentCv).toHaveBeenCalledWith(expect.objectContaining({ basics: expect.objectContaining({ name: "CV Candidate", headline: "Head of IT", showAge: false }) }), "my-cv.docx");
  });

  it("rejects oversized declared bodies before reading the file or invoking AI", async () => {
    const response = await post(formWith(), { "content-length": String(RESUME_MAX_BYTES + 64_001) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: RESUME_MESSAGES.tooBig });
    expect(extractProfile).not.toHaveBeenCalled();
    expect(storeAgentCv).not.toHaveBeenCalled();
  });

  it.each([undefined, "1", "invalid"])("checks actual file size when the length header is %s", async (contentLength) => {
    const response = await post(formWith(new Uint8Array(RESUME_MAX_BYTES + 1), "too-big.pdf"), contentLength ? { "content-length": contentLength } : {});
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: RESUME_MESSAGES.tooBig });
    expect(extractProfile).not.toHaveBeenCalled();
    expect(storeAgentCv).not.toHaveBeenCalled();
  });

  it("requires a configured AI provider before uploading a private CV", async () => {
    vi.mocked(isAiConfigured).mockResolvedValueOnce(false);
    const response = await post();
    expect(response.status).toBe(409);
    expect(storeAgentCv).not.toHaveBeenCalled();
    expect(extractProfile).not.toHaveBeenCalled();
  });

  it.each([new FormData(), (() => { const form = new FormData(); form.set("file", "not a file"); return form; })()])("requires a file field", async (form) => {
    const response = await post(form);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Choose a CV file." });
    expect(storeAgentCv).not.toHaveBeenCalled();
  });

  it("returns a clear bad-input response for malformed form data", async () => {
    const response = await POST(request("POST", "not multipart", { "content-type": "text/plain" }), undefined);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Choose a CV file." });
    expect(extractProfile).not.toHaveBeenCalled();
  });

  it("refuses unsupported binary uploads before invoking AI", async () => {
    const response = await post(formWith(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]), "photo.png"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: RESUME_MESSAGES.wrongType });
    expect(storeAgentCv).not.toHaveBeenCalled();
    expect(extractProfile).not.toHaveBeenCalled();
  });
});

describe("private CV mutation protection", () => {
  it.each(["POST", "DELETE"] as const)("requires authentication for %s", async (method) => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await (method === "POST" ? POST : DELETE)(request(method, method === "POST" ? formWith() : undefined), undefined);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: messages.signedOut });
    expect(storeAgentCv).not.toHaveBeenCalled();
    expect(removeAgentCv).not.toHaveBeenCalled();
    expect(extractProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "https://foreign.example"], ["DELETE", "https://foreign.example"], ["POST", ""], ["DELETE", ""],
  ] as const)("refuses %s with foreign/missing origin %s", async (method, origin) => {
    const input = request(method, method === "POST" ? formWith() : undefined, { origin });
    if (!origin) input.headers.delete("origin");
    const response = await (method === "POST" ? POST : DELETE)(input, undefined);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: messages.crossOrigin });
    expect(storeAgentCv).not.toHaveBeenCalled();
    expect(removeAgentCv).not.toHaveBeenCalled();
    expect(extractProfile).not.toHaveBeenCalled();
  });

  it("removes only the stored upload through an authenticated same-origin DELETE", async () => {
    const response = await DELETE(request("DELETE"), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(removeAgentCv).toHaveBeenCalledOnce();
    expect(storeAgentCv).not.toHaveBeenCalled();
  });
});
