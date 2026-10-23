import { expect, test, type Page } from "@playwright/test";

import { MANUAL_FILTER_POSTINGS } from "./manual-filter-fixtures.mts";
import { FAKE_AI_PORT, FAKE_JOBS_PORT, fakeJobSearches, resetData, sql } from "./support";

type SourceRequest = { path: string; query: string | null; cursor: string | null };
type ModelRequest = { path: string; schema: string | null };

async function calls() {
  const [searches, sourceResponse, modelResponse] = await Promise.all([
    fakeJobSearches(),
    fetch(`http://localhost:${FAKE_JOBS_PORT}/requests`),
    fetch(`http://localhost:${FAKE_AI_PORT}/requests`),
  ]);
  expect(sourceResponse.ok).toBe(true);
  expect(modelResponse.ok).toBe(true);
  return {
    searches,
    sources: ((await sourceResponse.json()) as { requests: SourceRequest[] }).requests,
    models: ((await modelResponse.json()) as { requests: ModelRequest[] }).requests,
  };
}

async function search(page: Page, keywords: string) {
  await page.goto(`/jobs?q=${keywords}&where=Berlin&country=de`);
  await page.getByRole("search", { name: "Search postings" }).getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/jobs\?search=c/);
  return new URL(page.url()).searchParams.get("search")!;
}

async function expectOnlyEligible(page: Page) {
  const list = page.getByRole("list", { name: "Postings", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("button", { name: /^Head of IT / })).toContainText("Harbor Products");
  await expect(page.getByRole("heading", { level: 2, name: "Head of IT", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Posting text" })).toContainText("Italian is required.");
  for (const excluded of MANUAL_FILTER_POSTINGS.slice(1)) {
    await expect(list.getByText(excluded.title, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: excluded.title, exact: true })).toHaveCount(0);
  }
}

async function revisitWithoutCalls(page: Page, searchId: string, summary: string) {
  await page.waitForLoadState("networkidle");
  const before = await calls();
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: summary })).toBeVisible();
  await page.getByRole("link", { name: /^Past searches/ }).click();
  // Use the retained search's link, rather than running the filled-in search form.
  await page.locator(`a[href="/jobs?search=${searchId}"]`).click();
  await expect(page.getByRole("status").filter({ hasText: summary })).toBeVisible();
  await page.goto("/jobs");
  await expect(page.getByRole("status").filter({ hasText: summary })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await calls()).toEqual(before);
}

test.beforeEach(resetData);

