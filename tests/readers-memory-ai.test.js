'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { E, window, parseText, byName } = require('./helpers');
const R = require('../app/js/readers.js');
const M = require('../app/js/memory.js');
const AI = require('../app/js/ai.js');

const fileOf = (name, data) => ({ name, arrayBuffer: async () => (data instanceof Uint8Array ? data : new TextEncoder().encode(data)).buffer });

async function makeXlsx(sheets) {
  const zip = new JSZip();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = i => String.fromCharCode(65 + i);
  zip.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + sheets.map((s, i) => '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"' + (s.hidden ? ' state="hidden"' : '') + '/>').join('') + '</sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '</Relationships>');
  sheets.forEach((s, i) => {
    zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + s.rows.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((c, ci) => c === '' ? '' : '<c r="' + col(ci) + (ri + 1) + '" t="inlineStr"><is><t>' + esc(c) + '</t></is></c>').join('') + '</row>').join('')
      + '</sheetData></worksheet>');
  });
  return zip.generateAsync({ type: 'uint8array' });
}

test('reads an .xlsx workbook tab by tab and skips hidden tabs', async () => {
  const data = await makeXlsx([
    { name: 'Keywords', rows: [['Ad Group', 'Keyword', 'Match Type'], ['Emergency Plumbing', 'emergency plumber', 'Exact'], ['', '24 hour plumber', 'Phrase']] },
    { name: 'Ads', rows: [['Ad Group', 'Headline 1', 'Headline 2', 'Headline 3', 'Description 1', 'Description 2'],
      ['Emergency Plumbing', '24/7 Emergency Plumbers', 'Fast Burst Pipe Repair', 'Licensed Local Plumbers', 'Licensed plumbers on call day and night.', 'Upfront pricing before any work starts.']] },
    { name: 'Old', hidden: true, rows: [['Ad Group', 'Keyword'], ['Nope', 'should not appear']] }
  ]);
  const src = await R.readFile(fileOf('plan.xlsx', data), { JSZip, DOMParser: window.DOMParser });
  const m = E.parseBlocksToModel(src.blocks, src.name);
  const g = byName(m, 'Emergency Plumbing');
  assert.deepEqual(g.keywords, ['[emergency plumber]', '"24 hour plumber"']);
  assert.equal(g.headlines.length, 3);
  assert.ok(!m.adGroups.some(x => x.name === 'Nope'));
});

test('reads a UTF-16 Ads Editor export and a plain CSV', async () => {
  const tsv = 'Campaign\tAd Group\tKeyword\tCriterion Type\nCore\tIT Support\tit support\tPhrase\n';
  const u16 = new Uint8Array(2 + tsv.length * 2);
  u16[0] = 0xff; u16[1] = 0xfe;
  for (let i = 0; i < tsv.length; i++) { u16[2 + i * 2] = tsv.charCodeAt(i); }
  const a = await R.readFile(fileOf('export.csv', u16), {});
  assert.deepEqual(E.parseBlocksToModel(a.blocks, a.name).adGroups[0].keywords, [{ text: 'it support', match: 'phrase' }]);
  const b = await R.readFile(fileOf('plan.md', '## Ad Group: Drains\nKeywords: drain cleaning, blocked drain'), {});
  assert.deepEqual(E.parseBlocksToModel(b.blocks, b.name).adGroups[0].keywords.map(k => k.text), ['drain cleaning', 'blocked drain']);
});

test('unsupported files explain what to do', async () => {
  await assert.rejects(R.readFile(fileOf('old.doc', 'x'), {}), /save it as \.docx/i);
  await assert.rejects(R.readFile(fileOf('brief.pdf', 'x'), {}), /Paste text/);
});

const memStore = () => { const data = {}; return { getItem: k => data[k] || null, setItem: (k, v) => { data[k] = v; }, data }; };

