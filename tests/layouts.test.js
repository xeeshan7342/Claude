'use strict';
// The same campaign written up in the different ways client docs actually arrive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { E, parseHTML, parseText, summary, byName } = require('./helpers');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('Word doc: ad group headings, section headings, headline tables with a Chars column, campaign table', () => {
  const m = parseHTML(fixture('structure-doc.html'));
  assert.deepEqual(m.campaigns.map(c => c.name), ['A - Urgent Repairs', 'B - Installs']);
  assert.deepEqual(m.campaigns.map(c => c.budget), [50, 30]);
  const s = summary(m);
  assert.deepEqual(s.map(g => [g.name, g.campaign]), [
    ['Emergency Plumbing', 'A - Urgent Repairs'], ['Drain Cleaning', 'A - Urgent Repairs'], ['Water Heater Installation', 'B - Installs']]);
  const em = byName(m, 'Emergency Plumbing');
  assert.deepEqual(em.keywords, ['emergency plumber', '24 hour plumber', '[emergency plumber near me]', '"burst pipe repair"']);
  assert.deepEqual(em.headlines, ['24/7 Emergency Plumbers', 'Fast Burst Pipe Repair', 'Licensed Local Plumbers', 'No Call-Out Surprises']);
  assert.equal(em.descriptions.length, 2);
  assert.equal(byName(m, 'Water Heater Installation').finalUrl, 'https://www.example.com/water-heaters');
  assert.equal(m.detected.finalUrl, 'https://www.example.com/plumbing');
  assert.deepEqual(m.accountNegatives.map(E.kwToLine), ['jobs', 'diy', '[plumber salary]']);
  // sitelinks are reported, never mixed into ad text
  assert.ok(m.skipped.some(x => x.text === 'Book Online' && /Sitelinks/.test(x.reason)));
  assert.ok(m.notes.some(n => /monthly budget of 1,520 converted to 50 per day/.test(n.msg)));
});

test('pasted plain text with no bullets and no "Ad Group" labels', () => {
  const m = parseText([
    'Plumbing Campaign Plan',
    'Emergency Plumbing',
    'Keywords',
    'emergency plumber',
    '24 hour plumber',
    'Headlines',
    '24/7 Emergency Plumbers',
    'Fast Burst Pipe Repair',
    'Licensed Local Plumbers',
    'Descriptions',
    'Licensed plumbers on call day and night. Upfront pricing before any work starts.',
    'Burst pipe or no hot water? Book a plumber and get a firm arrival time today.',
    'Drain Cleaning Services',
    'Keywords',
    'drain cleaning',
    'blocked drain service',
    'Headlines',
    'Blocked Drain Specialists',
    'Same Day Drain Cleaning',
    'Clear Drains, Fair Prices',
    'Descriptions',
    'We clear kitchen, bathroom and main drains with camera checks to find the cause.',
    'Same day drain cleaning from local plumbers. Upfront quote before we start.'
  ].join('\n'));
  const s = summary(m);
  assert.deepEqual(s.map(g => g.name), ['Emergency Plumbing', 'Drain Cleaning Services']);
  assert.deepEqual(s[0].keywords, ['emergency plumber', '24 hour plumber']);
  assert.equal(s[0].descriptions.length, 2);
  assert.deepEqual(s[1].keywords, ['drain cleaning', 'blocked drain service']);
  assert.equal(s[1].headlines.length, 3);
});

test('markdown from ChatGPT or Claude with pipe tables', () => {
  const m = parseText([
    '# Harbor Plumbing – Search Campaign',
    '## Ad Group: Emergency Plumbing',
    '**Keywords:** emergency plumber, 24 hour plumber, burst pipe repair',
    '### Headlines',
    '| # | Headline | Characters |',
    '|---|---|---|',
    '| 1 | 24/7 Emergency Plumbers | 23 |',
    '| 2 | Fast Burst Pipe Repair | 22 |',
    '| 3 | Licensed Local Plumbers | 23 |',
    '### Descriptions',
    '| # | Description | Characters |',
    '|---|---|---|',
    '| 1 | Licensed plumbers on call day and night. Upfront pricing before any work starts. | 80 |',
    '| 2 | Burst pipe or no hot water? Book a plumber and get a firm arrival time today. | 76 |'
  ].join('\n'));
  const g = byName(m, 'Emergency Plumbing');
  assert.deepEqual(g.keywords, ['emergency plumber', '24 hour plumber', 'burst pipe repair']);
  assert.deepEqual(g.headlines, ['24/7 Emergency Plumbers', 'Fast Burst Pipe Repair', 'Licensed Local Plumbers']);
  assert.equal(g.descriptions.length, 2);
});

