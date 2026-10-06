/* Memory: what the tool has been taught about your docs, plus saved client defaults.
   Lives in this browser (localStorage). Export it as a file to share with your team or move to another computer. */
(function (root) {
  'use strict';
  const E = root.CBEngine || (typeof require === 'function' ? require('./engine.js') : null);
  const STORE_KEY = 'cbb.memory.v1';
  const ROLES = ['keywords', 'negatives', 'headlines', 'descriptions', 'adcopy', 'settings', 'other', 'adgroup', 'campaign', 'ignore'];
  const ROLE_LABEL = {
    keywords: 'Keywords section', negatives: 'Negative keywords section', headlines: 'Headlines section', descriptions: 'Descriptions section',
    adcopy: 'Mixed ad text section', settings: 'Settings section', other: 'Section to skip', adgroup: 'Ad group name', campaign: 'Campaign name', ignore: 'Line to ignore'
  };
  const PROFILE_FIELDS = ['finalUrl', 'matchType', 'bidStrategy', 'targetCpa', 'maxCpc', 'locations', 'allLocations', 'presenceOnly', 'languages', 'searchPartners', 'campaignStatus'];

  const empty = () => ({ version: 1, labels: {}, profiles: {} });

  // A storage object can be passed in (tests use a plain object); the default is localStorage, which can throw.
  function create(storage) {
    const backend = storage || (() => { try { return root.localStorage; } catch (e) { return null; } })();
    let cache = null;

    const load = () => {
      if (cache) return cache;
      let data = null;
      try { const raw = backend && backend.getItem(STORE_KEY); data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
      cache = sanitize(data) || empty();
      return cache;
    };
    const save = () => {
      try { if (backend) backend.setItem(STORE_KEY, JSON.stringify(cache)); return true; } catch (e) { return false; }
    };

    return {
      ROLES, ROLE_LABEL,
      // {labelKey: role}, the shape the engine reads
      roles() {
        const out = {};
        const labels = load().labels;
        Object.keys(labels).forEach(k => { out[k] = labels[k].role; });
        return out;
      },
      labels() {
        const labels = load().labels;
        return Object.keys(labels).map(k => Object.assign({ key: k }, labels[k])).sort((a, b) => b.at - a.at);
      },
      teach(text, role) {
        if (!ROLES.includes(role)) return null;
        const k = E.labelKey(text);
        if (!k) return null;
        load().labels[k] = { role, example: E.norm(text).slice(0, 120), at: Date.now() };
        save();
        return k;
      },
      forget(k) {
        delete load().labels[k];
        save();
      },
      profiles() {
        const p = load().profiles;
        return Object.keys(p).sort((a, b) => a.localeCompare(b)).map(name => Object.assign({ name }, p[name]));
      },
      saveProfile(name, S) {
        const nm = E.norm(name).slice(0, 80);
        if (!nm) return null;
        const settings = {};
        PROFILE_FIELDS.forEach(f => { if (S[f] !== undefined) settings[f] = JSON.parse(JSON.stringify(S[f])); });
        load().profiles[nm] = { settings, host: hostOf(S.finalUrl), at: Date.now() };
        save();
        return nm;
      },
      deleteProfile(name) {
        delete load().profiles[name];
        save();
      },
      // the saved profile whose site matches this final URL
      profileForUrl(url) {
        const h = hostOf(url);
        if (!h) return null;
        return this.profiles().find(p => p.host === h) || null;
      },
      exportJSON() {
        return JSON.stringify(Object.assign({ app: 'campaign-bulk-builder', exportedAt: new Date().toISOString() }, load()), null, 2);
      },
      // merges by default; returns counts
      importJSON(text, replace) {
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
        const clean = sanitize(data);
        if (!clean) throw new Error('That file is not a Campaign Bulk Builder memory export.');
        const cur = replace ? empty() : load();
        Object.assign(cur.labels, clean.labels);
        Object.assign(cur.profiles, clean.profiles);
        cache = cur;
        save();
        return { labels: Object.keys(clean.labels).length, profiles: Object.keys(clean.profiles).length };
      },
      clear() { cache = empty(); save(); }
    };
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
  }

  // Only keep known fields with the right types; anything else in the file is dropped.
  function sanitize(data) {
    if (!data || typeof data !== 'object' || data.version !== 1) return null;
    const out = empty();
    const labels = data.labels && typeof data.labels === 'object' ? data.labels : {};
    Object.keys(labels).forEach(k => {
      const v = labels[k];
      const kk = E.labelKey(k);
      if (!kk || !v || !ROLES.includes(v.role)) return;
      out.labels[kk] = { role: v.role, example: String(v.example || k).slice(0, 120), at: +v.at || 0 };
    });
    const profiles = data.profiles && typeof data.profiles === 'object' ? data.profiles : {};
    Object.keys(profiles).forEach(name => {
      const p = profiles[name];
      if (!p || typeof p.settings !== 'object') return;
      const s = {};
      const src = p.settings;
      if (typeof src.finalUrl === 'string') s.finalUrl = src.finalUrl.slice(0, 2000);
      if (['phrase', 'exact', 'broad', 'phrase+exact'].includes(src.matchType)) s.matchType = src.matchType;
      if (['maxclicks', 'maxconv', 'tcpa', 'manual'].includes(src.bidStrategy)) s.bidStrategy = src.bidStrategy;
      ['targetCpa', 'maxCpc'].forEach(f => { if (src[f] != null && isFinite(+src[f])) s[f] = String(src[f]); });
      if (Array.isArray(src.locations)) s.locations = src.locations.filter(l => l && typeof l.name === 'string').map(l => ({ name: l.name.slice(0, 200), id: /^\d{1,10}$/.test(String(l.id || '')) ? String(l.id) : '' }));
      if (Array.isArray(src.languages)) s.languages = src.languages.filter(c => typeof c === 'string' && /^[a-z]{2}(?:_[A-Z]{2})?$/.test(c));
      ['allLocations', 'presenceOnly', 'searchPartners'].forEach(f => { if (typeof src[f] === 'boolean') s[f] = src[f]; });
      if (['Paused', 'Enabled'].includes(src.campaignStatus)) s.campaignStatus = src.campaignStatus;
      const nm = E.norm(name).slice(0, 80);
      if (nm) out.profiles[nm] = { settings: s, host: typeof p.host === 'string' ? p.host.slice(0, 255) : hostOf(s.finalUrl), at: +p.at || 0 };
    });
    return out;
  }

  const api = { create, ROLES, ROLE_LABEL, PROFILE_FIELDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CBMemory = api;
})(typeof window !== 'undefined' ? window : globalThis);