test('memory: a taught label changes how the next doc is read', () => {
  const mem = M.create(memStore());
  const doc = 'Ad Group 1: IT Support\nKeywords\n- it support\nThings we never want\n- jobs\n- salary';
  const before = parseText(doc, 'a.txt', { memory: mem.roles() });
  assert.equal(before.adGroups[0].negatives.length, 0);
  assert.ok(before.skipped.some(s => s.text === 'Things we never want'));
  mem.teach('Things we never want', 'negatives');
  const after = parseText(doc, 'a.txt', { memory: mem.roles() });
  assert.deepEqual(after.adGroups[0].negatives.map(k => k.text), ['jobs', 'salary']);
  // a taught heading becomes an ad group name, and "ignore" hides a recurring line
  mem.teach('Plumbing Pros', 'adgroup');
  mem.teach('Internal note for the team', 'ignore');
  const m2 = parseText('Plumbing Pros\nInternal note for the team\nTarget keywords\n- plumber', 'b.txt', { memory: mem.roles() });
  assert.equal(m2.adGroups[0].name, 'Plumbing Pros');
});

test('memory: export, import and client profiles; junk in an imported file is dropped', () => {
  const a = M.create(memStore());
  a.teach('Search terms we block', 'negatives');
  a.saveProfile('Harbor Plumbing', { finalUrl: 'https://www.example.com/', matchType: 'exact', bidStrategy: 'maxconv', locations: [{ name: 'Austin, Texas, United States', id: '' }], languages: ['en'], allLocations: false, presenceOnly: true, searchPartners: false, campaignStatus: 'Paused' });
  const json = a.exportJSON();
  const b = M.create(memStore());
  const counts = b.importJSON(json);
  assert.deepEqual(counts, { labels: 1, profiles: 1 });
  assert.equal(b.roles()['search terms we block'], 'negatives');
  assert.equal(b.profileForUrl('https://example.com/plumbing').name, 'Harbor Plumbing');
  const evil = JSON.stringify({ version: 1, labels: { x: { role: 'drop tables' }, keywords: { role: 'keywords' } }, profiles: { p: { settings: { finalUrl: 'https://a.com', languages: ['en', '<script>'], bidStrategy: 'evil' } } } });
  const c = M.create(memStore());
  c.importJSON(evil);
  assert.deepEqual(c.roles(), { keywords: 'keywords' });
  assert.deepEqual(c.profiles()[0].settings, { finalUrl: 'https://a.com', languages: ['en'] });
  assert.throws(() => c.importJSON('{"hello": 1}'), /not a Campaign Bulk Builder memory export/);
});

test('AI: the request uses structured output, fallbacks and the default model', () => {
  const req = AI.buildRequest('doc text', { hints: AI.hintsFromMemory([{ example: 'Things we never want', role: 'negatives' }]) });
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(req.messages[0].content.includes('"Things we never want" means: a list of negative keywords'));
  assert.ok(req.messages[0].content.includes('<document>\ndoc text\n</document>'));
});

test('AI: the answer goes through the same model, notes and validation as the rule reader', async () => {
  const answer = {
    title: 'Harbor Plumbing',
    campaigns: [{
      name: 'Urgent Repairs', budget_amount: 1520, budget_period: 'monthly', locations: ['Austin, TX'], final_url: '',
      negative_keywords: [{ text: 'jobs', match_type: 'default' }],
      ad_groups: [{ name: 'Emergency Plumbing', keywords: [{ text: 'emergency plumber', match_type: 'exact' }, { text: '[24 hour plumber]', match_type: 'default' }],
        negative_keywords: [], headlines: ['24/7 Emergency Plumbers', 'Fast Burst Pipe Repair', 'Licensed Local Plumbers'],
        descriptions: ['Licensed plumbers on call day and night.', 'Upfront pricing before any work starts.'], final_url: 'example.com/emergency', path1: 'Emergency', path2: '' }]
    }],
    account_negative_keywords: [{ text: 'diy', match_type: 'broad' }],
    settings: { final_url: '', bid_strategy: 'maximize_conversions', target_cpa: null, max_cpc: null, default_match_type: 'not_stated', locations: [], presence_only: 'yes', languages: ['English'], search_partners: 'no', start_date: '' },
    unused_text: [{ text: 'Book Online', reason: 'sitelink' }]
  };
  // a fake SDK client that streams the answer back
  const client = { beta: { messages: { stream: req => {
    assert.equal(req.model, 'claude-sonnet-5-5');
    const handlers = {};
    return {
      on: (ev, fn) => { handlers[ev] = fn; },
      finalMessage: async () => { const text = JSON.stringify(answer); if (handlers.text) handlers.text(text); return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 2000 }, model: req.model }; }
    };
  } } } };
  let progress = 0;
  const out = await AI.read(client, 'doc', { model: 'claude-sonnet-5-5', onProgress: n => { progress = n; } });
  assert.ok(progress > 0);
  assert.equal(AI.costOf(out.usage, out.model), (1000 * 2 + 2000 * 10) / 1e6);
  const m = E.buildModel(AI.toResult(out.data), 'doc.docx');
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget]), [['Urgent Repairs', 50]]);
  assert.deepEqual(m.campaigns[0].locations, [{ name: 'Austin, Texas, United States', id: '' }]);
  assert.deepEqual(m.adGroups[0].keywords.map(E.kwToLine), ['[emergency plumber]', '[24 hour plumber]']);
  assert.equal(m.adGroups[0].finalUrl, 'https://example.com/emergency');
  assert.deepEqual(m.accountNegatives.map(E.kwToLine), ['diy (broad)']);
  assert.equal(m.detected.bidStrategy, 'maxconv');
  assert.deepEqual(m.detected.languages, ['en']);
  assert.equal(m.skipped[0].text, 'Book Online');
});