test('headings without the words "Ad Group", several campaign headings', () => {
  const m = parseText([
    '# Urgent Repairs',
    '## Emergency Plumbing',
    '**Keywords**',
    '- emergency plumber',
    '**Headlines**',
    '- 24/7 Emergency Plumbers',
    '- Fast Burst Pipe Repair',
    '- Licensed Local Plumbers',
    '**Descriptions**',
    '- Licensed plumbers on call day and night. Upfront pricing before any work starts.',
    '- Burst pipe or no hot water? Book a plumber and get a firm arrival time today.',
    '## Drain Cleaning',
    '**Keywords**',
    '- drain cleaning',
    '**Headlines**',
    '- Blocked Drain Specialists',
    '- Same Day Drain Cleaning',
    '- Clear Drains, Fair Prices',
    '**Descriptions**',
    '- We clear kitchen, bathroom and main drains with camera checks to find the cause.',
    '- Same day drain cleaning from local plumbers. Upfront quote before we start.',
    '# Installs',
    '## Water Heaters',
    '**Keywords**',
    '- water heater installation',
    '**Headlines**',
    '- Water Heater Installation',
    '- Tankless Heaters Installed',
    '- Hot Water Back Today',
    '**Descriptions**',
    '- Gas, electric and tankless water heaters supplied and fitted by licensed plumbers.',
    '- Old heater failing? Get a fixed-price replacement quote with no hidden fees.'
  ].join('\n'));
  assert.deepEqual(summary(m).map(g => [g.name, g.campaign]), [
    ['Emergency Plumbing', 'Urgent Repairs'], ['Drain Cleaning', 'Urgent Repairs'], ['Water Heaters', 'Installs']]);
});

test('one big table: ad group, keywords, headlines and descriptions columns with multi-line cells', () => {
  const html = '<table>'
    + '<tr><th>Ad Group</th><th>Keywords</th><th>Headlines</th><th>Descriptions</th><th>Final URL</th></tr>'
    + '<tr><td><p>Emergency Plumbing</p></td><td><p>emergency plumber</p><p>24 hour plumber</p></td>'
    + '<td><p>24/7 Emergency Plumbers</p><p>Fast Burst Pipe Repair</p><p>Licensed Local Plumbers</p></td>'
    + '<td><p>Licensed plumbers on call day and night. Upfront pricing before any work starts.</p></td><td><p>example.com/emergency</p></td></tr>'
    + '<tr><td><p>Drain Cleaning</p></td><td><p>drain cleaning</p></td><td><p>Blocked Drain Specialists</p></td><td><p>We clear kitchen, bathroom and main drains with camera checks.</p></td><td></td></tr>'
    + '</table>';
  const m = parseHTML(html);
  const g = byName(m, 'Emergency Plumbing');
  assert.deepEqual(g.keywords, ['emergency plumber', '24 hour plumber']);
  assert.equal(g.headlines.length, 3);
  assert.equal(g.descriptions.length, 1);
  assert.equal(g.finalUrl, 'https://example.com/emergency');
  assert.deepEqual(byName(m, 'Drain Cleaning').keywords, ['drain cleaning']);
});

test('Ads Editor style wide table with Headline 1..n and Description 1..n columns', () => {
  const rows = [
    ['Campaign', 'Ad Group', 'Headline 1', 'Headline 2', 'Headline 3', 'Description 1', 'Description 2', 'Path 1', 'Final URL'],
    ['Urgent Repairs', 'Emergency Plumbing', '24/7 Emergency Plumbers', 'Fast Burst Pipe Repair', 'Licensed Local Plumbers',
      'Licensed plumbers on call day and night. Upfront pricing before any work starts.', 'Burst pipe or no hot water? Book a plumber today.', 'Emergency', 'https://www.example.com/e']
  ];
  const m = E.parseSheets([{ name: 'Ads', rows }], 'ads.xlsx');
  const g = byName(m, 'Emergency Plumbing');
  assert.equal(g.campaign, 'Urgent Repairs');
  assert.equal(g.headlines.length, 3);
  assert.equal(g.descriptions.length, 2);
  assert.equal(m.adGroups[0].path1, 'Emergency');
});

