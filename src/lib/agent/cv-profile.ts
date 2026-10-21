import { z } from "zod";

import { LanguageLevel } from "@/generated/prisma/enums";
import { BASICS_FIELDS, basicsFromFields, sameName, type DateSpan, type ProfileData } from "@/lib/profile";
import type { ImportedProfile } from "@/lib/profile-import";

const span = {
  startYear: z.number().int().nullable(), startMonth: z.number().int().min(1).max(12).nullable(),
  endYear: z.number().int().nullable(), endMonth: z.number().int().min(1).max(12).nullable(), current: z.boolean(),
};
export const cvProfileSchema = z.object({
  basics: z.object({ ...Object.fromEntries(BASICS_FIELDS.map((field) => [field, z.string()])) as Record<(typeof BASICS_FIELDS)[number], z.ZodString>, showAge: z.boolean() }),
  skills: z.array(z.object({ id: z.string(), name: z.string() })),
  languages: z.array(z.object({ id: z.string(), name: z.string(), level: z.enum(LanguageLevel) })),
  experience: z.array(z.object({ id: z.string(), role: z.string(), company: z.string(), location: z.string(), bullets: z.string(), skillIds: z.array(z.string()), ...span })),
  projects: z.array(z.object({ id: z.string(), name: z.string(), link: z.string(), bullets: z.string(), skillIds: z.array(z.string()), ...span })),
  education: z.array(z.object({ id: z.string(), degree: z.string(), school: z.string(), notes: z.string(), ...span })),
  references: z.array(z.object({ id: z.string(), name: z.string(), relation: z.string(), company: z.string(), email: z.string(), phone: z.string() })),
});

function datesOf(entry: DateSpan): DateSpan {
  return { startYear: entry.startYear, startMonth: entry.startMonth, endYear: entry.endYear, endMonth: entry.endMonth, current: entry.current };
}

/** A separate CV never replaces the editable profile. Unverified names stay out. */
export function profileFromCv(imported: ImportedProfile): ProfileData {
  const skills = imported.skills.filter((skill) => skill.found).map((skill, i) => ({ id: `cv-skill-${i}`, name: skill.name }));
  const skillIds = (names: string[]) => names.flatMap((name) => skills.find((skill) => sameName(skill.name, name))?.id ?? []);
  const basics = basicsFromFields(BASICS_FIELDS.map((key) => ({ key, value: imported.basics[key] ?? "" })));
  return {
    basics: { ...basics, showAge: false }, skills,
    // The importer uses B2 as an editable placeholder when no level was stated.
    // A private CV has no confirmation step, so it cannot assert that proficiency.
    languages: imported.languages.filter((entry) => entry.levelGiven).map((entry, i) => ({ id: `cv-language-${i}`, name: entry.name, level: entry.level })),
    experience: imported.experience.filter((entry) => entry.unverified.length === 0).map((entry, i) => ({
      id: `cv-role-${i}`, role: entry.role, company: entry.company, location: entry.location,
      bullets: entry.bullets, skillIds: skillIds(entry.skills), ...datesOf(entry),
    })),
    projects: imported.projects.filter((entry) => entry.unverified.length === 0).map((entry, i) => ({
      id: `cv-project-${i}`, name: entry.name, link: entry.link, bullets: entry.bullets,
      skillIds: skillIds(entry.skills), ...datesOf(entry),
    })),
    education: imported.education.filter((entry) => entry.unverified.length === 0).map((entry, i) => ({
      id: `cv-education-${i}`, degree: entry.degree, school: entry.school, notes: entry.notes, ...datesOf(entry),
    })),
    references: [],
  };
}
