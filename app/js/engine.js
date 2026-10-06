/* Campaign Bulk Builder engine.
   Source (Word HTML, text, CSV or spreadsheet rows) -> blocks -> parse result -> campaign model -> Google Ads Editor rows.
   Plain browser script (window.CBEngine) that also loads in Node for the tests (module.exports). No dependencies. */
(function (root) {
  'use strict';

  /* ---------- text helpers ---------- */

  const norm = s => String(s == null ? '' : s)
    .replace(/[       ]/g, ' ')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ').trim();

  const key = s => norm(s).toLowerCase()
    .replace(/&/g, ' ').replace(/\band\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // Normalised form used to recognise labels and to store taught labels: no numbers, counts or punctuation.
  const labelKey = s => norm(s).toLowerCase()
    .replace(/\*\*|__/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();

  const cellNorm = s => String(s == null ? '' : s).split(/\r?\n/).map(norm).filter(Boolean).join('\n');

  function sim(a, b) {
    const A = new Set(key(a).split(' ').filter(Boolean));
    const B = new Set(key(b).split(' ').filter(Boolean));
    if (!A.size || !B.size) return 0;
    if (key(a) === key(b)) return 1;
    let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
    return inter / (A.size + B.size - inter);
  }

  let uid = 0;
  const nid = p => p + (++uid).toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---------- 1. Sources -> blocks ---------- */
  // Block types: {t:'h', level, text} {t:'p', text, bold} {t:'li', text} {t:'table', rows}

  // Text of an element with <br> kept as line breaks (Word uses them for "Shift+Enter" lines and inside table cells)
  function brText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    return c.textContent;
  }
  const lines = t => String(t).split('\n').map(norm).filter(Boolean);

  function cellText(c) {
    const parts = c.querySelectorAll('p, li');
    const texts = parts.length > 1 ? Array.from(parts).map(brText) : [brText(c)];
    // a blank line (two breaks) inside one paragraph separates items, as in "description<br><br>description"
    return texts.map(t => lines(t).join('\n')).filter(Boolean).join('\n');
  }

  function htmlToBlocks(html, ParserCtor) {
    const P = ParserCtor || root.DOMParser;
    const doc = new P().parseFromString('<div id="__r">' + html + '</div>', 'text/html');
    const r = doc.getElementById('__r');
    const out = [];
    const walk = el => {
      for (const n of Array.from(el.children)) {
        const tag = n.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          const t = norm(n.textContent);
          if (t) out.push({ t: 'h', level: +tag[1], text: t });
        } else if (tag === 'p') {
          const t = norm(n.textContent);
          if (!t) continue;
          const strong = norm(Array.from(n.querySelectorAll('strong, b')).map(x => x.textContent).join(''));
          const bold = strong.length > 0 && strong.length >= t.length - 1;
          lines(brText(n)).forEach(line => out.push({ t: 'p', text: line, bold }));
        } else if (tag === 'ul' || tag === 'ol') {
          for (const li of Array.from(n.children)) {
            if (li.tagName.toLowerCase() !== 'li') continue;
            const c = li.cloneNode(true);
            c.querySelectorAll('ul, ol').forEach(x => x.remove());
            lines(brText(c)).forEach(t => out.push({ t: 'li', text: t }));
            Array.from(li.children).filter(x => /^(ul|ol)$/i.test(x.tagName)).forEach(x => walk({ children: [x] }));
          }
        } else if (tag === 'table') {
          const rows = [];
          n.querySelectorAll('tr').forEach(tr => {
            const cells = Array.from(tr.children).filter(c => /^t[dh]$/i.test(c.tagName)).map(cellText);
            if (cells.some(Boolean)) rows.push(cells);
          });
          if (rows.length) out.push({ t: 'table', rows });
        } else {
          walk(n);
        }
      }
    };
    walk(r);
    return out;
  }

  const PIPE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const splitPipeRow = line => {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map(c => cellNorm(c.replace(/\*\*|__/g, '').replace(/<br\s*\/?>/gi, '\n')));
  };
  const BULLET = /^(?:[-*•◦▪●○·▸►→–—✓✔☐☑]|[☀-➿]|\p{Extended_Pictographic}|\d{1,2}[.)])\s+(.*)$/u;

  function textToBlocks(txt) {
    const out = [];
    const lines = String(txt).replace(/^﻿/, '').split(/\r?\n/);
    let table = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // Markdown pipe tables (what ChatGPT and Claude produce)
      if (/\|/.test(raw) && (/^\s*\|/.test(raw) || PIPE_SEP.test(lines[i + 1] || '')) && (raw.match(/\|/g) || []).length >= 2) {
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          if (!PIPE_SEP.test(lines[i])) rows.push(splitPipeRow(lines[i]));
          i++;
        }
        i--;
        if (rows.length) out.push({ t: 'table', rows });
        table = null;
        continue;
      }
      if (raw.includes('\t')) {
        const cells = raw.split('\t').map(norm);
        if (cells.some(Boolean)) {
          const headerLike = cells.filter(Boolean).every(c => c.length < 40) && cells.some(c => /^(?:rsa\s+)?(?:headlines?|descriptions?|key\s?words?|negative key\s?words?|campaigns?|ad groups?)$/i.test(c));
          if (!table || (headerLike && table.rows.length)) { table = { t: 'table', rows: [] }; out.push(table); }
          table.rows.push(cells);
        }
        continue;
      }
      table = null;
      let line = norm(raw);
      if (!line) continue;
      if (/^#{1,6}\s/.test(line)) {
        const lv = line.match(/^#+/)[0].length;
        out.push({ t: 'h', level: lv, text: norm(line.replace(/^#+/, '').replace(/\*\*|__/g, '')) });
        continue;
      }
      const bold = /^(?:\*\*|__).+(?:\*\*|__):?$/.test(line);
      line = norm(line.replace(/\*\*|__/g, ''));
      const bullet = line.match(BULLET);
      if (bullet) { if (norm(bullet[1])) out.push({ t: 'li', text: norm(bullet[1]) }); continue; }
      out.push({ t: 'p', text: line, bold });
    }
    return out;
  }

  function csvToRows(text) {
    const src = String(text).replace(/^﻿/, '');
    const first = src.split(/\r?\n/, 1)[0] || '';
    const count = ch => (first.split(ch).length - 1);
    const delim = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : (count(';') > count(',') ? ';' : ',');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (q) {
        if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(cellNorm)).filter(r => r.some(Boolean));
  }

  // One spreadsheet tab (or a CSV file) -> blocks. The tab name acts as a heading.
  function rowsToBlocks(rows, sheetName) {
    const out = [];
    const nm = norm(sheetName);
    if (nm && !/^(?:sheet|tab|page)\s*\d*$/i.test(nm)) out.push({ t: 'h', level: 1, text: nm, sheet: true });
    const clean = (rows || []).map(r => r.map(cellNorm)).filter(r => r.some(Boolean));
    if (clean.length) out.push({ t: 'table', rows: clean });
    return out;
  }

  /* ---------- 2. Vocabulary ---------- */

  const COPY = new Set(['keywords', 'headlines', 'descriptions', 'adcopy', 'negatives']);
  // Strong labels switch sections anywhere. Weak ones (settings, notes, ad copy) only when they look like labels,
  // so a keyword such as "landing page design" inside a keyword list is not mistaken for a heading.
  const SECTION_PATTERNS = [
    ['negatives', true, /^(?:(?:campaign|account|ad ?group|adgroup|shared|global|common|universal|master|standard|core|recommended|suggested|initial|starter|default|all|general)\s+)*(?:level\s+)?(?:negative|negatives|neg)(?:\s+(?:key ?words?|key ?phrases?|kws?|terms?|search terms?|queries|keyword list|match))*(?:\s+lists?)?(?:\s+(?:campaign|account|ad ?group|adgroup|shared|global)(?:\s+level)?)?(?:\s+(?:for|at|across|applied to)\s+[\p{L} ]{1,40})?$/u],
    ['negatives', true, /^(?:(?:key ?words?|terms|search terms|queries|searches)\s+to\s+(?:exclude|block|avoid|negate|add as negatives?)|exclusions?|exclusion lists?|excluded (?:key ?words?|terms|search terms|queries)|blocked (?:terms|key ?words?|queries|search terms))$/],
    ['keywords', true, /^(?:(?:target|targeted|targeting|core|primary|main|seed|suggested|recommended|positive|ad ?group|campaign|final|proposed|exact|phrase|broad|match|search|initial|starter|top|high intent|long tail|longtail|branded|brand|generic|competitor|service|services|product|location|local|secondary|additional|more|sample|example)\s+)*(?:key ?words?|key ?phrases?|kws?|search terms?|search queries|keyword (?:list|ideas|set|themes?|groups?))(?:\s+(?:list|lists|ideas|set|themes?|to target|exact|phrase|broad|match|types?))*$/],
    ['headlines', true, /^(?:(?:rsa|responsive search ads?|search ads?|ads?|ad copy|copy|suggested|recommended|final|proposed|core|pinned|optional|additional|extra|more|sample|example|google)\s+)*(?:headlines?|titles?|headline (?:options|variations|ideas|variants|copy|text))(?:\s+(?:options|variations|ideas|variants|copy|list|text))*$/],
    ['descriptions', true, /^(?:(?:rsa|responsive search ads?|search ads?|ads?|ad copy|copy|suggested|recommended|final|proposed|core|optional|additional|extra|more|sample|example|google)\s+)*(?:descriptions?|description lines?|descs?|body copy|body text|ad text|description (?:options|variations|ideas|variants|copy|text))(?:\s+(?:options|variations|ideas|variants|copy|list|text))*$/],
    ['adcopy', false, /^(?:(?:the|our|suggested|recommended|final|proposed|sample|example|google)\s+)*(?:rsas?|responsive search ads?|search ads?|ad copy|ads|ad|ad creatives?|creatives?|text ads?|ad variations?|ad texts?|ad copies)(?:\s+(?:copy|set|sets|variations?|options|version|versions|text|a|b|c))*$/],
    ['other', false, /^(?:(?:ad|campaign|account|recommended|suggested|optional|additional|key|important|general|final)\s+)*(?:level\s+)?(?:sitelinks?|site links?|sitelink (?:extensions?|assets?)|callouts?|callout (?:extensions?|assets?|text)|structured snippets?|snippets?|extensions?|assets?|ad (?:extensions?|assets)|images?|image (?:extensions?|assets?)|logos?|business (?:name|logo)|call (?:extensions?|assets?)|phone (?:number|extensions?|assets?)|promotions?|promotion (?:extensions?|assets?)|price (?:extensions?|assets?)|prices|lead forms?|location (?:extensions?|assets?)|app (?:extensions?|assets?)|notes?|strategy|rationale|reasoning|why|tips?|recommendations?|next steps?|checklist|to ?do|todo|landing pages? (?:notes|recommendations|suggestions|requirements|tips)|audiences?|audience (?:targeting|signals|segments|lists)|demographics?|ad schedul(?:e|ing)|schedul(?:e|ing)|day ?parting|conversion (?:tracking|actions?|goals?|setup)|conversions|kpis?|goals?|objectives?|measurement|tracking|reporting|budget (?:plan|split|allocation|breakdown|notes|rationale)|bid (?:adjustments|modifiers)|devices?|device (?:targeting|bid adjustments)|overview|summary|scope|assumptions|compliance|policy(?: notes)?|before you launch|launch checklist|optimi[sz]ation(?: plan| tips)?|timeline|appendix|references?|faqs?|questions|contents|table of contents|introduction|background|competitors?|competitor analysis|keyword research|research|analysis|insights|structure|account structure|campaign structure|naming conventions?|glossary)$/],
    ['settings', false, /^(?:(?:campaign|account|ad ?group|global|default|general|key|basic|initial|recommended)\s+)*(?:level\s+)?(?:settings|setup|set up|configuration|config|targeting|targeting settings|bidding|bid strategy|bidding strategy|budgets?|daily budget|monthly budget|locations?|location targeting|geo ?targeting|geos?|languages?|networks?|details|parameters|final urls?|landing pages?|landing page urls?|urls?)$/]
  ];
  const ROLE_SECTIONS = new Set(['keywords', 'negatives', 'headlines', 'descriptions', 'adcopy', 'other', 'settings']);

  function sectionLabel(text) {
    const tryOne = label => {
      const lk = labelKey(label);
      if (!lk || lk.split(' ').length > 9) return null;
      for (const [sec, strong, rx] of SECTION_PATTERNS) if (rx.test(lk)) return { sec, weak: !strong };
      return null;
    };
    const whole = /[:：]\s*\S/.test(norm(text)) ? null : tryOne(text);
    if (whole) return Object.assign(whole, { inline: '' });
    const m = norm(text).match(/^(.{2,60}?)\s*(?::|\s[-–—]\s|[–—])\s*(.+)$/);
    if (m) { const s = tryOne(m[1]); if (s) return Object.assign(s, { inline: norm(m[2]), label: m[1] }); }
    return null;
  }

  const settingsHint = lk => /budget|spend/.test(lk) ? 'budget' : /locat|geo|countr|market|region|cit(?:y|ies)|area/.test(lk) ? 'locations'
    : /languag/.test(lk) ? 'languages' : /bid/.test(lk) ? 'bidStrategy' : /url|landing|website|site|domain/.test(lk) ? 'finalUrl'
    : /network|partner/.test(lk) ? 'networks' : null;

  const AG_NUM = /^(?:ad[\s-]*group|adgroup|ag)\s*#?\s*(\d{1,3}[a-z]?)\s*(?:[-:.)|–—]\s*|\s+)(.+)$/i;
  const AG_NAMED = /^(?:ad[\s-]*group|adgroup)(?:\s*name)?\s*(?::|\||\s[-–—]\s|[–—])\s*(.+)$/i;
  const AG_ONLY = /^(?:ad[\s-]*group|adgroup)\s*#?\s*(\d{1,3}[a-z]?)\s*[:.]?$/i;
  const AG_LIST = /^ad[\s-]*groups\s*(?:\([^)]*\))?\s*(?::|\s[-–—]\s)\s*(.+)$/i;
  const CAMP_NUM = /^campaign\s*#?\s*(?:\d{1,3}\s*(?:[-:.)|–—]\s*|\s+)|[a-z]\s*(?:[:.)|–—]|\s-\s)\s*)(.+)$/i;
  const CAMP_NAMED = /^campaign(?:\s*name)?\s*(?::|\||\s[-–—]\s|[–—])\s*(.+)$/i;
  const NUMBERED = /^(headline|description|desc)\s*#?\s*(\d{1,2})\s*(?:\([^)]*\))?\s*(?:[:.)\-–—|=]\s*|\t)(.+)$/i;
  const NUMBERED_HD = /^([hd])\s*(\d{1,2})\s*(?:\([^)]*\))?\s*(?:[:.)|=]|\s[-–—]\s|[–—]|\t)\s*(.+)$/i;
  const NUMBERED_ONLY = /^(headline|description|desc)\s*#?\s*(\d{1,2})\s*(?:\([^)]*\))?\s*:?$/i;

  const STRIP_NUM = /^\s*(?:\d{1,2}[.)]|[-*•◦▪●○·])\s+/;
  const TRAIL_COUNT = /\s*(?:[([]\s*\d{1,3}\s*(?:\/\s*\d{2,3}\s*)?(?:chars?|characters)?\s*[)\]]|[|–—]\s*\d{1,3}\s*(?:chars?|characters)?|\s-\s\d{1,3}\s*(?:chars?|characters)?|\d{1,3}\s*(?:chars?|characters)|\s\d{1,3}\s*\/\s*(?:15|30|90))\s*$/i;
  const PIN_NOTE = /\s*[([](?:[^)\]]*\b(?:pin(?:ned)?|position|pos\.?)\b[^)\]]*)[)\]]\s*$|\s+[-–—]\s+pin(?:ned)?\b.*$/i;
  const HEADER_CELL = /^(?:#|no\.?|sr\.?|s\.?\s?no\.?|chars?|characters|char(?:acter)? count|count|length|len|status|notes?|pin(?:ned)?|position|match(?: type)?)$/i;

  function cleanName(s) {
    return norm(s).replace(/\*\*|__/g, '').replace(/^#+\s*/, '')
      .replace(/^(?:\d{1,2}[.)]|[-*•◦▪●○·])\s+/, '')
      .replace(/^(?:ad[\s-]*group|adgroup|ag)\s*#?\s*\d{1,3}[a-z]?\s*(?:[-:.)|–—]\s*|\s+)/i, '')
      .replace(/\s*\((?:\d+\s*)?(?:keywords?|kws?|ad groups?|headlines?)?[^)]*\)\s*$/i, '')
      .replace(/[:：]\s*$/, '')
      .replace(/^["']|["']$/g, '').trim();
  }
  function tidyCampaign(s) {
    return norm(s).replace(/^([A-Z0-9]{1,2})\s*[-–—.:)]\s*/, '$1 - ');
  }
  const cleanCampaignName = s => tidyCampaign(cleanName(norm(s).replace(/^campaign\s*#?\s*\d{1,3}\s*[-:.)|–—]\s*/i, '')));

  const isNoteLine = t => /^\(.*\)$|^\[.*\]$/.test(t)
    || /^(?:note|notes|tip|tips|important|reminder|optional|n\.?b\.?|todo|tbd|example|e\.g\.|eg)\b\s*[:\-–—]/i.test(t)
    || /^(?:pin|pinned)\b/i.test(t)
    || /\b(?:character|char)s?\s*(?:limit|count|max)/i.test(t)
    || /\bposition\s*\d\b/i.test(t)
    || /:\s*$/.test(t)
    || /\b(?:max(?:imum)?|min(?:imum)?|limit|up to|at least)\s*(?:of\s*)?\d+\s*(?:chars?|characters|headlines|descriptions|keywords)\b/i.test(t);

  const isNameLike = t => {
    const s = norm(t);
    return s.length >= 3 && s.length <= 70 && s.split(' ').length <= 9 && !/[.!?;,]$/.test(s) && !/https?:|www\./i.test(s) && !/:\s*\S/.test(s);
  };

  /* ---------- settings ---------- */

  const COUNTRIES = [
    ['United States', '2840', ['us', 'usa', 'u s', 'u s a', 'united states', 'united states of america', 'america', 'the us', 'the usa', 'the united states']],
    ['Canada', '2124', ['ca', 'can', 'canada']],
    ['United Kingdom', '2826', ['uk', 'u k', 'gb', 'gbr', 'united kingdom', 'great britain', 'britain', 'the uk', 'the united kingdom']],
    ['Australia', '2036', ['au', 'aus', 'australia']],
    ['New Zealand', '2554', ['nz', 'new zealand']],
    ['Ireland', '2372', ['ie', 'ireland', 'republic of ireland']],
    ['United Arab Emirates', '2784', ['uae', 'u a e', 'ae', 'united arab emirates', 'emirates', 'the uae']],
    ['Saudi Arabia', '2682', ['ksa', 'saudi', 'saudi arabia', 'kingdom of saudi arabia']],
    ['Qatar', '2634', ['qa', 'qatar']],
    ['Kuwait', '2414', ['kw', 'kuwait']],
    ['Bahrain', '2048', ['bh', 'bahrain']],
    ['Oman', '2512', ['om', 'oman']],
    ['Jordan', '2400', ['jordan']],
    ['Lebanon', '2422', ['lebanon']],
    ['Egypt', '2818', ['eg', 'egypt']],
    ['Morocco', '2504', ['morocco']],
    ['Turkey', '2792', ['tr', 'turkey', 'turkiye', 'türkiye']],
    ['Israel', '2376', ['israel']],
    ['Pakistan', '2586', ['pk', 'pakistan']],
    ['India', '2356', ['india', 'bharat']],
    ['Bangladesh', '2050', ['bd', 'bangladesh']],
    ['Sri Lanka', '2144', ['lk', 'sri lanka']],
    ['Nepal', '2524', ['nepal']],
    ['Maldives', '2462', ['maldives']],
    ['Singapore', '2702', ['sg', 'singapore']],
    ['Malaysia', '2458', ['malaysia']],
    ['Indonesia', '2360', ['indonesia']],
    ['Philippines', '2608', ['ph', 'philippines', 'the philippines']],
    ['Thailand', '2764', ['th', 'thailand']],
    ['Vietnam', '2704', ['vn', 'vietnam', 'viet nam']],
    ['Hong Kong', '2344', ['hk', 'hong kong']],
    ['Taiwan', '2158', ['tw', 'taiwan']],
    ['Japan', '2392', ['jp', 'japan']],
    ['South Korea', '2410', ['kr', 'korea', 'south korea', 'republic of korea']],
    ['China', '2156', ['cn', 'china']],
    ['Germany', '2276', ['de', 'germany', 'deutschland']],
    ['France', '2250', ['fr', 'france']],
    ['Spain', '2724', ['spain', 'españa', 'espana']],
    ['Italy', '2380', ['italy', 'italia']],
    ['Portugal', '2620', ['pt', 'portugal']],
    ['Netherlands', '2528', ['nl', 'netherlands', 'the netherlands', 'holland']],
    ['Belgium', '2056', ['belgium']],
    ['Luxembourg', '2442', ['luxembourg']],
    ['Switzerland', '2756', ['ch', 'switzerland']],
    ['Austria', '2040', ['austria']],
    ['Sweden', '2752', ['se', 'sweden']],
    ['Norway', '2578', ['norway']],
    ['Denmark', '2208', ['dk', 'denmark']],
    ['Finland', '2246', ['fi', 'finland']],
    ['Iceland', '2352', ['iceland']],
    ['Poland', '2616', ['pl', 'poland']],
    ['Czechia', '2203', ['cz', 'czechia', 'czech republic']],
    ['Slovakia', '2703', ['slovakia']],
    ['Hungary', '2348', ['hu', 'hungary']],
    ['Romania', '2642', ['ro', 'romania']],
    ['Bulgaria', '2100', ['bg', 'bulgaria']],
    ['Greece', '2300', ['gr', 'greece']],
    ['Croatia', '2191', ['hr', 'croatia']],
    ['Serbia', '2688', ['rs', 'serbia']],
    ['Slovenia', '2705', ['slovenia']],
    ['Estonia', '2233', ['estonia']],
    ['Cyprus', '2196', ['cy', 'cyprus']],
    ['Malta', '2470', ['mt', 'malta']],
    ['Ukraine', '2804', ['ua', 'ukraine']],
    ['South Africa', '2710', ['za', 'rsa', 'south africa']],
    ['Nigeria', '2566', ['ng', 'nigeria']],
    ['Kenya', '2404', ['ke', 'kenya']],
    ['Ghana', '2288', ['gh', 'ghana']],
    ['Mexico', '2484', ['mx', 'mexico']],
    ['Brazil', '2076', ['br', 'brazil', 'brasil']],
    ['Argentina', '2032', ['ar', 'argentina']],
    ['Chile', '2152', ['cl', 'chile']],
    ['Colombia', '2170', ['co', 'colombia']],
    ['Peru', '2604', ['pe', 'peru']]
  ];
  const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };
  const CA_PROVINCES = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' };
  // State-level regions outside the US and Canada (they stand alone, and qualify a city written before them),
  // and well-known cities (they stand alone and can take a region after them). Values are the country.
  const REGION_STATES = {
    'england': 'United Kingdom', 'scotland': 'United Kingdom', 'wales': 'United Kingdom', 'northern ireland': 'United Kingdom',
    'new south wales': 'Australia', 'nsw': 'Australia', 'victoria': 'Australia', 'queensland': 'Australia', 'western australia': 'Australia', 'south australia': 'Australia', 'tasmania': 'Australia',
    'dubai': 'United Arab Emirates', 'abu dhabi': 'United Arab Emirates', 'sharjah': 'United Arab Emirates', 'ajman': 'United Arab Emirates', 'ras al khaimah': 'United Arab Emirates', 'fujairah': 'United Arab Emirates', 'umm al quwain': 'United Arab Emirates',
    'maharashtra': 'India', 'delhi ncr': 'India', 'ncr': 'India', 'karnataka': 'India', 'tamil nadu': 'India', 'telangana': 'India', 'gujarat': 'India', 'kerala': 'India', 'west bengal': 'India', 'uttar pradesh': 'India', 'rajasthan': 'India', 'haryana': 'India', 'andhra pradesh': 'India', 'madhya pradesh': 'India', 'bihar': 'India', 'odisha': 'India', 'goa': 'India',
    'sindh': 'Pakistan', 'khyber pakhtunkhwa': 'Pakistan', 'balochistan': 'Pakistan'
  };
  const REGION_CITIES = {
    'london': 'United Kingdom', 'manchester': 'United Kingdom', 'birmingham': 'United Kingdom',
    'riyadh': 'Saudi Arabia', 'jeddah': 'Saudi Arabia', 'dammam': 'Saudi Arabia', 'mecca': 'Saudi Arabia', 'makkah': 'Saudi Arabia', 'doha': 'Qatar', 'muscat': 'Oman', 'manama': 'Bahrain', 'kuwait city': 'Kuwait',
    'delhi': 'India', 'new delhi': 'India', 'mumbai': 'India', 'bangalore': 'India', 'bengaluru': 'India', 'hyderabad': 'India', 'chennai': 'India', 'kolkata': 'India', 'pune': 'India',
    'karachi': 'Pakistan', 'lahore': 'Pakistan', 'islamabad': 'Pakistan'
  };
  const LANGS = [
    ['en', 'English'], ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['ur', 'Urdu'],
    ['hi', 'Hindi'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['tr', 'Turkish'], ['zh_CN', 'Chinese (simplified)'],
    ['zh_TW', 'Chinese (traditional)'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ru', 'Russian'], ['pl', 'Polish'], ['sv', 'Swedish'],
    ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'], ['el', 'Greek'], ['iw', 'Hebrew'], ['id', 'Indonesian'], ['ms', 'Malay'],
    ['th', 'Thai'], ['vi', 'Vietnamese'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['gu', 'Gujarati'],
    ['ml', 'Malayalam'], ['pa', 'Punjabi'], ['fa', 'Persian'], ['tl', 'Filipino'], ['ro', 'Romanian'], ['hu', 'Hungarian'], ['cs', 'Czech'], ['uk', 'Ukrainian']
  ];

  function findCountry(name) {
    const k = key(name);
    if (!k) return null;
    for (const [n, id, aliases] of COUNTRIES) if (aliases.includes(k)) return { name: n, id };
    return null;
  }
  const lookupCode = (map, p, allowCode) => {
    const t = norm(p);
    if (allowCode && /^[A-Za-z]{2}$/.test(t) && map[t.toUpperCase()]) return map[t.toUpperCase()];
    const k = key(t);
    for (const code in map) if (key(map[code]) === k) return map[code];
    return null;
  };
  const usState = (p, allowCode) => lookupCode(US_STATES, p, allowCode);
  const province = (p, allowCode) => lookupCode(CA_PROVINCES, p, allowCode);
  const inMap = (map, p) => { const k = key(p); for (const r in map) if (key(r) === k) return map[r]; return null; };
  const regionState = p => inMap(REGION_STATES, p);
  const regionCity = p => inMap(REGION_CITIES, p);
  const titleCase = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase());
  const nice = p => p === p.toLowerCase() ? titleCase(p) : p;
  const isKnownPlace = p => !!(findCountry(p) || usState(p, false) || province(p, false) || regionState(p) || regionCity(p));

  function parseLocations(value) {
    let v = norm(value);
    const info = { presence: null, notes: [] };
    if (/\bpresence\b/i.test(v)) info.presence = !/\binterest\b/i.test(v) || /presence only/i.test(v);
    const ex = v.match(/[,;(]?\s*\b(?:excluding|exclude[sd]?|except|but not|not including|minus|without)\b\s*:?\s*([^)]*)\)?\s*$/i);
    if (ex) { info.notes.push('Excluded locations (' + norm(ex[1]) + ') are not exported. Add them in Ads Editor as excluded locations.'); v = v.slice(0, ex.index); }
    const rad = v.match(/\b(\d+(?:\.\d+)?)\s*(mi|miles?|km|kms|kilomet(?:er|re)s?)\b\s*(?:radius)?\s*(?:of|around|from)?\s*/i);
    if (rad) { info.notes.push('Radius targeting (' + rad[1] + ' ' + rad[2] + ') is not exported. The place itself is targeted; set the radius in Ads Editor.'); v = norm(v.replace(rad[0], ' ')); }
    v = v.replace(/\([^)]*\)/g, ' ').replace(/\b(?:presence only|presence or interest|people in(?: or regularly in)?)\b/gi, ' ');
    const out = [];
    const push = loc => { if (loc.name && !out.some(o => o.name.toLowerCase() === loc.name.toLowerCase())) out.push(loc); };
    v.split(/\s*(?:;|\||\n|\/)\s*/).map(norm).filter(Boolean).forEach(chunk => {
      let pieces = chunk.split(/\s+(?:and|&|\+)\s+/i).map(norm).filter(Boolean);
      if (pieces.length > 1 && !pieces.every(p => p.split(',').map(norm).filter(Boolean).every(isKnownPlace))) pieces = [chunk];
      pieces.forEach(piece => {
        const parts = piece.split(',').map(p => norm(p).replace(/^(?:and|&)\s+/i, '')).filter(Boolean);
        const usCtx = parts.filter(p => usState(p, true)).length >= 2 && !parts.some(p => findCountry(p) && !usState(p, true));
        let i = 0;
        while (i < parts.length) {
          const p = parts[i];
          const next = parts[i + 1];
          // "New York, NY" and "Washington, DC" are cities: a state name followed by a state code is not the state itself
          const cityFirst = p.length > 2 && next && /^[A-Za-z]{2}$/.test(next) && !!(US_STATES[next.toUpperCase()] || CA_PROVINCES[next.toUpperCase()]);
          const st = cityFirst ? null : usState(p, usCtx);
          const c = st ? null : findCountry(p);
          if (c) { push({ name: c.name, id: c.id }); i++; continue; }
          const pr = st || cityFirst ? null : province(p, false);
          const rs = st || pr || cityFirst ? null : regionState(p);
          let name, country = null, j = i + 1;
          if (st || pr || rs) {
            name = st || pr || nice(p);
            country = st ? 'United States' : pr ? 'Canada' : rs;
            const qc = j < parts.length ? findCountry(parts[j]) : null;
            if (qc) { country = qc.name; j++; }
          } else {
            // a city: take the region and/or country written after it
            name = nice(p);
            let gotRegion = false;
            while (j < parts.length) {
              const q = parts[j];
              const qs = !gotRegion && !country ? (usState(q, true) || province(q, true) || (regionState(q) ? nice(q) : null)) : null;
              if (qs) {
                name += ', ' + qs; gotRegion = true; j++;
                country = usState(q, true) ? 'United States' : province(q, true) ? 'Canada' : regionState(q);
                continue;
              }
              const qc = findCountry(q);
              if (qc) { country = qc.name; j++; }
              break;
            }
            if (!country) country = regionCity(p);
          }
          if (country && !name.toLowerCase().endsWith(country.toLowerCase())) name += ', ' + country;
          push({ name, id: '' });
          i = j;
        }
      });
    });
    return { list: out, presence: info.presence, notes: info.notes };
  }

  const money = s => {
    const t = String(s || '').replace(/,/g, '');
    const m = t.match(/(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?)?(?![a-z\d])/i);
    if (!m) return null;
    let n = +m[1];
    const u = (m[2] || '').toLowerCase();
    if (u === 'k' || u === 'thousand') n *= 1000; else if (u) n *= 100000;
    return n;
  };

  // "$1,500/month", "50 per day", "Monthly budget: 1500 (about 49/day)" -> { daily, basis, amount }
  function parseBudget(label, value) {
    const t = String(value || '').replace(/,/g, '');
    const m = t.match(/(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?)?(?![a-z\d])/i);
    if (!m) return null;
    const amount = money(m[0]);
    const unitOf = w => /^d/i.test(w) ? 'daily' : /^(?:mo|mth|month)/i.test(w) ? 'monthly' : /^w/i.test(w) ? 'weekly' : 'yearly';
    const UNIT = /(?:\/\s*|per\s+|a\s+|an\s+|each\s+|every\s+)?\b(day|daily|d|month|monthly|mo|mth|week|weekly|wk|year|yr|annual|annually)\b/i;
    let basis = null;
    const after = t.slice(m.index + m[0].length).match(new RegExp('^\\s*' + UNIT.source, 'i'));
    if (after) basis = unitOf(after[1]);
    if (!basis) {
      const l = String(label || '').toLowerCase();
      if (/month/.test(l)) basis = 'monthly'; else if (/week/.test(l)) basis = 'weekly'; else if (/annual|year/.test(l)) basis = 'yearly'; else if (/\bday\b|daily/.test(l)) basis = 'daily';
    }
    if (!basis) {
      // only trust a unit elsewhere in the value when it is not inside an aside like "(about $1,520/month)"
      const bare = t.replace(/\([^)]*\)/g, ' ');
      const units = bare.match(new RegExp(UNIT.source, 'gi')) || [];
      if (units.length === 1) basis = unitOf(units[0].replace(/^(?:\/\s*|per\s+|a\s+|an\s+|each\s+|every\s+)/i, ''));
    }
    const div = { daily: 1, monthly: 30.4, weekly: 7, yearly: 365 }[basis || 'daily'];
    return { daily: Math.round((amount / div) * 100) / 100, basis: basis || 'unlabeled', amount };
  }

  function parseBid(v) {
    const t = String(v).toLowerCase();
    if (/target\s*cpa|tcpa|target cost per/.test(t)) return 'tcpa';
    if (/maxim\w*\s*conv/.test(t)) return 'maxconv';
    if (/maxim\w*\s*clicks?/.test(t)) return 'maxclicks';
    if (/manual|\bcpc\b/.test(t)) return 'manual';
    return null;
  }
  function parseMatch(v) {
    const t = String(v).toLowerCase();
    if (/phrase/.test(t) && /exact/.test(t)) return 'phrase+exact';
    if (/exact/.test(t)) return 'exact';
    if (/phrase/.test(t)) return 'phrase';
    if (/broad/.test(t)) return 'broad';
    return null;
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = n => String(n).padStart(2, '0');
  function parseDate(v) {
    const t = norm(v).toLowerCase();
    let m;
    if ((m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) return { date: m[1] + '-' + pad(m[2]) + '-' + pad(m[3]) };
    if ((m = t.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/))) {
      const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (a > 12 && b <= 12) return { date: y + '-' + pad(b) + '-' + pad(a) };
      if (b > 12 && a <= 12) return { date: y + '-' + pad(a) + '-' + pad(b) };
      return { date: null, ambiguous: true };
    }
    const mi = MONTHS.findIndex(mo => new RegExp('\\b' + mo).test(t));
    const day = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b(?!\d)/);
    const yr = t.match(/\b(20\d{2})\b/);
    if (mi >= 0 && day && yr) return { date: yr[1] + '-' + pad(mi + 1) + '-' + pad(+day[1]) };
    return null;
  }

  const SETTING_LABELS = [
    ['budget', /^(?:(?:avg|average|est|estimated|recommended|suggested|starting|initial|test|testing|campaign|total|overall|proposed|daily|monthly|weekly|ad|media)\s+)*(?:daily\s+|monthly\s+|weekly\s+)?(?:budgets?|spend|ad spend)(?:\s+(?:per\s+(?:day|month|week)|daily|monthly|weekly|cap|amount|limit|budget))*$/],
    ['bidStrategy', /^(?:(?:campaign|recommended|suggested|initial|starting)\s+)?(?:bid(?:ding)?(?:\s+strategy)?(?:\s+type)?|strategy type|bidding approach|bidding method|bid type)$/],
    ['targetCpa', /^(?:(?:target|max|desired|goal)\s+)?(?:cpa|cost per (?:conversion|acquisition|lead))(?:\s+(?:target|goal))?$|^tcpa$/],
    ['maxCpc', /^(?:(?:default|ad group|max(?:imum)?|starting|initial)\s+)+(?:cpc|bid|cpc bid)(?:\s+limit)?$|^max(?:imum)? cpc(?: bid)?$/],
    ['locations', /^(?:(?:target|targeted|targeting|campaign|geo)\s+)?(?:locations?|geo(?:graph(?:y|ies))?|geos?|geo target(?:ing|s)?|countries|country|markets?|regions?|cities|city|areas?|service areas?|location targeting|geographic targeting|locations to target)$/],
    ['languages', /^(?:target(?:ed)?\s+)?languages?$/],
    ['finalUrl', /^(?:(?:default|main|campaign|ad group)\s+)?(?:final\s+urls?|landing\s+pages?(?:\s+urls?)?|lp(?:\s+url)?|destination(?:\s+urls?)?|urls?|website|web\s+site|site|domain)$/],
    ['path1', /^(?:display\s+)?(?:url\s+)?path\s*1$/],
    ['path2', /^(?:display\s+)?(?:url\s+)?path\s*2$/],
    ['matchType', /^(?:default\s+)?(?:keyword\s+)?match\s*types?$/],
    ['networks', /^(?:networks?|network settings|search partners?|search network partners|google search partners)$/],
    ['presence', /^(?:location\s+options?|targeting\s+(?:method|option)|location\s+targeting\s+(?:method|option)|location\s+setting)$/],
    ['startDate', /^(?:campaign\s+)?(?:start(?:\s+date)?|launch(?:\s+date)?|go\s*live(?:\s+date)?)$/]
  ];
  function settingLabel(label) {
    const l = norm(label).toLowerCase().replace(/\*\*|__/g, '').replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!l) return null;
    for (const [k, rx] of SETTING_LABELS) if (rx.test(l)) return k;
    return null;
  }
  const findUrl = v => {
    const m = norm(v).match(/(https?:\/\/[^\s<>"')]+|(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s<>"')]*)?)/i);
    if (!m) return null;
    const u = m[1].replace(/[),.;]+$/, '');
    return /^https?:/i.test(u) ? u : 'https://' + u;
  };
  const cleanPath = v => norm(v).replace(/^\/+|\/+$/g, '').replace(/\s+/g, '-');

  function settingFrom(label, value) {
    const k = settingLabel(label);
    if (!k) return null;
    const v = norm(value);
    if (!v) return null;
    switch (k) {
      case 'budget': { const b = parseBudget(label, v); return b ? { k, v: b } : null; }
      case 'targetCpa': case 'maxCpc': { const n = money(v); return n == null ? null : { k, v: n }; }
      case 'bidStrategy': { const b = parseBid(v); if (!b) return null; const n = b === 'tcpa' ? money(v) : null; return { k, v: b, targetCpa: n }; }
      case 'matchType': { const mt = parseMatch(v); return mt ? { k, v: mt } : null; }
      case 'finalUrl': { const u = findUrl(v); return u ? { k, v: u } : null; }
      case 'locations': {
        const r = parseLocations(v);
        const list = r.list.filter(l => l.id || l.name.split(' ').length <= 6);
        return list.length || r.presence != null ? { k, v: list, presence: r.presence, notes: r.notes } : null;
      }
      case 'languages': {
        const parts = v.split(/,|;|\/|\band\b|&|\+/i).map(norm).filter(Boolean);
        const codes = parts.map(p => { const f = LANGS.find(([c, n]) => c.toLowerCase() === p.toLowerCase() || n.toLowerCase() === p.toLowerCase() || n.toLowerCase().split(' ')[0] === p.toLowerCase()); return f ? f[0] : null; }).filter(Boolean);
        return codes.length ? { k, v: [...new Set(codes)] } : null;
      }
      case 'networks': {
        const no = /\b(no|exclude[sd]?|off|without|not|disabled?|false)\b/i.test(v);
        if (/partner/i.test(label)) return { k, v: !no && /\b(yes|on|include[sd]?|enabled?|true)\b/i.test(v) };
        return { k, v: /partner/i.test(v) && !no };
      }
      case 'presence': return /presence|interest/i.test(v) ? { k, v: !/interest/i.test(v) || /presence only/i.test(v) } : null;
      case 'startDate': { const d = parseDate(v); return d ? { k, v: d.date, ambiguous: !!d.ambiguous, raw: v } : null; }
      case 'path1': case 'path2': return { k, v: cleanPath(v) };
    }
    return null;
  }

  function matchSetting(line) {
    const t = norm(line).replace(/\*\*|__/g, '');
    const m = t.match(/^([^:=]{1,60}?)\s*(?::|=|\s[-–—]\s|[–—]|\t)\s*(.+)$/);
    return m ? settingFrom(m[1], m[2]) : null;
  }

  /* ---------- keywords and ad text ---------- */

  function parseKeyword(raw, matchHint) {
    let t = norm(raw).replace(STRIP_NUM, '').replace(TRAIL_COUNT, '');
    let match = null, m;
    if ((m = t.match(/^\[(.+)\]$/))) { t = m[1]; match = 'exact'; }
    else if ((m = t.match(/^"(.+)"$/))) { t = m[1]; match = 'phrase'; }
    else if (/^\+\S/.test(t)) { t = t.replace(/(^|\s)\+/g, '$1'); match = 'broad'; }
    else if ((m = t.match(/^(.*?)\s*(?:[([]\s*(exact|phrase|broad)(?:\s*match)?\s*[)\]]|[|–—]\s*(exact|phrase|broad)(?:\s*match)?|\s-\s(exact|phrase|broad)(?:\s*match)?)$/i))) {
      t = m[1]; match = (m[2] || m[3] || m[4]).toLowerCase();
    }
    if (matchHint) { const mh = parseMatch(matchHint); if (mh && mh !== 'phrase+exact') match = mh; }
    t = norm(t).replace(/[.;]+$/, '');
    return t ? { text: t, match } : null;
  }

  // Strip search volume, CPC and similar columns pasted from keyword tools: "plumber near me – 1,300 – $12.50"
  const METRIC = /^(?:[\d.,$€£₹%kKmM\s/-]+|(?:low|medium|med|high|very high)(?:\s+(?:competition|comp))?|(?:exact|phrase|broad)(?:\s+match)?|[\d.,]+[kKmM]?\s*(?:searches|search volume|vol(?:ume)?|monthly searches|cpc|clicks|impr\w*|\/mo)|(?:vol(?:ume)?|cpc|kd|sv|comp(?:etition)?|searches)\s*[:=]?\s*[\d$€£₹.,%kK]+.*)$/i;
  function keywordCore(text) {
    let t = norm(text).replace(/\s*\((?=[^)]*\d)(?![^)]*\b(?:exact|phrase|broad)\b)[^)]*\)\s*$/i, '');
    const parts = t.split(/\s+[|–—]\s+|\s+-\s+|\t/);
    if (parts.length > 1 && parts.slice(1).every(p => METRIC.test(norm(p)))) {
      const mt = parts.slice(1).map(p => parseMatch(p)).find(Boolean);
      t = parts[0] + (mt && mt !== 'phrase+exact' ? ' (' + mt + ')' : '');
    }
    return norm(t);
  }

  const cleanCopy = s => norm(s).replace(STRIP_NUM, '').replace(PIN_NOTE, '').replace(TRAIL_COUNT, '').replace(PIN_NOTE, '')
    .replace(/^"(.+)"$/, '$1').replace(/\s*[✓✔]$/, '').trim();

  /* ---------- tables ---------- */

  function hdrField(cell) {
    const t = norm(cell).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9#. ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (/^(?:#|no|no\.|sr|sr\.|s\.? ?no\.?|sl|serial|chars?|characters?|char(?:acter)? count|count|length|len|character length|status|notes?|comments?|pin(?:ned)?|position|priority|rank|volume|search volume|avg\.? monthly searches|monthly searches|searches|competition|competition index|cpc|avg\.? cpc|est\.? cpc|top of page bid.*|bid range|intent|difficulty|kd|trend|source|type|value)$/.test(t)) return 'ignore';
    if (/^campaigns?(?: name)?$/.test(t)) return 'campaign';
    if (/^(?:ad ?groups?|adgroup)(?: name| theme)?$|^theme$|^ag$/.test(t)) return 'adgroup';
    if (/negative/.test(t)) return 'negatives';
    if (/^(?:match(?: type)?|criterion type|kw match type|keyword match type)$/.test(t)) return 'match';
    if (/^(?:target |core |primary |seed |suggested |recommended )?(?:key ?words?|key ?phrases?|search terms?|kws?)(?: text| list)?$/.test(t)) return 'keywords';
    if (/^(?:rsa |ad )?headlines?(?: ?\d{1,2})?(?: text)?$|^h ?\d{1,2}$|^titles?$/.test(t)) return 'headlines';
    if (/^(?:rsa |ad )?(?:descriptions?|description lines?|desc)(?: ?\d{1,2})?(?: line \d)?(?: text)?$|^d ?\d{1,2}$/.test(t)) return 'descriptions';
    if (/^(?:final ?urls?|landing pages?(?: urls?)?|lp(?: url)?|destination(?: url)?|urls?)$/.test(t)) return 'finalUrl';
    if (/^(?:display )?(?:url )?path ?1$/.test(t)) return 'path1';
    if (/^(?:display )?(?:url )?path ?2$/.test(t)) return 'path2';
    if (/budget/.test(t)) return 'budget';
    if (/^(?:max\.? ?cpc|default (?:max )?cpc|ad group (?:max )?cpc|max(?:imum)? cpc bid|default bid)$/.test(t)) return 'maxCpc';
    return null;
  }
  const COPY_FIELDS = new Set(['keywords', 'negatives', 'headlines', 'descriptions']);

  function isFieldLabel(c) {
    const t = norm(c);
    if (!t || t.length > 60) return false;
    if (NUMBERED_ONLY.test(t) || /^(?:headline|description|desc|h|d)\s*\d{1,2}$/i.test(t)) return true;
    const f = hdrField(t);
    if (f && f !== 'ignore') return true;
    if (settingLabel(t)) return true;
    const s = sectionLabel(t);
    if (s && !s.inline) return true;
    return /^(?:ad ?group|campaign)(?:\s+(?:name|theme))?$/i.test(t);
  }

  function tableShape(rowsIn) {
    const rows = rowsIn.map(r => r.map(c => cellNorm(c)));
    const width = Math.max(0, ...rows.map(r => r.length));
    const filled = r => r.filter(Boolean).length;
    const single = rows.filter(r => filled(r) <= 1).length;
    if (width <= 1 || (rows.length >= 3 && single / rows.length >= 0.7)) return { kind: 'lines', rows };
    const firstCol = rows.map(r => r[0] || '').filter(Boolean);
    const labels = firstCol.filter(isFieldLabel).length;
    if (labels >= 2 && labels >= firstCol.length * 0.5) {
      const head = rows[0];
      const rest = head.slice(1).filter(Boolean);
      const cornerOk = !head[0] || /^(?:fields?|elements?|items?|assets?|components?|types?|labels?|attributes?|parts?|sections?|ad groups?)$/i.test(head[0]);
      const multi = cornerOk && rest.length >= 1 && rest.every(c => !isFieldLabel(c) && hdrField(c) !== 'ignore')
        && (rest.length >= 2 || !head[0] || /ad groups?/i.test(head[0]));
      return { kind: 'kv', rows, multi };
    }
    let hi = -1, best = 0;
    for (let r = 0; r < Math.min(3, rows.length); r++) {
      const f = rows[r].map(hdrField).filter(x => x && x !== 'ignore').length;
      if (f > best) { best = f; hi = r; }
    }
    if (hi < 0) return { kind: 'plain', rows };
    const fields = rows[hi].map(hdrField);
    const has = f => fields.includes(f);
    const copy = [...COPY_FIELDS].some(has);
    const agCol = has('adgroup'), campCol = has('campaign');
    if (campCol && agCol && !copy && !has('finalUrl')) return { kind: 'mapping', rows, hi, fields };
    if (campCol && has('budget') && !copy && !agCol) return { kind: 'budgets', rows, hi, fields };
    if (copy || has('finalUrl') || has('path1') || has('path2') || has('maxCpc')) return { kind: 'records', rows, hi, fields, copy, agCol, campCol };
    return { kind: 'plain', rows };
  }

  /* ---------- 3. Blocks -> parse result ---------- */

  function classify(b, mem) {
    if (b.t === 'table') return { k: 'table', level: 99 };
    const text = b.text;
    const isLi = b.t === 'li';
    const level = b.t === 'h' ? b.level : (b.t === 'p' && b.bold ? 7 : (isLi ? 10 : 9));
    const lk = labelKey(text);
    const role = mem && lk && mem[lk];
    if (role) {
      if (ROLE_SECTIONS.has(role)) return { k: 'section', sec: role, inline: '', level, taught: true, hint: role === 'settings' ? settingsHint(lk) : null, matchHint: parseMatch(text) };
      if (role === 'adgroup') return { k: 'adgroup', name: cleanName(text), level, taught: true };
      if (role === 'campaign') return { k: 'campaign', name: cleanCampaignName(text), level, taught: true };
      if (role === 'ignore') return { k: 'note', level };
    }
    let m;
    if (text.length <= 140) {
      if (!isLi || AG_NUM.test(text)) {
        if ((m = text.match(AG_NUM)) || (!isLi && (m = text.match(AG_NAMED)))) {
          const name = cleanName(m[m.length - 1]);
          const asSection = sectionLabel(name);
          if (asSection && !asSection.inline) return { k: 'section', sec: asSection.sec, weak: asSection.weak, inline: '', level, matchHint: parseMatch(text) };
          if (name && !/^level\b/i.test(name)) return { k: 'adgroup', name, level };
        }
        if (!isLi && (m = text.match(AG_ONLY))) return { k: 'adgroup', name: 'Ad group ' + m[1], level };
        if (!isLi && (m = text.match(AG_LIST))) return { k: 'aglist', names: m[1], level };
        if (!isLi && ((m = text.match(CAMP_NUM)) || (m = text.match(CAMP_NAMED)))) {
          const name = tidyCampaign(cleanName(m[1]));
          if (name && !/^level\b/i.test(name) && !sectionLabel(name) && !settingLabel(name)) return { k: 'campaign', name, level };
        }
      }
      if ((m = text.match(NUMBERED)) || (!(b.t === 'h') && (m = text.match(NUMBERED_HD)))) {
        return { k: 'numbered', sec: /^h/i.test(m[1]) ? 'headlines' : 'descriptions', text: m[3], level };
      }
      if (!isLi && (m = text.match(NUMBERED_ONLY))) return { k: 'section', sec: /^h/i.test(m[1]) ? 'headlines' : 'descriptions', inline: '', level, single: true };
      const sl = sectionLabel(text);
      if (sl && !sl.inline && (!isLi || /:\s*$/.test(text))) {
        return { k: 'section', sec: sl.sec, weak: sl.weak, inline: '', level, hint: sl.sec === 'settings' ? settingsHint(lk) : null, matchHint: parseMatch(text) };
      }
      const s = matchSetting(text);
      if (s) return { k: 'setting', s, level };
      if (sl && sl.inline && sl.sec !== 'settings') return { k: 'section', sec: sl.sec, weak: sl.weak, inline: sl.inline, level, matchHint: parseMatch(sl.label || '') };
    }
    if (b.t === 'h' || (b.t === 'p' && b.bold && text.length < 100)) return { k: 'heading', level };
    return { k: 'text', level };
  }

  // Headings that are not labelled as ad groups become ad groups when they hold one set of keywords and ad text,
  // and campaigns when the doc is split into several headed blocks of ad groups.
  function inferStructure(blocks, cls, shapes) {
    const n = blocks.length;
    const lvl = i => cls[i].level;
    const rangeEnd = i => {
      const L = lvl(i);
      for (let j = i + 1; j < n; j++) if ((cls[j].k === 'heading' || cls[j].k === 'adgroup' || cls[j].k === 'campaign') && lvl(j) <= L) return j;
      return n;
    };
    const firstTitle = cls.findIndex(c => c.k === 'heading' || c.k === 'campaign' || c.k === 'adgroup');
    const heads = [];
    for (let i = 0; i < n; i++) if (cls[i].k === 'heading' && cls[i].level <= 8) heads.push(i);
    heads.sort((a, b) => lvl(b) - lvl(a) || a - b);  // deepest first, so parents see inferred children
    const holders = [];
    heads.forEach(i => {
      const end = rangeEnd(i);
      let kw = 0, h = 0, d = 0, ad = 0, copy = 0, ags = 0;
      for (let j = i + 1; j < end; j++) {
        const c = cls[j];
        if (c.k === 'adgroup') ags++;
        else if (c.k === 'section' && !c.single) {
          if (c.sec === 'keywords') kw++; else if (c.sec === 'headlines') h++; else if (c.sec === 'descriptions') d++; else if (c.sec === 'adcopy') ad++;
        } else if (c.k === 'numbered' || (c.k === 'section' && c.single)) copy++;
        else if (c.k === 'table') {
          const t = shapes[j];
          if (t.kind === 'records' && t.agCol) ags++;
          else if ((t.kind === 'records' && t.copy) || t.kind === 'kv') copy++;
        }
      }
      const evidence = kw + h + d + ad + copy;
      if (!ags && evidence > 0 && kw <= 2 && h <= 1 && d <= 1) {
        cls[i] = Object.assign({}, cls[i], { k: 'adgroup', name: cleanName(blocks[i].text), inferred: true });
      } else if (ags || kw >= 2) holders.push(i);
    });
    const byLevel = new Map();
    holders.forEach(i => { if (!byLevel.has(lvl(i))) byLevel.set(lvl(i), []); byLevel.get(lvl(i)).push(i); });
    byLevel.forEach(list => list.forEach(i => {
      if (list.length >= 2 || (i !== firstTitle && /\bcampaign\b/i.test(blocks[i].text))) {
        cls[i] = Object.assign({}, cls[i], { k: 'campaign', name: cleanCampaignName(blocks[i].text), inferred: true });
      }
    }));
  }

  function parseBlocks(blocks, opts) {
    opts = opts || {};
    const res = {
      title: '', campaignHint: '', mapping: [], adGroups: [], accountNegatives: [], campaignNegatives: {}, campaignLocations: {},
      settings: {}, campaignBudgets: {}, campaignUrls: {}, globalBudget: null, agProps: [], notes: [], skipped: []
    };
    const cls = blocks.map(b => classify(b, opts.memory));
    const shapes = blocks.map(b => b.t === 'table' ? tableShape(b.rows) : null);
    inferStructure(blocks, cls, shapes);

    let ag = null, agLevel = 99, campCtx = null, campLevel = 99;
    let section = null, secInfo = null;
    let lastPlain = null, step = 0;

    const skip = (text, reason, extra) => {
      res.skipped.push(Object.assign({ text: norm(text), reason, ag, section }, extra || {}));
      return res.skipped.length - 1;
    };
    const getAg = (name, campHint, flags) => {
      const nm = cleanName(name);
      const k = key(nm);
      if (!k) return null;
      const ch = campHint || null;
      const same = res.adGroups.filter(a => key(a.name) === k);
      let hit = null;
      if (ch) hit = same.find(a => a.campHint && key(a.campHint) === key(ch)) || same.find(a => !a.campHint);
      else hit = same[0];
      if (hit) { if (ch && !hit.campHint) hit.campHint = ch; return hit; }
      const a = Object.assign({ name: nm, campHint: ch, keywords: [], negatives: [], headlines: [], descriptions: [], finalUrl: '', path1: '', path2: '', maxCpc: null }, flags || {});
      res.adGroups.push(a);
      return a;
    };
    const ensureAg = () => {
      if (!ag) ag = getAg(campCtx || res.campaignHint || ('Ad group ' + (res.adGroups.length + 1)), campCtx, { implicit: true });
      return ag;
    };
    const negList = scope => {
      if (scope === 'account') return res.accountNegatives;
      if (scope === 'campaign') {
        if (!campCtx) return res.accountNegatives;
        const k = key(campCtx);
        return (res.campaignNegatives[k] = res.campaignNegatives[k] || []);
      }
      return ensureAg().negatives;
    };
    const negScope = (b, text) => {
      if (/\bad[\s-]?groups?\b/i.test(text)) return 'adgroup';
      if (/\bcampaigns?\b/i.test(text)) return 'campaign';
      if (/\b(?:account|shared|global|universal|master|all|every|common)\b/i.test(text)) return 'account';
      if (ag && (b.t !== 'h' || b.level > agLevel)) return 'adgroup';
      return campCtx ? 'campaign' : 'account';
    };

    const rejectKeyword = (p, isLi) => {
      const words = p.split(' ').length;
      if (p.length > (isLi ? 120 : 80)) return 'too long for a keyword (' + p.length + ' characters)';
      if (/[.!?:]$/.test(p) && words > 4) return 'reads like a sentence, not a keyword';
      if (words > (isLi ? 14 : 10)) return 'too many words for a keyword (' + words + ')';
      return null;
    };
    const rejectCopy = (s, t, isLi) => {
      if (s === 'headlines') {
        if (t.length > (isLi ? 45 : 40)) return 'too long for a headline (' + t.length + ' characters)';
        return null;
      }
      if (t.length < (isLi ? 15 : 20)) return 'too short for a description (' + t.length + ' characters)';
      if (t.length > (isLi ? 120 : 110)) return 'too long for a description (' + t.length + ' characters)';
      return null;
    };

    const addItem = (sec, rawText, isLi, matchHint, scope) => {
      const text = norm(rawText);
      if (!text) return {};
      let last = {};
      if (sec === 'keywords' || sec === 'negatives') {
        const core = keywordCore(text.replace(STRIP_NUM, ''));
        let parts = [core];
        if (core.includes(',')) {
          const p = core.split(/,(?!\d{3}\b)/).map(norm).filter(Boolean);
          if (p.length > 1 && p.every(x => x.split(' ').length <= 8)) parts = p;
        }
        parts.forEach(p0 => {
          let p = keywordCore(p0);
          let s = sec;
          if (s === 'keywords' && /^-\S/.test(p)) { s = 'negatives'; p = p.slice(1); }
          const why = rejectKeyword(p, isLi);
          if (why) { last = { skipIdx: skip(p0, why) }; return; }
          const kw = parseKeyword(p, matchHint);
          if (!kw) return;
          const list = s === 'negatives' ? negList(scope || (secInfo && secInfo.scope) || (ag ? 'adgroup' : 'account')) : ensureAg().keywords;
          if (!list.some(x => x.text.toLowerCase() === kw.text.toLowerCase() && x.match === kw.match)) { list.push(kw); last = { added: { list, value: kw } }; }
        });
        return last;
      }
      if (isNoteLine(text)) return { skipIdx: skip(text, 'looks like a note, not ad text') };
      const c = cleanCopy(text);
      if (!c) return {};
      let pieces = [c];
      if ((sec === 'headlines' || sec === 'adcopy') && /\s\|\s/.test(c)) {
        const p = c.split(/\s+\|\s+/).map(norm).filter(Boolean);
        if (p.length > 1 && p.every(x => x.length <= 35)) pieces = p;
      }
      pieces.forEach(piece => {
        const s = sec === 'adcopy' ? (piece.length <= 30 ? 'headlines' : 'descriptions') : sec;
        const why = rejectCopy(s, piece, isLi);
        if (why) {
          const suggest = s === 'headlines' && piece.length <= 90 ? 'description' : s === 'descriptions' && piece.length <= 30 ? 'headline' : null;
          last = { skipIdx: skip(piece, why, { suggest }) };
          return;
        }
        const t = ensureAg();
        const list = s === 'headlines' ? t.headlines : t.descriptions;
        list.push(piece);
        last = { added: { list, value: piece } };
      });
      return last;
    };

    const applySetting = (s, inSettingsSection) => {
      const k = s.k;
      if (k === 'finalUrl' || k === 'path1' || k === 'path2' || k === 'maxCpc') {
        if (ag) { ag[k] = s.v; return; }
        if (k === 'finalUrl') { if (campCtx) res.campaignUrls[key(campCtx)] = s.v; else res.settings.finalUrl = s.v; return; }
        if (k === 'maxCpc') res.settings.maxCpc = s.v;
        return;
      }
      if (k === 'budget') { if (campCtx) res.campaignBudgets[key(campCtx)] = s.v; else res.globalBudget = s.v; return; }
      if (k === 'locations') {
        if (s.presence != null) res.settings.presenceOnly = s.presence;
        (s.notes || []).forEach(msg => res.notes.push({ level: 'warn', msg }));
        if (!s.v.length) return;
        const accumulate = inSettingsSection && secInfo && secInfo.locSeen;
        if (campCtx) {
          const kk = key(campCtx);
          res.campaignLocations[kk] = accumulate && res.campaignLocations[kk] ? res.campaignLocations[kk].concat(s.v) : s.v;
        } else {
          res.settings.locations = accumulate && res.settings.locations ? res.settings.locations.concat(s.v) : s.v;
        }
        if (secInfo) secInfo.locSeen = true;
        return;
      }
      if (k === 'bidStrategy') { res.settings.bidStrategy = s.v; if (s.targetCpa) res.settings.targetCpa = s.targetCpa; return; }
      if (k === 'presence') { res.settings.presenceOnly = s.v; return; }
      if (k === 'startDate') {
        if (s.v) res.settings.startDate = s.v;
        else res.notes.push({ level: 'warn', msg: 'Start date "' + s.raw + '" could be day/month or month/day, so it was not used. Set it in Account defaults.' });
        return;
      }
      if (k === 'languages' && inSettingsSection && secInfo && secInfo.langSeen && res.settings.languages) {
        res.settings.languages = [...new Set(res.settings.languages.concat(s.v))];
        return;
      }
      if (k === 'languages' && secInfo) secInfo.langSeen = true;
      res.settings[k] = s.v;
    };
    // Settings that may sit inside an ad group's copy sections without ending them
    const COPY_SAFE_SETTINGS = new Set(['finalUrl', 'path1', 'path2', 'maxCpc', 'budget', 'bidStrategy', 'targetCpa', 'matchType', 'startDate']);

    const undoLast = prev => {
      if (prev.added) { const ix = prev.added.list.lastIndexOf(prev.added.value); if (ix >= 0) prev.added.list.splice(ix, 1); }
      if (prev.skipIdx != null) res.skipped[prev.skipIdx] = null;
    };
    const cycleDone = (a, sec) => {
      const k = a.keywords.length, h = a.headlines.length, d = a.descriptions.length;
      if (sec === 'keywords') return k > 0 && (h > 0 || d > 0);
      if (sec === 'headlines') return h > 0 && (d > 0 || k > 0);
      if (sec === 'descriptions') return d > 0 && h > 0 && k > 0;
      if (sec === 'adcopy') return (h > 0 || d > 0) && k > 0;
      return false;
    };

    const startSection = (c, b, stepNo) => {
      const sec = c.sec;
      if (sec === 'keywords' || sec === 'headlines' || sec === 'descriptions' || sec === 'adcopy') {
        const prev = lastPlain && lastPlain.step === stepNo - 1 ? lastPlain : null;
        const cycle = ag && cycleDone(ag, sec);
        if (prev && isNameLike(prev.text) && !matchSetting(prev.text) && (!ag || cycle)) {
          undoLast(prev);
          ag = getAg(prev.text, campCtx, { plainNamed: true }); agLevel = 9;
        } else if (cycle && (ag.implicit || ag.plainNamed || ag.auto)) {
          ag = getAg('Ad group ' + (res.adGroups.length + 1), campCtx, { auto: true }); agLevel = 9;
        }
      }
      section = sec;
      secInfo = { sec, label: b.text, matchHint: c.matchHint || null, hint: c.hint || null, scope: null, itemTypes: new Set() };
      if (sec === 'negatives') secInfo.scope = negScope(b, b.text);
      if (c.inline) {
        if (sec === 'settings') { const s = settingFrom(c.hint || b.text, c.inline); if (s) applySetting(s, true); }
        else if (COPY.has(sec)) {
          const items = (sec === 'headlines' || sec === 'adcopy') ? c.inline.split(/\s*;\s*/) : [c.inline];
          items.forEach(it => addItem(sec, it, false, secInfo.matchHint));
        }
      }
    };

    const content = (b, stepNo) => {
      const text = b.text, isLi = b.t === 'li';
      const plain = b.t === 'p' && !b.bold;
      if (section && COPY.has(section)) {
        // A short unbulleted line between bulleted items is a label the tool does not know, not an item.
        const bulleted = secInfo && secInfo.itemTypes.has('li') && !secInfo.itemTypes.has('p');
        if (plain && bulleted) {
          if (isNameLike(text) && !isNoteLine(text)) {
            const ix = skip(text, 'unbulleted line between bulleted items, read as a label the tool did not recognise', { kind: 'label' });
            section = null; secInfo = null;
            lastPlain = { step: stepNo, text, skipIdx: ix };
          } else {
            skip(text, 'unbulleted note between bulleted items');
            lastPlain = null;
          }
          return;
        }
        if (secInfo) secInfo.itemTypes.add(b.t);
        const r = addItem(section, text, isLi, secInfo && secInfo.matchHint);
        lastPlain = plain ? { step: stepNo, text, added: r.added || null, skipIdx: r.skipIdx } : null;
        return;
      }
      if (section === 'settings') {
        const hintLabel = { budget: secInfo.label, locations: 'Locations', languages: 'Languages', bidStrategy: 'Bid strategy', finalUrl: 'Final URL', networks: 'Networks' }[secInfo.hint];
        const s = matchSetting(text) || (hintLabel ? settingFrom(hintLabel, text) : null);
        if (s) { applySetting(s, true); lastPlain = null; return; }
        const ix = skip(text, 'not a setting the tool understands');
        lastPlain = plain ? { step: stepNo, text, skipIdx: ix } : null;
        return;
      }
      if (section === 'other') {
        const ix = skip(text, 'in the "' + norm(secInfo.label).replace(/:$/, '') + '" section, which is not exported', { kind: 'other' });
        lastPlain = plain ? { step: stepNo, text, skipIdx: ix } : null;
        return;
      }
      const ix = skip(text, 'not inside a keywords or ad text section', { kind: 'prose' });
      lastPlain = plain ? { step: stepNo, text, skipIdx: ix } : null;
    };

    const handleBlock = (b, c) => {
      step++;
      const text = b.text;
      if (!res.title && (c.k === 'heading' || c.k === 'campaign') && (b.t === 'h' || (b.t === 'p' && b.bold))) res.title = text;
      const inCopy = !!section && COPY.has(section);
      const plainLine = b.t !== 'h' && !(b.t === 'p' && b.bold) && !/:\s*$/.test(text);
      switch (c.k) {
        case 'campaign':
          campCtx = c.name; campLevel = c.level; ag = null; agLevel = 99; section = null; secInfo = null; lastPlain = null;
          if (!res.campaignHint) res.campaignHint = c.name;
          return;
        case 'adgroup':
          ag = getAg(c.name, campCtx); agLevel = c.level; section = null; secInfo = null; lastPlain = null;
          return;
        case 'aglist':
          if (campCtx) res.mapping.push({ campaign: campCtx, adGroups: splitList(c.names).map(cleanName), budget: null });
          else skip(text, 'ad group list outside a campaign', { kind: 'prose' });
          lastPlain = null;
          return;
        case 'numbered':
          addItem(c.sec, c.text, true); lastPlain = null;
          return;
        case 'section': {
          const bulletedSection = secInfo && secInfo.itemTypes && secInfo.itemTypes.has('li') && !secInfo.itemTypes.has('p');
          if (c.weak && !c.taught && inCopy && plainLine && !(b.t === 'p' && bulletedSection)) break;
          if (b.sheet) { ag = null; agLevel = 99; campCtx = null; campLevel = 99; }
          startSection(c, b, step); lastPlain = null;
          return;
        }
        case 'setting': {
          const k = c.s.k;
          const apply = !inCopy ? true : b.t === 'li' ? /^(?:finalUrl|path1|path2|maxCpc)$/.test(k) : COPY_SAFE_SETTINGS.has(k);
          if (apply) { applySetting(c.s, section === 'settings'); lastPlain = null; return; }
          break;
        }
        case 'note':
          skip(text, 'ignored because you taught the tool to skip it', { kind: 'taught' }); lastPlain = null;
          return;
        case 'heading':
          if (inCopy && b.t === 'p') {
            const ix = skip(text, 'bold line, read as a sub-heading', { suggest: text.length <= 30 ? 'headline' : 'description' });
            section = null; secInfo = null;
            lastPlain = { step, text, skipIdx: ix };
            return;
          }
          if (c.level <= agLevel) { ag = null; agLevel = 99; }
          if (c.level <= campLevel) { campCtx = null; campLevel = 99; }
          section = null; secInfo = null;
          lastPlain = null;
          if (b.t === 'h' && !b.sheet && text !== res.title) skip(text, 'heading the tool did not recognise', { kind: 'heading' });
          return;
      }
      content(b, step);
    };

    const handleTable = rowsRaw => {
      const shape = tableShape(rowsRaw);
      const rows = shape.rows;
      lastPlain = null;
      if (shape.kind === 'lines') {
        rows.forEach(r => r.filter(Boolean).forEach(cell => cell.split('\n').map(norm).filter(Boolean).forEach(line => {
          const blk = { t: 'p', text: line, bold: false };
          handleBlock(blk, classify(blk, opts.memory));
        })));
        return;
      }
      if (shape.kind === 'kv') {
        const kvApply = (label, value) => {
          const v = String(value || '');
          if (!norm(v)) return;
          if (!label) { skip(norm(v), 'table cell without a label', { kind: 'table' }); return; }
          if (/^(?:ad ?group|adgroup)(?:\s+(?:name|theme))?$/i.test(label)) { ag = getAg(norm(v), campCtx); return; }
          if (/^campaign(?:\s+name)?$/i.test(label)) { campCtx = tidyCampaign(norm(v)); if (!res.campaignHint) res.campaignHint = campCtx; return; }
          let m;
          if ((m = label.match(NUMBERED_ONLY)) || (m = label.match(/^(headline|description|desc|h|d)\s*(\d{1,2})$/i))) {
            addItem(/^h/i.test(m[1]) ? 'headlines' : 'descriptions', v.replace(/\n/g, ' '), true);
            return;
          }
          const sl = sectionLabel(label);
          if (sl && !sl.inline && COPY.has(sl.sec)) {
            const lines = v.split('\n').map(norm).filter(Boolean);
            const scope = sl.sec === 'negatives' ? negScope({ t: 'p' }, label) : null;
            lines.forEach(line => addItem(sl.sec, line, true, parseMatch(label), scope));
            return;
          }
          const s = settingFrom(label, v.replace(/\n/g, ', '));
          if (s) { applySetting(s, false); return; }
          if (sl && sl.sec === 'other') { skip(label + ': ' + norm(v), 'in the "' + label + '" row, which is not exported', { kind: 'other' }); return; }
          skip(label + ': ' + norm(v), 'table row the tool did not recognise', { kind: 'table' });
        };
        if (shape.multi) {
          const head = rows[0];
          for (let j = 1; j < head.length; j++) {
            if (!head[j]) continue;
            const prev = ag;
            ag = getAg(head[j], campCtx);
            rows.slice(1).forEach(r => kvApply(norm(r[0] || ''), r[j] || ''));
            ag = prev;
          }
        } else {
          rows.forEach(r => kvApply(norm(r[0] || ''), r.slice(1).filter(Boolean).join('\n')));
        }
        return;
      }
      if (shape.kind === 'mapping') {
        const { hi, fields } = shape;
        const ci = fields.indexOf('campaign'), ai = fields.indexOf('adgroup'), bi = fields.indexOf('budget');
        rows.slice(hi + 1).forEach(r => {
          const camp = r[ci], ags = r[ai];
          if (!camp && ags && res.mapping.length) { res.mapping[res.mapping.length - 1].adGroups.push(...splitList(ags).map(cleanName)); return; }
          if (!camp) return;
          res.mapping.push({ campaign: tidyCampaign(camp), adGroups: splitList(ags).map(cleanName), budget: bi >= 0 && r[bi] ? parseBudget(rows[hi][bi], r[bi]) : null });
        });
        return;
      }
      if (shape.kind === 'budgets') {
        const { hi, fields } = shape;
        const ci = fields.indexOf('campaign'), bi = fields.indexOf('budget');
        rows.slice(hi + 1).forEach(r => { const b = r[ci] && r[bi] ? parseBudget(rows[hi][bi], r[bi]) : null; if (b) res.campaignBudgets[key(tidyCampaign(r[ci]))] = b; });
        return;
      }
      if (shape.kind === 'records') {
        const { hi, fields } = shape;
        const col = f => fields.indexOf(f);
        const head = rows[hi];
        const prevAg = ag;
        let curAg = null, curCamp = null;
        rows.slice(hi + 1).forEach(r => {
          const campName = col('campaign') >= 0 ? r[col('campaign')] : '';
          if (campName) curCamp = tidyCampaign(campName);
          const agName = col('adgroup') >= 0 ? r[col('adgroup')] : '';
          const rowHasCopy = fields.some((f, ix) => COPY_FIELDS.has(f) && r[ix] && !/^\d+$/.test(r[ix]));
          if (curCamp && col('budget') >= 0 && r[col('budget')]) { const b = parseBudget(head[col('budget')], r[col('budget')]); if (b) res.campaignBudgets[key(curCamp)] = b; }
          if (agName && !rowHasCopy) {
            const props = { name: cleanName(agName), campHint: curCamp || campCtx };
            fields.forEach((f, ix) => {
              if (!r[ix]) return;
              if (f === 'finalUrl') props.finalUrl = findUrl(r[ix]);
              if (f === 'path1' || f === 'path2') props[f] = cleanPath(r[ix]);
              if (f === 'maxCpc') props.maxCpc = money(r[ix]);
            });
            res.agProps.push(props);
            return;
          }
          if (agName) curAg = getAg(agName, curCamp || campCtx);
          ag = col('adgroup') >= 0 ? (curAg || prevAg) : prevAg;
          const mi = col('match');
          const matchCell = mi >= 0 ? r[mi] : '';
          const negRow = /negative/i.test(matchCell);
          const negScopeRow = negRow ? (/campaign/i.test(matchCell) ? 'campaign' : (ag ? 'adgroup' : 'account')) : null;
          const prevCamp = campCtx;
          if (curCamp) campCtx = curCamp;
          fields.forEach((f, ix) => {
            const v = r[ix];
            if (!v || /^\d+$/.test(v)) return;
            if (f === 'keywords') v.split('\n').forEach(line => addItem(negRow ? 'negatives' : 'keywords', line, true, matchCell.replace(/negative/i, ''), negScopeRow));
            else if (f === 'negatives') v.split('\n').forEach(line => addItem('negatives', line, true, null, /campaign/i.test(head[ix]) ? 'campaign' : /account|shared|all/i.test(head[ix]) ? 'account' : (ag ? 'adgroup' : 'account')));
            else if (f === 'headlines') v.split('\n').forEach(line => addItem('headlines', line, true));
            else if (f === 'descriptions') v.split('\n').forEach(line => addItem('descriptions', line, true));
            else if (f === 'finalUrl') { const u = findUrl(v); if (u) ensureAg().finalUrl = u; }
            else if (f === 'path1' || f === 'path2') ensureAg()[f] = cleanPath(v);
            else if (f === 'maxCpc') { const n = money(v); if (n != null) ensureAg().maxCpc = n; }
          });
          campCtx = prevCamp;
        });
        if (col('adgroup') >= 0) ag = prevAg;
        return;
      }
      // plain table: columns may be ad groups, or it is a list inside the current section
      if (section && COPY.has(section)) {
        const head = rows[0];
        const named = head.filter(c => c && !/^\d+$/.test(c) && hdrField(c) == null && c.length <= 60);
        const dataCells = rows.slice(1).flat().filter(Boolean);
        const lowerShare = dataCells.length ? dataCells.filter(c => /^[a-z]/.test(c)).length / dataCells.length : 0;
        const transposed = named.length >= 2 && rows.length >= 3 && named.length === head.filter(Boolean).length
          && named.every(c => /^[\p{Lu}\d]/u.test(c)) && (section !== 'keywords' || lowerShare >= 0.6);
        if (transposed) {
          head.forEach((h, j) => {
            if (!h) return;
            const prev = ag;
            ag = getAg(h, campCtx);
            rows.slice(1).forEach(r => { const v = r[j]; if (v && !/^\d+$/.test(v)) addItem(section, v, true, secInfo && secInfo.matchHint); });
            ag = prev;
          });
          return;
        }
        const data = rows.filter(r => !r.every(c => !c || HEADER_CELL.test(c) || hdrField(c)));
        const width = Math.max(0, ...data.map(r => r.length));
        let bestCol = 0, bestLen = -1;
        for (let i = 0; i < width; i++) {
          const vals = data.map(r => r[i]).filter(v => v && !/^\d+$/.test(v));
          const avg = vals.length ? vals.reduce((s, v) => s + v.length, 0) / vals.length : 0;
          if (avg > bestLen) { bestLen = avg; bestCol = i; }
        }
        // first column of names next to multi-line lists: one ad group per row
        const names = data.map(r => r[0] || '');
        const rowGroups = bestCol !== 0 && data.length >= 2 && names.every(v => v && !v.includes('\n') && v.length <= 60 && /^[\p{Lu}\d]/u.test(v))
          && data.filter(r => (r[bestCol] || '').includes('\n')).length >= data.length / 2;
        const prevAg = ag;
        data.forEach(r => {
          const c = r[bestCol];
          if (!c || /^\d+$/.test(c)) return;
          if (rowGroups) ag = getAg(r[0], campCtx);
          c.split('\n').forEach(line => addItem(section, line, true, secInfo && secInfo.matchHint));
        });
        if (rowGroups) ag = prevAg;
        return;
      }
      skip(rows[0].filter(Boolean).join(' | '), 'table the tool did not recognise', { kind: 'table' });
    };

    blocks.forEach((b, i) => {
      if (b.t === 'table') { step++; handleTable(b.rows); return; }
      handleBlock(b, cls[i]);
    });

    if (!res.title && blocks[0] && blocks[0].t === 'p' && cls[0].k === 'text' && isNameLike(blocks[0].text)) res.title = blocks[0].text;
    res.skipped = res.skipped.filter(Boolean);
    return res;
  }

  const splitList = s => {
    const t = String(s || '');
    const parts = /\n/.test(t) ? t.split(/\n+/) : /;/.test(t) ? t.split(/;+/) : t.split(/,+/);
    return parts.map(norm).filter(Boolean);
  };

  /* ---------- 4. Parse result -> model ---------- */

  function suggestPaths(name) {
    const words = norm(name).replace(/&/g, ' ').split(/[\s/,]+/)
      .filter(w => w && !/^(and|for|the|of|to|a|an|with|in|on)$/i.test(w))
      .map(w => w.replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 15)).filter(Boolean);
    const take = () => {
      let out = '';
      while (words.length) {
        const next = out ? out + '-' + words[0] : words[0];
        if (next.length > 15) break;
        out = next; words.shift();
      }
      return out;
    };
    const p1 = take();
    const p2 = take();
    return [p1, p2];
  }

  // A campaign name from the doc title: "Brightside Dental – Search Plan" -> "Brightside Dental - Search"
  function deriveName(title) {
    const t = norm(title)
      .replace(/\b(?:google\s+)?(?:ads\s+)?(?:search\s+)?campaigns?\b/gi, ' ')
      .replace(/\b(?:structure|plan|proposal|brief|setup|build(?:out)?|strategy|overview|draft|v\d+)\b/gi, ' ')
      .replace(/\b(?:google\s+ads|adwords|google|ppc|sem)\b/gi, ' ')
      .replace(/[\s\-–—:|]+search\s*$/i, '')
      .replace(/\s*[-–—:|]+\s*$/, '').replace(/^\s*[-–—:|]+\s*/, '')
      .replace(/\s+[-–—:|]+\s+[-–—:|\s]*/g, ' - ').replace(/[\s\-–—:|]+$/, '').replace(/\s+/g, ' ').trim();
    return t ? t + ' - Search' : '';
  }

  const fmtNum = n => (Math.round(n * 100) / 100).toLocaleString('en-US');

  function buildModel(res, sourceName) {
    const model = {
      source: sourceName || '', title: res.title, campaigns: [], adGroups: [], accountNegatives: res.accountNegatives.slice(),
      notes: [], skipped: [], detected: res.settings
    };
    res.notes.forEach(n => model.notes.push(n));
    const byKey = new Map();
    const usedNegKeys = new Set();
    const budgetNote = (c, b) => {
      if (!b) return;
      if (b.basis === 'monthly' || b.basis === 'weekly' || b.basis === 'yearly') {
        model.notes.push({ level: 'info', msg: c.name + ': ' + b.basis + ' budget of ' + fmtNum(b.amount) + ' converted to ' + fmtNum(b.daily) + ' per day.' });
      } else if (b.basis === 'unlabeled') {
        model.notes.push({ level: 'warn', msg: c.name + ': the doc gives a budget of ' + fmtNum(b.amount) + ' without saying daily or monthly. It went in as a daily budget, so check it.' });
      }
    };
    const mkC = (name, budget) => {
      const k = key(name);
      if (byKey.has(k)) return byKey.get(k);
      const b = budget || res.campaignBudgets[k] || null;
      if (res.campaignNegatives[k]) usedNegKeys.add(k);
      const c = { id: nid('c'), name, budget: b ? b.daily : null, budgetBasis: b ? b.basis : null, negatives: (res.campaignNegatives[k] || []).slice(), locations: res.campaignLocations[k] ? res.campaignLocations[k].slice() : null, finalUrl: res.campaignUrls[k] || '' };
      budgetNote(c, b);
      model.campaigns.push(c); byKey.set(k, c);
      return c;
    };
    const listed = [];
    res.mapping.forEach(m => {
      const c = mkC(m.campaign, m.budget);
      m.adGroups.forEach(n => listed.push({ n, c, used: false }));
    });

    const agIds = new Map();
    res.adGroups.forEach(a => {
      // look in the ad group's own campaign first, so "Brand" under two campaigns stays in both
      const search = list => { let b = null, sc = 0; list.forEach(L => { const s = sim(L.n, a.name); if (s > sc) { sc = s; b = L; } }); return [b, sc]; };
      const pool = a.campHint ? listed.filter(L => key(L.c.name) === key(a.campHint)) : [];
      let [best, score] = pool.length ? search(pool) : [null, 0];
      if (!best || score < 0.6) [best, score] = search(listed);
      let camp = null;
      if (best && score >= 0.6) { camp = best.c; best.used = true; }
      if (!camp && a.campHint) camp = mkC(a.campHint);
      if (!camp) { const nm = res.campaignHint || deriveName(res.title) || 'Search campaign'; camp = mkC(nm); }
      const props = res.agProps.find(p => key(p.name) === key(a.name)) || res.agProps.map(p => [p, sim(p.name, a.name)]).filter(x => x[1] >= 0.6).sort((x, y) => y[1] - x[1]).map(x => x[0])[0];
      const [p1, p2] = suggestPaths(a.name);
      const path1 = a.path1 || (props && props.path1) || '';
      const path2 = a.path2 || (props && props.path2) || '';
      const g = {
        id: nid('g'), name: a.name, campaignId: camp.id,
        keywords: a.keywords, negatives: a.negatives,
        headlines: a.headlines.slice(0, 15), descriptions: a.descriptions.slice(0, 4),
        finalUrl: a.finalUrl || (props && props.finalUrl) || camp.finalUrl || '',
        path1: path1 || p1, path2: path2 || (path1 ? '' : p2),
        maxCpc: a.maxCpc != null ? a.maxCpc : (props && props.maxCpc != null ? props.maxCpc : null),
        auto: !!a.auto
      };
      agIds.set(a, g.id);
      a.headlines.slice(15).forEach(h => model.skipped.push({ text: h, reason: 'over the limit of 15 headlines per ad', agId: g.id, kind: 'limit', suggest: null }));
      a.descriptions.slice(4).forEach(d => model.skipped.push({ text: d, reason: 'over the limit of 4 descriptions per ad', agId: g.id, kind: 'limit', suggest: null }));
      if (a.auto) model.notes.push({ level: 'warn', msg: '"' + a.name + '" had no name in the doc, so it was named automatically. Rename it below.' });
      model.adGroups.push(g);
    });
    res.agProps.forEach(p => {
      const matched = res.adGroups.some(a => key(a.name) === key(p.name) || sim(a.name, p.name) >= 0.6);
      if (!matched) model.notes.push({ level: 'warn', msg: 'The doc gives settings for "' + p.name + '" but has no keywords or ads for it.' });
    });
    const order = g => { const L = listed.find(x => x.used && x.c.id === g.campaignId && sim(x.n, g.name) >= 0.6); return L ? listed.indexOf(L) : 1e4; };
    const ci = id => model.campaigns.findIndex(c => c.id === id);
    const docIx = new Map(model.adGroups.map((g, i) => [g, i]));
    model.adGroups.sort((a, b) => (ci(a.campaignId) - ci(b.campaignId)) || (order(a) - order(b)) || (docIx.get(a) - docIx.get(b)));
    listed.filter(L => !L.used).forEach(L => model.notes.push({ level: 'warn', msg: '"' + L.n + '" is listed under ' + L.c.name + ' but has no ad group section in the doc.' }));
    model.adGroups.forEach(g => {
      const a = res.adGroups.find(x => agIds.get(x) === g.id);
      if (a && a.headlines.length > 15) model.notes.push({ level: 'warn', msg: g.name + ': doc has ' + a.headlines.length + ' headlines. Google allows 15, so the first 15 were kept. The rest are in the import report.' });
      if (a && a.descriptions.length > 4) model.notes.push({ level: 'warn', msg: g.name + ': doc has ' + a.descriptions.length + ' descriptions. Google allows 4, so the first 4 were kept. The rest are in the import report.' });
    });
    Object.keys(res.campaignNegatives).forEach(k => {
      if (usedNegKeys.has(k)) return;
      res.campaignNegatives[k].forEach(n => { if (!model.accountNegatives.some(x => x.text === n.text && x.match === n.match)) model.accountNegatives.push(n); });
    });
    Object.keys(res.campaignUrls).forEach(k => { if (!byKey.has(k) && !res.settings.finalUrl) res.settings.finalUrl = res.campaignUrls[k]; });
    Object.keys(res.campaignLocations).forEach(k => { if (!byKey.has(k) && !res.settings.locations) res.settings.locations = res.campaignLocations[k]; });
    Object.keys(res.campaignBudgets).forEach(k => { if (!byKey.has(k) && !res.globalBudget) res.globalBudget = res.campaignBudgets[k]; });
    if (res.globalBudget) {
      const free = model.campaigns.filter(c => c.budget == null);
      if (model.campaigns.length === 1 && free.length === 1) { free[0].budget = res.globalBudget.daily; free[0].budgetBasis = res.globalBudget.basis; budgetNote(free[0], res.globalBudget); }
      else if (free.length) model.notes.push({ level: 'info', msg: 'Doc mentions a budget of ' + fmtNum(res.globalBudget.amount) + (res.globalBudget.basis !== 'unlabeled' ? ' (' + res.globalBudget.basis + ')' : '') + '. Set the daily budget for each campaign below.' });
    }
    res.skipped.forEach(s => model.skipped.push({ text: s.text, reason: s.reason, kind: s.kind || 'item', suggest: s.suggest || null, agId: s.ag ? agIds.get(s.ag) || null : null, section: s.section || null }));
    return model;
  }

  // Blocks back to markdown-like text, the form the AI reader receives.
  function blocksToText(blocks) {
    const cell = c => String(c == null ? '' : c).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
    return blocks.map(b => {
      if (b.t === 'h') return '#'.repeat(Math.min(b.level, 6)) + ' ' + b.text + (b.sheet ? ' (spreadsheet tab)' : '');
      if (b.t === 'li') return '- ' + b.text;
      if (b.t === 'p') return b.bold ? '**' + b.text + '**' : b.text;
      if (b.t === 'table') return b.rows.map(r => '| ' + r.map(cell).join(' | ') + ' |').join('\n');
      return '';
    }).join('\n');
  }

  function parseBlocksToModel(blocks, name, opts) { return buildModel(parseBlocks(blocks, opts), name); }
  function parseHTML(html, name, ParserCtor, opts) { return parseBlocksToModel(htmlToBlocks(html, ParserCtor), name, opts); }
  function parseText(txt, name, opts) { return parseBlocksToModel(textToBlocks(txt), name, opts); }
  function parseSheets(sheets, name, opts) {
    const blocks = [];
    sheets.forEach(s => rowsToBlocks(s.rows, s.name).forEach(b => blocks.push(b)));
    return parseBlocksToModel(blocks, name, opts);
  }

  /* ---------- 5. Validation ---------- */

  const BAD_KW = /[!@%^*()={};~`<>?\\|,]/;
  const matchTypesFor = (k, global) => k.match ? [k.match] : (global === 'phrase+exact' ? ['phrase', 'exact'] : [global]);
  const kwWords = s => norm(s).toLowerCase().replace(/[^\p{L}\p{N}'&.+#-]+/gu, ' ').trim().split(' ').filter(Boolean);

  // Does a negative keyword stop this keyword's own search from showing an ad?
  function negBlocks(neg, kwText) {
    const n = kwWords(neg.text), k = kwWords(kwText);
    if (!n.length || !k.length) return false;
    const mt = neg.match || 'phrase';
    if (mt === 'exact') return n.join(' ') === k.join(' ');
    if (mt === 'broad') return n.every(w => k.includes(w));
    for (let i = 0; i + n.length <= k.length; i++) if (n.every((w, j) => k[i + j] === w)) return true;
    return false;
  }

  const EMOJI = /\p{Extended_Pictographic}/u;
  const REPEAT_PUNCT = /([!?])\1|!\?|\?!/;
  const findPhone = t => {
    const m = t.match(/\+?\(?\d[\d\s().-]{7,}\d/);
    if (!m) return null;
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 9 || /^\d{4}\s*[-–]\s*\d{4}$/.test(m[0].trim())) return null;
    return m[0].trim();
  };
  const SHOUT_OK = new Set(['HVAC', 'CCTV', 'HIPAA', 'GDPR', 'ASAP', 'NASA', 'USPS', 'UPVC', 'LASIK', 'IELTS', 'TOEFL', 'NCLEX', 'FAQS', 'SAAS', 'CPAP', 'MBBS', 'BBA', 'CRM', 'ERP', 'HTML', 'JSON', 'NYSE', 'NASDAQ', 'ISO', 'MSME', 'NHS', 'IVF', 'ICSE', 'CBSE', 'ACCA', 'ICAEW', 'SEBI', 'RERA', 'NEET', 'GMAT', 'GRE', 'PMP', 'CISSP', 'CCNA', 'AWS', 'GCP', 'SOC', 'PCI', 'SMB', 'SMBS', 'SMES', 'MSPS', 'B2B', 'B2C', 'DIY', 'LLC', 'INC', 'USA', 'UAE', 'KSA', 'NYC']);

  function validate(model, S, today) {
    const errors = [], warnings = [];
    const E = (o, msg) => errors.push(Object.assign({ msg }, o));
    const W = (o, msg) => warnings.push(Object.assign({ msg }, o));
    const urlOk = u => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u || '');
    const camp = id => model.campaigns.find(c => c.id === id);

    const used = model.campaigns.filter(c => model.adGroups.some(g => g.campaignId === c.id));
    if (!model.adGroups.length) E({ scope: 'doc' }, 'No ad groups found yet. Load a campaign doc or add an ad group.');
    if (!urlOk(S.finalUrl) && model.adGroups.some(g => !urlOk(g.finalUrl))) E({ scope: 'settings', field: 'finalUrl' }, 'Add a final URL that starts with https://');
    if (S.bidStrategy === 'tcpa' && !(+S.targetCpa > 0)) E({ scope: 'settings', field: 'targetCpa' }, 'Target CPA needs an amount.');
    if (S.bidStrategy === 'manual' && !(+S.maxCpc > 0) && model.adGroups.some(g => !(+g.maxCpc > 0))) E({ scope: 'settings', field: 'maxCpc' }, 'Manual CPC needs a default max CPC.');
    const usesDefaultLocs = used.some(c => !(c.locations && c.locations.length));
    if (usesDefaultLocs && !S.allLocations && !S.locations.length) E({ scope: 'settings', field: 'locations' }, 'Add at least one location, or choose "All countries" if that is really the plan.');
    const allLocs = (usesDefaultLocs && !S.allLocations ? S.locations : []).concat(...used.map(c => c.locations || []));
    const noId = [...new Set(allLocs.filter(l => !l.id).map(l => l.name))];
    noId.forEach(n => W({ scope: 'settings', field: 'locations' }, '"' + n + '" has no location ID, so Ads Editor will match it by name. Check it landed on the right place after import.'));
    if (!S.languages.length) W({ scope: 'settings', field: 'languages' }, 'No language set, so campaigns will target all languages.');
    if (S.campaignStatus === 'Enabled') W({ scope: 'settings' }, 'Campaigns will go live as soon as you post in Editor.');
    if (S.startDate && today && S.startDate < today) E({ scope: 'settings', field: 'startDate' }, 'The start date is in the past. Google will not accept it.');

    const names = new Map();
    used.forEach(c => {
      const k = c.name.trim().toLowerCase();
      if (!k) E({ scope: 'campaign', id: c.id, field: 'name' }, 'A campaign needs a name.');
      else if (names.has(k)) E({ scope: 'campaign', id: c.id, field: 'name' }, 'Two campaigns are named "' + c.name + '".');
      names.set(k, 1);
      if (!(+c.budget > 0)) E({ scope: 'campaign', id: c.id, field: 'budget' }, c.name + ': add a daily budget.');
    });
    model.campaigns.filter(c => !used.includes(c)).forEach(c => W({ scope: 'campaign', id: c.id }, c.name + ' has no ad groups and will be skipped.'));

    const checkKw = (k, o, label, what) => {
      const words = k.text.split(' ').length;
      if (k.text.length > 80) E(o, label + ': ' + what + ' "' + k.text.slice(0, 40) + '..." is over 80 characters.');
      if (words > 10) E(o, label + ': ' + what + ' "' + k.text + '" has ' + words + ' words (limit 10).');
      const bad = k.text.match(BAD_KW);
      if (bad) E(o, label + ': ' + what + ' "' + k.text + '" contains "' + bad[0] + '", which Google does not accept in keywords.');
    };
    model.accountNegatives.forEach(k => checkKw(k, { scope: 'settings', field: 'acctNeg' }, 'Negative keywords for every campaign', 'negative'));
    used.forEach(c => (c.negatives || []).forEach(k => checkKw(k, { scope: 'campaign', id: c.id, field: 'negatives' }, c.name, 'campaign negative')));

    const copyChecks = (t, o, label, what) => {
      if (EMOJI.test(t)) E(o, label + ': ' + what + ' has an emoji or symbol, which Google rejects in ad text.');
      if (REPEAT_PUNCT.test(t)) E(o, label + ': ' + what + ' repeats punctuation ("!!" or "?!"), which Google rejects.');
      const ph = findPhone(t);
      if (ph) W(o, label + ': ' + what + ' contains a phone number (' + ph + '). Google disapproves phone numbers in ad text; use a call asset.');
      const shout = (t.match(/\b[A-Z]{4,}\b/g) || []).filter(w => !SHOUT_OK.has(w));
      if (shout.length) W(o, label + ': ' + what + ' has "' + shout[0] + '" in capitals. Google disapproves capitals used for emphasis, so check it is a real acronym.');
    };

    const kwIndex = new Map();
    const agNames = new Map();
    model.adGroups.forEach(g => {
      const o = { scope: 'adgroup', id: g.id };
      const c = camp(g.campaignId);
      const ak = (g.campaignId + '|' + g.name.trim().toLowerCase());
      if (!g.name.trim()) E(o, 'An ad group needs a name.');
      else if (agNames.has(ak)) E(o, g.name + ' appears twice in ' + (c ? c.name : 'one campaign') + '.');
      agNames.set(ak, 1);
      const label = g.name || 'Untitled ad group';
      const hs = g.headlines.map(norm).filter(Boolean);
      const ds = g.descriptions.map(norm).filter(Boolean);
      if (hs.length < 3) E(Object.assign({ field: 'h' }, o), label + ': needs at least 3 headlines (has ' + hs.length + ').');
      if (ds.length < 2) E(Object.assign({ field: 'd' }, o), label + ': needs at least 2 descriptions (has ' + ds.length + ').');
      g.headlines.forEach((h, i) => {
        const t = norm(h); if (!t) return;
        const oi = Object.assign({ field: 'h', i }, o);
        if (t.length > 30) E(oi, label + ': headline ' + (i + 1) + ' is ' + t.length + ' characters (limit 30).');
        if (/!/.test(t)) E(oi, label + ': headline ' + (i + 1) + ' has an exclamation mark, which Google rejects in headlines.');
        copyChecks(t, oi, label, 'headline ' + (i + 1));
      });
      const seen = new Set();
      hs.forEach(h => { const k = h.toLowerCase(); if (seen.has(k)) E(Object.assign({ field: 'h' }, o), label + ': duplicate headline "' + h + '".'); seen.add(k); });
      const seenD = new Set();
      ds.forEach(d => { const k = d.toLowerCase(); if (seenD.has(k)) E(Object.assign({ field: 'd' }, o), label + ': duplicate description.'); seenD.add(k); });
      g.descriptions.forEach((d, i) => {
        const t = norm(d); if (!t) return;
        const oi = Object.assign({ field: 'd', i }, o);
        if (t.length > 90) E(oi, label + ': description ' + (i + 1) + ' is ' + t.length + ' characters (limit 90).');
        copyChecks(t, oi, label, 'description ' + (i + 1));
      });
      ['path1', 'path2'].forEach(p => {
        const v = g[p] || '';
        if (v.length > 15) E(Object.assign({ field: p }, o), label + ': ' + (p === 'path1' ? 'Path 1' : 'Path 2') + ' is ' + v.length + ' characters (limit 15).');
        if (/[\s/]/.test(v)) E(Object.assign({ field: p }, o), label + ': display paths cannot contain spaces or slashes.');
      });
      if (!g.path1 && g.path2) E(Object.assign({ field: 'path1' }, o), label + ': Path 2 needs Path 1.');
      if (g.finalUrl && !urlOk(g.finalUrl)) E(Object.assign({ field: 'finalUrl' }, o), label + ': final URL must start with https://');
      if (!g.keywords.length) W(o, label + ': no keywords yet.');
      g.keywords.forEach(k => {
        checkKw(k, Object.assign({ field: 'keywords' }, o), label, 'keyword');
        matchTypesFor(k, S.matchType).forEach(mt => {
          const ix = k.text.toLowerCase() + '|' + mt;
          if (!kwIndex.has(ix)) kwIndex.set(ix, []);
          kwIndex.get(ix).push(g);
        });
      });
      g.negatives.forEach(k => checkKw(k, Object.assign({ field: 'negatives' }, o), label, 'negative'));
      // negatives that block this ad group's own keywords
      const negs = model.accountNegatives.map(n => [n, 'account negative'])
        .concat(((c && c.negatives) || []).map(n => [n, 'campaign negative']))
        .concat(g.negatives.map(n => [n, 'ad group negative']));
      g.keywords.forEach(k => {
        const hit = negs.find(([n]) => negBlocks(n, k.text));
        if (hit) W(Object.assign({ field: 'keywords' }, o), label + ': the ' + hit[1] + ' "' + hit[0].text + '" blocks the keyword "' + k.text + '", so it will never show an ad.');
      });
    });
    kwIndex.forEach((gs, ix) => {
      const uniq = [...new Set(gs)];
      const kw = ix.split('|')[0];
      if (uniq.length > 1) uniq.forEach(g => W({ scope: 'adgroup', id: g.id, field: 'keywords', dup: kw }, '"' + kw + '" is in ' + uniq.map(x => x.name).join(' and ') + '. The ad groups will compete for the same searches.'));
    });
    return { errors, warnings };
  }

  /* ---------- 6. Export ---------- */

  const BID_LABEL = { maxclicks: 'Maximize clicks', maxconv: 'Maximize conversions', tcpa: 'Maximize conversions', manual: 'Manual CPC' };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const HEADERS = ['Campaign', 'Campaign Type', 'Networks', 'Budget', 'Budget type', 'Bid Strategy Type', 'Target CPA', 'Languages', 'Targeting method', 'Start Date', 'Campaign Status',
    'Location', 'Location ID', 'Ad Group', 'Max CPC', 'Ad Group Status', 'Keyword', 'Criterion Type', 'Ad type', 'Status']
    .concat(Array.from({ length: 15 }, (_, i) => 'Headline ' + (i + 1)))
    .concat(Array.from({ length: 4 }, (_, i) => 'Description ' + (i + 1)))
    .concat(['Path 1', 'Path 2', 'Final URL']);
  const num = v => { const n = +v; return isFinite(n) && n > 0 ? String(Math.round(n * 100) / 100) : ''; };

  function exportRows(model, S) {
    const raw = [];
    const row = o => raw.push(o);
    model.campaigns.forEach(c => {
      const ags = model.adGroups.filter(g => g.campaignId === c.id);
      if (!ags.length) return;
      const cn = c.name.trim();
      row({
        kind: 'campaign', Campaign: cn, 'Campaign Type': 'Search', Networks: S.searchPartners ? 'Google search;Search Partners' : 'Google search', Budget: num(c.budget), 'Budget type': 'Daily',
        'Bid Strategy Type': BID_LABEL[S.bidStrategy], 'Target CPA': S.bidStrategy === 'tcpa' ? num(S.targetCpa) : '', Languages: S.languages.join(';'),
        'Targeting method': S.presenceOnly ? 'Location of presence' : '', 'Start Date': S.startDate || '', 'Campaign Status': S.campaignStatus
      });
      const locs = c.locations && c.locations.length ? c.locations : (S.allLocations ? [] : S.locations);
      locs.forEach(L => row({ kind: 'location', Campaign: cn, Location: L.name, 'Location ID': L.id || '' }));
      ags.forEach(g => {
        const gn = g.name.trim();
        row({ kind: 'adgroup', Campaign: cn, 'Ad Group': gn, 'Max CPC': S.bidStrategy === 'manual' ? num(+g.maxCpc > 0 ? g.maxCpc : S.maxCpc) : '', 'Ad Group Status': 'Enabled' });
        g.keywords.forEach(k => matchTypesFor(k, S.matchType).forEach(mt => row({ kind: 'keyword', Campaign: cn, 'Ad Group': gn, Keyword: k.text, 'Criterion Type': cap(mt), Status: 'Enabled' })));
        g.negatives.forEach(k => row({ kind: 'negative', Campaign: cn, 'Ad Group': gn, Keyword: k.text, 'Criterion Type': 'Negative ' + cap(k.match || 'phrase') }));
        const ad = { kind: 'ad', Campaign: cn, 'Ad Group': gn, 'Ad type': 'Responsive search ad', Status: 'Enabled', 'Path 1': g.path1 || '', 'Path 2': g.path2 || '', 'Final URL': (g.finalUrl || S.finalUrl || '').trim() };
        g.headlines.map(norm).filter(Boolean).slice(0, 15).forEach((h, i) => { ad['Headline ' + (i + 1)] = h; });
        g.descriptions.map(norm).filter(Boolean).slice(0, 4).forEach((d, i) => { ad['Description ' + (i + 1)] = d; });
        row(ad);
      });
      const negs = [];
      model.accountNegatives.concat(c.negatives || []).forEach(k => { if (!negs.some(x => x.text.toLowerCase() === k.text.toLowerCase() && x.match === k.match)) negs.push(k); });
      negs.forEach(k => row({ kind: 'negative', Campaign: cn, Keyword: k.text, 'Criterion Type': 'Campaign Negative ' + cap(k.match || 'phrase') }));
    });
    const headers = HEADERS.filter(h => raw.some(r => r[h]));
    return { headers, rows: raw.map(r => headers.map(h => r[h] == null ? '' : String(r[h]))), kinds: raw.map(r => r.kind) };
  }

  const csvCell = v => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const toCSV = t => [t.headers].concat(t.rows).map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const toTSV = t => [t.headers].concat(t.rows).map(r => r.map(v => v.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n') + '\n';

  const kwToLine = k => k.match === 'exact' ? '[' + k.text + ']' : k.match === 'phrase' ? '"' + k.text + '"' : k.match === 'broad' ? k.text + ' (broad)' : k.text;
  const linesToKw = txt => {
    const out = [];
    String(txt).split(/\n/).forEach(l => { const k = parseKeyword(l); if (k && !out.some(x => x.text.toLowerCase() === k.text.toLowerCase() && x.match === k.match)) out.push(k); });
    return out;
  };

  const api = {
    norm, key, labelKey, sim, htmlToBlocks, textToBlocks, csvToRows, rowsToBlocks, classify, parseBlocks, buildModel, parseBlocksToModel,
    parseHTML, parseText, parseSheets, validate, exportRows, toCSV, toTSV, suggestPaths, COUNTRIES, LANGS, findCountry, parseLocations,
    parseBudget, matchSetting, sectionLabel, kwToLine, linesToKw, matchTypesFor, negBlocks, nid, parseKeyword, deriveName, blocksToText, tidyCampaign,
    settingFrom
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CBEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
