'use strict';
// Each test pins a misread found by the second round of stress tests (AI chat pastes, plain-text pastes,
// international spreadsheets and agency docs). All content is made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, parseHTML, parseText, settings, summary, byName } = require('./helpers');

const sheets = list => E.parseSheets(list.map(([name, rows]) => ({ name, rows })), 'plan.xlsx');
const negs = list => list.map(E.kwToLine);

/* ---------- AI chat pastes ---------- */

test('icons in front of labels and headings are decoration, and "---" is never content', () => {
  const m = parseText([
    '## 🎯 Campaign 1: AC Repair – Emergency',
    '**💰 Budget:** $40/day',
    '### Ad Group 1: Emergency AC',
    '**🔑 Keywords**', '- [emergency ac repair]', '- "ac repair near me"',
    '**✍️ Headlines**', '- 24/7 Emergency AC Repair', '- Same-Day AC Repair', '- No Overtime Fees',
    '**📝 Descriptions**', '- Fast AC repair from licensed techs, day or night, with stocked trucks.', '- Upfront pricing and same-day service across the whole metro area.',
    '---',
    '**🚫 Negative Keywords**', '- jobs', '- diy'
  ].join('\n'));
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget]), [['AC Repair – Emergency', 40]]);
  const g = byName(m, 'Emergency AC');
  assert.deepEqual(g.keywords, ['[emergency ac repair]', '"ac repair near me"']);
  assert.equal(g.headlines.length, 3);
  assert.ok(!g.headlines.includes('Descriptions'));
  assert.equal(g.descriptions.length, 2);
  assert.deepEqual(g.negatives, [], 'the rule ends the ad group, so the closing list is not its own');
  assert.deepEqual(negs(m.campaigns[0].negatives.concat(m.accountNegatives)), ['jobs', 'diy']);
});

test('a leading minus on a negative is not part of the keyword', () => {
  const m = parseText('Ad Group 1: Movers\nKeywords\n- local movers\nNegative keywords: -truck rental, -u haul, -diy');
  assert.deepEqual(negs(m.adGroups[0].negatives), ['truck rental', 'u haul', 'diy']);
});

test('negatives that say they apply to all, both or every campaign are account negatives', () => {
  const base = 'Campaign 1: Implants\nAd Group 1: Implant Cost\nKeywords\n- implant cost\nCampaign 2: Invisalign\nAd Group 2: Invisalign\nKeywords\n- invisalign\n';
  for (const label of ['## Shared Negative Keyword List (all campaigns)', '## Campaign-Level Negatives (apply to both campaigns)']) {
    const m = parseText(base + label + '\n- jobs\n- dental school');
    assert.deepEqual(negs(m.accountNegatives), ['jobs', 'dental school'], label);
    assert.ok(m.campaigns.every(c => !c.negatives.length), label);
  }
  const m = parseText(base + '## Negative Keywords\nApply at the account level:\n- jobs\n- clippers');
  assert.deepEqual(negs(m.accountNegatives), ['jobs', 'clippers']);
});

test('bold sub-labels inside a negatives section send each list to its campaign', () => {
  const m = parseHTML('<h2>Campaign 1: Panchakarma – Bengaluru</h2><h3>Ad Group 1: Panchakarma</h3><p>Keywords:</p><ul><li>panchakarma bangalore</li></ul>'
    + '<h2>Campaign 2: Ayurvedic Doctor – Pune</h2><h3>Ayurvedic Doctor – Pune</h3><p>Keywords:</p><ul><li>ayurvedic doctor pune</li></ul>'
    + '<h1>Negative Keywords</h1><p><strong>Account level (all campaigns):</strong></p><ul><li>jobs</li><li>course</li></ul>'
    + '<p><strong>Panchakarma – Bengaluru only:</strong></p><ul><li>pune</li></ul><p><strong>Ayurvedic Doctor – Pune only:</strong></p><ul><li>bangalore</li></ul>');
  assert.deepEqual(negs(m.accountNegatives), ['jobs', 'course']);
  assert.deepEqual(m.campaigns.map(c => [c.name, negs(c.negatives)]), [['Panchakarma – Bengaluru', ['pune']], ['Ayurvedic Doctor – Pune', ['bangalore']]]);
  assert.deepEqual(m.adGroups.map(g => g.negatives.length), [0, 0]);
});

