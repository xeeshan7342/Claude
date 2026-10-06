'use strict';
// Each test pins one problem found in the review of the first version.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, parseText, byName } = require('./helpers');

const AG = [
  'Ad Group 1: IT Support',
  'Keywords',
  '- it support',
  '- managed it',
  'Headlines',
  '- IT Support Experts',
  '- Fast IT Help',
  '- Managed IT Services',
  'Descriptions',
  '- We fix IT problems fast for small businesses across the region.',
  '- Talk to a specialist about a managed IT plan for your business.'
].join('\n');
const locs = line => parseText(line + '\n' + AG).detected.locations;

test('budgets: a monthly column is converted, not used as a daily budget', () => {
  const m = parseText('Campaign\tAd Groups\tMonthly Budget\nCore IT\tIT Support\t$1,500\n' + AG);
  assert.equal(m.campaigns[0].budget, 49.34);
});

test('budgets: a monthly figure in brackets does not divide a daily budget', () => {
  assert.equal(parseText('Daily budget: $50 (about $1,520/month)\n' + AG).campaigns[0].budget, 50);
  assert.equal(parseText('Budget: $50/day ($1,520/mo)\n' + AG).campaigns[0].budget, 50);
  assert.equal(parseText('Monthly budget: $1,520 (about $50/day)\n' + AG).campaigns[0].budget, 50);
  assert.equal(parseText('Budget: 1.5k per month\n' + AG).campaigns[0].budget, 49.34);
});

test('budgets: an unlabeled amount is kept but flagged', () => {
  const m = parseText('Budget: 1500\n' + AG);
  assert.equal(m.campaigns[0].budget, 1500);
  assert.ok(m.notes.some(n => n.level === 'warn' && /without saying daily or monthly/.test(n.msg)));
});

test('locations: "City, Region" stays one place and never adds a whole country', () => {
  assert.deepEqual(locs('Locations: Los Angeles, CA'), [{ name: 'Los Angeles, California, United States', id: '' }]);
  assert.deepEqual(locs('Locations: Dubai, UAE'), [{ name: 'Dubai, United Arab Emirates', id: '' }]);
  assert.deepEqual(locs('Locations: Mumbai, India'), [{ name: 'Mumbai, India', id: '' }]);
  assert.deepEqual(locs('Target locations: Toronto, ON; Vancouver, BC').map(l => l.name), ['Toronto, Ontario, Canada', 'Vancouver, British Columbia, Canada']);
  assert.deepEqual(locs('Locations: New York, NY, Los Angeles, CA').map(l => l.name), ['New York, New York, United States', 'Los Angeles, California, United States']);
});

test('locations: England is England, not the whole UK', () => {
  assert.deepEqual(locs('Locations: England'), [{ name: 'England, United Kingdom', id: '' }]);
});

test('locations: country lists, state lists and presence notes', () => {
  assert.deepEqual(locs('Locations: US, Canada'), [{ name: 'United States', id: '2840' }, { name: 'Canada', id: '2124' }]);
  assert.deepEqual(locs('Locations: United States and Canada').map(l => l.id), ['2840', '2124']);
  assert.deepEqual(locs('Locations: CA, NV, AZ').map(l => l.name), ['California, United States', 'Nevada, United States', 'Arizona, United States']);
  const m = parseText('Locations: US, Canada (presence only)\n' + AG);
  assert.deepEqual(m.detected.locations.map(l => l.id), ['2840', '2124']);
  assert.equal(m.detected.presenceOnly, true);
});

test('negatives: "Campaign-Level Negative Keywords" is a negatives section, not a campaign', () => {
  const m = parseText('# Campaign-Level Negative Keywords\n- free\n- jobs\n' + AG);
  assert.deepEqual(m.campaigns.map(c => c.name), ['Search campaign']);
  assert.deepEqual(m.accountNegatives.map(k => k.text), ['free', 'jobs']);
});

test('negatives: "Ad Group-Level Negatives" goes to the ad group, not a new empty one', () => {
  const m = parseText(AG + '\n# Ad Group-Level Negatives\n- cheap\n- diy');
  assert.equal(m.adGroups.length, 1);
  assert.deepEqual(byName(m, 'IT Support').negatives, ['cheap', 'diy']);
});

test('negatives: a plain "Ad group negatives" line never becomes a description', () => {
  const m = parseText(AG + '\nAd group negatives\n- jobs\n- cheap');
  const g = byName(m, 'IT Support');
  assert.equal(g.descriptions.length, 2);
  assert.deepEqual(g.negatives, ['jobs', 'cheap']);
});

test('negatives: bold and Word-heading versions of the label', () => {
  const { window } = require('./helpers');
  const base = '<h2>Ad Group 1: IT Support</h2><p>Keywords</p><ul><li>it support</li></ul>';
  for (const head of ['<h3>Ad Group Negatives</h3>', '<p><strong>Ad Group Negatives</strong></p>', '<p>Ad Group Negatives</p>']) {
    const m = E.parseHTML(base + head + '<ul><li>jobs</li><li>cheap</li></ul>', 'x.docx', window.DOMParser);
    assert.deepEqual(m.adGroups[0].negatives.map(k => k.text), ['jobs', 'cheap'], head);
  }
});

test('"Campaign-Level Settings" keeps its budget for the campaign', () => {
  const m = parseText('# Campaign-Level Settings\nDaily budget: $40\n' + AG);
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget]), [['Search campaign', 40]]);
});

