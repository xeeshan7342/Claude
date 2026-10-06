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