test('a named list under a shared negatives heading stays shared', () => {
  const m = parseHTML('<h1>Campaign 1: Botox</h1><h2>Botox</h2><p>Keywords:</p><ul><li>botox near me</li></ul>'
    + '<h1>Shared Negative Keyword Lists</h1><h2>Master Negatives (apply to all Google campaigns)</h2><ul><li>jobs</li></ul><h2>Competitor Names</h2><ul><li>the botox bar</li></ul>');
  assert.deepEqual(negs(m.accountNegatives), ['jobs', 'the botox bar']);
});

test('a numbered RSA list ends at the first unbulleted line, so a closing question is not a description', () => {
  const m = parseText('### Ad copy — Teen Drivers Ed\n- H1: Ohio-Approved Drivers Ed\n- H2: Flexible Lesson Times\n- H3: Free Home Pickup\n'
    + '- D1: State-approved online class plus 8 hours of in-car training with certified instructors.\n'
    + '- D2: Free home and school pickup across Columbus. Weekend and evening lessons available.\n\n'
    + 'Would you like me to add a separate campaign for adult driving lessons and road test prep?');
  assert.equal(m.adGroups[0].descriptions.length, 2);
  assert.ok(m.skipped.some(s => /Would you like me/.test(s.text)));
});

test('"Teen Drivers Ed — RSA" joins the Teen Drivers Ed ad group from the keyword table', () => {
  const m = parseText('| Ad Group | Keywords | Match |\n|---|---|---|\n| Teen Drivers Ed | drivers ed columbus<br>teen driving school | Phrase |\n\n'
    + '### Teen Drivers Ed — RSA\n- H1: Ohio-Approved Drivers Ed\n- H2: Flexible Lesson Times\n- H3: Free Home Pickup');
  assert.deepEqual(summary(m).map(g => [g.name, g.keywords.length, g.headlines.length]), [['Teen Drivers Ed', 2, 3]]);
});

test('a budget written in the campaign heading is read', () => {
  assert.equal(parseText("## Campaign 1: Teen Driver's Ed ($40/day)\nAd Group 1: Teen\nKeywords\n- drivers ed").campaigns[0].budget, 40);
  assert.equal(parseText('## Campaign 2 – Long Distance – $3,000/month\nAd Group 1: Long\nKeywords\n- long distance movers').campaigns[0].budget, 98.68);
});

test('a headline with a pin note keeps the headline', () => {
  const m = parseText('Ad Group 1: Dog Grooming\nKeywords\n- dog grooming\nHeadlines\n- Portland Dog Grooming (21) — Pin to position 1\n- Book a Groom Online\n- Pin H1 to position 1');
  assert.deepEqual(m.adGroups[0].headlines, ['Portland Dog Grooming', 'Book a Groom Online']);
  assert.ok(m.skipped.some(s => s.text === 'Pin H1 to position 1'));
});

test('a "Pro Tips" heading with advice lines is not an ad group', () => {
  const m = parseText('## Ad Group 1: Solar\n**Keywords:** solar installers\n**Headlines:** Solar Experts; Free Quote; Local Installers\n'
    + '## 💡 Pro Tips\n**Negative keywords:** check the search terms report weekly and add anything irrelevant.');
  assert.deepEqual(m.adGroups.map(g => g.name), ['Solar']);
});

/* ---------- plain-text pastes (Google Docs, no bold, no headings) ---------- */

test('plain text: a blank line before "Sitelinks" or "Callouts" ends the negatives list', () => {
  const m = parseText('Ad Group 1 – Drains\nKeywords\ndrain cleaning\nHeadlines\nDrain Cleaning Pros\nFast Drain Service\nLicensed Plumbers\n\n'
    + 'Account-Level Negatives\njobs\nfree\n\nSitelinks\nBook Online – /book\nCoupons – /coupons\n\nCallouts\nLicensed & Insured\n\nNext Steps\nPlease send changes by Friday.');
  assert.deepEqual(negs(m.accountNegatives), ['jobs', 'free']);
  assert.ok(m.skipped.some(s => s.text === 'Book Online – /book' && s.kind === 'other'));
});