test('field and value table per ad group', () => {
  const html = '<h2>Emergency Plumbing</h2><table>'
    + '<tr><td>Keywords</td><td><p>emergency plumber</p><p>24 hour plumber</p></td></tr>'
    + '<tr><td>Headline 1</td><td>24/7 Emergency Plumbers</td></tr>'
    + '<tr><td>Headline 2</td><td>Fast Burst Pipe Repair</td></tr>'
    + '<tr><td>Headline 3</td><td>Licensed Local Plumbers</td></tr>'
    + '<tr><td>Description 1</td><td>Licensed plumbers on call day and night. Upfront pricing before any work starts.</td></tr>'
    + '<tr><td>Description 2</td><td>Burst pipe or no hot water? Book a plumber and get a firm arrival time today.</td></tr>'
    + '<tr><td>Final URL</td><td>https://www.example.com/emergency</td></tr>'
    + '</table>';
  const m = parseHTML(html);
  const g = byName(m, 'Emergency Plumbing');
  assert.ok(g, 'heading became the ad group');
  assert.deepEqual(g.keywords, ['emergency plumber', '24 hour plumber']);
  assert.equal(g.headlines.length, 3);
  assert.equal(g.descriptions.length, 2);
  assert.equal(g.finalUrl, 'https://www.example.com/emergency');
});

test('field and value table with one column per ad group', () => {
  const html = '<table>'
    + '<tr><th></th><th>Emergency Plumbing</th><th>Drain Cleaning</th></tr>'
    + '<tr><td>Keywords</td><td><p>emergency plumber</p></td><td><p>drain cleaning</p><p>blocked drain</p></td></tr>'
    + '<tr><td>Headline 1</td><td>24/7 Emergency Plumbers</td><td>Blocked Drain Specialists</td></tr>'
    + '<tr><td>Description 1</td><td>Licensed plumbers on call day and night. Upfront pricing.</td><td>We clear kitchen, bathroom and main drains with camera checks.</td></tr>'
    + '</table>';
  const m = parseHTML(html);
  assert.deepEqual(byName(m, 'Drain Cleaning').keywords, ['drain cleaning', 'blocked drain']);
  assert.deepEqual(byName(m, 'Emergency Plumbing').headlines, ['24/7 Emergency Plumbers']);
});

test('keywords table where each column is an ad group', () => {
  const m = parseText([
    'Keywords',
    'Emergency Plumbing\tDrain Cleaning',
    'emergency plumber\tdrain cleaning',
    '24 hour plumber\tblocked drain service'
  ].join('\n'));
  assert.deepEqual(byName(m, 'Emergency Plumbing').keywords, ['emergency plumber', '24 hour plumber']);
  assert.deepEqual(byName(m, 'Drain Cleaning').keywords, ['drain cleaning', 'blocked drain service']);
});

test('spreadsheet tabs: campaigns, keywords, ads and negatives', () => {
  const sheets = [
    { name: 'Campaigns', rows: [['Campaign', 'Ad Groups', 'Daily Budget'], ['Urgent Repairs', 'Emergency Plumbing; Drain Cleaning', '45']] },
    { name: 'Keywords', rows: [['Campaign', 'Ad Group', 'Keyword', 'Match Type'],
      ['Urgent Repairs', 'Emergency Plumbing', 'emergency plumber', 'Exact'],
      ['Urgent Repairs', 'Emergency Plumbing', '24 hour plumber', 'Phrase'],
      ['Urgent Repairs', 'Drain Cleaning', 'drain cleaning', 'Broad'],
      ['Urgent Repairs', 'Drain Cleaning', 'plumbing jobs', 'Negative Phrase']] },
    { name: 'Ads', rows: [['Campaign', 'Ad Group', 'Headline 1', 'Headline 2', 'Headline 3', 'Description 1', 'Description 2'],
      ['Urgent Repairs', 'Emergency Plumbing', '24/7 Emergency Plumbers', 'Fast Burst Pipe Repair', 'Licensed Local Plumbers', 'Licensed plumbers on call day and night.', 'Upfront pricing before any work starts.']] },
    { name: 'Negatives', rows: [['free'], ['diy'], ['training course']] }
  ];
  const m = E.parseSheets(sheets, 'plan.xlsx');
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget]), [['Urgent Repairs', 45]]);
  const em = byName(m, 'Emergency Plumbing');
  assert.deepEqual(em.keywords, ['[emergency plumber]', '"24 hour plumber"']);
  assert.equal(em.headlines.length, 3);
  const dc = byName(m, 'Drain Cleaning');
  assert.deepEqual(dc.keywords, ['drain cleaning (broad)']);
  assert.deepEqual(dc.negatives, ['"plumbing jobs"']);
  assert.deepEqual(m.accountNegatives.map(k => k.text), ['free', 'diy', 'training course']);
});

