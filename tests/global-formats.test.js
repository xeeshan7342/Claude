'use strict';
// Currencies, countries, regions and cities from anywhere, and the layouts found in the third check. All content is made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, parseText, summary } = require('./helpers');

const budget = v => { const b = E.parseBudget('Budget', v); return b && [b.amount, b.basis]; };
const places = v => E.parseLocations(v).list.map(l => l.name + (l.id ? ' #' + l.id : ''));

test('amounts in any currency and number format', () => {
  assert.deepEqual(budget('$1,500/month'), [1500, 'monthly']);
  assert.deepEqual(budget('1.500 € al mes'), [1500, 'monthly']);
  assert.deepEqual(budget('2.500,50 R$ por mês'), [2500.5, 'monthly']);
  assert.deepEqual(budget("CHF 1'200 per month"), [1200, 'monthly']);
  assert.deepEqual(budget('1 500 zł / mies'), [1500, 'monthly']);
  assert.deepEqual(budget('€12,50 per day'), [12.5, 'daily']);
  assert.deepEqual(budget('KWD 1.500 per day'), [1.5, 'daily'], 'dinars have three decimals');
  assert.deepEqual(budget('AED 18,000 monthly'), [18000, 'monthly']);
  assert.deepEqual(budget('١٢٠٠ درهم يوميا'), [1200, 'daily']);
  assert.deepEqual(budget('Rs 5,000 روزانہ'), [5000, 'daily']);
  assert.deepEqual(budget('₹ 50,000 मासिक'), [50000, 'monthly']);
  assert.deepEqual(budget('Rp 1,5 juta per hari'), [1500000, 'daily']);
  assert.deepEqual(budget('¥100,000/月'), [100000, 'monthly']);
  assert.deepEqual(budget('$3k/m'), [3000, 'monthly']);
  assert.deepEqual(budget('$1.2M per year'), [1200000, 'yearly']);
  assert.deepEqual(budget('30 EUR/Tag'), [30, 'daily']);
  assert.deepEqual(budget('5000 TL günlük'), [5000, 'daily']);
});

test('every country has its Google location ID', () => {
  assert.equal(E.COUNTRIES.length, 249);
  assert.ok(E.COUNTRIES.every(([, id]) => /^2\d{3}$/.test(id)));
  assert.deepEqual(places('Nigeria; Kenya; Ghana'), ['Nigeria #2566', 'Kenya #2404', 'Ghana #2288']);
  assert.deepEqual(places('South Korea, Türkiye, Czech Republic'), ['South Korea #2410', 'Turkey #2792', 'Czechia #2203']);
  assert.deepEqual(places('Trinidad and Tobago'), ['Trinidad and Tobago #2780']);
});

test('regions anywhere keep city, region and country together', () => {
  assert.deepEqual(places('Monterrey, Nuevo León, Mexico'), ['Monterrey, Nuevo León, Mexico']);
  assert.deepEqual(places('Guadalajara, Jalisco'), ['Guadalajara, Jalisco, Mexico']);
  assert.deepEqual(places('Munich, Bavaria'), ['Munich, Bavaria, Germany']);
  assert.deepEqual(places('Kuala Lumpur, Selangor'), ['Kuala Lumpur, Selangor, Malaysia']);
  assert.deepEqual(places('Amritsar, Punjab'), ['Amritsar, Punjab, India']);
  assert.deepEqual(places('Lahore, Punjab, Pakistan'), ['Lahore, Punjab, Pakistan']);
  assert.deepEqual(places('Seoul, Busan'), ['Seoul, South Korea', 'Busan, South Korea'], 'two cities stay two cities');
  assert.deepEqual(places('Houston, Dallas, Austin'), ['Houston', 'Dallas', 'Austin']);
});

test('Australian state codes, and WA is Washington unless the city is Australian', () => {
  assert.deepEqual(places('Sydney, NSW; Melbourne, VIC'), ['Sydney, New South Wales, Australia', 'Melbourne, Victoria, Australia']);
  assert.deepEqual(places('Perth, WA'), ['Perth, Western Australia, Australia']);
  assert.deepEqual(places('Seattle, WA'), ['Seattle, Washington, United States']);
});

test('big cities written alone get their country', () => {
  assert.deepEqual(places('Lagos, Abuja'), ['Lagos, Nigeria', 'Abuja, Nigeria']);
  assert.deepEqual(places('São Paulo; Bogotá'), ['São Paulo, Brazil', 'Bogotá, Colombia']);
  assert.deepEqual(places('Riyadh, Jeddah, Dammam'), ['Riyadh, Saudi Arabia', 'Jeddah, Saudi Arabia', 'Dammam, Saudi Arabia']);
});

test('email-style brief: "Campaign - X", "Budget 20/day", "AG:", "KWs:", "H1:" and a sign-off', () => {
  const m = parseText('Hi team, structure below.\n\nCampaign - Brand\nBudget 20/day\nAG: Brand terms\nKWs: acme plumbing, acme plumbers\n'
    + 'H1: Acme Plumbing Official\nH2: Licensed Local Plumbers\nH3: Book Online Today\n'
    + 'D1: The official Acme Plumbing site. Licensed plumbers serving the county.\nD2: Upfront pricing and a 1-year guarantee on every job.\n\nThanks!');
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget]), [['Brand', 20]]);
  assert.deepEqual(summary(m).map(g => [g.name, g.keywords.length, g.headlines.length, g.descriptions.length]), [['Brand terms', 2, 3, 2]]);
});