test('plain text: "Callouts" inside a headline list and a Meta block after the negatives are not imported', () => {
  const m = parseText('Ad Group 1 – Personal Training\nKeywords\npersonal trainer charlotte\nHeadlines\nCertified Personal Trainers\nFree Fitness Assessment\nTrain 1-on-1\n'
    + 'Callouts\nFree Parking\nKids Club\nDescriptions\nWork 1-on-1 with a certified coach who builds a plan around your goals.\nStart with a free fitness assessment and body scan. No contract.\n\n'
    + 'Negative Keywords\nplanet fitness\njobs\nMeta Ads\nPrimary Text\nNew year, new you. Join with $0 enrollment this month.\nHeadline\nYour First Week Is Free');
  const g = m.adGroups[0];
  assert.deepEqual(g.headlines, ['Certified Personal Trainers', 'Free Fitness Assessment', 'Train 1-on-1']);
  assert.equal(g.descriptions.length, 2);
  assert.deepEqual([...negs(g.negatives), ...negs(m.campaigns[0].negatives), ...negs(m.accountNegatives)], ['planet fitness', 'jobs']);
  assert.ok(m.notes.some(n => /Skipped the "Meta Ads" section/.test(n.msg)));
});

/* ---------- budgets, locations and languages from international briefs ---------- */

test('budgets: lakh, crore, pcm, p/m and p.m.', () => {
  const b = v => E.parseBudget('Budget', v);
  assert.equal(b('₹1.5L/month').daily, 4934.21);
  assert.equal(b('£1,500 pcm').daily, 49.34);
  assert.equal(b('£900 p/m').daily, 29.61);
  assert.equal(b('₹ 2,00,000 p.m. (FY27 online budget is ₹1.2 Cr)').daily, 6578.95);
  assert.equal(b('₹1.2 Cr per year').amount, 12000000);
});

test('locations: city, region, country; "Pan India"; "UAE (Dubai & Abu Dhabi only)"; long place names', () => {
  const locs = v => E.settingFrom('Locations', v).v.map(l => l.name);
  assert.deepEqual(locs('Lahore, Punjab, Pakistan; Islamabad & Rawalpindi'), ['Lahore, Punjab, Pakistan', 'Islamabad, Pakistan', 'Rawalpindi, Pakistan']);
  assert.deepEqual(locs('Pan India (excluding J&K)'), ['India']);
  assert.deepEqual(locs('UAE (Dubai & Abu Dhabi only)'), ['Dubai, United Arab Emirates', 'Abu Dhabi, United Arab Emirates']);
  assert.deepEqual(locs('Dubai Hills Estate, Dubai'), ['Dubai Hills Estate, Dubai, United Arab Emirates']);
  assert.deepEqual(locs('US, Canada (presence only)'), ['United States', 'Canada']);
});

test('languages: Kannada is known, and an unknown language is reported', () => {
  assert.deepEqual(E.settingFrom('Languages', 'English, Hindi & Kannada').v, ['en', 'hi', 'kn']);
  const m = parseText('Languages: English, Klingon\nAd Group 1: A\nKeywords\n- a b');
  assert.ok(m.notes.some(n => /Klingon/.test(n.msg)));
});

/* ---------- spreadsheets ---------- */

