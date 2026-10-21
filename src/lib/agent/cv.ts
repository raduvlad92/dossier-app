import "server-only";

import { ActionError } from "@/lib/action";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { decryptSecret, encryptSecret, type SecretKind } from "@/lib/secrets";
import { loadSettings } from "@/lib/settings-data";
import type { ProfileData } from "@/lib/profile";

import { cvProfileSchema } from "./cv-profile";

const CV_KEY = "agentCvUploadEnc";
const CV_NAME = "agentCvUploadName";
export const AGENT_CV_SECRET: SecretKind = { purpose: "api-key-encryption", associatedData: "dossier agent cv v1" };

export async function agentCvUploadName(): Promise<string | null> {
  return (await prisma.setting.findUnique({ where: { key: CV_NAME } }))?.value ?? null;
}

export async function storeAgentCv(profile: ProfileData, name: string): Promise<void> {
  const encrypted = encryptSecret(AGENT_CV_SECRET, JSON.stringify(cvProfileSchema.parse(profile)));
  await prisma.$transaction([
    prisma.setting.upsert({ where: { key: CV_KEY }, create: { key: CV_KEY, value: encrypted }, update: { value: encrypted } }),
    prisma.setting.upsert({ where: { key: CV_NAME }, create: { key: CV_NAME, value: name }, update: { value: name } }),
  ]);
}

export async function removeAgentCv(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: { in: [CV_KEY, CV_NAME] } } });
}

/** The base CV is rendered directly from the current profile in Dossier. */
export async function loadAgentProfile(source?: "profile" | "uploaded" | "generated"): Promise<ProfileData> {
  const agentCvSource = source ?? (await loadSettings()).agentCvSource;
  if (agentCvSource !== "uploaded") return loadProfile();
  const stored = await prisma.setting.findUnique({ where: { key: CV_KEY } });
  if (!stored) throw new ActionError("Upload your CV in Settings → Job agent, or choose another CV source.");
  try {
    return cvProfileSchema.parse(JSON.parse(decryptSecret(AGENT_CV_SECRET, stored.value)));
  } catch {
    throw new ActionError("Your saved CV cannot be read. Upload it again in Settings → Job agent.");
  }
}

/** Drafts retain their factual CV when the selection or editable profile changes. */
export async function loadApplicationProfile(applicationId: string): Promise<ProfileData> {
  const application = await prisma.application.findUnique({ where: { id: applicationId }, select: { profileSnapshot: true } });
  if (application && application.profileSnapshot !== null) {
    const parsed = cvProfileSchema.safeParse(application.profileSnapshot);
    if (!parsed.success) throw new ActionError("This application's saved CV cannot be read. Restore it from a backup.");
    return parsed.data;
  }
  return loadProfile();
}