test('AI: refusals and truncated answers become clear errors', async () => {
  const fake = msg => ({ beta: { messages: { stream: () => ({ on: () => {}, finalMessage: async () => msg }) } } });
  await assert.rejects(AI.read(fake({ stop_reason: 'refusal', content: [], stop_details: null }), 'doc'), /declined/);
  await assert.rejects(AI.read(fake({ stop_reason: 'max_tokens', content: [] }), 'doc'), /too long/);
  await assert.rejects(AI.read(fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"x":1}' }] }), 'doc'), /expected shape/);
});

test('AI with a Claude plan: a prompt to paste into claude.ai, and the pasted reply goes through the same model', () => {
  const prompt = AI.chatPrompt('# Plumbing\nAd Group 1: Drains\nKeywords\n- drain cleaning', []);
  assert.match(prompt, /```json/);
  assert.match(prompt, /"account_negative_keywords"/);
  assert.match(prompt, /<document>[\s\S]*drain cleaning[\s\S]*<\/document>/);
  const reply = 'Here is the structure:\n```json\n' + JSON.stringify({
    title: 'Plumbing', campaigns: [{ name: 'Plumbing', budget_amount: 30, budget_period: 'daily', locations: ['Austin, TX'], final_url: '', bid_strategy: 'not_stated', target_cpa: null,
      negative_keywords: [], ad_groups: [{ name: 'Drains', keywords: [{ text: 'drain cleaning', match_type: 'phrase' }], negative_keywords: [], headlines: ['Drain Cleaning Pros'], descriptions: [], final_url: '', path1: '', path2: '' }] }],
    settings: { final_url: 'https://www.example.com' }
  }) + '\n```\nLet me know if you need changes.';
  const m = E.buildModel(AI.toResult(AI.parseChatAnswer(reply)), 'doc.docx');
  assert.deepEqual(m.adGroups.map(g => [g.name, g.keywords.map(E.kwToLine)]), [['Drains', ['"drain cleaning"']]]);
  assert.equal(m.campaigns[0].budget, 30);
  assert.throws(() => AI.parseChatAnswer('Sorry, I cannot help with that.'), /No JSON found/);
  assert.throws(() => AI.parseChatAnswer('```json\n{"campaigns": [{"name": "x"'), /not complete JSON/);
});

test('AI with an API key: Haiku 4.5 is the cheapest option and gets a request it accepts', () => {
  const haiku = AI.MODELS.find(m => m.id === 'claude-haiku-4-5');
  assert.ok(haiku);
  const req = AI.buildRequest('doc', { model: 'claude-haiku-4-5' });
  assert.equal(req.thinking, undefined);
  assert.equal(req.fallbacks, undefined);
  assert.equal(req.output_config.effort, undefined);
  assert.equal(req.output_config.format.type, 'json_schema');
});
