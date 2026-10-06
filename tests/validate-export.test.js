'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, parseText, settings } = require('./helpers');

const TODAY = '2026-10-06';
const doc = extra => parseText([
  'Daily budget: 30',
  'Ad Group 1: IT Support',
  'Keywords',
  '- it support',
  '- free it support quote',
  'Headlines',
  '- IT Support Experts',
  '- Fast IT Help',
  '- Managed IT Services',
  'Descriptions',
  '- We fix IT problems fast for small businesses across the region.',
  '- Talk to a specialist about a managed IT plan for your business.'
].join('\n') + (extra ? '\n' + extra : ''));
const msgs = (list, rx) => list.filter(x => rx.test(x.msg));

test('a clean doc has no errors', () => {
  const v = E.validate(doc(), settings(), TODAY);
  assert.deepEqual(v.errors, []);
});

test('negative keywords are validated like keywords', () => {
  const m = doc('Ad group negatives\n- jobs!\n- cheap?');
  m.accountNegatives = E.linesToKw('what is it?');
  const v = E.validate(m, settings(), TODAY);
  assert.equal(msgs(v.errors, /negative "jobs!" contains "!"/).length, 1);
  assert.equal(msgs(v.errors, /negative "cheap\?" contains "\?"/).length, 1);
  assert.equal(msgs(v.errors, /Negative keywords for every campaign: negative "what is it\?"/).length, 1);
});

test('a negative that blocks one of your own keywords is flagged', () => {
  const m = doc();
  m.accountNegatives = E.linesToKw('free');
  const v = E.validate(m, settings(), TODAY);
  assert.equal(msgs(v.warnings, /account negative "free" blocks the keyword "free it support quote"/).length, 1);
  assert.ok(E.negBlocks({ text: 'support quote', match: null }, 'free it support quote'));
  assert.ok(!E.negBlocks({ text: 'quote support', match: null }, 'free it support quote'));
  assert.ok(E.negBlocks({ text: 'quote support', match: 'broad' }, 'free it support quote'));
  assert.ok(!E.negBlocks({ text: 'support', match: 'exact' }, 'free it support quote'));
});

test('a start date in the past is an error', () => {
  const v = E.validate(doc(), settings({ startDate: '2026-01-01' }), TODAY);
  assert.equal(msgs(v.errors, /start date is in the past/).length, 1);
  assert.equal(E.validate(doc(), settings({ startDate: '2026-11-01' }), TODAY).errors.length, 0);
});

test('locations: none is an error unless "All countries" is chosen; places without an ID get a warning', () => {
  assert.equal(msgs(E.validate(doc(), settings({ locations: [] }), TODAY).errors, /at least one location/).length, 1);
  assert.equal(E.validate(doc(), settings({ locations: [], allLocations: true }), TODAY).errors.length, 0);
  const v = E.validate(doc(), settings({ locations: [{ name: 'Dubai, United Arab Emirates', id: '' }] }), TODAY);
  assert.equal(msgs(v.warnings, /"Dubai, United Arab Emirates" has no location ID/).length, 1);
});

test('ad text policy checks: emoji, repeated punctuation, phone numbers, shouting', () => {
  const m = doc();
  const g = m.adGroups[0];
  g.headlines[0] = 'Fast IT Help 🚀';
  g.headlines[1] = 'Need IT Help??';
  g.descriptions[0] = 'Call 0800 123 4567 for help with any IT problem today, any time.';
  g.descriptions[1] = 'FREE quotes and fast HVAC style service for every business we work with.';
  const v = E.validate(m, settings(), TODAY);
  assert.equal(msgs(v.errors, /emoji/).length, 1);
  assert.equal(msgs(v.errors, /repeats punctuation/).length, 1);
  assert.equal(msgs(v.warnings, /phone number/).length, 1);
  assert.equal(msgs(v.warnings, /"FREE" in capitals/).length, 1);
  assert.equal(msgs(v.warnings, /HVAC/).length, 0);
});

test('the review sample passes through: duplicates across ad groups are a warning', () => {
  const m = parseText('Daily budget: 20\nAd Group 1: A\nKeywords\n- office network installation\nAd Group 2: B\nKeywords\n- office network installation');
  const v = E.validate(m, settings(), TODAY);
  assert.equal(msgs(v.warnings, /"office network installation" is in A and B/).length, 2);
});

test('export: campaign negatives, per-campaign locations, ad group max CPC, broad match', () => {
  const m = parseText([
    'Campaign 1: Core',
    'Daily budget: 40',
    'Locations: Austin, TX',
    'Campaign negative keywords: jobs, salary',
    'Ad Group 1: IT Support',
    'Max CPC: 3.5',
    'Keywords',
    '- it support (broad)',
    'Headlines',
    '- IT Support Experts',
    '- Fast IT Help',
    '- Managed IT Services',
    'Descriptions',
    '- We fix IT problems fast for small businesses across the region.',
    '- Talk to a specialist about a managed IT plan for your business.'
  ].join('\n'));
  m.accountNegatives = E.linesToKw('free\njobs');
  const t = E.exportRows(m, settings({ bidStrategy: 'manual', maxCpc: '2' }));
  const col = h => t.headers.indexOf(h);
  const rows = t.rows.map((r, i) => ({ kind: t.kinds[i], r }));
  assert.deepEqual(rows.filter(x => x.kind === 'location').map(x => x.r[col('Location')]), ['Austin, Texas, United States']);
  assert.deepEqual(rows.filter(x => x.kind === 'keyword').map(x => x.r[col('Criterion Type')]), ['Broad']);
  assert.equal(rows.find(x => x.kind === 'adgroup').r[col('Max CPC')], '3.5');
  const campNeg = rows.filter(x => x.kind === 'negative' && !x.r[col('Ad Group')]).map(x => x.r[col('Keyword')]);
  assert.deepEqual(campNeg, ['free', 'jobs', 'salary']);
});

test('export: "All countries" writes no location rows; CSV quoting is correct', () => {
  const m = doc();
  m.adGroups[0].descriptions[0] = 'Fast, friendly "IT" help for small businesses across the whole region.';
  const t = E.exportRows(m, settings({ locations: [], allLocations: true }));
  assert.equal(t.kinds.filter(k => k === 'location').length, 0);
  const csv = E.toCSV(t);
  assert.ok(csv.includes('"Fast, friendly ""IT"" help for small businesses across the whole region."'));
  assert.ok(csv.endsWith('\r\n'));
});

test('several locations without an ID give one grouped warning', () => {
  const list = ['Bloomingdale', 'Roselle', 'Wheaton', 'Lombard', 'Itasca', 'Addison'].map(n => ({ name: n + ', Illinois, United States', id: '' }));
  const v = E.validate(doc(), settings({ locations: list }), TODAY);
  const w = msgs(v.warnings, /no location ID/);
  assert.equal(w.length, 1);
  assert.match(w[0].msg, /^6 locations have no location ID \(Bloomingdale, Illinois, United States; .*; and 2 more\)/);
});
