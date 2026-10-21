import { z } from "zod";

/** Editable employer exclusions, applied to the employer name rather than the ad text. */
export const DEFAULT_EXCLUDED_COMPANIES = [
  "KPMG",
  "Deloitte",
  "PwC",
  "PricewaterhouseCoopers",
  "EY",
  "Ernst & Young",
  "Accenture",
  "Capgemini",
  "McKinsey",
  "Boston Consulting Group",
  "BCG",
  "Bain",
  "Booz Allen",
  "BearingPoint",
  "Cognizant",
  "Infosys",
  "TCS",
  "Tata Consultancy Services",
  "Wipro",
  "NTT DATA",
  "Reply",
  "Sopra Steria",
];

// This module is shared with Settings. Provider access lives in exclusions.ts.
export const agentExclusionsSchema = z.object({
  englishOnly: z.boolean().default(true),
  /** Empty disables the spoken-language restriction. The ad-language rule is separate. */
  allowedLanguages: z.array(z.string().trim().min(1).max(80)).max(50).default(["English", "Italian"]),
  excludeConsultancies: z.boolean().default(true),
  companies: z.array(z.string().trim().min(1).max(300)).max(100).default(DEFAULT_EXCLUDED_COMPANIES),
});

export type AgentExclusions = z.output<typeof agentExclusionsSchema>;
