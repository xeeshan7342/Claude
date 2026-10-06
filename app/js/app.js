/* Campaign Bulk Builder page: wires the engine, readers, memory and AI reader to the interface. */
(function () {
  'use strict';
  const E = window.CBEngine;
  const R = window.CBReaders;
  const AI = window.CBAI;
  const mem = window.CBMemory.create();
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w, p) => n + ' ' + (n === 1 ? w : (p || w + 's'));
  const clone = o => JSON.parse(JSON.stringify(o));
  const pad = n => String(n).padStart(2, '0');
  const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const money = n => (Math.round(n * 100) / 100).toLocaleString('en-US');
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del(k) { try { window.localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };

  const DEFAULTS = {
    finalUrl: '', matchType: 'phrase', bidStrategy: 'maxclicks', targetCpa: '', maxCpc: '',
    locations: [], allLocations: false, presenceOnly: true, languages: ['en'], searchPartners: false, campaignStatus: 'Paused', startDate: ''
  };
  const S = clone(DEFAULTS);
  const setS = obj => { Object.keys(S).forEach(k => delete S[k]); Object.assign(S, clone(DEFAULTS), clone(obj)); };
  const EMPTY_MODEL = () => ({ source: '', title: '', campaigns: [], adGroups: [], accountNegatives: [], notes: [], skipped: [], detected: {} });
  const state = {
    source: null, model: EMPTY_MODEL(), ruleModel: null, aiModel: null, readMode: 'rules', aiInfo: '',
    isSample: false, open: new Set(), v: { errors: [], warnings: [] }, dirty: false, profileName: '', profilePicked: false, profileApplied: '', aiAbort: null
  };

  /* downloads: Claude's download capability when this runs as a Claude artifact, a normal browser download otherwise */
  let dlApi = null;
  const dlReady = (async () => {
    try { dlApi = (window.claude && window.claude.use) ? await window.claude.use('downloads') : null; } catch (e) { dlApi = null; }
    return dlApi;
  })();
  async function saveFile(filename, data, mime) {
    const api = dlApi || await dlReady;
    if (api) { await api.save({ filename, data }); return; }
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---------------- settings ---------------- */
  function buildSettingsUI() {
    const sel = $('#locAdd');
    E.COUNTRIES.forEach(([n, id]) => { const o = document.createElement('option'); o.value = id; o.textContent = n; sel.appendChild(o); });
    const more = $('#langMore');
    E.LANGS.slice(9).forEach(([c, n]) => { const o = document.createElement('option'); o.value = c; o.textContent = n; more.appendChild(o); });
    $('#startDate').min = todayISO();

    $('#finalUrl').addEventListener('input', e => { S.finalUrl = e.target.value.trim(); updateAllSerps(); refresh(); });
    $$('input[name="matchType"]').forEach(r => r.addEventListener('change', e => { S.matchType = e.target.value; refresh(); }));
    $('#bidStrategy').addEventListener('change', e => { S.bidStrategy = e.target.value; syncBidRows(); refresh(); });
    $('#targetCpa').addEventListener('input', e => { S.targetCpa = e.target.value; refresh(); });
    $('#maxCpc').addEventListener('input', e => { S.maxCpc = e.target.value; refresh(); });
    sel.addEventListener('change', e => {
      const id = e.target.value; if (!id) return;
      if (id === '__all') { S.allLocations = true; S.locations = []; }
      else {
        const c = E.COUNTRIES.find(x => x[1] === id);
        if (c && !S.locations.some(l => l.id === id)) S.locations.push({ name: c[0], id });
        S.allLocations = false;
      }
      e.target.value = ''; renderLocations(); refresh();
    });
    const addCustom = () => {
      const inp = $('#locCustom'); const v = E.norm(inp.value); if (!v) return;
      E.parseLocations(v).list.forEach(loc => { if (!S.locations.some(l => l.name.toLowerCase() === loc.name.toLowerCase())) S.locations.push(loc); });
      S.allLocations = false;
      inp.value = ''; renderLocations(); refresh();
    };
    $('#locCustomAdd').addEventListener('click', addCustom);
    $('#locCustom').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
    $('#locChips').addEventListener('click', e => {
      const b = e.target.closest('button[data-loc]'); if (!b) return;
      if (b.dataset.loc === 'all') S.allLocations = false; else S.locations.splice(+b.dataset.loc, 1);
      renderLocations(); refresh();
    });
    $('#presenceOnly').addEventListener('change', e => { S.presenceOnly = e.target.checked; refresh(); });
    $('#langs').addEventListener('change', () => { S.languages = $$('.lang').filter(x => x.checked).map(x => x.value); refresh(); });
    more.addEventListener('change', e => { const c = e.target.value; if (c && !S.languages.includes(c)) S.languages.push(c); e.target.value = ''; renderLangs(); refresh(); });
    $('#searchPartners').addEventListener('change', e => { S.searchPartners = e.target.checked; refresh(); });
    $$('input[name="campStatus"]').forEach(r => r.addEventListener('change', e => { S.campaignStatus = e.target.value; refresh(); }));
    $('#startDate').addEventListener('change', e => { S.startDate = e.target.value; refresh(); });

    $('#profileSel').addEventListener('change', e => {
      const name = e.target.value;
      state.profileName = name;
      state.profilePicked = !!name;
      const p = mem.profiles().find(x => x.name === name);
      if (p) { setS(Object.assign({}, S, p.settings)); syncSettingsUI(); updateAllSerps(); refresh(); toast('Applied the ' + name + ' profile.'); }
      $('#profileDel').hidden = !name;
    });
    $('#profileSave').addEventListener('click', () => {
      let host = '';
      try { host = new URL(S.finalUrl).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
      let name = state.profileName || host || (state.model.title || '').slice(0, 40);
      try { const asked = window.prompt('Name this client profile', name); if (asked === null) return; name = asked; } catch (e) { /* prompts blocked: keep the default name */ }
      const saved = mem.saveProfile(name, S);
      if (!saved) { toast('Give the profile a name.', true); return; }
      state.profileName = saved; state.profilePicked = true; renderProfiles(); toast('Saved the ' + saved + ' profile.');
    });
    $('#profileDel').addEventListener('click', () => {
      const name = state.profileName; if (!name) return;
      mem.deleteProfile(name); state.profileName = ''; state.profilePicked = false; renderProfiles(); toast('Deleted the ' + name + ' profile.');
    });
  }
  function renderProfiles() {
    const sel = $('#profileSel');
    sel.innerHTML = '<option value="">No profile</option>' + mem.profiles().map(p => '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>').join('');
    sel.value = state.profileName && mem.profiles().some(p => p.name === state.profileName) ? state.profileName : '';
    $('#profileDel').hidden = !sel.value;
  }
  function syncBidRows() {
    $('#tcpaRow').hidden = S.bidStrategy !== 'tcpa';
    $('#cpcRow').hidden = S.bidStrategy !== 'manual';
  }
  function renderLocations() {
    const chips = [];
    if (S.allLocations) chips.push('<span class="chip">All countries<button type="button" data-loc="all" aria-label="Remove all countries">&times;</button></span>');
    S.locations.forEach((l, i) => chips.push('<span class="chip">' + esc(l.name) + (l.id ? ' <span class="mono">' + esc(l.id) + '</span>' : ' <span class="mono" title="Matched by name in Ads Editor">name</span>') + '<button type="button" data-loc="' + i + '" aria-label="Remove ' + esc(l.name) + '">&times;</button></span>'));
    $('#locChips').innerHTML = chips.length ? chips.join('') : '<span class="hint">No locations yet. Add one, or pick All countries.</span>';
  }
  function renderLangs() {
    const shown = E.LANGS.filter((x, i) => i < 9 || S.languages.includes(x[0]));
    $('#langs').innerHTML = shown.map(([c, n]) => '<label class="check"><input type="checkbox" class="lang" value="' + esc(c) + '"' + (S.languages.includes(c) ? ' checked' : '') + '><span>' + esc(n) + '</span></label>').join('');
  }
  function syncSettingsUI() {
    $('#finalUrl').value = S.finalUrl;
    const mt = $('input[name="matchType"][value="' + S.matchType + '"]'); if (mt) mt.checked = true;
    $('#bidStrategy').value = S.bidStrategy; syncBidRows();
    $('#targetCpa').value = S.targetCpa; $('#maxCpc').value = S.maxCpc;
    renderLocations(); renderLangs();
    $('#presenceOnly').checked = S.presenceOnly;
    $('#searchPartners').checked = S.searchPartners;
    const cs = $('input[name="campStatus"][value="' + S.campaignStatus + '"]'); if (cs) cs.checked = true;
    $('#startDate').value = S.startDate;
    renderProfiles();
  }

  // What the doc says goes on top of the current settings. Returns the list of things taken from the doc.
  function applyDetected(model) {
    const d = model.detected || {};
    const picked = [];
    if (d.finalUrl) { S.finalUrl = d.finalUrl; picked.push('final URL'); }
    if (d.locations && d.locations.length) { S.locations = clone(d.locations); S.allLocations = false; picked.push('locations'); }
    if (d.presenceOnly != null) { S.presenceOnly = d.presenceOnly; picked.push('location option'); }
    if (d.languages) { S.languages = d.languages.slice(); picked.push('languages'); }
    if (d.bidStrategy) { S.bidStrategy = d.bidStrategy; picked.push('bid strategy'); }
    if (d.targetCpa) { S.targetCpa = String(d.targetCpa); picked.push('target CPA'); }
    if (d.maxCpc) { S.maxCpc = String(d.maxCpc); picked.push('max CPC'); }
    if (d.matchType) { S.matchType = d.matchType; picked.push('match type'); }
    if (d.networks != null) { S.searchPartners = d.networks; picked.push('networks'); }
    if (d.startDate && d.startDate >= todayISO()) { S.startDate = d.startDate; picked.push('start date'); }
    return picked;
  }
  // A new doc starts from clean defaults, so one client's settings never leak into the next. A profile you picked
  // yourself stays on; otherwise the profile whose site matches the doc's final URL is used, for this doc only.
  function freshSettings(model) {
    const d = model.detected || {};
    let prof = state.profilePicked ? mem.profiles().find(p => p.name === state.profileName) : null;
    if (!prof) prof = d.finalUrl ? mem.profileForUrl(d.finalUrl) : null;
    state.profileName = prof ? prof.name : '';
    setS(prof ? prof.settings : {});
    state.profileApplied = prof ? prof.name : '';
    return applyDetected(model);
  }

  /* ---------------- loading ---------------- */
  const parseSource = src => E.parseBlocksToModel(src.blocks, src.name, { memory: mem.roles() });

  function loadModel(model, opts) {
    opts = opts || {};
    state.model = model;
    state.isSample = !!opts.sample;
    state.dirty = false;
    state.open = new Set(model.adGroups[0] ? [model.adGroups[0].id] : []);
    model.adGroups.forEach(g => { const [a, b] = E.suggestPaths(g.name); g._autoPaths = g.path1 === a && g.path2 === b; });
    model._picked = opts.fresh ? freshSettings(model) : applyDetected(model);
    syncSettingsUI(); renderDoc(); renderTree(); renderReport(); refresh();
    if (opts.announce) {
      const kw = model.adGroups.reduce((s, g) => s + g.keywords.length, 0);
      if (model.adGroups.length) toast('Read ' + (model.source || 'the doc') + ': ' + plural(model.campaigns.length, 'campaign') + ', ' + plural(model.adGroups.length, 'ad group') + ', ' + plural(kw, 'keyword') + '.');
      else toast('No ad groups found in ' + (model.source || 'the doc') + '. Check the import report, or try AI reading.', true);
    }
  }
  function loadSource(src, opts) {
    state.source = src;
    state.aiModel = null; state.readMode = 'rules'; state.aiInfo = '';
    $('#aiBack').hidden = true; $('#aiProgress').textContent = '';
    state.ruleModel = parseSource(src);
    loadModel(state.ruleModel, Object.assign({ fresh: true, announce: true }, opts || {}));
  }
  function reread() {
    if (!state.source) return;
    state.ruleModel = parseSource(state.source);
    state.readMode = 'rules';
    $('#aiBack').hidden = true;
    loadModel(state.ruleModel, { announce: true });
  }

  function renderDoc() {
    const m = state.model;
    const has = !!state.source;
    $('#docbar').hidden = !has;
    $('#aiQuick').hidden = !has;
    $('#docName').textContent = m.source || 'Untitled doc';
    const ext = /\.([a-z0-9]{2,5})$/i.exec(m.source || '');
    $('#docBadge').textContent = ext ? ext[1].toUpperCase() : 'TEXT';
    $('#sampleTag').hidden = !state.isSample;
    const tag = $('#modeTag');
    tag.textContent = state.readMode === 'ai' ? 'Read by AI' : 'Read by rules';
    tag.className = 'mode-tag' + (state.readMode === 'ai' ? ' ai' : '');
    const notes = [];
    if (state.isSample) notes.push({ level: 'info', msg: 'This is a made-up sample. Load your own doc to replace it.' });
    if (state.readMode === 'ai' && state.aiInfo) notes.push({ level: 'info', msg: state.aiInfo });
    if (state.profileApplied) notes.push({ level: 'info', msg: 'Client profile "' + state.profileApplied + '" applied.' });
    if (m._picked && m._picked.length) notes.push({ level: 'info', msg: 'Taken from the doc: ' + m._picked.join(', ') + '.' });
    if (has && !S.finalUrl && m.adGroups.some(g => !g.finalUrl)) notes.push({ level: 'warn', msg: 'The doc has no final URL. Add the client\'s URL in Account defaults.' });
    m.notes.forEach(n => notes.push(n));
    $('#notes').innerHTML = notes.map(n => '<div class="note ' + (n.level === 'warn' ? 'warn' : n.level === 'err' ? 'err' : 'info') + '">' + esc(n.msg) + '</div>').join('');
    $('#formatHelp').open = has && !m.adGroups.length;
  }

  /* ---------------- import report ---------------- */
  const MAIN_KINDS = new Set(['item', 'label', 'limit', 'ai', 'table']);
  function reportOptions(entry) {
    const g = findG(entry.agId) || currentAg();
    const target = g ? esc(g.name) : 'the first ad group';
    const sug = entry.suggest;
    return '<option value="">Use as…</option>'
      + (state.model.adGroups.length ? '<optgroup label="Add to ' + target + '">'
        + '<option value="add:headline">Add as headline' + (sug === 'headline' ? ' (suggested)' : '') + '</option>'
        + '<option value="add:description">Add as description' + (sug === 'description' ? ' (suggested)' : '') + '</option>'
        + '<option value="add:keyword">Add as keyword</option>'
        + '<option value="add:negative">Add as negative keyword</option></optgroup>' : '')
      + (state.readMode === 'rules' ? '<optgroup label="Teach: lines like this are">'
        + '<option value="teach:keywords">a keywords label</option>'
        + '<option value="teach:negatives">a negative keywords label</option>'
        + '<option value="teach:headlines">a headlines label</option>'
        + '<option value="teach:descriptions">a descriptions label</option>'
        + '<option value="teach:adcopy">a mixed ad text label</option>'
        + '<option value="teach:adgroup">an ad group name</option>'
        + '<option value="teach:campaign">a campaign name</option>'
        + '<option value="teach:other">a section to skip</option>'
        + '<option value="teach:ignore">always ignore this line</option></optgroup>' : '');
  }
  function reportRow(entry, ix) {
    return '<li><div><div class="txt">' + esc(entry.text) + '</div><div class="why">' + esc(entry.reason) + '</div></div>'
      + '<select data-rep="' + ix + '" aria-label="What is this line?">' + reportOptions(entry) + '</select></li>';
  }
  function renderReport() {
    const list = state.model.skipped || [];
    const main = [], more = [];
    list.forEach((e, i) => (MAIN_KINDS.has(e.kind) ? main : more).push([e, i]));
    $('#reportPanel').hidden = !list.length;
    $('#reportTitle').textContent = 'Import report: ' + plural(list.length, 'line') + ' not used';
    $('#reportMain').innerHTML = main.length ? main.slice(0, 150).map(([e, i]) => reportRow(e, i)).join('') : '<li class="hint" style="display:block">Nothing inside the keyword and ad sections was left out.</li>';
    $('#reportMoreBox').hidden = !more.length;
    $('#reportMoreSum').textContent = plural(more.length, 'other line') + ' (headings, notes, sitelinks and other text outside the ad sections)';
    $('#reportMore').innerHTML = more.slice(0, 200).map(([e, i]) => reportRow(e, i)).join('');
  }
  function currentAg() {
    const openId = [...state.open].pop();
    return findG(openId) || state.model.adGroups[0] || null;
  }
  function onReportChoice(sel) {
    const entry = state.model.skipped[+sel.dataset.rep];
    const [act, what] = sel.value.split(':');
    if (!entry || !act) return;
    if (act === 'add') {
      const g = findG(entry.agId) || currentAg();
      if (!g) { toast('Add an ad group first.', true); sel.value = ''; return; }
      if (what === 'headline') { if (g.headlines.filter(Boolean).length >= 15) { toast(g.name + ' already has 15 headlines.', true); sel.value = ''; return; } g.headlines.push(entry.text); }
      else if (what === 'description') { if (g.descriptions.filter(Boolean).length >= 4) { toast(g.name + ' already has 4 descriptions.', true); sel.value = ''; return; } g.descriptions.push(entry.text); }
      else if (what === 'keyword') { E.linesToKw(entry.text).forEach(k => g.keywords.push(k)); }
      else if (what === 'negative') { E.linesToKw(entry.text).forEach(k => g.negatives.push(k)); }
      state.model.skipped.splice(+sel.dataset.rep, 1);
      state.dirty = true;
      state.open.add(g.id);
      renderTree(); renderReport(); refresh();
      toast('Added to ' + g.name + '.');
      return;
    }
    if (act === 'teach') {
      mem.teach(entry.text, what);
      renderMemory();
      let go = true;
      if (state.dirty) {
        try { go = window.confirm('Saved to memory. Read the doc again now? Edits you made below will be lost.'); } catch (e) { go = false; }
      }
      if (go) { reread(); toast('Saved to memory and read the doc again.'); }
      else { sel.value = ''; toast('Saved to memory. It applies the next time you load a doc.'); }
    }
  }

  /* ---------------- tree ---------------- */
  const campOptions = sel => state.model.campaigns.map(c => '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.name || 'Untitled campaign') + '</option>').join('');

  function copyRow(g, f, i, v) {
    const max = f === 'h' ? 30 : 90;
    const len = E.norm(v).length;
    const id = f + '-' + g.id + '-' + i;
    const label = (f === 'h' ? 'Headline ' : 'Description ') + (i + 1);
    const field = f === 'h'
      ? '<input id="' + id + '" data-f="h" data-i="' + i + '" value="' + esc(v) + '" aria-label="' + label + '" autocomplete="off">'
      : '<textarea id="' + id + '" data-f="d" data-i="' + i + '" rows="2" aria-label="' + label + '">' + esc(v) + '</textarea>';
    return '<div class="copy-row"><span class="ix mono">' + (i + 1) + '</span>' + field +
      '<span class="cnt mono' + (len > max ? ' over' : '') + '" data-cnt="' + id + '">' + len + '/' + max + '</span>' +
      '<button type="button" class="x" data-act="del-' + f + '" data-i="' + i + '" aria-label="Remove ' + label.toLowerCase() + '">&times;</button></div>';
  }

  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return 'example.com'; } }
  function serpInner(g) {
    const hs = g.headlines.map(E.norm).filter(Boolean).slice(0, 3);
    const ds = g.descriptions.map(E.norm).filter(Boolean).slice(0, 2);
    const host = hostOf(g.finalUrl || S.finalUrl);
    const path = [g.path1, g.path2].filter(Boolean).join('/');
    return '<div class="serp-top"><b>Sponsored</b></div>' +
      '<div class="serp-url">' + esc(host) + (path ? '/' + esc(path) : '') + '</div>' +
      '<div class="serp-h">' + (hs.length ? esc(hs.join(' | ')) : '<span class="hint">Add headlines to preview</span>') + '</div>' +
      '<div class="serp-d">' + esc(ds.join(' ')) + '</div>';
  }

  function agHTML(g) {
    const isOpen = state.open.has(g.id);
    const head = '<summary><span class="caret" aria-hidden="true"></span><span class="ag-title" data-title>' + esc(g.name || 'Untitled ad group') + '</span>' +
      '<span class="ag-counts mono" data-counts></span><span class="pill-sm ok" data-state>Ready</span></summary>';
    if (!isOpen) return '<details class="ag" data-gid="' + esc(g.id) + '">' + head + '</details>';
    const kwText = g.keywords.map(E.kwToLine).join('\n');
    const negText = g.negatives.map(E.kwToLine).join('\n');
    const manual = S.bidStrategy === 'manual';
    return '<details class="ag" data-gid="' + esc(g.id) + '" open>' + head + '<div class="ag-body">' +
      '<div class="grid-3">' +
        '<div class="field"><label class="lbl" for="name-' + g.id + '">Ad group name</label><input id="name-' + g.id + '" data-f="name" value="' + esc(g.name) + '" autocomplete="off"></div>' +
        '<div class="field"><label class="lbl" for="camp-' + g.id + '">Campaign</label><select id="camp-' + g.id + '" data-f="campaignId">' + campOptions(g.campaignId) + '</select></div>' +
        '<div class="field"><label class="lbl" for="finalUrl-' + g.id + '">Final URL <span class="mono">override</span></label><input id="finalUrl-' + g.id + '" data-f="finalUrl" type="url" value="' + esc(g.finalUrl) + '" placeholder="' + esc(S.finalUrl || 'Uses the account final URL') + '" spellcheck="false"></div>' +
      '</div>' +
      '<div class="grid-paths">' +
        '<div class="field"><label class="lbl" for="path1-' + g.id + '">Path 1 <span class="mono" data-cnt="path1-' + g.id + '">' + (g.path1 || '').length + '/15</span></label><input id="path1-' + g.id + '" data-f="path1" value="' + esc(g.path1) + '" spellcheck="false"></div>' +
        '<div class="field"><label class="lbl" for="path2-' + g.id + '">Path 2 <span class="mono" data-cnt="path2-' + g.id + '">' + (g.path2 || '').length + '/15</span></label><input id="path2-' + g.id + '" data-f="path2" value="' + esc(g.path2) + '" spellcheck="false"></div>' +
        (manual ? '<div class="field"><label class="lbl" for="maxCpc-' + g.id + '">Max CPC <span class="mono">override</span></label><input id="maxCpc-' + g.id + '" data-f="maxCpc" type="number" min="0" step="0.01" inputmode="decimal" value="' + (g.maxCpc != null ? esc(g.maxCpc) : '') + '" placeholder="' + esc(S.maxCpc || 'default') + '"></div>'
          : '<div class="serp-label">Paths are suggested from the ad group name. Edit them freely.</div>') +
      '</div>' +
      '<div class="ag-cols">' +
        '<div class="field">' +
          '<label class="lbl" for="kw-' + g.id + '">Keywords <span class="mono" data-kwcount>' + g.keywords.length + '</span></label>' +
          '<textarea id="kw-' + g.id + '" class="kw-area" data-f="keywords" spellcheck="false">' + esc(kwText) + '</textarea>' +
          '<p class="hint">One per line. Plain keywords use the default match type. [exact], "phrase" or keyword (broad) overrides it.</p>' +
          '<label class="lbl" for="neg-' + g.id + '" style="margin-top:8px">Ad group negatives <span class="mono">' + g.negatives.length + '</span></label>' +
          '<textarea id="neg-' + g.id + '" class="neg-area" data-f="negatives" spellcheck="false" placeholder="Optional">' + esc(negText) + '</textarea>' +
        '</div>' +
        '<div class="field" style="gap:12px">' +
          '<div><div class="serp-label" style="margin-bottom:6px">Ad preview</div><div class="serp" data-serp>' + serpInner(g) + '</div></div>' +
          '<div class="field"><span class="lbl">Headlines <span class="mono" data-hcount>' + g.headlines.length + '/15</span></span>' +
            '<div class="copy-list" id="h-' + g.id + '">' + g.headlines.map((h, i) => copyRow(g, 'h', i, h)).join('') + '</div>' +
            (g.headlines.length < 15 ? '<button type="button" class="btn btn-ghost btn-sm add-line" data-act="add-h">+ Headline</button>' : '') + '</div>' +
          '<div class="field"><span class="lbl">Descriptions <span class="mono">' + g.descriptions.length + '/4</span></span>' +
            '<div class="copy-list" id="d-' + g.id + '">' + g.descriptions.map((d, i) => copyRow(g, 'd', i, d)).join('') + '</div>' +
            (g.descriptions.length < 4 ? '<button type="button" class="btn btn-ghost btn-sm add-line" data-act="add-d">+ Description</button>' : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ag-foot"><ul class="ag-issues" data-issues></ul><button type="button" class="btn btn-ghost btn-sm danger" data-act="del-ag">Remove ad group</button></div>' +
    '</div></details>';
  }

  const monthlyHint = b => +b > 0 ? 'About ' + money(b * 30.4) + ' a month' : 'Per day';
  function campHTML(c) {
    const ags = state.model.adGroups.filter(g => g.campaignId === c.id);
    const negs = c.negatives || [];
    const locs = c.locations && c.locations.length ? c.locations : null;
    return '<article class="camp" data-cid="' + esc(c.id) + '">' +
      '<div class="camp-head">' +
        '<div class="field grow"><label class="lbl" for="cn-' + c.id + '">Campaign</label><input id="cn-' + c.id + '" class="camp-name" data-cf="name" value="' + esc(c.name) + '" autocomplete="off"></div>' +
        '<div class="field budget"><label class="lbl" for="cb-' + c.id + '">Daily budget</label><input id="cb-' + c.id + '" type="number" min="0" step="0.01" inputmode="decimal" data-cf="budget" value="' + (c.budget != null ? esc(c.budget) : '') + '" placeholder="e.g. 40"><span class="budget-hint" data-bhint>' + esc(monthlyHint(c.budget)) + '</span></div>' +
        '<div class="camp-meta mono" data-cmeta></div>' +
        (ags.length ? '' : '<button type="button" class="btn btn-ghost btn-sm danger" data-act="del-camp">Remove</button>') +
      '</div>' +
      '<div class="camp-extra">' +
        (locs ? '<div class="loc-override"><span>Locations for this campaign:</span>' + locs.map(l => '<span class="chip">' + esc(l.name) + (l.id ? ' <span class="mono">' + esc(l.id) + '</span>' : '') + '</span>').join('') + '<button type="button" class="btn btn-ghost btn-sm" data-act="clear-cloc">Use account defaults</button></div>' : '') +
        '<details' + (negs.length ? ' open' : '') + '><summary class="hint" style="cursor:pointer">Campaign negatives <span class="mono">' + (negs.length || '') + '</span></summary>' +
          '<textarea id="cneg-' + c.id + '" class="neg-area" data-cf="negatives" spellcheck="false" placeholder="Only for this campaign">' + esc(negs.map(E.kwToLine).join('\n')) + '</textarea></details>' +
      '</div>' +
      (ags.length ? ags.map(agHTML).join('') : '<div class="empty">No ad groups here yet.</div>') +
      '<div class="camp-foot"><button type="button" class="btn btn-ghost btn-sm" data-act="add-ag">+ Ad group</button></div>' +
    '</article>';
  }

  function renderTree() {
    const m = state.model;
    if (!state.source && !m.campaigns.length) {
      $('#campaigns').innerHTML = '<div class="panel welcome"><h2>Start with a campaign doc</h2>' +
        '<p>Load a Word doc, an Excel workbook, a CSV or a text file with the campaign structure, or paste the text. The tool finds the campaigns, ad groups, keywords and ad text, checks them against Google\'s limits, and builds one file for Ads Editor.</p>' +
        '<p>Nothing is uploaded. Lines it can\'t place show up in an import report, where you can teach it how your docs are written.</p>' +
        '<div class="row"><label for="fileIn" class="btn btn-primary" tabindex="0">Load campaign doc</label><button type="button" class="btn" data-act="sample">Try the sample</button></div></div>';
    } else {
      $('#campaigns').innerHTML = m.campaigns.length ? m.campaigns.map(campHTML).join('') : '<div class="panel empty">No campaigns found. Check the import report above, try AI reading, or add a campaign by hand.</div>';
    }
    $('#acctNeg').value = m.accountNegatives.map(E.kwToLine).join('\n');
    $('#acctNegCount').textContent = m.accountNegatives.length || '';
    $('#toggleAll').textContent = state.open.size >= m.adGroups.length && m.adGroups.length ? 'Collapse all' : 'Expand all';
  }

  const findG = id => id ? state.model.adGroups.find(g => g.id === id) : null;
  const findC = id => state.model.campaigns.find(c => c.id === id);

  function rerenderAg(g) {
    const el = $('details.ag[data-gid="' + g.id + '"]');
    if (el) el.outerHTML = agHTML(g);
  }
  function updateCounter(id, len, max) {
    const c = $('[data-cnt="' + id + '"]'); if (!c) return;
    c.textContent = len + '/' + max; c.classList.toggle('over', len > max);
  }
  function updateSerp(g) { const el = $('details.ag[data-gid="' + g.id + '"] [data-serp]'); if (el) el.innerHTML = serpInner(g); }
  function updateAllSerps() { state.model.adGroups.forEach(updateSerp); }

  function bindTree() {
    const root = $('#campaigns');
    root.addEventListener('input', e => {
      const t = e.target;
      const cEl = t.closest('[data-cid]');
      if (t.dataset.cf && cEl) {
        const c = findC(cEl.dataset.cid);
        if (t.dataset.cf === 'name') { c.name = t.value; $$('option[value="' + c.id + '"]').forEach(o => { o.textContent = t.value || 'Untitled campaign'; }); }
        else if (t.dataset.cf === 'budget') { c.budget = t.value === '' ? null : +t.value; const h = $('[data-bhint]', cEl); if (h) h.textContent = monthlyHint(c.budget); }
        else if (t.dataset.cf === 'negatives') c.negatives = E.linesToKw(t.value);
        state.dirty = true;
        refresh(); return;
      }
      const gEl = t.closest('[data-gid]'); if (!gEl || !t.dataset.f) return;
      const g = findG(gEl.dataset.gid); const f = t.dataset.f;
      state.dirty = true;
      if (f === 'name') {
        g.name = t.value; $('[data-title]', gEl).textContent = t.value || 'Untitled ad group';
        if (g._autoPaths) {
          const [a, b] = E.suggestPaths(t.value); g.path1 = a; g.path2 = b;
          const p1 = $('#path1-' + g.id), p2 = $('#path2-' + g.id);
          if (p1) { p1.value = a; updateCounter('path1-' + g.id, a.length, 15); }
          if (p2) { p2.value = b; updateCounter('path2-' + g.id, b.length, 15); }
          updateSerp(g);
        }
      } else if (f === 'finalUrl') { g.finalUrl = t.value.trim(); updateSerp(g); }
      else if (f === 'path1' || f === 'path2') { g[f] = t.value.trim(); g._autoPaths = false; updateCounter(f + '-' + g.id, g[f].length, 15); updateSerp(g); }
      else if (f === 'maxCpc') { g.maxCpc = t.value === '' ? null : +t.value; }
      else if (f === 'keywords') { g.keywords = E.linesToKw(t.value); $('[data-kwcount]', gEl).textContent = g.keywords.length; }
      else if (f === 'negatives') { g.negatives = E.linesToKw(t.value); }
      else if (f === 'h' || f === 'd') {
        const i = +t.dataset.i; (f === 'h' ? g.headlines : g.descriptions)[i] = t.value;
        updateCounter(f + '-' + g.id + '-' + i, E.norm(t.value).length, f === 'h' ? 30 : 90); updateSerp(g);
      }
      refresh();
    });
    root.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.f !== 'campaignId') return;
      const g = findG(t.closest('[data-gid]').dataset.gid);
      g.campaignId = t.value;
      const ix = state.model.adGroups.indexOf(g);
      state.model.adGroups.splice(ix, 1);
      const last = state.model.adGroups.map(x => x.campaignId).lastIndexOf(t.value);
      state.model.adGroups.splice(last + 1, 0, g);
      state.dirty = true;
      renderTree(); refresh();
      const moved = $('details.ag[data-gid="' + g.id + '"]'); if (moved) moved.scrollIntoView({ block: 'nearest' });
      toast(g.name + ' moved to ' + (findC(t.value).name || 'campaign') + '.');
    });
    root.addEventListener('toggle', e => {
      const d = e.target; if (!d.matches || !d.matches('details.ag')) return;
      const id = d.dataset.gid;
      if (d.open && !state.open.has(id)) { state.open.add(id); rerenderAg(findG(id)); refresh(); }
      else if (!d.open && state.open.has(id)) { state.open.delete(id); }
      $('#toggleAll').textContent = state.open.size >= state.model.adGroups.length ? 'Collapse all' : 'Expand all';
    }, true);
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'sample') { loadSample(); return; }
      const cEl = b.closest('[data-cid]');
      const gEl = b.closest('[data-gid]');
      if (act === 'add-ag') {
        const g = { id: E.nid('g'), name: 'New ad group', campaignId: cEl.dataset.cid, keywords: [], negatives: [], headlines: ['', '', ''], descriptions: ['', ''], finalUrl: '', path1: 'New', path2: 'Ad-Group', maxCpc: null, _autoPaths: true };
        const last = state.model.adGroups.map(x => x.campaignId).lastIndexOf(g.campaignId);
        state.model.adGroups.splice(last + 1, 0, g);
        state.open.add(g.id); state.dirty = true; renderTree(); refresh();
        const n = $('#name-' + g.id); if (n) { n.focus(); n.select(); }
        return;
      }
      if (act === 'del-camp') {
        const c = findC(cEl.dataset.cid); const ix = state.model.campaigns.indexOf(c);
        state.model.campaigns.splice(ix, 1); renderTree(); refresh();
        toast(c.name + ' removed.', false, () => { state.model.campaigns.splice(ix, 0, c); renderTree(); refresh(); });
        return;
      }
      if (act === 'clear-cloc') {
        const c = findC(cEl.dataset.cid); const prev = c.locations; c.locations = null; state.dirty = true; renderTree(); refresh();
        toast(c.name + ' now uses the account locations.', false, () => { c.locations = prev; renderTree(); refresh(); });
        return;
      }
      if (!gEl) return;
      const g = findG(gEl.dataset.gid);
      if (act === 'del-ag') {
        const ix = state.model.adGroups.indexOf(g);
        state.model.adGroups.splice(ix, 1); state.open.delete(g.id); state.dirty = true; renderTree(); refresh();
        toast(g.name + ' removed.', false, () => { state.model.adGroups.splice(ix, 0, g); state.open.add(g.id); renderTree(); refresh(); });
        return;
      }
      if (act === 'add-h' || act === 'add-d') {
        const list = act === 'add-h' ? g.headlines : g.descriptions;
        list.push(''); rerenderAg(g); refresh();
        const f = act === 'add-h' ? 'h' : 'd';
        const el = $('#' + f + '-' + g.id + '-' + (list.length - 1)); if (el) el.focus();
        return;
      }
      if (act === 'del-h' || act === 'del-d') {
        const list = act === 'del-h' ? g.headlines : g.descriptions;
        list.splice(+b.dataset.i, 1); state.dirty = true; rerenderAg(g); refresh();
      }
    });

    $('#acctNeg').addEventListener('input', e => { state.model.accountNegatives = E.linesToKw(e.target.value); $('#acctNegCount').textContent = state.model.accountNegatives.length || ''; state.dirty = true; refresh(); });
    $('#addCamp').addEventListener('click', () => {
      const c = { id: E.nid('c'), name: 'New campaign', budget: null, negatives: [], locations: null, finalUrl: '' };
      state.model.campaigns.push(c);
      if (!state.source) state.source = { name: 'Built by hand', kind: 'manual', blocks: [] };
      renderDoc(); renderTree(); refresh();
      const n = $('#cn-' + c.id); if (n) { n.focus(); n.select(); }
    });
    $('#toggleAll').addEventListener('click', () => {
      const all = state.open.size >= state.model.adGroups.length;
      state.open = all ? new Set() : new Set(state.model.adGroups.map(g => g.id));
      renderTree(); refresh();
    });
    $('#reportPanel').addEventListener('change', e => { const s = e.target.closest('select[data-rep]'); if (s && s.value) onReportChoice(s); });
  }

  /* ---------------- validation display ---------------- */
  let exportCache = null;
  function refresh() {
    const m = state.model;
    const v = state.v = E.validate(m, S, todayISO());
    exportCache = null;
    const has = !!state.source || m.campaigns.length > 0;

    const used = m.campaigns.filter(c => m.adGroups.some(g => g.campaignId === c.id));
    $('#stC').textContent = used.length;
    $('#stG').textContent = m.adGroups.length;
    $('#stK').textContent = m.adGroups.reduce((s, g) => s + g.keywords.length, 0);
    $('#stA').textContent = m.adGroups.filter(g => g.headlines.some(h => E.norm(h))).length;
    const pill = $('#statusPill');
    pill.className = 'pill ' + (v.errors.length ? 'err' : v.warnings.length ? 'warn' : 'ok');
    pill.textContent = v.errors.length ? plural(v.errors.length, 'issue') + ' to fix' : v.warnings.length ? 'Ready, ' + plural(uniqMsgs(v.warnings).length, 'note') : 'Ready to export';

    $$('.bad').forEach(x => x.classList.remove('bad'));
    if (has) v.errors.forEach(er => { const el = fieldEl(er); if (el) el.classList.add('bad'); });

    m.campaigns.forEach(c => {
      const el = $('[data-cid="' + c.id + '"] [data-cmeta]'); if (!el) return;
      const ags = m.adGroups.filter(g => g.campaignId === c.id);
      el.textContent = plural(ags.length, 'ad group') + ' · ' + ags.reduce((s, g) => s + g.keywords.length, 0) + ' kw';
    });
    m.adGroups.forEach(g => {
      const d = $('details.ag[data-gid="' + g.id + '"]'); if (!d) return;
      const errs = v.errors.filter(x => x.scope === 'adgroup' && x.id === g.id);
      const warns = v.warnings.filter(x => x.scope === 'adgroup' && x.id === g.id);
      const hs = g.headlines.filter(h => E.norm(h)).length, ds = g.descriptions.filter(x => E.norm(x)).length;
      $('[data-counts]', d).textContent = g.keywords.length + ' kw · ' + hs + ' H · ' + ds + ' D';
      const st = $('[data-state]', d);
      st.className = 'pill-sm ' + (errs.length ? 'err' : warns.length ? 'warn' : 'ok');
      st.textContent = errs.length ? errs.length + ' to fix' : warns.length ? plural(warns.length, 'note') : 'Ready';
      const hc = $('[data-hcount]', d); if (hc) hc.textContent = g.headlines.length + '/15';
      const list = $('[data-issues]', d);
      if (list) list.innerHTML = errs.map(x => '<li class="err">' + esc(x.msg) + '</li>').join('') + warns.map(x => '<li class="warn">' + esc(x.msg) + '</li>').join('');
    });

    const ep = $('#exportPill');
    ep.className = 'pill-sm ' + (v.errors.length ? 'err' : 'ok');
    ep.textContent = v.errors.length ? plural(v.errors.length, 'issue') + ' to fix' : 'Ready';
    const errs = has ? v.errors.slice(0, 8) : [];
    $('#errList').innerHTML = errs.map((x, i) => '<li><button type="button" data-err="' + i + '">' + esc(x.msg) + '</button></li>').join('') +
      (has && v.errors.length > 8 ? '<li class="hint" style="padding:4px 2px">+' + (v.errors.length - 8) + ' more in the ad groups below</li>' : '');
    const wm = has ? uniqMsgs(v.warnings) : [];
    $('#warnBox').hidden = !wm.length;
    $('#warnSum').textContent = plural(wm.length, 'note') + ' worth a look';
    $('#warnList').innerHTML = wm.map(x => '<li>' + esc(x) + '</li>').join('');
    const blocked = v.errors.length > 0;
    $('#dlBtn').setAttribute('aria-disabled', blocked ? 'true' : 'false');
    $('#copyBtn').setAttribute('aria-disabled', blocked ? 'true' : 'false');
    const t = getExport();
    $('#exportMeta').textContent = has ? t.rows.length + ' rows · ' + t.headers.length + ' columns · ' + fileName() : '';
    if ($('#previewBox').open) renderPreview();
  }
  const uniqMsgs = arr => [...new Set(arr.map(x => x.msg))];
  function getExport() { if (!exportCache) exportCache = E.exportRows(state.model, S); return exportCache; }

  function fieldEl(er) {
    if (er.scope === 'settings') return er.field ? $('#' + er.field) : null;
    if (er.scope === 'campaign') return $(er.field === 'name' ? '#cn-' + er.id : er.field === 'negatives' ? '#cneg-' + er.id : '#cb-' + er.id);
    if (er.scope === 'adgroup') {
      if (er.field === 'h' || er.field === 'd') return er.i != null ? $('#' + er.field + '-' + er.id + '-' + er.i) : $('#' + er.field + '-' + er.id);
      if (er.field === 'keywords') return $('#kw-' + er.id);
      if (er.field === 'negatives') return $('#neg-' + er.id);
      if (er.field) return $('#' + er.field + '-' + er.id);
    }
    return null;
  }
  function jumpTo(er) {
    if (er.scope === 'adgroup' && !state.open.has(er.id)) { state.open.add(er.id); rerenderAg(findG(er.id)); refresh(); }
    if (er.scope === 'campaign' && er.field === 'negatives') { const d = $('#cneg-' + er.id); if (d && d.closest('details')) d.closest('details').open = true; }
    let el = fieldEl(er);
    if (!el && er.scope === 'adgroup') el = $('details.ag[data-gid="' + er.id + '"] summary');
    if (!el && er.scope === 'doc') el = $('#fileLabel');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setTimeout(() => el.focus({ preventScroll: true }), 250);
  }

  function renderPreview() {
    const t = getExport();
    const rows = t.rows.slice(0, 80);
    $('#previewTable').innerHTML = '<thead><tr>' + t.headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map((r, i) => '<tr class="k-' + esc(t.kinds[i]) + '">' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</tbody>';
  }

  /* ---------------- export ---------------- */
  function fileName() {
    const base = (state.model.source || 'campaigns').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'campaigns';
    return base + '_AdsEditor_Import.csv';
  }
  function blockedNotice() {
    toast('Fix ' + plural(state.v.errors.length, 'issue') + ' before exporting. The first one is highlighted.', true);
    if (state.v.errors[0]) jumpTo(state.v.errors[0]);
  }
  function showFallback(text, kind) {
    $('#fallbackBox').hidden = false;
    $('#fallbackLbl').textContent = kind === 'csv'
      ? 'Saving files did not work here. Copy this text into a file named ' + fileName() + ', or use Copy for Editor paste.'
      : 'Copy did not go through. Select all of this text, copy it, then use Paste text in Ads Editor.';
    const ta = $('#fallbackText'); ta.value = text; ta.focus(); ta.select();
  }
  function bindExport() {
    $('#dlBtn').addEventListener('click', async () => {
      if (state.v.errors.length) return blockedNotice();
      const csv = E.toCSV(getExport());
      try {
        await saveFile(fileName(), csv, 'text/csv;charset=utf-8');
        toast('Saved ' + fileName() + '. Import it in Ads Editor.');
      } catch (e) {
        const code = e && e.code;
        if (code === 'declined') toast('Download cancelled.');
        else if (code === 'rate_limited') toast('A save prompt is already open.');
        else showFallback(csv, 'csv');
      }
    });
    $('#copyBtn').addEventListener('click', () => {
      if (state.v.errors.length) return blockedNotice();
      const tsv = E.toTSV(getExport());
      const n = getExport().rows.length;
      let p;
      try { p = navigator.clipboard.writeText(tsv); } catch (e) { p = Promise.reject(e); }
      p.then(() => toast('Copied ' + n + ' rows. In Ads Editor: Account > Import > Paste text.'), () => showFallback(tsv, 'tsv'));
    });
    $('#errList').addEventListener('click', e => { const b = e.target.closest('[data-err]'); if (b) jumpTo(state.v.errors[+b.dataset.err]); });
    $('#previewBox').addEventListener('toggle', () => { if ($('#previewBox').open) renderPreview(); });
  }

  /* ---------------- sources ---------------- */
  async function handleFile(file) {
    if (!file) return;
    try {
      const src = await R.readFile(file, {});
      loadSource(src);
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast(e.message || 'Could not read that file.', true);
    }
  }
  function loadSample() {
    const s = window.CBSample;
    loadSource({ name: s.name, kind: 'md', blocks: E.textToBlocks(s.text) }, { sample: true, announce: false });
  }
  function bindSources() {
    $('#fileIn').addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value = ''; });
    document.addEventListener('keydown', e => {
      const l = e.target.closest && e.target.closest('label[for="fileIn"], label[for="memImportIn"]');
      if (l && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('#' + l.getAttribute('for')).click(); }
    });
    $('#pasteToggle').addEventListener('click', () => { const p = $('#pastePanel'); p.hidden = !p.hidden; if (!p.hidden) $('#pasteArea').focus(); });
    $('#pasteCancel').addEventListener('click', () => { $('#pastePanel').hidden = true; });
    $('#pasteParse').addEventListener('click', () => {
      const txt = $('#pasteArea').value;
      if (!txt.trim()) { toast('Paste the doc text first.', true); return; }
      $('#pastePanel').hidden = true; $('#pasteArea').value = '';
      loadSource({ name: 'Pasted text', kind: 'text', blocks: E.textToBlocks(txt) });
    });
    let depth = 0;
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('#dropOverlay').hidden = false; });
    document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) $('#dropOverlay').hidden = true; });
    document.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; $('#dropOverlay').hidden = true; handleFile(e.dataTransfer.files[0]); });
  }

  /* ---------------- AI reading ---------------- */
  const KEY_STORE = 'cbb.aiKey';
  function bindAI() {
    $('#aiModel').innerHTML = AI.MODELS.map(m => '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>').join('');
    const savedModel = store.get('cbb.aiModel');
    if (savedModel && AI.MODELS.some(m => m.id === savedModel)) $('#aiModel').value = savedModel;
    const savedKey = store.get(KEY_STORE);
    if (savedKey) { $('#aiKey').value = savedKey; $('#aiRemember').checked = true; }
    $('#aiModel').addEventListener('change', e => store.set('cbb.aiModel', e.target.value));
    $('#aiRemember').addEventListener('change', e => { if (e.target.checked && $('#aiKey').value.trim()) store.set(KEY_STORE, $('#aiKey').value.trim()); else store.del(KEY_STORE); });
    $('#aiKey').addEventListener('change', e => { if ($('#aiRemember').checked) store.set(KEY_STORE, e.target.value.trim()); });
    $('#aiKeyShow').addEventListener('click', () => { const k = $('#aiKey'); const show = k.type === 'password'; k.type = show ? 'text' : 'password'; $('#aiKeyShow').textContent = show ? 'Hide' : 'Show'; });
    $('#aiRun').addEventListener('click', runAI);
    $('#aiQuick').addEventListener('click', () => {
      $('#aiPanel').open = true;
      if ($('#aiKey').value.trim()) runAI();
      else { $('#aiPanel').scrollIntoView({ block: 'start' }); $('#aiKey').focus(); toast('Add your Anthropic API key to read with AI.'); }
    });
    $('#aiStop').addEventListener('click', () => { if (state.aiAbort) state.aiAbort.abort(); });
    $('#aiBack').addEventListener('click', () => {
      if (!state.ruleModel) return;
      state.readMode = 'rules'; $('#aiBack').hidden = true;
      loadModel(state.ruleModel, {});
      $('#aiState').textContent = 'Optional'; $('#aiState').className = 'pill-sm';
    });
  }
  async function runAI() {
    if (!state.source || !state.source.blocks.length) { toast('Load a doc first.', true); return; }
    const key = $('#aiKey').value.trim();
    if (!key) { $('#aiPanel').open = true; $('#aiKey').focus(); toast('Add your Anthropic API key first.', true); return; }
    if (!window.Anthropic) { toast('The AI library did not load. Reload the page.', true); return; }
    if (state.aiAbort) return;
    if ($('#aiRemember').checked) store.set(KEY_STORE, key);
    const model = $('#aiModel').value || AI.DEFAULT_MODEL;
    const client = new window.Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
    const ctrl = new AbortController();
    state.aiAbort = ctrl;
    $('#aiRun').disabled = true; $('#aiQuick').disabled = true; $('#aiStop').hidden = false;
    $('#aiState').textContent = 'Reading'; $('#aiState').className = 'pill-sm warn';
    const started = Date.now();
    const tick = setInterval(() => { if (!ctrl.signal.aborted) $('#aiProgress').textContent = 'Reading the doc... ' + Math.round((Date.now() - started) / 1000) + 's'; }, 1000);
    try {
      const docText = E.blocksToText(state.source.blocks);
      const out = await AI.read(client, docText, {
        model, signal: ctrl.signal, hints: AI.hintsFromMemory(mem.labels()),
        onProgress: n => { $('#aiProgress').textContent = 'Writing the structure... ' + n.toLocaleString() + ' characters'; }
      });
      const result = E.buildModel(AI.toResult(out.data), state.source.name);
      const cost = AI.costOf(out.usage, out.model);
      state.aiInfo = 'Read by AI (' + out.model + '). Used ' + (out.usage.input_tokens || 0).toLocaleString() + ' input and ' + (out.usage.output_tokens || 0).toLocaleString() + ' output tokens, about $' + cost.toFixed(2) + '.';
      state.aiModel = result; state.readMode = 'ai';
      loadModel(result, { announce: true });
      $('#aiBack').hidden = !state.ruleModel;
      $('#aiProgress').textContent = 'Done in ' + Math.round((Date.now() - started) / 1000) + 's. About $' + cost.toFixed(2) + '.';
      $('#aiState').textContent = 'In use'; $('#aiState').className = 'pill-sm ok';
    } catch (e) {
      const f = AI.friendlyError(e, window.Anthropic);
      $('#aiProgress').textContent = f.message;
      $('#aiState').textContent = f.cancelled ? 'Optional' : 'Failed'; $('#aiState').className = 'pill-sm' + (f.cancelled ? '' : ' err');
      if (!f.cancelled) toast(f.message, true);
    } finally {
      clearInterval(tick);
      state.aiAbort = null;
      $('#aiRun').disabled = false; $('#aiQuick').disabled = false; $('#aiStop').hidden = true;
    }
  }

  /* ---------------- memory panel ---------------- */
  function renderMemory() {
    const labels = mem.labels();
    $('#memCount').textContent = plural(labels.length, 'label');
    $('#memList').innerHTML = labels.length
      ? labels.map(l => '<li><div><div>' + esc(l.example) + '</div><div class="role">' + esc(mem.ROLE_LABEL[l.role] || l.role) + '</div></div><button type="button" class="x" data-forget="' + esc(l.key) + '" aria-label="Forget ' + esc(l.example) + '">&times;</button></li>').join('')
      : '<li class="hint" style="display:block">Nothing taught yet. Use the import report after loading a doc.</li>';
  }
  function bindMemory() {
    $('#memList').addEventListener('click', e => {
      const b = e.target.closest('[data-forget]'); if (!b) return;
      mem.forget(b.dataset.forget); renderMemory(); toast('Forgotten. It applies the next time you load a doc.');
    });
    $('#memExport').addEventListener('click', async () => {
      try { await saveFile('campaign-builder-memory.json', mem.exportJSON(), 'application/json'); toast('Memory exported.'); }
      catch (e) { toast('Could not save the memory file here.', true); }
    });
    $('#memImportIn').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const counts = mem.importJSON(await f.text());
        renderMemory(); renderProfiles();
        toast('Imported ' + plural(counts.labels, 'label') + ' and ' + plural(counts.profiles, 'profile') + '.');
      } catch (err) { toast(err.message, true); }
    });
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg, isErr, undo) {
    const t = $('#toast');
    t.className = isErr ? 'is-err' : '';
    t.innerHTML = '<span></span>' + (undo ? '<button type="button">Undo</button>' : '');
    t.firstChild.textContent = msg;
    if (undo) t.querySelector('button').onclick = () => { undo(); t.hidden = true; };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 7000 : 4500);
  }

  /* ---------------- boot ---------------- */
  if (window.CBB_SINGLE_FILE || location.protocol === 'file:') $('#offlineLink').parentElement.hidden = true;
  buildSettingsUI(); bindTree(); bindExport(); bindSources(); bindAI(); bindMemory();
  syncSettingsUI(); renderMemory(); renderDoc(); renderTree(); renderReport(); refresh();
})();
