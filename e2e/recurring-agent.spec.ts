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

test("keeps the job watch usable at 320px and 390px without changing the desktop sidebar preference", async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: "dossier_sidebar", value: "expanded", url: baseURL! }]);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings?section=agent");
    const sidebar = page.getByRole("complementary");
    const main = page.getByRole("main");
    // The sidebar animates its width, so measure after the rail has settled.
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await expect.poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(48);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    for (const input of await page.getByLabel("What", { exact: true }).all()) {
      await input.scrollIntoViewIfNeeded();
      await expect(input).toBeVisible();
      await expect(input).toBeInViewport({ ratio: 1 });
      expect(await input.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth;
      })).toBe(true);
    }

    const mainWidth = await main.evaluate((element) => element.getBoundingClientRect().width);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(sidebar).not.toHaveAttribute("data-collapsed");
    await expect.poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(260);
    await expect.poll(() => main.evaluate((element) => element.getBoundingClientRect().width)).toBe(mainWidth);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect.poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(48);
    await expect.poll(() => main.evaluate((element) => element.getBoundingClientRect().width)).toBe(mainWidth);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect((await page.context().cookies()).find((cookie) => cookie.name === "dossier_sidebar")?.value).toBe("expanded");
  }
});