test('numbered ad text: "Headline 1:", "H2 -", "D1:"', () => {
  const m = parseText([
    'Ad Group 1: Emergency Plumbing',
    'Keywords: emergency plumber, 24 hour plumber',
    'Headline 1: 24/7 Emergency Plumbers',
    'H2 - Fast Burst Pipe Repair',
    'Headline 3 (23 chars): Licensed Local Plumbers',
    'D1: Licensed plumbers on call day and night. Upfront pricing before any work starts.',
    'Description 2: Burst pipe or no hot water? Book a plumber and get a firm arrival time today.'
  ].join('\n'));
  const g = byName(m, 'Emergency Plumbing');
  assert.deepEqual(g.headlines, ['24/7 Emergency Plumbers', 'Fast Burst Pipe Repair', 'Licensed Local Plumbers']);
  assert.equal(g.descriptions.length, 2);
  assert.deepEqual(g.keywords, ['emergency plumber', '24 hour plumber']);
});

test('one "Ad copy" list is split into headlines and descriptions by length', () => {
  const m = parseText([
    'Ad Group: Emergency Plumbing',
    'Keywords',
    '- emergency plumber',
    'Ad copy',
    '- 24/7 Emergency Plumbers',
    '- Fast Burst Pipe Repair',
    '- Licensed plumbers on call day and night. Upfront pricing before any work starts.'
  ].join('\n'));
  const g = byName(m, 'Emergency Plumbing');
  assert.deepEqual(g.headlines, ['24/7 Emergency Plumbers', 'Fast Burst Pipe Repair']);
  assert.equal(g.descriptions.length, 1);
});

test('keyword lists pasted from Keyword Planner keep only the keyword', () => {
  const m = parseText([
    'Ad Group: Emergency Plumbing',
    'Keywords',
    '- emergency plumber – 1,300 – $12.50',
    '- 24 hour plumber | 880 searches | High',
    '- burst pipe repair (590)',
    '- -free'
  ].join('\n'));
  const g = byName(m, 'Emergency Plumbing');
  assert.deepEqual(g.keywords, ['emergency plumber', '24 hour plumber', 'burst pipe repair']);
  assert.deepEqual(g.negatives, ['free']);
});

test('callouts and sitelinks after the descriptions do not become ad text', () => {
  const m = parseText([
    'Ad Group: Emergency Plumbing',
    'Keywords',
    '- emergency plumber',
    'Headlines',
    '- 24/7 Emergency Plumbers',
    '- Fast Burst Pipe Repair',
    '- Licensed Local Plumbers',
    'Descriptions',
    '- Licensed plumbers on call day and night. Upfront pricing before any work starts.',
    '- Burst pipe or no hot water? Book a plumber and get a firm arrival time today.',
    'Callouts',
    '- Licensed & Insured',
    '- Upfront Pricing',
    'Sitelinks:',
    '- Book Online'
  ].join('\n'));
  const g = byName(m, 'Emergency Plumbing');
  assert.equal(g.headlines.length, 3);
  assert.equal(g.descriptions.length, 2);
  assert.ok(m.skipped.some(s => s.text === 'Upfront Pricing' && /Callouts/.test(s.reason)));
});

