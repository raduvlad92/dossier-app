import { describe, expect, it } from "vitest";

import { BASICS_FIELDS } from "@/lib/profile";
import type { ImportedProfile } from "@/lib/profile-import";

import { cvProfileSchema, profileFromCv } from "./cv-profile";

const span = { startYear: 2020, startMonth: 3, endYear: null, endMonth: null, current: true };
const imported = (): ImportedProfile => ({
  basics: { name: "CV Candidate", headline: "Head of IT", summary: "IT operations leader." },
  skills: [{ name: "Terraform", found: true }, { name: "Imaginary Skill", found: false }],
  languages: [{ name: "English", level: "C1", levelGiven: true }, { name: "Italian", level: "B2", levelGiven: false }],
  experience: [
    { role: "IT Manager", company: "CV Company", location: "Milan", bullets: "Led internal IT operations.", skills: ["terraform", "Imaginary Skill"], ...span, unverified: [] },
    { role: "Chief Scientist", company: "Invented Company", location: "", bullets: "Unconfirmed.", skills: [], ...span, unverified: ["Invented Company"] },
  ],
  projects: [
    { name: "CV Platform", link: "https://example.com/platform", bullets: "Built an internal platform.", skills: ["TERRAFORM"], ...span, unverified: [] },
    { name: "Imaginary Project", link: "", bullets: "", skills: [], ...span, unverified: ["Imaginary Project"] },
  ],
  education: [
    { degree: "Computer Science", school: "CV University", notes: "Systems focus", ...span, unverified: [] },
    { degree: "Imaginary Degree", school: "Invented University", notes: "", ...span, unverified: ["Invented University"] },
  ],
  references: [{ name: "Private Reference", relation: "Manager", company: "CV Company", email: "private@example.com", phone: "12345", unverified: [] }],
});

describe("private CV profile", () => {
  it("keeps confirmed facts in a complete profile without altering the imported reading", () => {
    const input = imported();
    const original = structuredClone(input);
    const profile = profileFromCv(input);
    expect(profile.basics).toMatchObject({ name: "CV Candidate", headline: "Head of IT", showAge: false, email: "" });
    expect(Object.keys(profile.basics).sort()).toEqual([...BASICS_FIELDS, "showAge"].sort());
    expect(profile.skills).toEqual([{ id: "cv-skill-0", name: "Terraform" }]);
    expect(profile.experience).toEqual([{ id: "cv-role-0", role: "IT Manager", company: "CV Company", location: "Milan", bullets: "Led internal IT operations.", skillIds: ["cv-skill-0"], ...span }]);
    expect(profile.projects).toEqual([{ id: "cv-project-0", name: "CV Platform", link: "https://example.com/platform", bullets: "Built an internal platform.", skillIds: ["cv-skill-0"], ...span }]);
    expect(profile.education).toEqual([{ id: "cv-education-0", degree: "Computer Science", school: "CV University", notes: "Systems focus", ...span }]);
    expect(profile.references).toEqual([]);
    expect(JSON.stringify(profile)).not.toMatch(/unverified|Imaginary|Invented|private@example/);
    expect(cvProfileSchema.parse(profile)).toEqual(profile);
    expect(input).toEqual(original);
  });

  it("does not turn the importer's default B2 placeholder into a claimed proficiency", () => {
    expect(profileFromCv(imported()).languages).toEqual([{ id: "cv-language-0", name: "English", level: "C1" }]);
  });

  it("reads an empty CV without copying facts from the editable profile", () => {
    const profile = profileFromCv({ basics: {}, skills: [], languages: [], experience: [], projects: [], education: [], references: [] });
    expect(profile.basics.name).toBe("");
    expect(profile.basics.showAge).toBe(false);
    for (const key of ["skills", "languages", "experience", "projects", "education", "references"] as const) expect(profile[key]).toEqual([]);
  });

  it("refuses damaged snapshot dates instead of rendering a month outside the calendar", () => {
    const profile = profileFromCv(imported());
    profile.experience[0].startMonth = 13;
    expect(cvProfileSchema.safeParse(profile).success).toBe(false);
  });
});
