import { expect, test } from "@playwright/test";

import { FAKE_AI_PORT, fakeJobSearches, resetData, sql } from "./support";

test.beforeAll(resetData);
test.afterAll(async () => {
  await sql(`DELETE FROM "Setting" WHERE key LIKE 'agent%'`);
  await sql(`DELETE FROM "AgentCandidate"`);
});

test("persists multiple searches and exclusions, follows pages, and scores only one eligible unique job", async ({ page }) => {
  await page.goto("/settings?section=agent");
  while (await page.getByRole("group", { name: /^Search \d+$/ }).count() < 3) {
    await page.getByRole("button", { name: "Add another search" }).click();
  }
  const targets = [
    { keywords: "watch-e2e Head of IT", place: "Berlin", country: "de" },
    { keywords: "watch-e2e TechOps Lead", place: "Milan", country: "it" },
    { keywords: "watch-e2e IT Manager", place: "London", country: "gb" },
  ];
  for (const [index, target] of targets.entries()) {
    const search = page.getByRole("group", { name: `Search ${index + 1}`, exact: true });
    await search.getByLabel("What", { exact: true }).fill(target.keywords);
    await search.getByLabel("Where", { exact: true }).fill(target.place);
    await search.getByLabel("Country", { exact: true }).selectOption(target.country);
  }
  await page.getByLabel("Check for new jobs").selectOption("3");
  await page.getByLabel("Result pages per search, at most").selectOption("2");
  await page.getByLabel("Allowed required languages").fill("English, Italian");
  await page.getByLabel("Excluded companies").fill("KPMG\nDeloitte");
  await page.getByLabel("Excluded companies").blur();
  await page.getByRole("switch", { name: "Run the job agent" }).click();
  await expect(page.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("All changes saved")).toBeVisible();

  await page.reload();
  for (const [index, target] of targets.entries()) {
    const search = page.getByRole("group", { name: `Search ${index + 1}`, exact: true });
    await expect(search.getByLabel("What", { exact: true })).toHaveValue(target.keywords);
    await expect(search.getByLabel("Where", { exact: true })).toHaveValue(target.place);
    await expect(search.getByLabel("Country", { exact: true })).toHaveValue(target.country);
  }
  await expect(page.getByLabel("Check for new jobs")).toHaveValue("3");
  await expect(page.getByLabel("Result pages per search, at most")).toHaveValue("2");
  await expect(page.getByLabel("Allowed required languages")).toHaveValue("English, Italian");
  await expect(page.getByLabel("Excluded companies")).toHaveValue("KPMG\nDeloitte");
  await expect(page.getByRole("switch", { name: "Only postings written in English" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Exclude consultancy groups" })).toHaveAttribute("aria-checked", "true");

  const searchesBefore = await fakeJobSearches();
  const scoresBefore = (await (await fetch(`http://localhost:${FAKE_AI_PORT}/agent-scores`)).json() as { scores: unknown[] }).scores.length;
  await page.goto("/agent");
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByRole("region", { name: "Scored postings" }).getByRole("heading", { level: 3, name: "Head of IT" })).toBeVisible({ timeout: 30_000 });
  expect(await fakeJobSearches()).toBe(searchesBefore + 6);
  const candidates = await sql<{ title: string; company: string }>(`SELECT title, company FROM "AgentCandidate"`);
  expect(candidates).toEqual([{ title: "Head of IT", company: "Harbor Products" }]);
  const scores = (await (await fetch(`http://localhost:${FAKE_AI_PORT}/agent-scores`)).json() as { scores: { title: string; company: string }[] }).scores.slice(scoresBefore);
  expect(scores).toEqual([{ title: "Head of IT", company: "Harbor Products" }]);
  await expect(page.getByText(/Excluded 4:/).first()).toBeVisible();
});
