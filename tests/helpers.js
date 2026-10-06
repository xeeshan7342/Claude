'use strict';
const { JSDOM } = require('jsdom');
const E = require('../app/js/engine.js');

const { window } = new JSDOM('');
const parseHTML = (html, name, opts) => E.parseHTML(html, name || 'doc.docx', window.DOMParser, opts);
const parseText = (txt, name, opts) => E.parseText(txt, name || 'doc.txt', opts);

const settings = over => Object.assign({
  finalUrl: 'https://www.example.com/', matchType: 'phrase', bidStrategy: 'maxclicks', targetCpa: '', maxCpc: '',
  locations: [{ name: 'United States', id: '2840' }], allLocations: false, presenceOnly: true, languages: ['en'],
  searchPartners: false, campaignStatus: 'Paused', startDate: ''
}, over || {});

// Compact view of a model for assertions
const summary = m => m.adGroups.map(g => ({
  name: g.name,
  campaign: (m.campaigns.find(c => c.id === g.campaignId) || {}).name,
  keywords: g.keywords.map(E.kwToLine),
  negatives: g.negatives.map(E.kwToLine),
  headlines: g.headlines,
  descriptions: g.descriptions,
  finalUrl: g.finalUrl
}));
const byName = (m, name) => summary(m).find(g => g.name === name);

module.exports = { E, window, parseHTML, parseText, settings, summary, byName };