test('spreadsheet: settings tab, campaign table with locations, languages and bidding, ad groups as columns, per-campaign negatives columns', () => {
  const m = sheets([
    ['Brief', [['Website', 'https://www.example.co.uk'], ['Locations', 'Manchester, UK; Salford'], ['Bidding', 'Maximise clicks for first 4 weeks, then switch to Target CPA £45'], ['Default match type', 'Phrase']]],
    ['Campaigns', [['Campaign', 'Budget', 'Locations', 'Languages', 'Bid Strategy', 'Ad Groups'],
      ['Repair', '£1,500 pcm', '', 'English', '', 'Boiler Repair\nBoiler Service'],
      ['Installs', '£900 p/m', 'Stockport', 'English, Polish', 'Maximise Conversions', 'New Boiler\nBoiler Finance']]],
    ['Keywords - Repair', [['Boiler Repair', 'Boiler Service'], ['[boiler repair manchester]', '"annual boiler service"'], ['"boiler engineer"', '[boiler service near me]'], ['"gas boiler repair"', '']]],
    ['Keywords - Installs', [['Campaign: Installs   |   all phrase match unless shown'], ['New Boiler', 'Boiler Finance'], ['new boiler installation', 'boiler finance'], ['[boiler fitters]', 'pay monthly boiler']]],
    ['Negs', [['Account-level negatives', 'Repair (campaign negatives)', 'Campaign negatives - Installs'], ['jobs', 'new boiler', 'repair'], ['diy', '', 'service']]]
  ]);
  assert.equal(m.detected.finalUrl, 'https://www.example.co.uk');
  assert.equal(m.detected.bidStrategy, 'maxclicks');
  assert.ok(!m.detected.targetCpa);
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget, c.bidStrategy, c.languages, c.locations && c.locations.map(l => l.name), negs(c.negatives)]), [
    ['Repair', 49.34, null, ['en'], null, ['new boiler']],
    ['Installs', 29.61, 'maxconv', ['en', 'pl'], ['Stockport, United Kingdom'], ['repair', 'service']]]);
  assert.deepEqual(summary(m).map(g => [g.name, g.campaign, g.keywords]), [
    ['Boiler Repair', 'Repair', ['[boiler repair manchester]', '"boiler engineer"', '"gas boiler repair"']],
    ['Boiler Service', 'Repair', ['"annual boiler service"', '[boiler service near me]']],
    ['New Boiler', 'Installs', ['"new boiler installation"', '[boiler fitters]']],
    ['Boiler Finance', 'Installs', ['"boiler finance"', '"pay monthly boiler"']]]);
  assert.deepEqual(negs(m.accountNegatives), ['jobs', 'diy']);
  assert.ok(!m.notes.some(n => /looked like an ad group/.test(n.msg)), 'tab names are not ad groups');
});

test('spreadsheet: ad copy written one row per asset, with a character count column', () => {
  const m = sheets([
    ['Ads', [['Campaign', 'Ad Group', 'Asset', 'Text', 'Chars'],
      ['Off-Plan', 'Apartments', 'Headline 1', 'Dubai Hills Apartments', '22'], ['', '', 'Headline 2', '10% Down Payment Plan', '21'],
      ['', '', 'Description 1', 'Off-plan 1, 2 and 3 bedroom apartments. Pay 10% now and the rest on handover.', '76'],
      ['', '', 'Final URL', 'https://www.example.com/apartments', ''], ['', '', 'Path 1', 'dubai-hills', '11'], ['', '', 'Path 2', 'apartments', '10'],
      ['Ready Villas', 'Villas', 'Headline 1', 'Ready Villas in the UAE', '23']]],
    ['Copy', [['Element', 'Copy', 'Chars'], ['Ad group', 'Boiler Repair'], ['Headline 1', 'Boiler Repair in Manchester', '27'], ['Path 1', 'boiler-repair', '13']]]
  ]);
  assert.deepEqual(summary(m).map(g => [g.name, g.campaign, g.headlines, g.finalUrl]), [
    ['Apartments', 'Off-Plan', ['Dubai Hills Apartments', '10% Down Payment Plan'], 'https://www.example.com/apartments'],
    ['Villas', 'Ready Villas', ['Ready Villas in the UAE'], ''],
    ['Boiler Repair', 'Search campaign', ['Boiler Repair in Manchester'], '']]);
  assert.deepEqual([m.adGroups[0].path1, m.adGroups[0].path2, m.adGroups[2].path1], ['dubai-hills', 'apartments', 'boiler-repair']);
});

test('spreadsheet: keyword columns by match type, and a Level column on the negatives tab', () => {
  const m = sheets([
    ['Keywords', [['Campaign', 'Ad Group', 'Exact Match', 'Phrase Match', 'Broad Match'],
      ['Implants', 'Dental Implants', 'dental implants dubai', 'implant cost dubai', 'best implant dentist'], ['', '', '', 'tooth implant marina', '']]],
    ['Negatives', [['Negative Keyword', 'Match Type', 'Level', 'Campaign', 'Ad Group'],
      ['free', 'Broad', 'Account', 'All campaigns', ''], ['dentures', 'Phrase', 'Campaign', 'Implants', ''], ['veneers', 'Exact', 'Ad Group', 'Implants', 'Dental Implants']]]
  ]);
  const g = byName(m, 'Dental Implants');
  assert.deepEqual(g.keywords, ['[dental implants dubai]', '"implant cost dubai"', 'best implant dentist (broad)', '"tooth implant marina"']);
  assert.deepEqual(g.negatives, ['[veneers]']);
  assert.deepEqual(negs(m.campaigns[0].negatives), ['"dentures"']);
  assert.deepEqual(negs(m.accountNegatives), ['free (broad)']);
});