test('notes inside a headlines section are reported, not imported as headlines', () => {
  const m = parseText('Ad Group 1: IT Support\nKeywords\n- it support\nHeadlines\nCharacter limit: 30\nPin headline 1 to position 1\n- IT Support Experts\n- Fast IT Help\n- Managed IT Services');
  assert.deepEqual(byName(m, 'IT Support').headlines, ['IT Support Experts', 'Fast IT Help', 'Managed IT Services']);
  assert.equal(m.skipped.filter(s => /note/.test(s.reason)).length, 2);
});

test('copy that does not fit is reported with a suggestion instead of vanishing', () => {
  const m = parseText('Ad Group 1: IT Support\nKeywords\n- it support\nHeadlines\n- IT Support Experts\n- Managed IT Services For Every Small Business Across The Region\nDescriptions\n- Call us now.');
  const long = m.skipped.find(s => /too long for a headline/.test(s.reason));
  assert.ok(long);
  assert.equal(long.suggest, 'description');
  assert.ok(long.agId);
  assert.ok(m.skipped.some(s => /too short for a description/.test(s.reason)));
});

test('broad match survives a round trip through the keyword box', () => {
  const m = parseText('Ad Group 1: IT Support\nKeywords\n- it support (broad)\n- [it company]\nNegative keywords\n- jobs (broad)');
  const g = m.adGroups[0];
  const box = g.keywords.map(E.kwToLine).join('\n');
  assert.equal(box, 'it support (broad)\n[it company]');
  assert.deepEqual(E.linesToKw(box + '\nnew keyword').map(k => k.match), ['broad', 'exact', null]);
  assert.deepEqual(E.linesToKw(g.negatives.map(E.kwToLine).join('\n')), [{ text: 'jobs', match: 'broad' }]);
});

// Found by testing a real med spa doc (Vida Health Spa) after launch.
test('a list of towns with the state written once puts every town in that state', () => {
  const list = locs('Locations: Bloomingdale, IL plus Roselle, Carol Stream, Glendale Heights, Addison, Wheaton, Glen Ellyn, Lombard, St. Charles.');
  assert.equal(list.length, 9);
  assert.ok(list.every(l => l.name.endsWith(', Illinois, United States')), JSON.stringify(list));
  assert.equal(list[8].name, 'St. Charles, Illinois, United States');
  assert.deepEqual(locs('Locations: Bloomingdale IL plus Roselle and Wheaton').map(l => l.name.split(',')[0]), ['Bloomingdale', 'Roselle', 'Wheaton']);
  assert.deepEqual(locs('Locations: Austin, TX; Round Rock').map(l => l.name), ['Austin, Texas, United States', 'Round Rock, Texas, United States']);
  assert.deepEqual(locs('Locations: Trinidad and Tobago').map(l => l.name), ['Trinidad and Tobago']);
  assert.deepEqual(locs('Locations: Houston, Dallas, Austin').map(l => l.name), ['Houston', 'Dallas', 'Austin']);
});

test('settings written as sentences still count: "Languages: English."', () => {
  const m = parseText('Campaign Settings\nLanguages: English, Spanish.\nBidding: Maximize conversions.\n' + AG);
  assert.deepEqual(m.detected.languages, ['en', 'es']);
  assert.equal(m.detected.bidStrategy, 'maxconv');
});

test('"Landing Page: <description>" without a URL is reported as needing one', () => {
  const m = parseText('Ad Group 1: IT Support\nLanding Page: Managed IT services page with consult CTA\nKeywords\n- it support');
  const lp = m.skipped.find(s => s.kind === 'lp');
  assert.ok(lp && /gives no URL/.test(lp.reason));
  assert.equal(m.adGroups[0].finalUrl, '');
});

test('a "Note: ..." line between keywords is a note and the keywords after it are kept', () => {
  const m = parseText('Ad Group 1: IT Support\nKeywords\n- it support\nNote: lowest search volume of the three, watch impression share.\n- managed it\nHeadlines\n- IT Support Experts\nSitelinks: Book Online, Pricing\n- Fast IT Help');
  const g = byName(m, 'IT Support');
  assert.deepEqual(g.keywords, ['it support', 'managed it']);
  assert.deepEqual(g.headlines, ['IT Support Experts', 'Fast IT Help']);
  assert.ok(m.skipped.some(s => s.kind === 'note' && /^Note:/.test(s.text)));
  assert.ok(m.skipped.some(s => /"Sitelinks" line/.test(s.reason)));
});

// Safeguards that an early edit failed to save; pinned so they cannot silently go missing again.
test('"Keyword match types: Phrase + Exact" is a setting, not a keywords heading', () => {
  const c = E.classify({ t: 'p', text: 'Keyword match types: Phrase + Exact' });
  assert.equal(c.k, 'setting');
  assert.equal(c.s.v, 'phrase+exact');
});

test('keywords that start with "ag" are not ad group labels; "AG 2: Name" is', () => {
  assert.equal(E.classify({ t: 'li', text: 'ag 1 tractor parts' }).k, 'text');
  assert.equal(E.classify({ t: 'p', text: 'ag 2 seed supply' }).k, 'text');
  assert.deepEqual(E.classify({ t: 'p', text: 'AG 2: Drain Cleaning' }), { k: 'adgroup', name: 'Drain Cleaning', level: 9 });
});

test('ad groups and campaigns named like weak section words keep their names', () => {
  assert.equal(E.classify({ t: 'h', level: 2, text: 'Ad Group 3: Search Ads' }).name, 'Search Ads');
  assert.equal(E.classify({ t: 'h', level: 1, text: 'Campaign: Search Ads' }).k, 'campaign');
});

test('taught labels cannot hit built-in object keys', () => {
  assert.equal(E.classify({ t: 'p', text: 'constructor' }, {}).k, 'text');
  assert.equal(E.classify({ t: 'p', text: 'toString' }, {}).k, 'text');
});