test('a keyword that looks like a section word stays a keyword', () => {
  const m = parseText([
    'Ad Group: Web Design',
    'Keywords',
    'landing page design',
    'search ads agency',
    'ad copy writing service',
    'Headlines',
    'Landing Pages That Convert',
    'Search Ads Done Right',
    'Ad Copy That Sells'
  ].join('\n'));
  const g = byName(m, 'Web Design');
  assert.deepEqual(g.keywords, ['landing page design', 'search ads agency', 'ad copy writing service']);
  assert.equal(g.headlines.length, 3);
});

test('campaign headings with ad group headings under them', () => {
  const m = parseHTML('<h1>Campaign 1: Urgent Repairs</h1><p>Daily budget: $40</p><h2>Ad Group 1: Emergency Plumbing</h2><h3>Keywords</h3><ul><li>emergency plumber</li></ul>'
    + '<h1>Campaign 2 – Installs</h1><p>Budget: $900 per month</p><p>Locations: Austin, TX</p><h2>Ad Group 1: Water Heaters</h2><h3>Keywords</h3><ul><li>water heater installation</li></ul>');
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget]), [['Urgent Repairs', 40], ['Installs', 29.61]]);
  assert.deepEqual(summary(m).map(g => g.campaign), ['Urgent Repairs', 'Installs']);
  assert.deepEqual(m.campaigns[1].locations, [{ name: 'Austin, Texas, United States', id: '' }]);
});

test('an Ads Editor CSV export can be read back in', () => {
  const csv = [
    'Campaign,Ad Group,Keyword,Criterion Type,Headline 1,Headline 2,Headline 3,Description 1,Description 2,Final URL',
    'Urgent Repairs,Emergency Plumbing,emergency plumber,Exact,,,,,,',
    'Urgent Repairs,Emergency Plumbing,plumber jobs,Negative Phrase,,,,,,',
    'Urgent Repairs,,cheap,Campaign Negative Broad,,,,,,',
    'Urgent Repairs,Emergency Plumbing,,,24/7 Emergency Plumbers,Fast Burst Pipe Repair,Licensed Local Plumbers,"Licensed plumbers on call day and night, every day.",Upfront pricing before any work starts.,https://www.example.com/'
  ].join('\n');
  const m = E.parseBlocksToModel(E.rowsToBlocks(E.csvToRows(csv), ''), 'export.csv');
  const g = byName(m, 'Emergency Plumbing');
  assert.deepEqual(g.keywords, ['[emergency plumber]']);
  assert.deepEqual(g.negatives, ['"plumber jobs"']);
  assert.equal(g.headlines.length, 3);
  assert.equal(g.descriptions[0], 'Licensed plumbers on call day and night, every day.');
  assert.deepEqual(m.campaigns[0].negatives.map(E.kwToLine), ['cheap (broad)']);
});

test('Word line breaks inside a table cell or paragraph are separate lines', () => {
  const html = '<table><tr><td><p>Ad Group</p></td><td><p>Keywords</p></td><td><p>Headlines</p></td><td><p>Descriptions</p></td></tr>'
    + '<tr><td><p>Local Movers</p></td><td><p>local movers<br />moving company near me</p></td>'
    + '<td><p>Local Movers You Can Trust<br />Fixed-Price House Moves<br />Book Your Move Online</p></td>'
    + '<td><p>Careful local movers with fixed prices and no hidden fees.<br /><br />Get a quick quote and pick a moving date.</p></td></tr></table>'
    + '<h2>Office Moves</h2><p>Keywords</p><p>office movers<br />office relocation services</p>';
  const m = parseHTML(html);
  const g = byName(m, 'Local Movers');
  assert.deepEqual(g.keywords, ['local movers', 'moving company near me']);
  assert.equal(g.headlines.length, 3);
  assert.equal(g.descriptions.length, 2);
  assert.deepEqual(byName(m, 'Office Moves').keywords, ['office movers', 'office relocation services']);
});

test('default campaign name comes from the doc title without the planning words', () => {
  assert.equal(E.deriveName('Brightside Dental – Search Plan'), 'Brightside Dental - Search');
  assert.equal(E.deriveName('Northwind Movers Google Ads'), 'Northwind Movers - Search');
  assert.equal(E.deriveName('Search Engine Experts'), 'Search Engine Experts - Search');
});
