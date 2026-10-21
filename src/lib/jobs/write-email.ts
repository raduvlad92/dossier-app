import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { DocumentKind, VersionCause } from "@/generated/prisma/enums";
import { getAiProvider } from "@/lib/ai";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { writeEmail } from "@/lib/ai/tasks";
import { extractedOf, matchSchema, unitsSchema, type Unit } from "@/lib/application-data";
import { emailParts } from "@/lib/application-email";
import { updateDocuments } from "@/lib/document-units";
import { saveVersion } from "@/lib/document-versions";
import { isParagraph } from "@/lib/letter-frame";
import { prisma } from "@/lib/prisma";
import { loadApplicationProfile } from "@/lib/agent/cv";

import { defineJob } from "./runner";

/** The key of an application's email writing, to find it again after a reload. */
export const emailJobKey = (applicationId: string) => `email:${applicationId}`;

/**
 * Writes the application's email (its Email tab), or writes it again: the
 * recipient the posting names, a subject and the message, saved as the
 * EMAIL document with a version of its own. Writing again keeps a recipient
 * the posting doesn't give, which the user typed in.
 */
export const writeEmailJob = defineJob({
  type: "write-email",
  input: z.object({ applicationId: z.string().min(1) }),
  result: z.object({
    /** The email as written. */
    units: unitsSchema,
    /** The email it replaced, for Undo; null for the first one. */
    previous: unitsSchema.nullable(),
  }),
  async run({ applicationId }, { step, signal }) {
    await step("Writing the email");
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, include: { documents: true } });
    const unitsOf = (kind: DocumentKind): Unit[] | null => {
      const parsed = unitsSchema.safeParse(application.documents.find((document) => document.kind === kind)?.units);
      return parsed.success ? parsed.data : null;
    };
    const match = matchSchema.safeParse(application.match);

    const [provider, options, profile] = await Promise.all([getAiProvider(), loadTaskOptions(), loadApplicationProfile(applicationId)]);
    const { data, promptVersion } = await writeEmail(
      provider,
      {
        profile,
        extracted: extractedOf(application),
        match: match.success ? match.data : null,
        tone: application.tone,
        note: application.userNote,
        posting: application.postingText,
        // Only the paragraphs: the letter's sender and signature hold contact details (E8-11).
        letter: (unitsOf(DocumentKind.COVER_LETTER) ?? []).filter(isParagraph).map((unit) => unit.text),
      },
      // In the language of the resume and the letter it goes with.
      { ...options, language: application.language || options.language, signal },
    );

    if (!unitsOf(DocumentKind.EMAIL)) {
      try {
        await prisma.$transaction(async (tx) => {
          const document = await tx.document.create({ data: { applicationId, kind: DocumentKind.EMAIL, units: data, writtenWith: promptVersion } });
          await saveVersion(tx, document.id, data, { cause: VersionCause.WRITTEN });
        });
        return { units: data, previous: null };
      } catch (error) {
        // Written meanwhile: write over it, as below.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      }
    }

    const written = await updateDocuments(
      applicationId,
      async (documents) => {
        const previous = documents[DocumentKind.EMAIL] ?? [];
        const kept = emailParts(previous).to;
        const units = data.map((unit) => (unit.id === "to" && !unit.text && kept ? { ...unit, text: kept } : unit));
        documents[DocumentKind.EMAIL] = units;
        return { units, previous };
      },
      { version: { cause: VersionCause.WRITTEN } },
    );
    await prisma.document.updateMany({ where: { applicationId, kind: DocumentKind.EMAIL }, data: { writtenWith: promptVersion } });
    return written;
  },
});

export type WriteEmailResult = z.infer<typeof writeEmailJob.result>;
