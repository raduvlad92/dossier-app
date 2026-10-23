import type { FoundPosting } from "../src/lib/job-search/search";

// Full, realistic descriptions: an English title or a model's language label
// must never stand in for evidence from the actual duties and requirements.
const internalRole = "You will lead our internal technology operations, manage the service desk and improve identity and access management. You will own the IT budget and build a reliable support service for our employees.";
const english = `Harbor Products builds its own software products. We develop scheduling tools that help our customers plan their work and keep their teams informed.\n\n${internalRole}\n\nWe are looking for experience leading an internal IT team, managing suppliers and improving security. English is required. Italian is required. German is optional. We provide a permanent employment contract and support professional development.`;
const german = "Rhein Products entwickelt eigene Softwareprodukte für die Planung und Verwaltung von Geschäftsprozessen. Unsere Mitarbeitenden arbeiten gemeinsam an zuverlässigen Lösungen für unsere Kunden.\n\nAls Leiter IT übernehmen Sie die Verantwortung für unsere interne IT und führen ein Team von acht Mitarbeitenden. Sie entwickeln unsere IT-Strategie weiter, steuern externe Dienstleister und stellen den zuverlässigen Betrieb unserer Systeme sicher.\n\nSie verfügen über mehrjährige Erfahrung in der Führung von technischen Teams und gestalten die Zusammenarbeit mit unseren Fachabteilungen. Wir bieten Ihnen eine unbefristete Anstellung und unterstützen Ihre berufliche Weiterentwicklung.";
const germanRequired = `Internal Systems builds its own software products. We are a software company headquartered in Berlin, Germany. As Head of IT, you will lead our internal technology operations, manage the service desk and improve identity and access management. You will own the IT budget and build a reliable support service for our employees.\n\nEnglish is required. German is required.`;
const consultancy = `Advisory Bridge provides technology consulting to external clients. Our teams deliver professional services and manage outsourced technology projects for customer organisations.\n\nWe are hiring an IT Manager to lead consulting teams and improve the services we deliver to clients. You will manage project budgets, support our consultants and coordinate delivery across several customer accounts.\n\nWe are looking for experience in technology leadership and managing client relationships. English is required. We offer a permanent contract and opportunities to develop your management skills.`;

function posting(externalId: string, title: string, company: string, description: string): FoundPosting {
  return {
    source: "JSEARCH", externalId, title, company, description,
    place: "Berlin", remote: false, salary: "", postedAt: "2026-10-20T09:00:00.000Z",
    url: `https://jobs.example/${externalId}`, via: "LinkedIn", complete: true,
  };
}

export const MANUAL_FILTER_POSTINGS = [
  posting("manual-allowed", "Head of IT", "Harbor Products", english),
  posting("manual-german-body", "Head of IT, Internal Systems", "Rhein Products", german),
  posting("manual-german-required", "TechOps Lead", "Internal Systems", germanRequired),
  posting("manual-kpmg", "IT Manager, Corporate Systems", "KPMG", `KPMG provides professional advisory services. We are hiring an IT Manager to support our employees and lead our internal technology operations.\n\n${internalRole}\n\nEnglish is required. We are looking for experience managing suppliers, supporting business teams and improving security.`),
  posting("manual-consultancy", "IT Manager, Client Delivery", "Advisory Bridge", consultancy),
];