test('spreadsheet: settings blocks per campaign in one tab, with shared settings written after the last block', () => {
  const m = sheets([['Campaign Settings', [
    ['Campaign', 'Off-Plan'], ['Budget', 'AED 1,200 per day'], ['Locations', 'Dubai Hills Estate, Dubai'], ['Languages', 'English, Arabic'],
    ['Campaign', 'Ready Villas'], ['Budget', 'AED 18,000 per month'], ['Locations', 'UAE (Dubai & Abu Dhabi only)'], ['Languages', 'English'],
    ['Bid strategy', 'Maximise Conversions']]]]);
  assert.deepEqual(m.campaigns.map(c => [c.name, c.budget, c.languages, c.locations.map(l => l.name), c.bidStrategy]), [
    ['Off-Plan', 1200, ['en', 'ar'], ['Dubai Hills Estate, Dubai, United Arab Emirates'], null],
    ['Ready Villas', 592.11, ['en'], ['Dubai, United Arab Emirates', 'Abu Dhabi, United Arab Emirates'], null]]);
  assert.equal(m.detected.bidStrategy, 'maxconv');
});

/* ---------- per-campaign bidding and languages in the export ---------- */

test('export: each campaign row carries its own bid strategy, target CPA and languages', () => {
  const m = parseText('Ad Group 1: A\nKeywords\n- a b\nHeadlines\n- One Two\n- Three Four\n- Five Six\nDescriptions\n- Seven eight nine ten eleven twelve.\n- Thirteen fourteen fifteen sixteen.');
  m.campaigns[0].bidStrategy = 'tcpa'; m.campaigns[0].targetCpa = 140; m.campaigns[0].languages = ['en', 'es']; m.campaigns[0].budget = 20;
  const t = E.exportRows(m, settings({ bidStrategy: 'maxconv' }));
  const row = t.rows[t.kinds.indexOf('campaign')];
  const col = h => row[t.headers.indexOf(h)];
  assert.deepEqual([col('Bid Strategy Type'), col('Target CPA'), col('Languages')], ['Maximize conversions', '140', 'en;es']);
  m.campaigns[0].targetCpa = null;
  assert.ok(E.validate(m, settings({ bidStrategy: 'maxconv' }), '2026-10-06').errors.some(e => e.scope === 'campaign' && e.field === 'tcpa'));
});

test('negatives listed under a loose campaign name find the campaign; unknown names go to every campaign with a note', () => {
  const m = parseText('Campaign 1: DBD – Implants & Cosmetic\nAd Group 1: Implants\nKeywords\n- dental implants\nCampaign 2: DBD – Emergency\nAd Group 2: Emergency\nKeywords\n- emergency dentist\n'
    + '# Negative Keywords\nImplants & Cosmetic only:\n- cheap\nWhatever Campaign only:\n- zzz');
  assert.deepEqual(negs(m.campaigns[0].negatives), ['cheap']);
  assert.deepEqual(negs(m.accountNegatives), ['zzz']);
  assert.ok(m.notes.some(n => /"Whatever" match no campaign/.test(n.msg)));
});

test('keyword insertion counts only its default text', () => {
  assert.equal(E.adLen('{KeyWord:Dental Implants Clinic Dubai}'), 28);
  const m = parseText('Ad Group 1: Implants\nKeywords\n- dental implants\nHeadlines\n- {KeyWord:Dental Implants Clinic Dubai}\n- Free 3D Scan\n- Book a Consult\nDescriptions\n- Implants from experienced surgeons. Book your free scan today.\n- Flexible payment plans on every implant treatment we offer.');
  assert.equal(m.adGroups[0].headlines[0], '{KeyWord:Dental Implants Clinic Dubai}');
  assert.ok(!E.validate(m, settings(), '2026-10-06').errors.some(e => /characters/.test(e.msg)));
});