test("manual Find jobs applies the default language and employer rules with the scheduler off", async ({ page }) => {
  // No agent settings are saved: this must exercise the strict defaults.
  expect(await sql(`SELECT key FROM "Setting" WHERE key IN ('agentEnabled', 'agentExclusions')`)).toEqual([]);
  await page.goto("/settings?section=agent");
  await expect(page.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Only postings written in English" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Allowed required languages")).toHaveValue("English, Italian");
  await expect(page.getByRole("switch", { name: "Exclude consultancy groups" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Excluded companies")).toHaveValue(/KPMG/);

  const before = await calls();
  const searchId = await search(page, "manual-filter-mixed-e2e");
  const summary = "1 eligible · 4 excluded · 0 unchecked · 5 source results";
  await expect(page.getByText("Your current rules apply to Find jobs searches and the Job agent, even when its schedule is off.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: summary })).toBeVisible();
  await expectOnlyEligible(page);
  await page.getByText("Why results are hidden", { exact: true }).click();
  for (const reason of [
    "The job description is not entirely in English.",
    "The posting requires a language outside your allowed languages.",
    "Employer is on your exclusion list (KPMG).",
    "The hiring employer is a consultancy or outsourcing group.",
  ]) await expect(page.getByText(`${reason} (1)`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recheck saved results", exact: true })).toHaveCount(0);

  const after = await calls();
  expect(after.searches).toBe(before.searches + 1);
  expect(after.models.slice(before.models.length).filter((call) => call.schema === "agent_posting_exclusions")).toHaveLength(3);
  // Rejected source results stay in the saved search, with their exact identities.
  const [retained] = await sql<{ found: number; postings: { externalId: string }[] }>(`SELECT found, postings FROM "PostingSearch" WHERE id = $1`, [searchId]);
  expect(retained.found).toBe(5);
  expect(retained.postings.map((posting) => posting.externalId)).toEqual(MANUAL_FILTER_POSTINGS.map((posting) => posting.externalId));
  await revisitWithoutCalls(page, searchId, summary);
  await expectOnlyEligible(page);
  expect(await sql(`SELECT key FROM "Setting" WHERE key = 'agentEnabled'`)).toEqual([]);
});

test("keeps advancing the source cursor when consecutive pages are entirely excluded", async ({ page }) => {
  const before = await calls();
  const searchId = await search(page, "manual-filter-pages-e2e");
  await expect(page.getByRole("status").filter({ hasText: "0 eligible · 2 excluded · 0 unchecked · 2 source results" })).toBeVisible();
  await expect(page.getByText("No results match your current rules. Excluded postings remain stored with this search.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Postings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Recheck saved results", exact: true })).toHaveCount(0);
  expect(await sql(`SELECT next FROM "PostingSearch" WHERE id = $1`, [searchId])).toEqual([{ next: "cursor:MANUAL-FILTER-PAGE-2" }]);

  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "0 eligible · 4 excluded · 0 unchecked · 4 source results" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Postings", exact: true })).toHaveCount(0);
  expect(await sql(`SELECT next FROM "PostingSearch" WHERE id = $1`, [searchId])).toEqual([{ next: "cursor:MANUAL-FILTER-PAGE-3" }]);
  await revisitWithoutCalls(page, searchId, "0 eligible · 4 excluded · 0 unchecked · 4 source results");

  await page.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 eligible · 4 excluded · 0 unchecked · 5 source results" })).toBeVisible();
  await expectOnlyEligible(page);
  await expect(page.getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
  const after = await calls();
  expect(after.searches).toBe(before.searches + 3);
  expect(after.sources.slice(before.sources.length).map(({ path, cursor }) => ({ path, cursor }))).toEqual([
    { path: "/jsearch/search-v2", cursor: null },
    { path: "/jsearch/search-v2", cursor: "MANUAL-FILTER-PAGE-2" },
    { path: "/jsearch/search-v2", cursor: "MANUAL-FILTER-PAGE-3" },
  ]);
  expect(await sql(`SELECT found, next FROM "PostingSearch" WHERE id = $1`, [searchId])).toEqual([{ found: 5, next: null }]);
});

test("holds legacy history until an explicit recheck sanitizes it without another source search", async ({ page }) => {
  const searchId = "e2e-legacy-manual";
  const query = { keywords: "legacy Head of IT", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" };
  await sql(`INSERT INTO "PostingSearch" (id, source, query, postings, found, next, "createdAt", "updatedAt") VALUES ($1, 'JSEARCH', $2::jsonb, $3::jsonb, 5, NULL, now(), now())`,
    [searchId, JSON.stringify(query), JSON.stringify(MANUAL_FILTER_POSTINGS)]);
  const before = await calls();
  await page.goto(`/jobs?search=${searchId}`);
  const summary = "0 eligible · 0 excluded · 5 unchecked · 5 source results";
  await expect(page.getByRole("status").filter({ hasText: summary })).toBeVisible();
  await expect(page.getByRole("list", { name: "Postings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Posting text" })).toHaveCount(0);
  await expect(page.getByText("No eligible postings are ready to show. Unchecked results stay hidden until they are verified against your current rules.")).toBeVisible();
  for (const action of ["Save", "Score", "Start application →"]) {
    await expect(page.getByRole("button", { name: action, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Recheck saved results", exact: true })).toBeEnabled();
  await revisitWithoutCalls(page, searchId, summary);
  expect(await calls()).toEqual(before);
  const [untouched] = await sql<{ postings: unknown[] }>(`SELECT postings FROM "PostingSearch" WHERE id = $1`, [searchId]);
  expect(untouched.postings).toEqual(MANUAL_FILTER_POSTINGS);

  await page.getByRole("button", { name: "Recheck saved results", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rechecking saved results…", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "1 eligible · 4 excluded · 0 unchecked · 5 source results" })).toBeVisible();
  await expectOnlyEligible(page);
  await expect(page.getByRole("button", { name: "Recheck saved results", exact: true })).toHaveCount(0);
  const checked = await calls();
  expect(checked.searches).toBe(before.searches);
  expect(checked.sources).toEqual(before.sources);
  expect(checked.models.slice(before.models.length).filter((call) => call.schema === "agent_posting_exclusions")).toHaveLength(3);
  expect(await sql(`SELECT found, next FROM "PostingSearch" WHERE id = $1`, [searchId])).toEqual([{ found: 5, next: null }]);
  await revisitWithoutCalls(page, searchId, "1 eligible · 4 excluded · 0 unchecked · 5 source results");
});

test("opens incomplete saved and dismissed history without automatically loading or checking it", async ({ page }) => {
  const snippet = "Harbor Products builds its own software products. We are hiring an IT leader to support our employees and manage our internal systems.";
  for (const [index, title] of ["Saved incomplete Head of IT", "Dismissed incomplete IT Manager"].entries()) {
    // No public URL: even a regression must stay entirely within fake services.
    await sql(`INSERT INTO "Posting" (id, source, "externalId", title, company, description, complete, "savedAt", "dismissedAt", "createdAt", "updatedAt") VALUES ($1, 'JSEARCH', $1, $2, 'Harbor Products', $3, false, $4, $5, now(), now())`,
      [`manual-incomplete-${index}`, title, snippet, index === 0 ? new Date() : null, index === 1 ? new Date() : null]);
  }
  const automaticActions: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/jobs") automaticActions.push(request.url());
  });
  const before = await calls();
  for (const [view, title] of [["saved", "Saved incomplete Head of IT"], ["dismissed", "Dismissed incomplete IT Manager"]]) {
    await page.goto(`/jobs?view=${view}`);
    await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Posting text" })).toContainText(snippet);
    await expect(page.getByRole("button", { name: "Check and load full text", exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole("region", { name: "Posting text" })).toContainText(snippet);
    await page.waitForLoadState("networkidle");
  }
  expect(automaticActions).toEqual([]);
  expect(await calls()).toEqual(before);
  expect(await sql(`SELECT complete FROM "Posting" WHERE id LIKE 'manual-incomplete-%' ORDER BY id`)).toEqual([{ complete: false }, { complete: false }]);
});
