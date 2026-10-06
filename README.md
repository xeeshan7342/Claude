# Campaign Bulk Builder

Turns a Google Ads campaign structure doc into one file you can import into Google Ads Editor. Load the doc, check what the tool found, fix anything it flags, and download the CSV.

It runs entirely in the browser. Docs are never uploaded. The only time anything leaves your computer is when you choose **Read with AI**, and then only the doc text goes to Anthropic's API under your own key.

## Ways to use it

**Online.** Once GitHub Pages is switched on (see below), the tool lives at `https://xeeshan7342.github.io/Claude/`.

**Offline, by double-click.** Download `campaign-builder.html` (linked at the bottom of the online tool, or build it with `npm run build`) and open it in Chrome, Edge, Firefox or Safari. Everything is inside that one file. Without internet it uses system fonts, and AI reading needs a connection.

**From a copy of this repo.** Open `app/index.html` directly. It needs no server and no build step.

## What docs it understands

Word (.docx), Excel (.xlsx, every visible tab), CSV and TSV (including Ads Editor exports), text and Markdown. From Google Docs use File, Download, Microsoft Word (.docx). From Google Sheets use .xlsx. You can also paste text.

The same campaign can be written up in many ways, and the reader handles these:

- Ad groups as headings with or without the words "Ad Group", as table rows, as table columns, as spreadsheet tabs, or as a plain line before a Keywords list.
- Campaigns from a campaign table (`Campaign | Ad Groups | Budget`), from `Campaign 1: ...` headings, from several headings that each hold ad groups, or from `Campaign | name` blocks in a settings tab.
- Keywords as lists, comma lists, tables, columns per match type (`Exact | Phrase | Broad`) or Keyword Planner pastes (search volume, CPC and competition columns are dropped). `[exact]`, `"phrase"`, `keyword (broad)` and `+broad` keep their match type, and `-keyword` is read as a negative.
- Headlines and descriptions as lists, tables with a character-count column, one row per asset (`Asset | Text`), numbered lines (`Headline 3: ...`, `H2 - ...`), `A | B | C` lines or one mixed "Ad copy" list (split by length). Keyword insertion such as `{KeyWord:Dental Implants}` is counted by its default text, as Google does.
- Negative keywords at account, campaign or ad group level, whatever the heading calls them. That includes one column per campaign, a `Level` column, and labels such as `Brand only:` or `Account level (all campaigns):`.
- Settings: final URL, budgets in any currency and number format (`$1,500`, `1.500 €`, `CHF 1'200`, `₹2,00,000`, lakh, crore, k, million; daily, weekly, monthly or yearly, also in common non-English words; monthly is divided by 30.4), locations (all 249 countries with their Google location IDs; states, provinces and other first-level regions worldwide; cities, with the country added for big cities written alone), languages, bid strategy, target CPA, max CPC, match type, search partners, presence-only and start date. Bid strategy, target CPA, locations and languages can differ per campaign.
- Answers copied from ChatGPT or Claude (icons, bold labels, `---` rules) and plain-text pastes where only blank lines separate the sections.

Sections for Meta, Microsoft Ads, LinkedIn, TikTok and other platforms are skipped as one unit, so their copy never ends up in a Search ad.

Sitelinks, callouts, notes and strategy text are not exported. They show up in the import report instead of leaking into ads.

## The import report and memory

Every line the tool could not place is listed in the import report with the reason. For each one you can:

- **Add it** as a headline, description, keyword or negative to the right ad group.
- **Teach the tool** what lines like it mean, for example that "Search terms we block" is a negative keywords label, or that a heading is an ad group name. The doc is read again straight away, and the lesson applies to every doc you load afterwards.

Taught labels and saved **client profiles** (final URL, locations, languages, bidding and other defaults per client) are kept in this browser. Use **Export memory** to save them to a file, and **Import memory** on another computer or for a teammate, so everyone's copy reads docs the same way. A profile loads by itself when a doc's final URL matches it. A new doc never inherits the previous client's settings.

## AI reading

For docs the rules can't follow, open **AI reading**. There are two ways to use it:

- **With my Claude plan** (Pro, Max or free, no API key): click **Copy for Claude**, paste it into a new chat on claude.ai, then paste Claude's whole answer back and click **Use this answer**.
- **With an API key**: paste an Anthropic API key (create one at console.anthropic.com; API use is billed separately from a Claude plan) and click **Read with AI**. Claude Haiku 4.5 is the cheapest option.

Either way Claude returns the structure as JSON in a fixed shape. The result goes through the same model, checks and export as the rule-based read, and anything Claude could not place shows up in the import report. **Back to the rule-based read** switches back.

## Checks before export

Export is blocked until errors are fixed. Errors cover Google's hard limits and rejections: headline 30 and description 90 characters, 3 to 15 headlines and 2 to 4 descriptions, duplicate headlines, exclamation marks in headlines, emoji, repeated punctuation, invalid keyword and negative keyword characters, keyword length and word count, display path rules, missing budgets, URLs, locations or bid amounts, and start dates in the past.

Warnings don't block export: negatives that block your own keywords, the same keyword in two ad groups, phone numbers or capitalised words in ad text, budgets the doc gave without saying daily or monthly, and locations Ads Editor has to match by name.

## Importing into Google Ads Editor

1. Open the account in Ads Editor and click **Get recent changes**.
2. Go to **Account > Import > From file** and pick the CSV (or **Paste text** if you used Copy for Editor paste).
3. Check the preview, then **Finish and review changes** and **Keep**.
4. If Editor flags **EU political ads**, select the new campaigns and set it to No.
5. Check that city and region locations landed on the right place in the **Locations** tab.
6. Review, then **Post**. Campaigns arrive paused unless you chose Enabled.

## Development

```bash
npm install        # dev tools: jsdom, jszip, mammoth, the Anthropic SDK, esbuild
npm test           # node:test suite in tests/
npm run build      # writes dist/campaign-builder.html
npm run vendor     # refreshes app/vendor/ after a dependency upgrade
```

The app is plain JavaScript with no build step. Files in `app/js`:

| File | What it does |
|---|---|
| `engine.js` | Reads blocks (headings, paragraphs, lists, tables) into campaigns and ad groups, validates, and writes Ads Editor rows. Runs in Node for the tests. |
| `readers.js` | Turns .docx, .xlsx, CSV and text files into blocks. |
| `memory.js` | Taught labels and client profiles, stored in the browser, with export and import. |
| `ai.js` | The optional Claude reader: request, schema, error messages and conversion to the engine's format. |
| `app.js` | The page. |
| `sample.js` | The made-up sample doc. |

`app/vendor` holds mammoth (Word), JSZip (Excel) and a bundled copy of the Anthropic SDK, so the tool works offline and loads nothing from a CDN except fonts. Versions are in `app/vendor/VERSIONS.txt`.

Never commit real client documents to this repository. It is public.

## Deploying to GitHub Pages

The workflow in `.github/workflows/pages.yml` runs the tests on every push and pull request, and deploys the site from the repository's default branch. To switch it on once: in the repository go to **Settings > Pages** and set **Source** to **GitHub Actions**, then re-run the workflow (Actions tab) or push again. The tool is then live at `https://xeeshan7342.github.io/Claude/`, with the offline file at `/campaign-builder.html`.
