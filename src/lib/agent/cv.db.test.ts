import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { createApplicationFromDocuments } from "@/lib/application-create";
import { loadDocuments } from "@/lib/application-documents";
import { buildExport } from "@/lib/data-export";
import { importExport, parseExport } from "@/lib/data-import";
import { demoProfile } from "@/lib/demo-profile";
import { loadProfile } from "@/lib/profile-data";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../prisma/seed/built-ins";

import { agentCvUploadName, loadAgentProfile, loadApplicationProfile, removeAgentCv, storeAgentCv } from "./cv";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "test-only-agent-cv-encryption-secret-over-32-characters", DOSSIER_DATA_DIR: "/tmp/dossier-agent-cv-test" } }));

const prisma = () => db.client!;
const uploaded = () => {
  const profile = demoProfile();
  profile.basics.name = "Uploaded Candidate";
  profile.basics.headline = "Head of IT";
  profile.skills = [{ id: "uploaded-terraform", name: "Terraform" }];
  profile.experience = [{ ...profile.experience[0], id: "uploaded-role", role: "IT Manager", company: "Uploaded Corporation", skillIds: ["uploaded-terraform"] }];
  return profile;
};

beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await prisma().profileField.createMany({ data: [{ key: "name", value: "Editable Candidate" }, { key: "headline", value: "Product Designer" }] });
  await saveSettings({ pageLimit: "none" });
});
afterAll(() => prisma().$disconnect());

describe("job agent CV selection", () => {
  it("uses the selected uploaded CV without replacing or merging the editable profile", async () => {
    const before = await loadProfile();
    await storeAgentCv(uploaded(), "my-cv.pdf");
    await saveSettings({ agentCvSource: "uploaded" });
    expect(await loadAgentProfile()).toEqual(uploaded());
    expect((await loadAgentProfile()).experience[0].company).toBe("Uploaded Corporation");
    expect(await loadProfile()).toEqual(before);
    expect((await loadProfile()).basics.name).toBe("Editable Candidate");
  });

  it.each(["profile", "generated"] as const)("uses current profile facts for %s instead of the stored upload", async (agentCvSource) => {
    await storeAgentCv(uploaded(), "my-cv.pdf");
    await saveSettings({ agentCvSource });
    expect(await loadAgentProfile()).toEqual(await loadProfile());
    expect((await loadAgentProfile()).basics.name).toBe("Editable Candidate");
  });

  it("explains a selected but missing upload and never falls back to a different CV", async () => {
    await saveSettings({ agentCvSource: "uploaded" });
    await expect(loadAgentProfile()).rejects.toThrow("Upload your CV in Settings");
  });

  it("encrypts CV facts with a fresh IV and removes only the upload's stored values", async () => {
    await storeAgentCv(uploaded(), "my-cv.pdf");
    const first = await prisma().setting.findUniqueOrThrow({ where: { key: "agentCvUploadEnc" } });
    expect(first.value).toMatch(/^v1\./);
    expect(first.value).not.toMatch(/Uploaded Candidate|Uploaded Corporation|Terraform|@example/);
    expect(await agentCvUploadName()).toBe("my-cv.pdf");
    await storeAgentCv(uploaded(), "new-cv.pdf");
    const second = await prisma().setting.findUniqueOrThrow({ where: { key: "agentCvUploadEnc" } });
    expect(second.value).not.toBe(first.value);
    await saveSettings({ agentCvSource: "uploaded" });
    expect(await loadAgentProfile()).toEqual(uploaded());
    await removeAgentCv();
    expect(await agentCvUploadName()).toBeNull();
    expect(await prisma().setting.findUnique({ where: { key: "agentCvUploadEnc" } })).toBeNull();
    expect(await prisma().setting.findUnique({ where: { key: "agentCvSource" } })).not.toBeNull();
    expect((await loadProfile()).basics.name).toBe("Editable Candidate");
    await expect(loadAgentProfile()).rejects.toThrow("Upload your CV in Settings");
  });

  it("fails clearly on damaged ciphertext without leaking its value", async () => {
    await storeAgentCv(uploaded(), "my-cv.pdf");
    await saveSettings({ agentCvSource: "uploaded" });
    await prisma().setting.update({ where: { key: "agentCvUploadEnc" }, data: { value: "secret-malformed-ciphertext" } });
    await expect(loadAgentProfile()).rejects.toThrow("Your saved CV cannot be read");
    await expect(loadAgentProfile()).rejects.not.toThrow("secret-malformed-ciphertext");
  });
});

