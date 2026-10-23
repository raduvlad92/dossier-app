import { describe, expect, it } from "vitest";

import { checkEnglishPostingLanguage, POSTING_LANGUAGE_GATE_VERSION } from "./posting-language";

const introduction = "We build fleet scheduling software for our customers. You will lead our internal IT operations.";
const english = "We are a German software company headquartered in Berlin, Germany. As Head of IT, you will lead our internal technology operations, manage the service desk and improve identity and access management. You will own the IT budget and build a reliable support service for our employees.";
const german = "Als Leiter IT übernehmen Sie die Verantwortung für unsere interne IT und führen ein Team von acht Mitarbeitenden. Sie entwickeln unsere IT-Strategie weiter, steuern externe Dienstleister und stellen den zuverlässigen Betrieb unserer Systeme sicher.";
const dutch = "Als IT-manager ben je verantwoordelijk voor de dagelijkse werking van onze interne IT-organisatie. Je geeft leiding aan een team van systeembeheerders en zorgt voor een veilige en betrouwbare werkomgeving.";

describe("independent posting body language gate", () => {
  it("exports the version used by eligibility fingerprints", () => {
    expect(POSTING_LANGUAGE_GATE_VERSION).toBe("v2:franc-min@6.2.0:body");
  });

  it.each([introduction, introduction.slice(0, -1), english])("accepts reliably detected English prose: %s", (description) => {
    expect(checkEnglishPostingLanguage(description)).toMatchObject({ allowed: true, language: "english", reason: null });
  });

  it.each([
    "Business-level German and fluent English are required to support our Berlin office.",
    "English is our working language; German is helpful but not required.",
    "You do not need to speak German. We provide language classes if you would like to learn.",
    "Fluency in either English or German is required; either language is sufficient.",
    "You must speak German, while Italian would be an advantage when working with our colleagues.",
  ])("does not confuse English human-language statements with a German ad: %s", (statement) => {
    expect(checkEnglishPostingLanguage(`${english}\n\n${statement}`).allowed).toBe(true);
  });

  it.each([
    [german, "other"],
    [dutch, "other"],
    [`${introduction}\n\n${german}`, "mixed"],
    [`${introduction}\n\n${dutch}`, "mixed"],
    [`${english}\n\nSie führen unser internes IT-Team.\nSie steuern externe Dienstleister.\nSie verantworten unser IT-Budget.`, "mixed"],
  ])("rejects substantive non-English prose: %s", (description, language) => {
    expect(checkEnglishPostingLanguage(description)).toMatchObject({ allowed: false, language, cacheable: true });
  });

  it.each(["\n\n", " "])("covers foreign duties after more than 2,048 English characters with separator %j", (separator) => {
    const body = `${Array.from({ length: 10 }, () => english).join(separator)}${separator}${german}`;
    expect(body.indexOf(german)).toBeGreaterThan(2048);
    expect(checkEnglishPostingLanguage(body)).toMatchObject({ allowed: false, language: "mixed", cacheable: true });
  });

  it.each([
    "", "IT Ops", "Head of IT", "x".repeat(500), "AWS SQL IT IAM SSO SOC NOC SaaS SAP ERP",
    "English German English German English German German English English German English German",
    "const server = new Server(); return config.language === 'German' ? response : request;",
    "You manage Microsoft Azure, TypeScript, Java, PowerShell, SAP and Siemens platforms.",
  ])("fails closed without permanent exclusion for insufficient/ambiguous prose: %s", (body) => {
    expect(checkEnglishPostingLanguage(body)).toMatchObject({ allowed: false, language: "unknown", cacheable: false });
  });

  it("does not classify technology lists or code as foreign human-language sections", () => {
    const description = `${english}\n\nPython, Java, JavaScript, TypeScript, C#, SQL, Bash, PowerShell, SAP, AWS, Azure, Microsoft 365, Jira, Okta.\n\n\`\`\`typescript\nconst server = new Server();\nreturn config.language === 'German' ? response : request;\n\`\`\`\n\nYou manage Microsoft Azure, TypeScript, Java, PowerShell, SAP and Siemens platforms.`;
    expect(checkEnglishPostingLanguage(description)).toMatchObject({ allowed: true, language: "english" });
  });

  it.each([", ", "; "])("recognizes bulleted technology lists separated with %j without dropping human requirements", (separator) => {
    const technologies = ["Python", "Java", "JavaScript", "TypeScript", "C#", "SQL", "Bash", "PowerShell", "SAP", "AWS", "Azure", "Microsoft 365", "Jira", "Okta"].join(separator);
    for (const prefix of ["", "- ", "• "]) {
      expect(checkEnglishPostingLanguage(`${introduction}\n\n${prefix}${technologies}.`).allowed).toBe(true);
    }
  });

  it("uses English context for a narrowly ranked technical business paragraph", () => {
    const statement = "You manage our Deloitte vendor contract and coordinate our global enterprise service management and infrastructure operations.";
    expect(checkEnglishPostingLanguage(`${english}\n\n${statement}`)).toMatchObject({ allowed: true, language: "english", cacheable: false });
    expect(checkEnglishPostingLanguage(statement)).toMatchObject({ allowed: false, language: "unknown", cacheable: false });
  });

  it.each([
    german.replaceAll(".", ";"),
    german.toUpperCase(),
    `${german} IT-Budget = 50000 EUR.`,
    `\`\`\`text\n${german}\n\`\`\``,
    `<pre>${german}</pre>`,
    "IT-Strategie entwickeln\nTeams erfolgreich führen\nDienstleister zuverlässig steuern\nSichere Systeme betreiben\nProzesse kontinuierlich verbessern\nMitarbeitende kompetent unterstützen\nProjekte gemeinsam planen\nVerantwortung zuverlässig übernehmen",
  ])("keeps substantive duties regardless of formatting: %s", (duties) => {
    expect(checkEnglishPostingLanguage(`${english}\n\n${duties}`)).toMatchObject({ allowed: false, cacheable: true });
  });

  it("reads HTML body prose while ignoring HTML code examples", () => {
    expect(checkEnglishPostingLanguage(`<p>${english}</p><pre>const server = new Server();</pre>`).allowed).toBe(true);
    expect(checkEnglishPostingLanguage(`<p>${english}</p><p>${german}</p>`)).toMatchObject({ allowed: false, cacheable: true });
  });

  it("is deterministic and does not let repeated English boilerplate hide foreign requirements", () => {
    const body = `${english.repeat(15)}\n\n${german}`;
    expect(checkEnglishPostingLanguage(body)).toEqual(checkEnglishPostingLanguage(body));
    expect(checkEnglishPostingLanguage(body).allowed).toBe(false);
  });

  it.each([",", ";"])("retains German requirements lists separated with %s", (separator) => {
    const requirements = [
      "Ihr Profil: Führungserfahrung, Kommunikationsstärke, Verhandlungssicherheit, Entscheidungsfreude.",
      "Ihre Kenntnisse: Netzwerkadministration, Personalverantwortung, Budgetplanung, Dienstleistersteuerung.",
      "Ihre Aufgaben: Mitarbeiterführung, Prozessoptimierung, Kostenkontrolle, Systembetreuung.",
    ].join("\n").replaceAll(",", separator);
    expect(checkEnglishPostingLanguage(`${introduction}\n\n${requirements}`).allowed).toBe(false);
  });
});
