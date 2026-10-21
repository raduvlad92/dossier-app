# Recurring job watch

This fork extends upstream Dossier 1.8.0. Configure it in **Settings → Job agent**, then use **Agent** to review matches and drafts.

- Save up to ten searches, each with its own title, country, location, radius, recency and remote preference. Suggested starting titles are Head of IT, TechOps Lead and IT Manager.
- New targets inherit the first saved target's location and filters. Initial setup keeps saved agent preferences, otherwise the latest Find jobs search, then your profile location. Every target remains editable.
- Repeat every 3, 6 or 12 hours, or daily at a chosen local hour. The single persistent app instance checks the schedule every minute, resumes after restart, and runs one catch-up search rather than replaying missed intervals. The browser can be closed.
- Search one to three result pages per target. All targets share one inspection/scoring budget and one draft budget. Eight scheduled searches per day fit the twelve-run rolling daily limit; manual runs wait at least an hour.
- Deduplicate by source identity and canonical job link across targets, pages and past candidates. Saved, dismissed and already applied jobs are skipped.
- Keep English-only ads and allow required spoken languages from English and Italian. Optional languages and alternatives are evaluated separately: German required rejects, German preferred can pass, English or German can pass. Mixed-language ads, incomplete descriptions and uncertain classification stay out of the match queue with a reason.
- Edit the excluded employers, including KPMG, Deloitte, PwC, EY and other consultancy groups. Name aliases are checked against the employer; incidental mentions in an ad do not alone make its employer a consultancy. Semantic classification also excludes consultancies outside the list.

Language and employer classification use the configured AI provider and can make mistakes. The Agent screen reports exclusion reasons, failed searches and work deferred by the budget. Confirmed exclusions are cached for seven days; changed content or changed filters is checked again. Uncertain or failed checks rotate behind uninspected results, so later targets can still progress. Current exclusions are checked again before preparing a draft from an older queued candidate.

## Choose a CV

Choose the current editable profile, **My uploaded CV**, or **Dossier base CV**. The base CV is rendered from the current profile, so those two choices share the same factual source.

The separate upload accepts PDF, Word, Markdown and text up to 5 MB. Dossier sends its extracted text to your chosen AI provider once to structure it, retains the checked facts encrypted, and leaves the editable profile as it is. It does not retain or attach the original file bytes. Names and skills that cannot be verified against the source are omitted, and unstated language proficiency is not invented.

The selected source is used for matching and agent drafts. Each draft stores its factual CV snapshot, so previews, PDF generation, later rewrites and email drafting continue using that CV after you change your profile or upload another CV. Export/restore carries the private CV and application snapshots as personal data; exported files should be kept private.

## Optional parsers

The existing JSearch, Adzuna or Bundesagentur job source still discovers jobs. Dossier first asks that source for complete details and then tries its protected page fetch. **Additional posting parsers** can use Apify or Bright Data when those fail; this enriches discovered job links rather than adding a separate discovery engine.

Both are off until configured and saved. They receive a job URL and parser input, never your CV. API keys are encrypted server-side and are not sent back to the browser. Tests use fake providers and make no paid calls.

For **Apify**, create a saved task that extracts one job page. Enter its task ID, token, input template and description output field. The default input is `{"startUrls":[{"url":"{{url}}"}],"maxCrawlPages":1}`; adapt it to your Actor's schema. Dossier sends a per-run `maxTotalChargeUsd` limit and requests one billed result. [Task API](https://docs.apify.com/api/v2/actor-task-runs-post).

For **Bright Data**, choose a URL-based job scraper, enter its dataset ID/token, and use its documented input schema. The default input is `{"input":[{"url":"{{url}}"}],"limit_per_input":1}`. A result limit is not a dollar cap; configure your account budget before enabling it. [Asynchronous scraper API](https://docs.brightdata.com/api-reference/rest-api/scraper/asynchronous-requests).

`{{url}}` is substituted as a JSON string value; the description field can be a dotted path. Automatic detection tries text, Markdown, job-description and content fields. Responses are capped at 2 MB and descriptions at 100,000 characters. Complete descriptions over the classifier's 20,000-character limit require manual review.

Remote run/snapshot IDs are persisted before polling, so a restart resumes the same work. Ambiguous trigger failures remain blocked for review in the provider console, preventing an automatic second charge. Pending parsing is retried by polling on a later search. Run journals and parser connections belong to the installation and are not included in portable exports. Provider credentials, account quotas, billing behavior and live parsing must be verified in your own account before relying on this connection.

## Run this fork

Use the existing upstream development and production workflows in [DEVELOPMENT.md](DEVELOPMENT.md) and [Dockerfile](Dockerfile). This is a persistent single-instance service with PostgreSQL, Chromium and `/data`; the schedule is internal to Dossier, not a T3 scheduled task. The job agent stays off until you enable it, and automatic drafts remain a separate option. Nothing applies for jobs or sends messages automatically.

The additional migration only adds nullable `Application.profileSnapshot`. Apply the normal forward migrations after backing up the existing database. The deployment wrapper retains its original production image until a custom build is selected.

Source: [raduvlad92/dossier-app](https://github.com/raduvlad92/dossier-app), under the upstream AGPL-3.0-only license.