describe("application CV snapshots", () => {
  it("exports portable CV facts and application snapshots, then restores and reencrypts the upload", async () => {
    const profile = uploaded();
    await storeAgentCv(profile, "portable-cv.pdf");
    await saveSettings({ agentCvSource: "uploaded" });
    const { id } = await prisma().application.create({ data: { title: "Snapshot export", profileSnapshot: JSON.parse(JSON.stringify(profile)) } });
    const encrypted = (await prisma().setting.findUniqueOrThrow({ where: { key: "agentCvUploadEnc" } })).value;

    const exported = await buildExport(prisma());
    expect(exported.agentCv).toEqual({ name: "portable-cv.pdf", profile });
    expect(exported.applications.find((application) => application.id === id)?.profileSnapshot).toEqual(profile);
    expect(exported.settings.map((setting) => setting.key)).not.toEqual(expect.arrayContaining(["agentCvUploadEnc", "agentCvUploadName"]));
    expect(JSON.stringify(exported)).not.toContain(encrypted);
    const parsed = parseExport(JSON.stringify(exported));
    if (!parsed.ok) throw new Error(parsed.error);

    await removeAgentCv();
    await prisma().application.deleteMany();
    await prisma().profileField.update({ where: { key: "name" }, data: { value: "Changed since export" } });
    await importExport(prisma(), parsed.data);

    expect(await agentCvUploadName()).toBe("portable-cv.pdf");
    expect(await loadAgentProfile()).toEqual(profile);
    expect(await loadApplicationProfile(id)).toEqual(profile);
    expect((await loadProfile()).basics.name).toBe("Editable Candidate");
    const restored = (await prisma().setting.findUniqueOrThrow({ where: { key: "agentCvUploadEnc" } })).value;
    expect(restored).toMatch(/^v1\./);
    expect(restored).not.toBe(encrypted);
    expect(restored).not.toContain("Uploaded Candidate");
  });

  it("persists the chosen CV when a draft is created, including rendering after selection/profile/upload changes", async () => {
    await storeAgentCv(uploaded(), "my-cv.pdf");
    await saveSettings({ agentCvSource: "uploaded" });
    const profile = await loadAgentProfile();
    const candidate = await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "snapshot-test", dedupeKey: "snapshot-test", status: "DRAFTING" } });
    const extracted = { title: "Head of IT · Hiring Company", company: "Hiring Company", role: "Head of IT", location: null, mode: null, salary: null, deadline: null, requirements: [], asksForReferences: false, language: "English" };
    const applicationId = await createApplicationFromDocuments({
      reading: { posting: "Hiring Company is hiring a Head of IT.", extracted, extractedWith: "test", matchedWith: "test" },
      documents: {
        resume: [{ id: "summary", label: "Summary", text: "IT operations leader." }], resumeWith: "test",
        letter: [{ id: "paragraph:1", label: "Opening", text: "I would like to lead your IT function." }], letterWith: "test",
      },
      match: { items: [] },
      details: { title: "Head of IT · Hiring Company", company: "Hiring Company", role: "Head of IT", location: "Berlin", mode: "Hybrid", salary: "", deadline: "" },
      postingUrl: "https://example.com/it-job", tone: "WARM", note: "",
      claim: { kind: "agent", candidateId: candidate.id, score: 92 }, profileOverride: profile,
    });
    expect((await prisma().application.findUniqueOrThrow({ where: { id: applicationId } })).profileSnapshot).toEqual(profile);

    await saveSettings({ agentCvSource: "generated" });
    await prisma().profileField.update({ where: { key: "name" }, data: { value: "Changed Editable Candidate" } });
    const replacement = uploaded();
    replacement.basics.name = "Replacement Upload";
    replacement.experience[0].company = "Replacement Corporation";
    await storeAgentCv(replacement, "replacement.pdf");
    await removeAgentCv();

    expect(await loadApplicationProfile(applicationId)).toEqual(profile);
    expect((await loadDocuments(applicationId)).profile).toEqual(profile);
    expect((await loadDocuments(applicationId)).letter?.units.find((unit) => unit.id === "sender")?.text).toContain("Uploaded Candidate");
    expect((await loadAgentProfile()).basics.name).toBe("Changed Editable Candidate");
  });

  it("keeps legacy applications on the editable profile even when the agent selects an upload", async () => {
    const { id } = await prisma().application.create({ data: {} });
    await storeAgentCv(uploaded(), "my-cv.pdf");
    await saveSettings({ agentCvSource: "uploaded" });
    expect((await loadApplicationProfile(id)).basics.name).toBe("Editable Candidate");
  });

  it.each([{}, false, 0, ""])("rejects malformed non-null snapshots rather than mixing in new facts: %j", async (profileSnapshot) => {
    const { id } = await prisma().application.create({ data: { profileSnapshot: profileSnapshot as Prisma.InputJsonValue } });
    await expect(loadApplicationProfile(id)).rejects.toThrow("saved CV cannot be read");
  });
});