test('"Search Campaign: Brakes" is the Brakes campaign', () => {
  const m = parseText('## Search Campaign: Brakes\nBudget: $30/day\n### Ad Group: Brake Repair\nKeywords\n- brake repair');
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget]), [['Brakes', 30]]);
});

test('Gemini style: a negatives line after list-item ad groups is not the last ad group\'s', () => {
  const m = parseText('**Campaign Name:** Green Shield\n**Location:** Tampa, FL\n\n**Ad Group 1: Termites**\n* **Keywords:** termite treatment, termite inspection\n'
    + '* **Headlines:**\n    * Termite Experts Near You\n    * Free Termite Inspection\n    * Licensed Techs\n\n**Negative Keywords:** free, diy');
  assert.deepEqual(m.adGroups[0].negatives, []);
  assert.equal(m.campaigns[0].negatives.length + m.accountNegatives.length, 2);
  assert.deepEqual(m.detected.locations.map(l => l.name), ['Tampa, Florida, United States'], 'a lone campaign\'s settings also fill the account defaults');
});

test('spreadsheet: one row per item, and a Target CPA column per campaign', () => {
  const m = E.parseSheets([{ name: 'Build', rows: [['Campaign', 'Ad Group', 'Type', 'Text'],
    ['Spark - Search', 'Electrician', 'Keyword', 'electrician near me'], ['', '', 'Keyword', '[emergency electrician]'], ['', '', 'Negative', 'electrician jobs'],
    ['', '', 'Headline', 'Licensed Local Electricians'], ['', '', 'Description', 'Licensed electricians for repairs, panels and wiring. Book online today.'],
    ['', '', 'Final URL', 'https://www.example.com']] }], 'build.xlsx');
  const g = summary(m)[0];
  assert.deepEqual([g.name, g.campaign, g.keywords, g.negatives, g.headlines.length, g.finalUrl], ['Electrician', 'Spark - Search', ['electrician near me', '[emergency electrician]'], ['electrician jobs'], 1, 'https://www.example.com']);
  const k = parseText('Campaign\tDaily Budget\tBid Strategy\tTarget CPA\tAd Groups\nLASIK\t$80\tTarget CPA\t$120\tLASIK Surgery\nEye Exams\t$25\tMaximize clicks\t\tEye Exam\n'
    + 'Ad Group: LASIK Surgery\nKeywords\n- lasik cost\nAd Group: Eye Exam\nKeywords\n- eye exam near me');
  assert.deepEqual(k.campaigns.map(c => [c.name, c.bidStrategy || k.detected.bidStrategy, c.targetCpa]), [['LASIK', 'tcpa', 120], ['Eye Exams', 'maxclicks', null]]);
});

test('a count after a list label is not an ad group: "Sample RSA Headlines (30 char max) — 12 of 15"', () => {
  const { parseHTML } = require('./helpers');
  const m = parseHTML('<h3>Medical Weight Loss</h3><p><strong>Keywords:</strong></p><ul><li>medical weight loss</li></ul>'
    + '<p><strong>Sample RSA Headlines (30 char max) — 3 of 15</strong></p><ul><li>Medical Weight Loss Clinic</li><li>Physician Supervised Plans</li><li>Book A Free Consultation</li></ul>'
    + '<p><strong>Sample RSA Descriptions (90 char max) — 2 of 4</strong></p><ul><li>Physician led weight loss programs tailored to you. Book your consult today.</li><li>Serving nearby suburbs. Schedule your appointment now with our team.</li></ul>');
  assert.deepEqual(summary(m).map(g => [g.name, g.headlines.length, g.descriptions.length]), [['Medical Weight Loss', 3, 2]]);
});

test('table-format doc: a layout key table, a settings table whose text says "budget", repeated campaigns and a notes table', () => {
  const { parseHTML } = require('./helpers');
  const tbl = rows => '<table>' + rows.map(r => '<tr>' + r.map(c => '<td><p>' + c + '</p></td>').join('') + '</tr>').join('') + '</table>';
  const m = parseHTML('<p><strong>How to Read This File</strong></p>'
    + tbl([['Section', 'Table Headers', 'One Row Equals'], ['Account Settings', 'Setting | Value', 'One account setting'], ['Google Keywords', 'Campaign | Ad Group | Match Type | Keyword', 'One keyword'], ['Responsive Search Ads', 'Campaign | Ad Group | Asset Type | Text', 'One headline']])
    + '<p><strong>1. Account Settings</strong></p>' + tbl([['Setting', 'Value'], ['Network', 'Search Network only, no Search Partners at this budget.'], ['Locations', 'Bloomingdale, IL'], ['Languages', 'English.']])
    + '<p><strong>2. Campaign Budgets</strong></p>' + tbl([['Campaign', 'Monthly Budget', 'Daily Budget', 'Ad Groups'], ['Aesthetics', '$200', '$6.58', 'Injectables']])
    + '<p><strong>3. Keywords</strong></p>' + tbl([['Campaign', 'Ad Group', 'Match Type', 'Keyword'], ['Aesthetics', 'Injectables', 'Phrase', 'botox near me'], ['Aesthetics', 'Injectables', 'Exact', 'botox near me']])
    + '<p><strong>4. Responsive Search Ads</strong></p>' + tbl([['Campaign', 'Ad Group', 'Asset Type', 'Position', 'Text', 'Characters'],
      ['Aesthetics', 'Injectables', 'Headline', '1', 'Botox & Filler Clinic', '21'], ['Aesthetics', 'Injectables', 'Final URL Note', '-', 'Injectables service page', '-']])
    + '<p><strong>6. Build Notes</strong></p>' + tbl([['Campaign', 'Ad Group', 'Note'], ['Aesthetics', 'Injectables', 'Most competitive ad group in the account.']]));
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget]), [['Aesthetics', 6.58]]);
  assert.deepEqual(summary(m).map(g => [g.name, g.keywords, g.headlines]), [['Injectables', ['"botox near me"', '[botox near me]'], ['Botox & Filler Clinic']]]);
  assert.deepEqual(m.detected.locations.map(l => l.name), ['Bloomingdale, Illinois, United States']);
  assert.ok(!m.notes.some(n => /listed under/.test(n.msg)), 'the notes table does not list the ad group twice');
  assert.ok(m.skipped.some(s => s.kind === 'other' && /laid out/.test(s.reason)));
  assert.ok(m.skipped.some(s => s.kind === 'lp') && m.skipped.some(s => s.kind === 'note' && /competitive/.test(s.text)));
});

test('table doc with "MH | Cancer | Search" campaign names, a Why column, location advice and a max CPC per campaign', () => {
  const { parseHTML } = require('./helpers');
  const tbl = rows => '<table>' + rows.map(r => '<tr>' + r.map(c => '<td><p>' + c + '</p></td>').join('') + '</tr>').join('') + '</table>';
  const W = 'MH | Cancer | Search | West Africa', E2 = 'MH | Cancer | Search | East Africa';
  const m = parseHTML('<p><strong>1. Campaign Settings</strong></p>' + tbl([['Setting', 'Value', 'Why'], ['Locations', 'Per campaign below. Add each country individually.', 'Lets you compare countries.'], ['Language', 'English', 'Add French ads later if English traffic is low.']])
    + '<p><strong>2. Campaign Budgets</strong></p>' + tbl([['Campaign', 'Locations', 'Daily budget (INR)', 'Starting max CPC (INR)', 'Bid strategy'],
      [W, 'Nigeria, Cameroon, The Gambia. Add Ghana if offered.', '500', '50', 'Manual CPC at launch.'], [E2, 'Kenya, Uganda', '500', '50', 'Manual CPC at launch.']])
    + '<p><strong>3. Keywords</strong></p>' + tbl([['Campaign', 'Ad Group', 'Match Type', 'Keyword', 'Final URL'], [W, 'Breast Cancer', 'Phrase', 'breast cancer treatment in india', 'https://www.example.com/breast'], [E2, 'Breast Cancer', 'Exact', 'breast cancer treatment in india', 'https://www.example.com/breast']])
    + '<p><strong>4. Responsive Search Ads</strong></p>' + tbl([['Campaign', 'Ad Group', 'Asset Type', 'Position', 'Text', 'Pin'], [W, 'Breast Cancer', 'Headline', '1', 'Breast Cancer Care India', '1'], [E2, 'Breast Cancer', 'Headline', '1', 'Breast Cancer Care India', '1']])
    + '<p>Total ad asset rows: 2.</p><p><strong>5. Negative Keywords</strong></p><p>Create one shared negative keyword list and apply it to both campaigns.</p>'
    + tbl([['Negative Keyword', 'Match Type', 'Reason'], ['jobs', 'Phrase', 'Jobs and education'], ['free treatment', 'Phrase', 'Free care seekers']]));
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget, c.locations.map(l => l.name)]), [[W, 500, ['Nigeria', 'Cameroon', 'The Gambia']], [E2, 500, ['Kenya', 'Uganda']]]);
  assert.deepEqual(summary(m).map(g => [g.name, g.campaign, g.headlines, g.negatives]), [['Breast Cancer', W, ['Breast Cancer Care India'], []], ['Breast Cancer', E2, ['Breast Cancer Care India'], []]]);
  assert.deepEqual(m.accountNegatives.map(E.kwToLine), ['"jobs"', '"free treatment"']);
  assert.deepEqual([m.detected.languages, m.detected.locations, m.detected.bidStrategy, m.detected.maxCpc], [['en'], undefined, 'manual', 50]);
  assert.ok(m.notes.some(n => /Not used from the locations: "Add Ghana if offered\."/.test(n.msg)));
  assert.ok(m.notes.some(n => /Pins are not exported/.test(n.msg)));
});
