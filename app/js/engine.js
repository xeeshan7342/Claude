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

  // Google counts only the default text of keyword insertion: "{KeyWord:Implants in Dubai}" is 17 characters
  const adLen = s => norm(s).replace(/\{\s*keyword\s*:\s*([^}]*)\}/gi, '$1').length;

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
  // "🎯 Campaign 1: AC Repair", "🔑 Keywords": the icon AI tools put in front of a heading or label
  const LEAD_ICON = /^(?:[\p{Extended_Pictographic}\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]|\p{Regional_Indicator})+\s*/u;
  const stripIcon = t => { const s = norm(t).replace(LEAD_ICON, ''); return s || norm(t); };
  const HR = /^(?:[-*_=~]\s*){3,}$/;

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
    let rule = false;
    const push = out.push.bind(out);
    out.push = b => { if (rule) { b.afterRule = true; rule = false; } return push(b); };
    const walk = el => {
      for (const n of Array.from(el.children)) {
        const tag = n.tagName.toLowerCase();
        if (tag === 'hr') { rule = true; continue; }
        if (/^h[1-6]$/.test(tag)) {
          const t = stripIcon(n.textContent);
          if (t) out.push({ t: 'h', level: +tag[1], text: t });
        } else if (tag === 'p') {
          const t = norm(n.textContent);
          if (!t) continue;
          const strong = norm(Array.from(n.querySelectorAll('strong, b')).map(x => x.textContent).join(''));
          const bold = strong.length > 0 && strong.length >= t.length - 1;
          lines(brText(n)).forEach(line => { if (!HR.test(line)) out.push({ t: 'p', text: bold ? stripIcon(line) : line, bold }); });
        } else if (tag === 'ul' || tag === 'ol') {
          for (const li of Array.from(n.children)) {
            if (li.tagName.toLowerCase() !== 'li') continue;
            const c = li.cloneNode(true);
            c.querySelectorAll('ul, ol').forEach(x => x.remove());
            lines(brText(c)).forEach(t => out.push({ t: 'li', text: t }));
            Array.from(li.children).filter(x => /^(ul|ol)$/i.test(x.tagName)).forEach(x => walk({ children: [x] }));
          }
        } else if (tag === 'table') {
          // expand merged cells: a cell merged down three rows repeats in each, so later columns never shift
          const grid = [];
          Array.from(n.querySelectorAll('tr')).forEach((tr, ri) => {
            const row = grid[ri] = grid[ri] || [];
            let ci = 0;
            Array.from(tr.children).filter(c => /^t[dh]$/i.test(c.tagName)).forEach(c => {
              while (row[ci] !== undefined) ci++;
              const text = cellText(c);
              const rs = Math.max(1, Math.min(50, +c.getAttribute('rowspan') || 1));
              const cs = Math.max(1, Math.min(50, +c.getAttribute('colspan') || 1));
              for (let r = 0; r < rs; r++) {
                const target = grid[ri + r] = grid[ri + r] || [];
                for (let k = 0; k < cs; k++) target[ci + k] = (k === 0) ? text : '';
              }
              ci += cs;
            });
          });
          const rows = grid.map(r => Array.from(r, x => x === undefined ? '' : x)).filter(r => r.some(Boolean));
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

  // A line that names a section or a campaign / ad group rather than being an item
  const isLabelish = t => /:$/.test(t) || !!sectionLabel(t) || AG_NUM.test(t) || CAMP_NUM.test(t) || /^(?:campaign|ad ?group)\b/i.test(t);

  function textToBlocks(txt) {
    const out = [];
    const lines = String(txt).replace(/^﻿/, '').split(/\r?\n/);
    let table = null, rule = false, gap = false;
    const push = out.push.bind(out);
    out.push = b => { if (rule) { b.afterRule = true; rule = false; } if (gap) { b.gapBefore = true; gap = false; } return push(b); };
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
      if (!line) { gap = true; continue; }
      if (HR.test(line)) { rule = true; continue; }
      if (/^#{1,6}\s/.test(line)) {
        const lv = line.match(/^#+/)[0].length;
        out.push({ t: 'h', level: lv, text: stripIcon(line.replace(/^#+/, '').replace(/\*\*|__/g, '')) });
        continue;
      }
      const bold = /^(?:\*\*|__).+(?:\*\*|__):?$/.test(line) || /^(?:\*\*|__)[^*_]+(?:\*\*|__)\s*$/.test(line);
      line = norm(line.replace(/\*\*|__/g, ''));
      const bullet = line.match(BULLET);
      // an icon in front of a bold line or a label is decoration, not a bullet
      const iconOnly = bullet && !/^[-*•◦▪●○·▸►→–—✓✔☐☑\d]/.test(line);
      if (bullet && iconOnly && (bold || isLabelish(norm(bullet[1])))) { out.push({ t: 'p', text: stripIcon(line), bold }); continue; }
      if (bullet) { if (norm(bullet[1]) && !HR.test(norm(bullet[1]))) out.push({ t: 'li', text: norm(bullet[1]) }); continue; }
      out.push({ t: 'p', text: stripIcon(line), bold });
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
    ['keywords', true, /^(?:(?:target|targeted|targeting|core|primary|main|seed|suggested|recommended|positive|ad ?group|campaign|final|proposed|exact|phrase|broad|match|search|initial|starter|top|high intent|long tail|longtail|branded|brand|generic|competitor|service|services|product|location|local|secondary|additional|more|sample|example)\s+)*(?:key ?words?|key ?phrases?|kws?|search terms?|search queries|keyword (?:list|ideas|set|themes?|groups?))(?:\s+(?:list|lists|ideas|set|themes?|to target))*$/],
    ['headlines', true, /^(?:(?:rsa|responsive search ads?|search ads?|ads?|ad copy|copy|suggested|recommended|final|proposed|core|pinned|optional|additional|extra|more|sample|example|google)\s+)*(?:headlines?|titles?|headline (?:options|variations|ideas|variants|copy|text))(?:\s+(?:options|variations|ideas|variants|copy|list|text))*$/],
    ['descriptions', true, /^(?:(?:rsa|responsive search ads?|search ads?|ads?|ad copy|copy|suggested|recommended|final|proposed|core|optional|additional|extra|more|sample|example|google)\s+)*(?:descriptions?|description lines?|descs?|body copy|body text|ad text|description (?:options|variations|ideas|variants|copy|text))(?:\s+(?:options|variations|ideas|variants|copy|list|text))*$/],
    ['adcopy', false, /^(?:(?:the|our|suggested|recommended|final|proposed|sample|example)\s+)*(?:rsas?|responsive search ads?|search ads?|ad copy|ads|ad|ad creatives?|creatives?|text ads?|ad variations?|ad texts?|ad copies)(?:\s+(?:copy|set|sets|variations?|options|version|versions|text|a|b|c))*$/],
    // asset types are never keywords or ad text, so they end a list even as a plain line
    ['other', true, /^(?:(?:ad|campaign|account|recommended|suggested|optional|additional)\s+)*(?:level\s+)?(?:sitelinks?|site links?|sitelink (?:extensions?|assets?)|callouts?|callout (?:extensions?|assets?|text)|structured snippets?|ad (?:extensions?|assets)|image (?:extensions?|assets?)|call (?:extensions?|assets?)|promotion (?:extensions?|assets?)|price (?:extensions?|assets?)|lead form (?:extensions?|assets?)|location (?:extensions?|assets?)|app (?:extensions?|assets?))$/],
    ['other', false, /^(?:(?:ad|campaign|account|recommended|suggested|optional|additional|key|important|general|final|pro|quick|bonus|expert|extra|helpful|our|my)\s+)*(?:level\s+)?(?:sitelinks?|site links?|sitelink (?:extensions?|assets?)|callouts?|callout (?:extensions?|assets?|text)|structured snippets?|snippets?|extensions?|assets?|ad (?:extensions?|assets)|images?|image (?:extensions?|assets?)|logos?|business (?:name|logo)|call (?:extensions?|assets?)|phone (?:number|extensions?|assets?)|promotions?|promotion (?:extensions?|assets?)|price (?:extensions?|assets?)|prices|lead forms?|location (?:extensions?|assets?)|app (?:extensions?|assets?)|notes?|strategy|rationale|reasoning|why|tips?|recommendations?|next steps?|checklist|to ?do|todo|landing pages? (?:notes|recommendations|suggestions|requirements|tips)|audiences?|audience (?:targeting|signals|segments|lists)|demographics?|ad schedul(?:e|ing)|schedul(?:e|ing)|day ?parting|conversion (?:tracking|actions?|goals?|setup)|conversions|kpis?|goals?|objectives?|measurement|tracking|reporting|budget (?:plan|split|allocation|breakdown|notes|rationale)|bid (?:adjustments|modifiers)|devices?|device (?:targeting|bid adjustments)|overview|summary|scope|assumptions|compliance|policy(?: notes)?|before you launch|launch checklist|optimi[sz]ation(?: plan| tips)?|timeline|appendix|references?|faqs?|questions|contents|table of contents|introduction|background|competitors?|competitor analysis|keyword research|research|analysis|insights|structure|account structure|campaign structure|naming conventions?|glossary)$/],
    ['settings', false, /^(?:(?:google|search|ppc|sem|campaign|campaigns|account|ad ?group|global|default|general|key|basic|initial|recommended)\s+)*(?:level\s+)?(?:settings|setup|set up|configuration|config|targeting|targeting settings|bidding|bid strategy|bidding strategy|budgets?|daily budget|monthly budget|locations?|location targeting|geo ?targeting|geos?|languages?|networks?|details|parameters|final urls?|landing pages?|landing page urls?|urls?)$/]
  ];
  const ROLE_SECTIONS = new Set(['keywords', 'negatives', 'headlines', 'descriptions', 'adcopy', 'other', 'settings']);

  function sectionLabel(text) {
    const one = lk => { for (const [sec, strong, rx] of SECTION_PATTERNS) if (rx.test(lk)) return { sec, weak: !strong }; return null; };
    const tryOne = label => {
      const lk = labelKey(label);
      if (!lk || lk.split(' ').length > 9) return null;
      const hit = one(lk);
      if (hit) return hit;
      // "Sitelinks & Callouts", "Notes and Next Steps": every part is a section to skip
      const parts = lk.split(/\s+and\s+/);
      if (parts.length > 1 && parts.every(x => { const h = one(x); return h && h.sec === 'other'; })) return { sec: 'other', weak: true };
      return null;
    };
    const whole = /[:：]\s*\S/.test(norm(text)) ? null : tryOne(text);
    if (whole) return Object.assign(whole, { inline: '' });
    const m = norm(text).match(/^(.{2,60}?)\s*(:|\s[-–—]\s|[–—])\s*(.+)$/);
    if (m) { const s = tryOne(m[1]); if (s) return Object.assign(s, { inline: norm(m[3]), label: m[1], sep: m[2].trim() === ':' ? 'colon' : 'dash' }); }
    return null;
  }

  const settingsHint = lk => /budget|spend/.test(lk) ? 'budget' : /locat|geo|countr|market|region|cit(?:y|ies)|area/.test(lk) ? 'locations'
    : /languag/.test(lk) ? 'languages' : /bid/.test(lk) ? 'bidStrategy' : /url|landing|website|site|domain/.test(lk) ? 'finalUrl'
    : /network|partner/.test(lk) ? 'networks' : null;

  const AG_NUM = /^(?:ad[\s-]*group|adgroup)\s*#?\s*(\d{1,3}(?:\.\d{1,3})*[a-z]?)\s*(?:[-:.)|–—]\s*|\s+)(.+)$/i;
  const AG_ABBR = /^AG\s*#?\s*(\d{1,3}(?:\.\d{1,3})*[a-z]?)?\s*[-:.)|–—]\s*(.+)$/;
  const AG_NAMED = /^(?:ad[\s-]*group|adgroup)(?:\s*name)?\s*(?::|\||\s[-–—]\s|[–—])\s*(.+)$/i;
  const AG_ONLY = /^(?:ad[\s-]*group|adgroup)\s*#?\s*(\d{1,3}(?:\.\d{1,3})*[a-z]?)\s*[:.]?$/i;
  const AG_LIST = /^ad[\s-]*groups\s*(?:\([^)]*\))?\s*(?::|\s[-–—]\s)\s*(.+)$/i;
  const CAMP_NUM = /^(?:google\s+(?:ads\s+)?)?(?:search\s+)?campaign\s*#?\s*(?:\d{1,3}(?:\.\d{1,3})*\s*(?:[-:.)|–—]\s*|\s+)|[a-z]\s*(?:[:.)|–—]|\s-\s)\s*)(.+)$/i;
  const CAMP_NAMED = /^(?:google\s+(?:ads\s+)?)?(?:search\s+)?campaign(?:\s*name)?\s*(?::|\||\s[-–—]\s|[–—])\s*(.+)$/i;
  const NUMBERED = /^(headline|description|desc)\s*#?\s*(\d{1,2})\s*(?:\([^)]*\))?\s*(?:[:.)\-–—|=]\s*|\t)(.+)$/i;
  const NUMBERED_HD = /^([hd])\s*(\d{1,2})\s*(?:\([^)]*\))?\s*(?:[:.)|=]|\s[-–—]\s|[–—]|\t)\s*(.+)$/i;
  const NUMBERED_ONLY = /^(headline|description|desc)\s*#?\s*(\d{1,2})\s*(?:\([^)]*\))?\s*:?$/i;

  const STRIP_NUM = /^\s*(?:\d{1,2}[.)]|[-*•◦▪●○·])\s+/;
  const TRAIL_COUNT = /\s*(?:[([]\s*\d{1,3}\s*(?:\/\s*\d{2,3}\s*)?(?:chars?|characters)?\s*[)\]]|[|–—]\s*\d{1,3}\s*(?:chars?|characters)?|\s-\s\d{1,3}\s*(?:chars?|characters)?|\d{1,3}\s*(?:chars?|characters)|\s\d{1,3}\s*\/\s*(?:15|30|90))\s*$/i;
  const PIN_NOTE = /\s*[([](?:[^)\]]*\b(?:pin(?:ned)?|position|pos\.?)\b[^)\]]*)[)\]]\s*$|\s*[([]\s*(?:p|pos|pin)\s*#?\s*[1-3]\s*[)\]]\s*$|\s+[-–—]\s+pin(?:ned)?\b.*$/i;
  const HEADER_CELL = /^(?:#|no\.?|sr\.?|s\.?\s?no\.?|chars?|characters|char(?:acter)? count|count|length|len|status|notes?|pin(?:ned)?|position|match(?: type)?)$/i;

  const COPY_SUFFIX = /\s*(?:[-–—:|]\s*|\(\s*)(?:rsas?|responsive search ads?|ad copy|ads?|ad text|copy|creatives?)\s*\)?\s*$/i;
  function cleanName(s) {
    return norm(s).replace(/\*\*|__/g, '').replace(/^#+\s*/, '').replace(COPY_SUFFIX, '')
      .replace(/^(?:\d{1,2}(?:\.\d{1,2}){1,3}\.?|\d{1,2}[.)]|[-*•◦▪●○·])\s+/, '')
      .replace(/^(?:ad[\s-]*group|adgroup|ag)\s*#?\s*\d{1,3}(?:\.\d{1,3})*[a-z]?\s*(?:[-:.)|–—]\s*|\s+)/i, '')
      .replace(/\s*\((?:\d+\s*)?(?:keywords?|kws?|ad groups?|headlines?)?[^)]*\)\s*$/i, '')
      .replace(/[:：]\s*$/, '')
      .replace(/^["']|["']$/g, '').trim();
  }
  function tidyCampaign(s) {
    return norm(s).replace(/^([A-Z0-9]{1,2})\s*[-–—.:)]\s*/, '$1 - ');
  }
  const cleanCampaignName = s => tidyCampaign(cleanName(stripOutline(s).replace(/^(?:google\s+(?:ads\s+)?)?(?:search\s+)?campaign\s*#?\s*(?:\d{1,3}(?:\.\d{1,3})*)?\s*[-:.)|–—]\s*/i, '')));

  const isNoteLine = t => /^\(.*\)$|^\[.*\]$/.test(t)
    || /^(?:note|notes|tip|tips|important|reminder|optional|n\.?b\.?|todo|tbd|example|e\.g\.|eg)\b\s*[:\-–—]/i.test(t)
    || /^(?:pin|pinned)\b/i.test(t)
    || /\b(?:character|char)s?\s*(?:limit|count|max)/i.test(t)
    || /\bposition\s*\d\b/i.test(t)
    || /:\s*$/.test(t)
    || /\b(?:max(?:imum)?|min(?:imum)?|limit|up to|at least)\s*(?:of\s*)?\d+\s*(?:chars?|characters|headlines|descriptions|keywords)\b/i.test(t);

  // "12 of 15", "4/4", "max 15", "15 headlines", "(30 chars)": a count, not a name or ad text
  const isCountNote = t => /\d/.test(t) && !norm(t).toLowerCase()
    .replace(/\b(?:of|out|headlines?|descriptions?|keywords?|chars?|characters?|max(?:imum)?|min(?:imum)?|up|to|total|used|lines?|written|provided|each|per|ad)\b/g, ' ')
    .replace(/[\d\s()\[\]\/.,:;+~\-–—]+/g, '');
  const isNameLike = t => {
    const s = norm(t);
    return s.length >= 3 && s.length <= 70 && s.split(' ').length <= 9 && !/[.!?;,]$/.test(s) && !/https?:|www\./i.test(s) && !/:\s*\S/.test(s);
  };

  /* ---------- settings ---------- */

  const COUNTRIES = [
    ['United States', '2840', ['us', 'usa', 'u s', 'u s a', 'united states', 'united states of america', 'america', 'the us', 'the usa', 'the united states']],
    ['Canada', '2124', ['ca', 'can', 'canada']],
    ['United Kingdom', '2826', ['uk', 'u k', 'gb', 'gbr', 'united kingdom', 'great britain', 'britain', 'the uk', 'the united kingdom', 'united kingdom of great britain northern ireland']],
    ['Australia', '2036', ['au', 'aus', 'australia']],
    ['New Zealand', '2554', ['nz', 'new zealand']],
    ['Ireland', '2372', ['ie', 'ireland', 'republic of ireland']],
    ['United Arab Emirates', '2784', ['uae', 'u a e', 'ae', 'united arab emirates', 'emirates', 'the uae', 'the united arab emirates']],
    ['Saudi Arabia', '2682', ['ksa', 'saudi', 'saudi arabia', 'kingdom of saudi arabia']],
    ['Qatar', '2634', ['qa', 'qatar', 'state of qatar']],
    ['Kuwait', '2414', ['kw', 'kuwait', 'state of kuwait']],
    ['Bahrain', '2048', ['bh', 'bahrain', 'kingdom of bahrain']],
    ['Oman', '2512', ['om', 'oman', 'sultanate of oman']],
    ['Jordan', '2400', ['jordan', 'hashemite kingdom of jordan']],
    ['Lebanon', '2422', ['lebanon', 'lebanese republic']],
    ['Egypt', '2818', ['eg', 'egypt', 'arab republic of egypt']],
    ['Morocco', '2504', ['morocco', 'kingdom of morocco']],
    ['Turkey', '2792', ['tr', 'turkey', 'turkiye', 'türkiye', 'republic of türkiye', 'republic of turkiye']],
    ['Israel', '2376', ['israel', 'state of israel']],
    ['Pakistan', '2586', ['pk', 'pakistan', 'islamic republic of pakistan']],
    ['India', '2356', ['india', 'bharat', 'republic of india']],
    ['Bangladesh', '2050', ['bd', 'bangladesh', 'people s republic of bangladesh']],
    ['Sri Lanka', '2144', ['lk', 'sri lanka', 'democratic socialist republic of sri lanka']],
    ['Nepal', '2524', ['nepal', 'federal democratic republic of nepal']],
    ['Maldives', '2462', ['maldives', 'republic of maldives']],
    ['Singapore', '2702', ['sg', 'singapore', 'republic of singapore']],
    ['Malaysia', '2458', ['malaysia']],
    ['Indonesia', '2360', ['indonesia', 'republic of indonesia']],
    ['Philippines', '2608', ['ph', 'philippines', 'the philippines', 'republic of the philippines']],
    ['Thailand', '2764', ['th', 'thailand', 'kingdom of thailand']],
    ['Vietnam', '2704', ['vn', 'vietnam', 'viet nam', 'socialist republic of viet nam']],
    ['Hong Kong', '2344', ['hk', 'hong kong', 'hong kong special administrative region of china', 'hong kong sar']],
    ['Taiwan', '2158', ['tw', 'taiwan', 'taiwan province of china']],
    ['Japan', '2392', ['jp', 'japan']],
    ['South Korea', '2410', ['kr', 'korea', 'south korea', 'republic of korea', 'korea republic of', 'rok']],
    ['China', '2156', ['cn', 'china', 'people s republic of china']],
    ['Germany', '2276', ['de', 'germany', 'deutschland', 'federal republic of germany']],
    ['France', '2250', ['fr', 'france', 'french republic']],
    ['Spain', '2724', ['spain', 'españa', 'espana', 'kingdom of spain']],
    ['Italy', '2380', ['italy', 'italia', 'italian republic']],
    ['Portugal', '2620', ['pt', 'portugal', 'portuguese republic']],
    ['Netherlands', '2528', ['nl', 'netherlands', 'the netherlands', 'holland', 'kingdom of the netherlands']],
    ['Belgium', '2056', ['belgium', 'kingdom of belgium']],
    ['Luxembourg', '2442', ['luxembourg', 'grand duchy of luxembourg']],
    ['Switzerland', '2756', ['ch', 'switzerland', 'swiss confederation']],
    ['Austria', '2040', ['austria', 'republic of austria']],
    ['Sweden', '2752', ['se', 'sweden', 'kingdom of sweden']],
    ['Norway', '2578', ['norway', 'kingdom of norway']],
    ['Denmark', '2208', ['dk', 'denmark', 'kingdom of denmark']],
    ['Finland', '2246', ['fi', 'finland', 'republic of finland']],
    ['Iceland', '2352', ['iceland', 'republic of iceland']],
    ['Poland', '2616', ['pl', 'poland', 'republic of poland']],
    ['Czechia', '2203', ['cz', 'czechia', 'czech republic']],
    ['Slovakia', '2703', ['slovakia', 'slovak republic']],
    ['Hungary', '2348', ['hu', 'hungary']],
    ['Romania', '2642', ['ro', 'romania']],
    ['Bulgaria', '2100', ['bg', 'bulgaria', 'republic of bulgaria']],
    ['Greece', '2300', ['gr', 'greece', 'hellenic republic']],
    ['Croatia', '2191', ['hr', 'croatia', 'republic of croatia']],
    ['Serbia', '2688', ['rs', 'serbia', 'republic of serbia']],
    ['Slovenia', '2705', ['slovenia', 'republic of slovenia']],
    ['Estonia', '2233', ['estonia', 'republic of estonia']],
    ['Cyprus', '2196', ['cy', 'cyprus', 'republic of cyprus']],
    ['Malta', '2470', ['mt', 'malta', 'republic of malta']],
    ['Ukraine', '2804', ['ua', 'ukraine']],
    ['South Africa', '2710', ['za', 'rsa', 'south africa', 'republic of south africa']],
    ['Nigeria', '2566', ['ng', 'nigeria', 'federal republic of nigeria']],
    ['Kenya', '2404', ['ke', 'kenya', 'republic of kenya']],
    ['Ghana', '2288', ['gh', 'ghana', 'republic of ghana']],
    ['Mexico', '2484', ['mx', 'mexico', 'united mexican states']],
    ['Brazil', '2076', ['br', 'brazil', 'brasil', 'federative republic of brazil']],
    ['Argentina', '2032', ['ar', 'argentina', 'argentine republic']],
    ['Chile', '2152', ['cl', 'chile', 'republic of chile']],
    ['Colombia', '2170', ['co', 'colombia', 'republic of colombia']],
    ['Peru', '2604', ['pe', 'peru', 'republic of peru']],
    ['Afghanistan', '2004', ['afghanistan', 'islamic republic of afghanistan']],
    ['Aland Islands', '2248', ['aland islands', 'åland islands']],
    ['Albania', '2008', ['albania', 'republic of albania']],
    ['Algeria', '2012', ['algeria', 'people s democratic republic of algeria']],
    ['American Samoa', '2016', ['american samoa']],
    ['Andorra', '2020', ['andorra', 'principality of andorra']],
    ['Angola', '2024', ['angola', 'republic of angola']],
    ['Anguilla', '2660', ['anguilla']],
    ['Antarctica', '2010', ['antarctica']],
    ['Antigua and Barbuda', '2028', ['antigua barbuda']],
    ['Armenia', '2051', ['armenia', 'republic of armenia']],
    ['Aruba', '2533', ['aruba']],
    ['Azerbaijan', '2031', ['azerbaijan', 'republic of azerbaijan']],
    ['Barbados', '2052', ['barbados']],
    ['Belarus', '2112', ['belarus', 'republic of belarus']],
    ['Belize', '2084', ['belize']],
    ['Benin', '2204', ['benin', 'republic of benin']],
    ['Bermuda', '2060', ['bermuda']],
    ['Bhutan', '2064', ['bhutan', 'kingdom of bhutan']],
    ['Bolivia', '2068', ['bolivia', 'bolivia plurinational state of', 'plurinational state of bolivia']],
    ['Bosnia and Herzegovina', '2070', ['bosnia herzegovina', 'republic of bosnia herzegovina', 'bosnia']],
    ['Botswana', '2072', ['botswana', 'republic of botswana']],
    ['Bouvet Island', '2074', ['bouvet island']],
    ['British Indian Ocean Territory', '2086', ['british indian ocean territory']],
    ['British Virgin Islands', '2092', ['british virgin islands', 'virgin islands british']],
    ['Brunei', '2096', ['brunei', 'brunei darussalam']],
    ['Burkina Faso', '2854', ['burkina faso']],
    ['Burundi', '2108', ['burundi', 'republic of burundi']],
    ['Cambodia', '2116', ['cambodia', 'kingdom of cambodia']],
    ['Cameroon', '2120', ['cameroon', 'republic of cameroon']],
    ['Cape Verde', '2132', ['cape verde', 'cabo verde', 'republic of cabo verde']],
    ['Caribbean Netherlands', '2535', ['caribbean netherlands', 'bonaire sint eustatius saba']],
    ['Cayman Islands', '2136', ['cayman islands']],
    ['Central African Republic', '2140', ['central african republic']],
    ['Chad', '2148', ['chad', 'republic of chad']],
    ['Christmas Island', '2162', ['christmas island']],
    ['Cocos (Keeling) Islands', '2166', ['cocos keeling islands']],
    ['Comoros', '2174', ['comoros', 'union of the comoros']],
    ['Cook Islands', '2184', ['cook islands']],
    ['Costa Rica', '2188', ['costa rica', 'republic of costa rica']],
    ["Cote d'Ivoire", '2384', ['cote d ivoire', 'côte d ivoire', 'republic of côte d ivoire', 'republic of cote d ivoire', 'ivory coast']],
    ['Cuba', '2192', ['cuba', 'republic of cuba']],
    ['Curacao', '2531', ['curacao', 'curaçao']],
    ['Democratic Republic of the Congo', '2180', ['democratic republic of the congo', 'congo the democratic republic of the', 'dr congo', 'drc', 'congo kinshasa']],
    ['Djibouti', '2262', ['djibouti', 'republic of djibouti']],
    ['Dominica', '2212', ['dominica', 'commonwealth of dominica']],
    ['Dominican Republic', '2214', ['dominican republic']],
    ['Ecuador', '2218', ['ecuador', 'republic of ecuador']],
    ['El Salvador', '2222', ['el salvador', 'republic of el salvador']],
    ['Equatorial Guinea', '2226', ['equatorial guinea', 'republic of equatorial guinea']],
    ['Eritrea', '2232', ['eritrea', 'the state of eritrea']],
    ['Eswatini', '2748', ['eswatini', 'kingdom of eswatini', 'swaziland']],
    ['Ethiopia', '2231', ['ethiopia', 'federal democratic republic of ethiopia']],
    ['Falkland Islands (Islas Malvinas)', '2238', ['falkland islands islas malvinas', 'falkland islands malvinas', 'falkland islands', 'falklands']],
    ['Faroe Islands', '2234', ['faroe islands']],
    ['Fiji', '2242', ['fiji', 'republic of fiji']],
    ['French Guiana', '2254', ['french guiana']],
    ['French Polynesia', '2258', ['french polynesia']],
    ['French Southern and Antarctic Lands', '2260', ['french southern antarctic lands', 'french southern territories']],
    ['Gabon', '2266', ['gabon', 'gabonese republic']],
    ['Georgia', '2268', ['georgia']],
    ['Gibraltar', '2292', ['gibraltar']],
    ['Greenland', '2304', ['greenland']],
    ['Grenada', '2308', ['grenada']],
    ['Guadeloupe', '2312', ['guadeloupe']],
    ['Guam', '2316', ['guam']],
    ['Guatemala', '2320', ['guatemala', 'republic of guatemala']],
    ['Guernsey', '2831', ['guernsey']],
    ['Guinea', '2324', ['guinea', 'republic of guinea']],
    ['Guinea-Bissau', '2624', ['guinea bissau', 'republic of guinea bissau']],
    ['Guyana', '2328', ['guyana', 'republic of guyana']],
    ['Haiti', '2332', ['haiti', 'republic of haiti']],
    ['Heard Island and McDonald Islands', '2334', ['heard island mcdonald islands']],
    ['Honduras', '2340', ['honduras', 'republic of honduras']],
    ['Iran', '2364', ['iran', 'iran islamic republic of', 'islamic republic of iran']],
    ['Iraq', '2368', ['iraq', 'republic of iraq']],
    ['Isle of Man', '2833', ['isle of man']],
    ['Jamaica', '2388', ['jamaica']],
    ['Jersey', '2832', ['jersey']],
    ['Kazakhstan', '2398', ['kazakhstan', 'republic of kazakhstan']],
    ['Kiribati', '2296', ['kiribati', 'republic of kiribati']],
    ['Kyrgyzstan', '2417', ['kyrgyzstan', 'kyrgyz republic']],
    ['Laos', '2418', ['laos', 'lao people s democratic republic', 'lao pdr']],
    ['Latvia', '2428', ['latvia', 'republic of latvia']],
    ['Lesotho', '2426', ['lesotho', 'kingdom of lesotho']],
    ['Liberia', '2430', ['liberia', 'republic of liberia']],
    ['Libya', '2434', ['libya']],
    ['Liechtenstein', '2438', ['liechtenstein', 'principality of liechtenstein']],
    ['Lithuania', '2440', ['lithuania', 'republic of lithuania']],
    ['Macao', '2446', ['macao', 'macao special administrative region of china', 'macau', 'macao sar']],
    ['Madagascar', '2450', ['madagascar', 'republic of madagascar']],
    ['Malawi', '2454', ['malawi', 'republic of malawi']],
    ['Mali', '2466', ['mali', 'republic of mali']],
    ['Marshall Islands', '2584', ['marshall islands', 'republic of the marshall islands']],
    ['Martinique', '2474', ['martinique']],
    ['Mauritania', '2478', ['mauritania', 'islamic republic of mauritania']],
    ['Mauritius', '2480', ['mauritius', 'republic of mauritius']],
    ['Mayotte', '2175', ['mayotte']],
    ['Micronesia', '2583', ['micronesia', 'micronesia federated states of', 'federated states of micronesia']],
    ['Moldova', '2498', ['moldova', 'moldova republic of', 'republic of moldova']],
    ['Monaco', '2492', ['monaco', 'principality of monaco']],
    ['Mongolia', '2496', ['mongolia']],
    ['Montenegro', '2499', ['montenegro']],
    ['Montserrat', '2500', ['montserrat']],
    ['Mozambique', '2508', ['mozambique', 'republic of mozambique']],
    ['Myanmar (Burma)', '2104', ['myanmar burma', 'myanmar', 'republic of myanmar', 'burma']],
    ['Namibia', '2516', ['namibia', 'republic of namibia']],
    ['Nauru', '2520', ['nauru', 'republic of nauru']],
    ['New Caledonia', '2540', ['new caledonia']],
    ['Nicaragua', '2558', ['nicaragua', 'republic of nicaragua']],
    ['Niger', '2562', ['niger', 'republic of the niger']],
    ['Niue', '2570', ['niue']],
    ['Norfolk Island', '2574', ['norfolk island']],
    ['North Korea', '2408', ['north korea', 'korea democratic people s republic of', 'democratic people s republic of korea', 'dprk']],
    ['North Macedonia', '2807', ['north macedonia', 'republic of north macedonia', 'macedonia']],
    ['Northern Mariana Islands', '2580', ['northern mariana islands', 'commonwealth of the northern mariana islands']],
    ['Palau', '2585', ['palau', 'republic of palau']],
    ['Palestine', '2275', ['palestine', 'palestine state of', 'the state of palestine', 'palestinian territories', 'state of palestine']],
    ['Panama', '2591', ['panama', 'republic of panama']],
    ['Papua New Guinea', '2598', ['papua new guinea', 'independent state of papua new guinea']],
    ['Paraguay', '2600', ['paraguay', 'republic of paraguay']],
    ['Pitcairn Islands', '2612', ['pitcairn islands', 'pitcairn']],
    ['Puerto Rico', '2630', ['puerto rico']],
    ['Republic of the Congo', '2178', ['republic of the congo', 'congo', 'congo brazzaville']],
    ['Reunion', '2638', ['reunion', 'réunion']],
    ['Russia', '2643', ['russia', 'russian federation']],
    ['Rwanda', '2646', ['rwanda', 'rwandese republic']],
    ['Saint Barthelemy', '2652', ['saint barthelemy', 'saint barthélemy', 'st barts', 'st barthelemy']],
    ['Saint Helena, Ascension and Tristan da Cunha', '2654', ['saint helena ascension tristan da cunha', 'saint helena', 'st helena']],
    ['Saint Kitts and Nevis', '2659', ['saint kitts nevis', 'st kitts nevis', 'st kitts']],
    ['Saint Lucia', '2662', ['saint lucia', 'st lucia']],
    ['Saint Martin', '2663', ['saint martin', 'saint martin french part', 'st martin']],
    ['Saint Pierre and Miquelon', '2666', ['saint pierre miquelon', 'st pierre miquelon']],
    ['Saint Vincent and the Grenadines', '2670', ['saint vincent the grenadines', 'st vincent the grenadines', 'st vincent']],
    ['Samoa', '2882', ['samoa', 'independent state of samoa']],
    ['San Marino', '2674', ['san marino', 'republic of san marino']],
    ['Sao Tome and Principe', '2678', ['sao tome principe', 'democratic republic of sao tome principe']],
    ['Senegal', '2686', ['senegal', 'republic of senegal']],
    ['Seychelles', '2690', ['seychelles', 'republic of seychelles']],
    ['Sierra Leone', '2694', ['sierra leone', 'republic of sierra leone']],
    ['Sint Maarten', '2534', ['sint maarten', 'sint maarten dutch part']],
    ['Solomon Islands', '2090', ['solomon islands']],
    ['Somalia', '2706', ['somalia', 'federal republic of somalia']],
    ['South Georgia and the South Sandwich Islands', '2239', ['south georgia the south sandwich islands']],
    ['South Sudan', '2728', ['south sudan', 'republic of south sudan']],
    ['Sudan', '2729', ['sudan', 'republic of the sudan']],
    ['Suriname', '2740', ['suriname', 'republic of suriname']],
    ['Svalbard and Jan Mayen', '2744', ['svalbard jan mayen']],
    ['Syria', '2760', ['syria', 'syrian arab republic']],
    ['Tajikistan', '2762', ['tajikistan', 'republic of tajikistan']],
    ['Tanzania', '2834', ['tanzania', 'tanzania united republic of', 'united republic of tanzania']],
    ['The Bahamas', '2044', ['the bahamas', 'bahamas', 'commonwealth of the bahamas']],
    ['The Gambia', '2270', ['the gambia', 'gambia', 'republic of the gambia']],
    ['Timor-Leste', '2626', ['timor leste', 'democratic republic of timor leste', 'east timor']],
    ['Togo', '2768', ['togo', 'togolese republic']],
    ['Tokelau', '2772', ['tokelau']],
    ['Tonga', '2776', ['tonga', 'kingdom of tonga']],
    ['Trinidad and Tobago', '2780', ['trinidad tobago', 'republic of trinidad tobago', 'trinidad']],
    ['Tunisia', '2788', ['tunisia', 'republic of tunisia']],
    ['Turkmenistan', '2795', ['turkmenistan']],
    ['Turks and Caicos Islands', '2796', ['turks caicos islands']],
    ['Tuvalu', '2798', ['tuvalu']],
    ['U.S. Virgin Islands', '2850', ['u s virgin islands', 'virgin islands u s', 'virgin islands of the united states', 'us virgin islands']],
    ['Uganda', '2800', ['uganda', 'republic of uganda']],
    ['United States Minor Outlying Islands', '2581', ['united states minor outlying islands']],
    ['Uruguay', '2858', ['uruguay', 'eastern republic of uruguay']],
    ['Uzbekistan', '2860', ['uzbekistan', 'republic of uzbekistan']],
    ['Vanuatu', '2548', ['vanuatu', 'republic of vanuatu']],
    ['Vatican City', '2336', ['vatican city', 'holy see vatican city state', 'vatican', 'holy see']],
    ['Venezuela', '2862', ['venezuela', 'venezuela bolivarian republic of', 'bolivarian republic of venezuela']],
    ['Wallis and Futuna', '2876', ['wallis futuna']],
    ['Western Sahara', '2732', ['western sahara']],
    ['Yemen', '2887', ['yemen', 'republic of yemen']],
    ['Zambia', '2894', ['zambia', 'republic of zambia']],
    ['Zimbabwe', '2716', ['zimbabwe', 'republic of zimbabwe']]
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
    'assam': 'India', 'jharkhand': 'India', 'chhattisgarh': 'India', 'uttarakhand': 'India', 'himachal pradesh': 'India', 'jammu and kashmir': 'India',
    'punjab': 'Pakistan', 'sindh': 'Pakistan', 'khyber pakhtunkhwa': 'Pakistan', 'kpk': 'Pakistan', 'balochistan': 'Pakistan', 'gilgit-baltistan': 'Pakistan', 'islamabad capital territory': 'Pakistan'
  };
  const REGION_CITIES = {
    'london': 'United Kingdom', 'manchester': 'United Kingdom', 'birmingham': 'United Kingdom',
    'riyadh': 'Saudi Arabia', 'jeddah': 'Saudi Arabia', 'dammam': 'Saudi Arabia', 'mecca': 'Saudi Arabia', 'makkah': 'Saudi Arabia', 'doha': 'Qatar', 'muscat': 'Oman', 'manama': 'Bahrain', 'kuwait city': 'Kuwait',
    'delhi': 'India', 'new delhi': 'India', 'mumbai': 'India', 'bangalore': 'India', 'bengaluru': 'India', 'hyderabad': 'India', 'chennai': 'India', 'kolkata': 'India', 'pune': 'India',
    'amritsar': 'India', 'ludhiana': 'India', 'chandigarh': 'India', 'jalandhar': 'India', 'ahmedabad': 'India', 'jaipur': 'India', 'kochi': 'India', 'mysuru': 'India', 'mysore': 'India',
    'karachi': 'Pakistan', 'lahore': 'Pakistan', 'islamabad': 'Pakistan', 'rawalpindi': 'Pakistan', 'faisalabad': 'Pakistan', 'multan': 'Pakistan', 'peshawar': 'Pakistan', 'quetta': 'Pakistan', 'sialkot': 'Pakistan', 'gujranwala': 'Pakistan',
    'sukkur': 'Pakistan', 'bahawalpur': 'Pakistan', 'sargodha': 'Pakistan', 'abbottabad': 'Pakistan',
    // big cities whose name is not shared with a big city elsewhere, so a bare name can take its country
    'medina': 'Saudi Arabia', 'madinah': 'Saudi Arabia', 'al khobar': 'Saudi Arabia', 'khobar': 'Saudi Arabia', 'taif': 'Saudi Arabia',
    'lucknow': 'India', 'surat': 'India', 'indore': 'India', 'bhopal': 'India', 'nagpur': 'India', 'noida': 'India', 'gurgaon': 'India', 'gurugram': 'India',
    'thane': 'India', 'navi mumbai': 'India', 'coimbatore': 'India', 'visakhapatnam': 'India', 'vadodara': 'India', 'patna': 'India', 'kanpur': 'India', 'thiruvananthapuram': 'India',
    'dhaka': 'Bangladesh', 'chittagong': 'Bangladesh', 'chattogram': 'Bangladesh', 'colombo': 'Sri Lanka', 'kandy': 'Sri Lanka', 'kathmandu': 'Nepal', 'pokhara': 'Nepal',
    'leeds': 'United Kingdom', 'liverpool': 'United Kingdom', 'glasgow': 'United Kingdom', 'edinburgh': 'United Kingdom', 'bristol': 'United Kingdom', 'sheffield': 'United Kingdom',
    'newcastle upon tyne': 'United Kingdom', 'nottingham': 'United Kingdom', 'leicester': 'United Kingdom', 'cardiff': 'United Kingdom', 'belfast': 'United Kingdom',
    'southampton': 'United Kingdom', 'coventry': 'United Kingdom', 'bradford': 'United Kingdom', 'salford': 'United Kingdom', 'stockport': 'United Kingdom', 'brighton': 'United Kingdom', 'aberdeen': 'United Kingdom',
    'dublin': 'Ireland', 'cork': 'Ireland', 'galway': 'Ireland',
    'toronto': 'Canada', 'montreal': 'Canada', 'calgary': 'Canada', 'edmonton': 'Canada', 'ottawa': 'Canada', 'mississauga': 'Canada', 'brampton': 'Canada', 'winnipeg': 'Canada', 'quebec city': 'Canada', 'saskatoon': 'Canada', 'vancouver': 'Canada',
    'sydney': 'Australia', 'melbourne': 'Australia', 'perth': 'Australia', 'brisbane': 'Australia', 'adelaide': 'Australia', 'canberra': 'Australia', 'gold coast': 'Australia', 'hobart': 'Australia',
    'auckland': 'New Zealand', 'wellington': 'New Zealand', 'christchurch': 'New Zealand',
    'kuala lumpur': 'Malaysia', 'johor bahru': 'Malaysia', 'jakarta': 'Indonesia', 'surabaya': 'Indonesia', 'bandung': 'Indonesia', 'manila': 'Philippines', 'quezon city': 'Philippines', 'makati': 'Philippines', 'cebu city': 'Philippines',
    'bangkok': 'Thailand', 'phuket': 'Thailand', 'chiang mai': 'Thailand', 'hanoi': 'Vietnam', 'ho chi minh city': 'Vietnam', 'saigon': 'Vietnam',
    'tokyo': 'Japan', 'osaka': 'Japan', 'yokohama': 'Japan', 'kyoto': 'Japan', 'seoul': 'South Korea', 'busan': 'South Korea', 'incheon': 'South Korea',
    'beijing': 'China', 'shanghai': 'China', 'shenzhen': 'China', 'guangzhou': 'China',
    'lagos': 'Nigeria', 'abuja': 'Nigeria', 'nairobi': 'Kenya', 'mombasa': 'Kenya', 'accra': 'Ghana', 'kumasi': 'Ghana', 'johannesburg': 'South Africa', 'cape town': 'South Africa', 'durban': 'South Africa', 'pretoria': 'South Africa',
    'casablanca': 'Morocco', 'rabat': 'Morocco', 'marrakech': 'Morocco', 'tunis': 'Tunisia', 'algiers': 'Algeria', 'addis ababa': 'Ethiopia', 'kampala': 'Uganda', 'dar es salaam': 'Tanzania', 'kigali': 'Rwanda', 'cairo': 'Egypt', 'giza': 'Egypt',
    'amman': 'Jordan', 'beirut': 'Lebanon', 'baghdad': 'Iraq', 'erbil': 'Iraq', 'tehran': 'Iran', 'istanbul': 'Turkey', 'ankara': 'Turkey', 'izmir': 'Turkey', 'tel aviv': 'Israel',
    'paris': 'France', 'marseille': 'France', 'lyon': 'France', 'berlin': 'Germany', 'munich': 'Germany', 'hamburg': 'Germany', 'frankfurt': 'Germany', 'cologne': 'Germany',
    'madrid': 'Spain', 'barcelona': 'Spain', 'seville': 'Spain', 'rome': 'Italy', 'milan': 'Italy', 'naples': 'Italy', 'turin': 'Italy',
    'amsterdam': 'Netherlands', 'rotterdam': 'Netherlands', 'the hague': 'Netherlands', 'brussels': 'Belgium', 'antwerp': 'Belgium', 'vienna': 'Austria', 'zurich': 'Switzerland', 'geneva': 'Switzerland',
    'lisbon': 'Portugal', 'porto': 'Portugal', 'stockholm': 'Sweden', 'oslo': 'Norway', 'copenhagen': 'Denmark', 'helsinki': 'Finland', 'warsaw': 'Poland', 'krakow': 'Poland',
    'prague': 'Czechia', 'budapest': 'Hungary', 'bucharest': 'Romania', 'athens': 'Greece',
    'mexico city': 'Mexico', 'guadalajara': 'Mexico', 'monterrey': 'Mexico', 'sao paulo': 'Brazil', 'rio de janeiro': 'Brazil', 'brasilia': 'Brazil', 'buenos aires': 'Argentina',
    'bogota': 'Colombia', 'medellin': 'Colombia', 'lima': 'Peru', 'quito': 'Ecuador', 'caracas': 'Venezuela'
  };
  // First-level regions of every country (ISO 3166-2, plus common English names), by Google country ID.
  // Used only to keep "Monterrey, Nuevo León, Mexico" or "Guadalajara, Jalisco" together as one place.
  const WORLD_REGIONS_SRC = '2004:badakhshan|badghis|baghlan|balkh|bamyan|daykundi|farah|faryab|ghazni|ghor|helmand|herat|jowzjan|kabul|kandahar|kapisa|khost|kunar|kunduz|laghman|logar|nangarhar|nimroz|nuristan|paktika|paktiya|panjshayr|parwan|samangan|sar e pul|takhar|uruzgan|wardak|zabul;2008:berat|diber|durres|elbasan|fier|gjirokaster|korce|kukes|lezhe|shkoder|tirane|vlore;2012:adrar|ain defla|ain temouchent|alger|annaba|batna|bechar|bejaia|beni abbes|biskra|blida|bordj badji mokhtar|bordj bou arreridj|bouira|boumerdes|chlef|constantine|djanet|djelfa|el bayadh|el meghaier|el meniaa|el oued|el tarf|ghardaia|guelma|illizi|in guezzam|in salah|jijel|khenchela|laghouat|m sila|mascara|medea|mila|mostaganem|naama|oran|ouargla|ouled djellal|oum el bouaghi|relizane|saida|setif|sidi bel abbes|skikda|souk ahras|tamanrasset|tebessa|tiaret|timimoun|tindouf|tipaza|tissemsilt|tizi ouzou|tlemcen|touggourt;2024:bengo|benguela|bie|cabinda|cuando cubango|cuanza norte|cuanza sul|cunene|huambo|huila|luanda|lunda norte|lunda sul|malange|moxico|namibe|uige|zaire;2031:abseron|agcabədi|agdam|agdas|agstafa|agsu|astara|balakən|beyləqan|biləsuvar|bərdə|cəbrayıl|cəlilabad|daskəsən|fuzuli|goranboy|goycay|goygol|gədəbəy|hacıqabul|imisli|ismayıllı|kurdəmir|kəlbəcər|lacın|lerik|lənkəran|masallı|naxcıvan|neftcala|oguz|qax|qazax|qobustan|quba|qubadlı|qusar|qəbələ|saatlı|sabirabad|sabran|salyan|samaxı|samux|siyəzən|susa|səki|səmkir|tovuz|tərtər|ucar|xacmaz|xocalı|xocavənd|xızı|yardımlı|yevlax|zaqatala|zəngilan|zərdab;2032:buenos aires|catamarca|chaco|chubut|cordoba|corrientes|entre rios|formosa|jujuy|la pampa|la rioja|mendoza|misiones|neuquen|rio negro|salta|san juan|san luis|santa cruz|santa fe|santiago del estero|tierra del fuego|tucuman;2036:australian capital territory|new south wales|northern territory|queensland|south australia|tasmania|victoria|western australia;2040:burgenland|karnten|niederosterreich|oberosterreich|salzburg|steiermark|tirol|vorarlberg|wien;2044:acklins|berry islands|bimini|black point|cat island|central abaco|central andros|central eleuthera|city of freeport|crooked island long cay|east grand bahama|exuma|grand cay|harbour island|hope town|inagua|long island|mangrove cay|mayaguana|moore s island|new providence|north abaco|north andros|north eleuthera|ragged island|rum cay|san salvador|south abaco|south andros|south eleuthera|spanish wells|west grand bahama;2048:al asimah|al janubiyah|al muharraq|ash shamaliyah;2050:barishal|chattogram|dhaka|khulna|mymensingh|rajshahi|rangpur|sylhet;2051:aragacotn|ararat|armavir|gegark unik|kotayk|lori|sirak|syunik|tavus|vayoc jor;2056:bruxelles capitale region de|flanders|vlaams gewest|wallonia|wallonne region;2064:bumthang|chhukha|dagana|gasa|haa|lhuentse|monggar|paro|pema gatshel|punakha|samdrup jongkhar|samtse|sarpang|thimphu|trashi yangtse|trashigang|trongsa|tsirang|wangdue phodrang|zhemgang;2068:chuquisaca|cochabamba|el beni|la paz|oruro|pando|potosi|santa cruz|tarija;2070:federacija bosne i hercegovine|republika srpska;2072:central|chobe|ghanzi|jwaneng|kgalagadi|kgatleng|kweneng|lobatse|north east|north west|selibe phikwe|south east|southern|sowa town;2076:acre|alagoas|amapa|amazonas|bahia|ceara|distrito federal|espirito santo|goias|maranhao|mato grosso|mato grosso do sul|minas gerais|para|paraiba|parana|pernambuco|piaui|rio de janeiro|rio grande do norte|rio grande do sul|rondonia|roraima|santa catarina|sao paulo|sergipe|tocantins;2084:cayo|corozal|orange walk|stann creek|toledo;2090:central|choiseul|guadalcanal|isabel|makira ulawa|malaita|rennell bellona|temotu|western;2096:belait|brunei muara|temburong|tutong;2100:blagoevgrad|burgas|dobrich|gabrovo|haskovo|kardzhali|kyustendil|lovech|montana|pazardzhik|pernik|pleven|plovdiv|razgrad|ruse|shumen|silistra|sliven|smolyan|sofia|sofia stolitsa|stara zagora|targovishte|varna|veliko tarnovo|vidin|vratsa|yambol;2104:ayeyarwady|bago|chin|kachin|kayah|kayin|magway|mandalay|mon|nay pyi taw|rakhine|sagaing|shan|tanintharyi|yangon;2108:bubanza|bujumbura mairie|bujumbura rural|bururi|cankuzo|cibitoke|gitega|karuzi|kayanza|kirundo|makamba|muramvya|muyinga|mwaro|ngozi|rumonge|rutana|ruyigi;2112:bresckaja voblasc|homielskaja voblasc|hrodzienskaja voblasc|mahiliouskaja voblasc|minskaja voblasc|viciebskaja voblasc;2116:baat dambang|banteay mean choay|kaeb|kampong chaam|kampong chhnang|kampong spueu|kampong thum|kampot|kandaal|kaoh kong|kracheh|mondol kiri|otdar mean chey|pailin|pousaat|preah sihanouk|preah vihear|prey veaeng|rotanak kiri|siem reab|stueng traeng|svaay rieng|taakaev|tbong khmum;2120:adamaoua|centre|east|far north|littoral|north|north west|south|south west|west;2124:alberta|british columbia|manitoba|new brunswick|newfoundland labrador|northwest territories|nova scotia|nunavut|ontario|prince edward island|quebec|saskatchewan|yukon;2140:bamingui bangoran|bangui|basse kotto|gribingui|haut mbomou|haute kotto|haute sangha|haute sangha mambere kadei|kemo gribingui|lobaye|mambere kadei|mbomou|nana mambere|ombella mpoko|ouaka|ouham|ouham pende|sangha|vakaga;2144:central province|eastern province|north central province|north western province|northern province|sabaragamuwa province|southern province|uva province|western province;2148:bahr el ghazal|batha|borkou|chari baguirmi|ennedi est|ennedi ouest|guera|hadjer lamis|kanem|lac|logone occidental|logone oriental|mandoul|mayo kebbi est|mayo kebbi ouest|moyen chari|ouaddai|salamat|sila|tandjile|tibesti|ville de ndjamena|wadi fira;2152:aisen del general carlos ibanez del campo|antofagasta|arica y parinacota|atacama|biobio|coquimbo|la araucania|libertador general bernardo o higgins|los lagos|los rios|magallanes|maule|nuble|region metropolitana de santiago|tarapaca|valparaiso;2156:anhui sheng|fujian sheng|gansu sheng|guangdong sheng|guangxi zhuangzu zizhiqu|guizhou sheng|hainan sheng|hebei sheng|heilongjiang sheng|henan sheng|hubei sheng|hunan sheng|jiangsu sheng|jiangxi sheng|jilin sheng|liaoning sheng|nei mongol zizhiqu|ningxia huizu zizhiqu|qinghai sheng|shaanxi sheng|shandong sheng|shanxi sheng|sichuan sheng|taiwan sheng|xinjiang uygur zizhiqu|xizang zizhiqu|yunnan sheng|zhejiang sheng;2158:changhua|chiayi|hsinchu|hualien|kinmen|lienchiang|miaoli|nantou|penghu|pingtung|taitung|yilan|yunlin;2170:amazonas|antioquia|arauca|atlantico|bolivar|boyaca|caldas|caqueta|casanare|cauca|cesar|choco|cordoba|cundinamarca|guainia|guaviare|huila|la guajira|magdalena|meta|narino|norte de santander|putumayo|quindio|risaralda|san andres providencia y santa catalina|santander|sucre|tolima|valle del cauca|vaupes|vichada;2174:anjouan|grande comore|moheli;2178:bouenza|brazzaville|cuvette|cuvette ouest|kouilou|lekoumou|likouala|niari|plateaux|pointe noire|pool|sangha;2180:bas uele|equateur|haut katanga|haut lomami|haut uele|ituri|kasai|kasai central|kasai oriental|kongo central|kwango|kwilu|lomami|lualaba|mai ndombe|maniema|mongala|nord kivu|nord ubangi|sankuru|sud kivu|sud ubangi|tanganyika|tshopo|tshuapa;2188:alajuela|cartago|guanacaste|heredia|limon|puntarenas|san jose;2191:bjelovarsko bilogorska zupanija|brodsko posavska zupanija|dubrovacko neretvanska zupanija|istarska zupanija|karlovacka zupanija|koprivnicko krizevacka zupanija|krapinsko zagorska zupanija|licko senjska zupanija|međimurska zupanija|osjecko baranjska zupanija|pozesko slavonska zupanija|primorsko goranska zupanija|sibensko kninska zupanija|sisacko moslavacka zupanija|splitsko dalmatinska zupanija|varazdinska zupanija|viroviticko podravska zupanija|vukovarsko srijemska zupanija|zadarska zupanija|zagrebacka zupanija;2192:artemisa|camaguey|ciego de avila|cienfuegos|granma|guantanamo|holguin|la habana|las tunas|matanzas|mayabeque|pinar del rio|sancti spiritus|santiago de cuba|villa clara;2196:ammochostos|keryneia|larnaka|lefkosia|lemesos|pafos;2203:jihocesky kraj|jihomoravsky kraj|karlovarsky kraj|kraj vysocina|kralovehradecky kraj|liberecky kraj|moravskoslezsky kraj|olomoucky kraj|pardubicky kraj|plzensky kraj|stredocesky kraj|ustecky kraj|zlinsky kraj;2204:alibori|atacora|atlantique|borgou|collines|couffo|donga|littoral|mono|oueme|plateau|zou;2208:hovedstaden|midtjylland|nordjylland|sjælland|syddanmark;2214:cibao nordeste|cibao noroeste|cibao norte|cibao sur|el valle|enriquillo|higuamo|ozama|valdesia|yuma;2218:azuay|bolivar|canar|carchi|chimborazo|cotopaxi|el oro|esmeraldas|galapagos|guayas|imbabura|loja|los rios|manabi|morona santiago|napo|orellana|pastaza|pichincha|santa elena|santo domingo de los tsachilas|sucumbios|tungurahua|zamora chinchipe;2222:ahuachapan|cabanas|chalatenango|cuscatlan|la libertad|la paz|la union|morazan|san miguel|san salvador|san vicente|santa ana|sonsonate|usulutan;2226:region continentale|region insulaire;2231:addis ababa|afar|amara|benshangul gumaz|dire dawa|gambela peoples|harari people|oromia|sidama|somali|southern nations nationalities peoples|southwest ethiopia peoples|tigrai;2232:al awsat|al janubi|ansaba|janubi al bahri al ahmar|qash barkah|shimali al bahri al ahmar;2233:harjumaa|hiiumaa|ida virumaa|jarvamaa|jogevamaa|laane virumaa|laanemaa|parnumaa|polvamaa|raplamaa|saaremaa|tartumaa|valgamaa|viljandimaa|vorumaa;2242:central|eastern|northern|western;2246:etela karjala|etela pohjanmaa|etela savo|kainuu|kanta hame|keski pohjanmaa|keski suomi|kymenlaakso|landskapet aland|lappi|paijat hame|pirkanmaa|pohjanmaa|pohjois karjala|pohjois pohjanmaa|pohjois savo|satakunta|uusimaa|varsinais suomi;2250:brittany|burgundy franche comte|corsica|normandy;2262:ali sabieh|arta|dikhil|obock|tadjourah;2266:estuaire|haut ogooue|moyen ogooue|ngounie|nyanga|ogooue ivindo|ogooue lolo|ogooue maritime|woleu ntem;2268:abkhazia|ajaria|guria|imereti|k akheti|kvemo kartli|mtskheta mtianeti|rach a lechkhumi kvemo svaneti|samegrelo zemo svaneti|samtskhe javakheti|shida kartli;2270:central river|lower river|north bank|upper river|western;2275:bethlehem|deir el balah|gaza|hebron|jenin|jericho al aghwar|jerusalem|khan yunis|nablus|north gaza|qalqilya|rafah|ramallah|salfit|tubas|tulkarm;2276:baden wurttemberg|bavaria|bayern|berlin|brandenburg|bremen|hamburg|hesse|hessen|lower saxony|mecklenburg vorpommern|mecklenburg western pomerania|niedersachsen|nordrhein westfalen|north rhine westphalia|rheinland pfalz|rhineland palatinate|saarland|sachsen|sachsen anhalt|saxony|saxony anhalt|schleswig holstein|thuringen|thuringia;2288:ahafo|ashanti|bono|bono east|central|eastern|greater accra|north east|northern|oti|savannah|upper east|upper west|volta|western|western north;2296:gilbert islands|line islands|phoenix islands;2300:agion oros|anatoliki makedonia kai thraki|attiki|dytiki ellada|dytiki makedonia|ionia nisia|ipeiros|kentriki makedonia|kriti|notio aigaio|peloponnisos|sterea ellada|thessalia|voreio aigaio;2320:alta verapaz|baja verapaz|chimaltenango|chiquimula|el progreso|escuintla|huehuetenango|izabal|jalapa|jutiapa|peten|quetzaltenango|quiche|retalhuleu|sacatepequez|san marcos|santa rosa|solola|suchitepequez|totonicapan|zacapa;2324:boke|conakry|faranah|kankan|kindia|labe|mamou|nzerekore;2328:barima waini|cuyuni mazaruni|demerara mahaica|east berbice corentyne|essequibo islands west demerara|mahaica berbice|pomeroon supenaam|potaro siparuni|upper demerara berbice|upper takutu upper essequibo;2332:artibonite|centre|grande anse|nippes|nord|nord est|nord ouest|ouest|sud|sud est;2340:atlantida|choluteca|colon|comayagua|copan|cortes|el paraiso|francisco morazan|gracias a dios|intibuca|islas de la bahia|la paz|lempira|ocotepeque|olancho|santa barbara|valle|yoro;2348:bacs kiskun|baranya|bekes|borsod abauj zemplen|csongrad csanad|fejer|gyor moson sopron|hajdu bihar|heves|jasz nagykun szolnok|komarom esztergom|nograd|pest|somogy|szabolcs szatmar bereg|tolna|vas|veszprem|zala;2352:austurland|hofuðborgarsvæði|norðurland eystra|norðurland vestra|suðurland|suðurnes|vestfirðir|vesturland;2356:andaman nicobar islands|andhra pradesh|arunachal pradesh|assam|bihar|chandigarh|chhattisgarh|dadra nagar haveli daman diu|delhi|goa|gujarat|haryana|himachal pradesh|jammu kashmir|jharkhand|karnataka|kerala|ladakh|lakshadweep|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|puducherry|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal;2364:alborz|ardabil|azarbayjan e gharbi|azarbayjan e sharqi|bushehr|chahar mahal va bakhtiari|esfahan|fars|gilan|golestan|hamadan|hormozgan|ilam|kerman|kermanshah|khorasan e jonubi|khorasan e razavi|khorasan e shomali|khuzestan|kohgiluyeh va bowyer ahmad|kordestan|lorestan|markazi|mazandaran|qazvin|qom|semnan|sistan va baluchestan|tehran|yazd|zanjan;2368:al anbar|al basrah|al muthanna|al qadisiyah|an najaf|babil|baghdad|dhi qar|diyala|iqlim kurdistan|karbala|kirkuk|maysan|ninawa|salah ad din|wasit;2372:connaught|leinster|munster|ulster;2376:al awsat|al janubi|al quds|ash shamali|hayfa|tall abib;2380:abruzzo|aosta valley|apulia|basilicata|calabria|campania|emilia romagna|friuli venezia giulia|lazio|liguria|lombardia|lombardy|marche|molise|piedmont|piemonte|puglia|sardegna|sardinia|sicilia|sicily|toscana|trentino alto adige|trentino south tyrol|tuscany|umbria|valle d aosta|veneto;2384:abidjan|bas sassandra|comoe|denguele|goh djiboua|lacs|lagunes|montagnes|sassandra marahoue|savanes|vallee du bandama|woroba|yamoussoukro|zanzan;2392:aichi|akita|aomori|chiba|ehime|fukui|fukuoka|fukushima|gifu|gunma|hiroshima|hokkaido|hyogo|ibaraki|ishikawa|iwate|kagawa|kagoshima|kanagawa|kochi|kumamoto|kyoto|mie|miyagi|miyazaki|nagano|nagasaki|nara|niigata|oita|okayama|okinawa|osaka|saga|saitama|shiga|shimane|shizuoka|tochigi|tokushima|tokyo|tottori|toyama|wakayama|yamagata|yamaguchi|yamanashi;2398:abay oblysy|almaty oblysy|aqmola oblysy|aqtobe oblysy|atyrau oblysy|batys qazaqstan oblysy|mangghystau oblysy|pavlodar oblysy|qaraghandy oblysy|qostanay oblysy|qyzylorda oblysy|shyghys qazaqstan oblysy|soltustik qazaqstan oblysy|turkistan oblysy|ulytau oblysy|zhambyl oblysy|zhetisu oblysy;2400:ajlun|al aqabah|al asimah|al balqa|al karak|al mafraq|at tafilah|az zarqa|irbid|jarash|ma an|madaba;2404:baringo|bomet|bungoma|busia|elgeyo|elgeyo marakwet|embu|garissa|homa bay|isiolo|kajiado|kakamega|kericho|kiambu|kilifi|kirinyaga|kisii|kisumu|kitui|kwale|laikipia|lamu|machakos|makueni|mandera|marakwet|marsabit|meru|migori|mombasa|murang a|nairobi city|nakuru|nandi|narok|nyamira|nyandarua|nyeri|samburu|siaya|taita|taita taveta|tana river|taveta|tharaka nithi|trans nzoia|turkana|uasin gishu|vihiga|wajir|west pokot;2408:hamkyeongnamto|hamkyeongpukto|hwanghainamto|hwanghaipukto|jakangto|kangweonto|phyeongannamto|phyeonganpukto|ryangkangto;2410:chungcheongbuk do|chungcheongnam do|gyeonggi do|gyeongsangbuk do|gyeongsangnam do|jeollabuk do|jeollanam do;2414:al ahmadi|al asimah|al farwaniyah|al jahra|hawalli|mubarak al kabir;2417:batken|chuy|jalal abad|naryn|osh|talas|ysyk kol;2418:attapu|bokeo|bolikhamxai|champasak|houaphan|khammouan|louang namtha|louangphabang|oudomxai|phongsali|salavan|savannakhet|viangchan|xaignabouli|xaisomboun|xekong|xiangkhouang;2422:akkar|al biqa|al janub|an nabatiyah|ash shimal|b alabak al hirmil|bayrut|jabal lubnan;2426:berea|botha bothe|leribe|mafeteng|maseru|mohale s hoek|mokhotlong|qacha s nek|quthing|thaba tseka;2430:bomi|bong|gbarpolu|grand bassa|grand cape mount|grand gedeh|grand kru|lofa|margibi|maryland|montserrado|nimba|river cess|river gee|sinoe;2434:al butnan|al jabal al akhdar|al jabal al gharbi|al jafarah|al jufrah|al kufrah|al marj|al marqab|al wahat|an nuqat al khams|az zawiyah|banghazi|darnah|ghat|misratah|murzuq|nalut|sabha|surt|tarabulus|wadi al hayat|wadi ash shati;2438:balzers|eschen|gamprin|mauren|planken|ruggell|schaan|schellenberg|triesen|triesenberg|vaduz;2440:alytaus apskritis|kauno apskritis|klaipedos apskritis|marijampoles apskritis|panevezio apskritis|siauliu apskritis|taurages apskritis|telsiu apskritis|utenos apskritis|vilniaus apskritis;2442:capellen|clervaux|diekirch|echternach|esch sur alzette|grevenmacher|mersch|redange|remich|vianden|wiltz;2450:antananarivo|antsiranana|fianarantsoa|mahajanga|toamasina|toliara;2454:central region|northern region|southern region;2458:johor|kedah|kelantan|melaka|negeri sembilan|pahang|perak|perlis|pulau pinang|sabah|sarawak|selangor|terengganu|wilayah persekutuan kuala lumpur|wilayah persekutuan labuan|wilayah persekutuan putrajaya;2462:faadhippolhu|felidhu atoll|fuvammulah|hahdhunmathi|kolhumadulu|male atoll|mulaku atoll|north ari atoll|north huvadhu atoll|north maalhosmadulu|north miladhunmadulu|north nilandhe atoll|north thiladhunmathi|south ari atoll|south huvadhu atoll|south maalhosmadulu|south miladhunmadulu|south nilandhe atoll|south thiladhunmathi;2466:bamako|gao|kayes|kidal|koulikoro|menaka|mopti|segou|sikasso|taoudenit|tombouctou;2470:attard|balzan|birgu|birkirkara|birzebbuga|bormla|dingli|fgura|floriana|fontana|gudja|gzira|għajnsielem|għarb|għargħur|għasri|għaxaq|iklin|isla|kalkara|kercem|kirkop|lija|luqa|marsa|marsaskala|marsaxlokk|mdina|mellieħa|mgarr|mosta|mqabba|msida|mtarfa|munxar|nadur|naxxar|paola|pembroke|pieta|qala|qormi|qrendi|rabat gozo|rabat malta|safi|saint john|saint julian s|saint lawrence|saint lucia s|saint paul s bay|sannat|santa venera|siggiewi|sliema|swieqi|ta xbiex|tarxien|valletta|xagħra|xewkija|xgħajra|zabbar|zebbug gozo|zebbug malta|zejtun|zurrieq|ħamrun;2478:adrar|assaba|brakna|dakhlet nouadhibou|gorgol|guidimaka|hodh ech chargui|hodh el gharbi|inchiri|nouakchott nord|nouakchott ouest|nouakchott sud|tagant|tiris zemmour|trarza;2480:black river|flacq|grand port|moka|pamplemousses|plaines wilhems|port louis|riviere du rempart|savanne;2484:aguascalientes|baja california|baja california sur|campeche|chiapas|chihuahua|ciudad de mexico|coahuila de zaragoza|colima|durango|guanajuato|guerrero|hidalgo|jalisco|michoacan de ocampo|morelos|nayarit|nuevo leon|oaxaca|puebla|queretaro|quintana roo|san luis potosi|sinaloa|sonora|tabasco|tamaulipas|tlaxcala|veracruz de ignacio de la llave|yucatan|zacatecas;2492:fontvieille|jardin exotique|la colle|la condamine|la gare|la source|larvotto|malbousquet|monaco ville|moneghetti|monte carlo|moulins|port hercule|saint roman|sainte devote|spelugues|vallon de la rousse;2496:arhangay|bayan olgiy|bayanhongor|bulgan|darhan uul|dornod|dornogovi|dundgovi|dzavhan|govi altay|govi sumber|hentiy|hovd|hovsgol|omnogovi|orhon|ovorhangay|selenge|suhbaatar|tov|uvs;2498:anenii noi|basarabeasca|briceni|cahul|calarasi|cantemir|causeni|cimislia|criuleni|donduseni|drochia|dubasari|edinet|falesti|floresti|gagauzia unitatea teritoriala autonoma utag|glodeni|hincesti|ialoveni|leova|nisporeni|ocnita|orhei|rezina|riscani|singerei|soldanesti|soroca|stefan voda|stinga nistrului unitatea teritoriala din|straseni|taraclia|telenesti|ungheni;2504:beni mellal khenifra|casablanca settat|dakhla oued ed dahab eh|draa tafilalet|fes meknes|guelmim oued noun eh partial|l oriental|laayoune sakia el hamra eh partial|marrakech safi|rabat sale kenitra|souss massa|tanger tetouan al hoceima;2508:cabo delgado|gaza|inhambane|manica|maputo|nampula|niassa|sofala|tete|zambezia;2512:ad dakhiliyah|al buraymi|al wusta|az zahirah|janub al batinah|janub ash sharqiyah|masqat|musandam|shamal al batinah|shamal ash sharqiyah|zufar;2516:erongo|hardap|karas|kavango east|kavango west|khomas|kunene|ohangwena|omaheke|omusati|oshana|oshikoto|otjozondjupa|zambezi;2520:aiwo|anabar|anetan|anibare|baitsi|boe|buada|denigomodu|ewa|ijuw|meneng|nibok|uaboe|yaren;2524:bagmati|gandaki|karnali|koshi|lumbini|madhesh|sudurpashchim;2528:drenthe|flevoland|fryslan|gelderland|groningen|limburg|noord brabant|noord holland|overijssel|sint maarten|utrecht|zeeland|zuid holland;2548:malampa|penama|sanma|shefa|tafea|torba;2554:auckland|bay of plenty|canterbury|gisborne|greater wellington|hawke s bay|manawatu whanganui|marlborough|nelson|northland|otago|southland|taranaki|tasman|waikato|west coast;2558:boaco|carazo|chinandega|chontales|costa caribe norte|costa caribe sur|esteli|granada|jinotega|leon|madriz|managua|masaya|matagalpa|nueva segovia|rio san juan|rivas;2562:agadez|diffa|dosso|maradi|niamey|tahoua|tillaberi|zinder;2566:abia|adamawa|akwa ibom|anambra|bauchi|bayelsa|benue|borno|cross river|delta|ebonyi|edo|ekiti|enugu|gombe|imo|jigawa|kaduna|kano|katsina|kebbi|kogi|kwara|lagos|nasarawa|ogun|ondo|osun|oyo|plateau|rivers|sokoto|taraba|yobe|zamfara;2578:agder|innlandet|møre og romsdal|nordland|oslo|rogaland|troms og finnmark|trøndelag|vestfold og telemark|vestland|viken;2581:baker island|howland island|jarvis island|johnston atoll|kingman reef|midway islands|navassa island|palmyra atoll|wake island;2583:chuuk|kosrae|pohnpei|yap;2584:ralik chain|ratak chain;2585:aimeliik|airai|angaur|hatohobei|kayangel|koror|melekeok|ngaraard|ngarchelong|ngardmau|ngatpang|ngchesar|ngeremlengui|ngiwal|peleliu|sonsorol;2586:azad jammu kashmir|azad kashmir|balochistan|gilgit baltistan|khyber pakhtunkhwa|kpk|punjab|sindh;2591:bocas del toro|chiriqui|cocle|colon|darien|embera|guna yala|herrera|los santos|naso tjer di|ngabe bugle|panama oeste|veraguas;2598:bougainville|central|chimbu|east new britain|east sepik|eastern highlands|enga|gulf|hela|jiwaka|madang|manus|milne bay|morobe|national capital district port moresby|new ireland|northern|southern highlands|west new britain|west sepik|western|western highlands;2600:alto paraguay|alto parana|amambay|boqueron|caaguazu|caazapa|canindeyu|central|concepcion|cordillera|guaira|itapua|misiones|neembucu|paraguari|presidente hayes|san pedro;2604:amazonas|ancash|apurimac|arequipa|ayacucho|cajamarca|cusco|el callao|huancavelica|huanuco|ica|junin|la libertad|lambayeque|lima|loreto|madre de dios|moquegua|pasco|piura|puno|san martin|tacna|tumbes|ucayali;2608:autonomous region in muslim mindanao armm|bicol region v|cagayan valley region ii|calabarzon region iv a|caraga region xiii|central luzon region iii|central visayas region vii|cordillera administrative region car|davao region xi|eastern visayas region viii|ilocos region i|mimaropa region iv b|national capital region|northern mindanao region x|soccsksargen region xii|western visayas region vi|zamboanga peninsula region ix;2616:dolnoslaskie|kujawsko pomorskie|lubelskie|lubuskie|mazowieckie|małopolskie|opolskie|podkarpackie|podlaskie|pomorskie|slaskie|swietokrzyskie|warminsko mazurskie|wielkopolskie|zachodniopomorskie|łodzkie;2620:aveiro|beja|braga|braganca|castelo branco|coimbra|evora|faro|guarda|leiria|lisboa|portalegre|porto|regiao autonoma da madeira|regiao autonoma dos acores|santarem|setubal|viana do castelo|vila real|viseu;2624:bissau|leste|norte|sul;2642:alba|arad|arges|bacau|bihor|bistrita nasaud|botosani|braila|brasov|buzau|calarasi|caras severin|cluj|constanta|covasna|dambovita|dolj|galati|giurgiu|gorj|harghita|hunedoara|ialomita|iasi|ilfov|maramures|mehedinti|mures|neamt|olt|prahova|salaj|satu mare|sibiu|suceava|teleorman|timis|tulcea|valcea|vaslui|vrancea;2643:adygeya respublika|altay respublika|altayskiy kray|amurskaya oblast|arkhangel skaya oblast|astrakhanskaya oblast|bashkortostan respublika|belgorodskaya oblast|bryanskaya oblast|buryatiya respublika|chechenskaya respublika|chelyabinskaya oblast|chukotskiy avtonomnyy okrug|chuvashskaya respublika|dagestan respublika|ingushetiya respublika|irkutskaya oblast|ivanovskaya oblast|kabardino balkarskaya respublika|kaliningradskaya oblast|kalmykiya respublika|kaluzhskaya oblast|kamchatskiy kray|karachayevo cherkesskaya respublika|kareliya respublika|kemerovskaya oblast|khabarovskiy kray|khakasiya respublika|khanty mansiyskiy avtonomnyy okrug|kirovskaya oblast|komi respublika|kostromskaya oblast|krasnodarskiy kray|krasnoyarskiy kray|kurganskaya oblast|kurskaya oblast|leningradskaya oblast|lipetskaya oblast|magadanskaya oblast|mariy el respublika|mordoviya respublika|moskovskaya oblast|murmanskaya oblast|nenetskiy avtonomnyy okrug|nizhegorodskaya oblast|novgorodskaya oblast|novosibirskaya oblast|omskaya oblast|orenburgskaya oblast|orlovskaya oblast|penzenskaya oblast|permskiy kray|primorskiy kray|pskovskaya oblast|rostovskaya oblast|ryazanskaya oblast|saha respublika|sakhalinskaya oblast|samarskaya oblast|saratovskaya oblast|severnaya osetiya respublika|smolenskaya oblast|stavropol skiy kray|sverdlovskaya oblast|tambovskaya oblast|tatarstan respublika|tomskaya oblast|tul skaya oblast|tverskaya oblast|tyumenskaya oblast|tyva respublika|udmurtskaya respublika|ul yanovskaya oblast|vladimirskaya oblast|volgogradskaya oblast|vologodskaya oblast|voronezhskaya oblast|yamalo nenetskiy avtonomnyy okrug|yaroslavskaya oblast|yevreyskaya avtonomnaya oblast|zabaykal skiy kray;2646:eastern|northern|southern|western;2659:nevis|saint kitts;2662:anse la raye|canaries|castries|choiseul|dennery|gros islet|laborie|micoud|soufriere|vieux fort;2678:agua grande|cantagalo|caue|lemba|lobata|me zochi|principe;2682:al bahah|al hudud ash shamaliyah|al jawf|al jouf|al madinah al munawwarah|al qasim|ar riyad|ash sharqiyah|asir|eastern province|ha il|hail|jazan|madinah province|makkah al mukarramah|makkah province|makkah region|mecca province|medina province|najran|qassim|riyadh province|riyadh region|tabuk;2686:dakar|diourbel|fatick|kaffrine|kaolack|kedougou|kolda|louga|matam|saint louis|sedhiou|tambacounda|thies|ziguinchor;2688:borski okrug|branicevski okrug|jablanicki okrug|kolubarski okrug|kosovo metohija|macvanski okrug|moravicki okrug|nisavski okrug|pcinjski okrug|pirotski okrug|podunavski okrug|pomoravski okrug|rasinski okrug|raski okrug|sumadijski okrug|toplicki okrug|vojvodina|zajecarski okrug|zlatiborski okrug;2690:anse aux pins|anse boileau|anse etoile|anse royale|au cap|baie lazare|baie sainte anne|beau vallon|bel air|bel ombre|cascade|english river|glacis|grand anse mahe|grand anse praslin|ile perseverance i|ile perseverance ii|la digue|les mamelles|mont buxton|mont fleuri|plaisance|pointe larue|port glaud|roche caiman|saint louis|takamaka;2694:eastern|north western|northern|southern|western area freetown;2702:central singapore|north east|north west|south east|south west;2703:banskobystricky kraj|bratislavsky kraj|kosicky kraj|nitriansky kraj|presovsky kraj|trenciansky kraj|trnavsky kraj|zilinsky kraj;2704:an giang|ba ria vung tau|bac giang|bac kan|bac lieu|bac ninh|ben tre|binh duong|binh phuoc|binh thuan|binh đinh|ca mau|cao bang|gia lai|ha giang|ha nam|ha tinh|hai duong|hau giang|hoa binh|hung yen|khanh hoa|kien giang|kon tum|lai chau|lam đong|lang son|lao cai|long an|nam đinh|nghe an|ninh binh|ninh thuan|phu tho|phu yen|quang binh|quang nam|quang ngai|quang ninh|quang tri|soc trang|son la|tay ninh|thai binh|thai nguyen|thanh hoa|thua thien hue|tien giang|tra vinh|tuyen quang|vinh long|vinh phuc|yen bai|đak lak|đak nong|đien bien|đong nai|đong thap;2706:awdal|bakool|banaadir|bari|bay|galguduud|gedo|hiiraan|jubbada dhexe|jubbada hoose|mudug|nugaal|sanaag|shabeellaha dhexe|shabeellaha hoose|sool|togdheer|woqooyi galbeed;2710:eastern cape|free state|gauteng|kwazulu natal|limpopo|mpumalanga|north west|northern cape|western cape;2716:bulawayo|harare|manicaland|mashonaland central|mashonaland east|mashonaland west|masvingo|matabeleland north|matabeleland south|midlands;2724:andalucia|andalusia|aragon|asturias principado de|balearic islands|basque country|canarias|canary islands|cantabria|castile leon|castilla la mancha|castilla y leon|catalonia|cataluna|catalunya|catalunya cataluna|community of madrid|extremadura|galicia|galicia galicia|illes balears|illes balears islas baleares|islas baleares|la rioja|madrid comunidad de|murcia region de|navarra comunidad foral de|pais vasco|region of murcia|valencian community|valenciana comunidad;2728:central equatoria|eastern equatoria|jonglei|lakes|northern bahr el ghazal|unity|upper nile|warrap|western bahr el ghazal|western equatoria;2729:blue nile|central darfur|east darfur|gedaref|gezira|kassala|khartoum|north darfur|north kordofan|northern|red sea|river nile|sennar|south darfur|south kordofan|west darfur|west kordofan|white nile;2740:brokopondo|commewijne|coronie|marowijne|nickerie|para|paramaribo|saramacca|sipaliwini|wanica;2748:hhohho|lubombo|manzini|shiselweni;2752:blekinge lan|blekinge lan se 10|dalarnas lan|dalarnas lan se 20|gavleborgs lan|gavleborgs lan se 21|gotlands lan|gotlands lan se 09|hallands lan|hallands lan se 13|jamtlands lan|jamtlands lan se 23|jonkopings lan|jonkopings lan se 06|kalmar lan|kalmar lan se 08|kronobergs lan|kronobergs lan se 07|norrbottens lan|norrbottens lan se 25|orebro lan|orebro lan se 18|ostergotlands lan|ostergotlands lan se 05|se 01|se 03|se 04|se 05|se 06|se 07|se 08|se 09|se 10|se 12|se 13|se 14|se 17|se 18|se 19|se 20|se 21|se 22|se 23|se 24|se 25|skane lan|skane lan se 12|sodermanlands lan|sodermanlands lan se 04|stockholms lan|stockholms lan se 01|uppsala lan|uppsala lan se 03|varmlands lan|varmlands lan se 17|vasterbottens lan|vasterbottens lan se 24|vasternorrlands lan|vasternorrlands lan se 22|vastmanlands lan|vastmanlands lan se 19|vastra gotalands lan|vastra gotalands lan se 14;2756:aargau|appenzell ausserrhoden|appenzell innerrhoden|basel landschaft|basel stadt|bern|berne|fribourg|geneva|geneve|glarus|graubunden|jura|luzern|neuchatel|nidwalden|obwalden|sankt gallen|schaffhausen|schwyz|solothurn|thurgau|ticino|uri|valais|vaud|zug|zurich;2760:al hasakah|al ladhiqiyah|al qunaytirah|ar raqqah|as suwayda|dar a|dayr az zawr|dimashq|halab|hamah|hims|idlib|rif dimashq|tartus;2762:khatlon|kuhistoni badakhshon|nohiyahoi tobei jumhuri|sughd;2764:amnat charoen|ang thong|bueng kan|buri ram|chachoengsao|chai nat|chaiyaphum|chanthaburi|chiang mai|chiang rai|chon buri|chumphon|kalasin|kamphaeng phet|kanchanaburi|khon kaen|krabi|lampang|lamphun|loei|lop buri|mae hong son|maha sarakham|mukdahan|nakhon nayok|nakhon pathom|nakhon phanom|nakhon ratchasima|nakhon sawan|nakhon si thammarat|nan|narathiwat|nong bua lam phu|nong khai|nonthaburi|pathum thani|pattani|phangnga|phatthalung|phayao|phetchabun|phetchaburi|phichit|phitsanulok|phra nakhon si ayutthaya|phrae|phuket|prachin buri|prachuap khiri khan|ranong|ratchaburi|rayong|roi et|sa kaeo|sakon nakhon|samut prakan|samut sakhon|samut songkhram|saraburi|satun|si sa ket|sing buri|songkhla|sukhothai|suphan buri|surat thani|surin|tak|trang|trat|ubon ratchathani|udon thani|uthai thani|uttaradit|yala|yasothon;2768:centrale|kara|maritime region|plateaux|savanes;2776:eua|ha apai|niuas|tongatapu|vava u;2780:arima|chaguanas|couva tabaquite talparo|diego martin|mayaro rio claro|penal debe|point fortin|princes town|san juan laventille|sangre grande|siparia|tobago|tunapuna piarco;2784:abu dhabi|abu zaby|ajman|al fujayrah|ash shariqah|dubai|dubayy|fujairah|ra s al khaymah|ras al khaimah|sharjah|umm al qaywayn|umm al quwain;2788:beja|ben arous|bizerte|gabes|gafsa|jendouba|kairouan|kasserine|kebili|l ariana|la manouba|le kef|mahdia|medenine|monastir|nabeul|sfax|sidi bouzid|siliana|sousse|tataouine|tozeur|tunis|zaghouan;2792:adana|adıyaman|afyonkarahisar|agrı|aksaray|amasya|ankara|antalya|ardahan|artvin|aydın|balıkesir|bartın|batman|bayburt|bilecik|bingol|bitlis|bolu|burdur|bursa|canakkale|cankırı|corum|denizli|diyarbakır|duzce|edirne|elazıg|erzincan|erzurum|eskisehir|gaziantep|giresun|gumushane|hakkari|hatay|igdır|isparta|istanbul|izmir|kahramanmaras|karabuk|karaman|kars|kastamonu|kayseri|kilis|kocaeli|konya|kutahya|kırklareli|kırsehir|kırıkkale|malatya|manisa|mardin|mersin|mugla|mus|nevsehir|nigde|ordu|osmaniye|rize|sakarya|samsun|sanlıurfa|siirt|sinop|sivas|sırnak|tekirdag|tokat|trabzon|tunceli|usak|van|yalova|yozgat|zonguldak;2795:ahal|balkan|dasoguz|lebap|mary;2798:funafuti;2804:avtonomna respublika krym|cherkaska oblast|chernihivska oblast|chernivetska oblast|dnipropetrovska oblast|donetska oblast|ivano frankivska oblast|kharkivska oblast|khersonska oblast|khmelnytska oblast|kirovohradska oblast|kyivska oblast|luhanska oblast|lvivska oblast|mykolaivska oblast|odeska oblast|poltavska oblast|rivnenska oblast|sumska oblast|ternopilska oblast|vinnytska oblast|volynska oblast|zakarpatska oblast|zaporizka oblast|zhytomyrska oblast;2818:ad daqahliyah|al bahr al ahmar|al buhayrah|al fayyum|al gharbiyah|al iskandariyah|al isma iliyah|al jizah|al minufiyah|al minya|al qahirah|al qalyubiyah|al uqsur|al wadi al jadid|alexandria governorate|as suways|ash sharqiyah|aswan|asyut|bani suwayf|bur sa id|cairo governorate|dumyat|giza governorate|janub sina|kafr ash shaykh|matruh|qina|shamal sina|suhaj;2826:cymru gb cym|england|northern ireland|scotland|wales|wales cymru gb cym;2834:arusha|coast|dar es salaam|dodoma|geita|iringa|kagera|katavi|kigoma|kilimanjaro|lindi|manyara|mara|mbeya|morogoro|mtwara|mwanza|njombe|pemba north|pemba south|rukwa|ruvuma|shinyanga|simiyu|singida|songwe|tabora|tanga|zanzibar north|zanzibar south|zanzibar west;2840:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|district of columbia|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming;2854:boucle du mouhoun|cascades|centre|centre est|centre nord|centre ouest|centre sud|est|hauts bassins|nord|plateau central|sahel|sud ouest;2858:artigas|canelones|cerro largo|colonia|durazno|flores|florida|lavalleja|maldonado|montevideo|paysandu|rio negro|rivera|rocha|salto|san jose|soriano|tacuarembo|treinta y tres;2860:andijon|buxoro|farg ona|jizzax|namangan|navoiy|qashqadaryo|qoraqalpog iston respublikasi|samarqand|sirdaryo|surxondaryo|toshkent|xorazm;2862:amazonas|anzoategui|apure|aragua|barinas|bolivar|carabobo|cojedes|delta amacuro|falcon|guarico|la guaira|lara|merida|miranda|monagas|nueva esparta|portuguesa|sucre|tachira|trujillo|yaracuy|zulia;2876:alo|sigave|uvea;2882:a ana|aiga i le tai|atua|fa asaleleaga|gaga emauga|gagaifomauga|palauli|satupa itea|tuamasaga|va a o fonoti|vaisigano;2887:abyan|ad dali|adan|al bayda|al hudaydah|al jawf|al mahrah|al mahwit|amran|arkhabil suqutra|dhamar|hadramawt|hajjah|ibb|lahij|ma rib|raymah|sanʻa|saʻdah|shabwah|taʻizz;2894:central|copperbelt|eastern|luapula|lusaka|muchinga|north western|northern|southern|western';
  const plainKey = s => key(String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
  let worldRegions = null;
  // "jalisco" -> ['Mexico']; "punjab" -> ['India', 'Pakistan']
  const worldRegion = name => {
    if (!worldRegions) {
      worldRegions = new Map();
      const byId = new Map(COUNTRIES.map(c => [c[1], c[0]]));
      WORLD_REGIONS_SRC.split(';').forEach(part => {
        const [id, list] = part.split(':');
        list.split('|').forEach(k => { const a = worldRegions.get(k) || []; a.push(byId.get(id)); worldRegions.set(k, a); });
      });
    }
    return worldRegions.get(plainKey(name)) || null;
  };
  const LANGS = [
    ['en', 'English'], ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['ur', 'Urdu'],
    ['hi', 'Hindi'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['tr', 'Turkish'], ['zh_CN', 'Chinese (simplified)'],
    ['zh_TW', 'Chinese (traditional)'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ru', 'Russian'], ['pl', 'Polish'], ['sv', 'Swedish'],
    ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'], ['el', 'Greek'], ['iw', 'Hebrew'], ['id', 'Indonesian'], ['ms', 'Malay'],
    ['th', 'Thai'], ['vi', 'Vietnamese'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['gu', 'Gujarati'],
    ['ml', 'Malayalam'], ['kn', 'Kannada'], ['pa', 'Punjabi'], ['fa', 'Persian'], ['tl', 'Filipino'], ['ro', 'Romanian'], ['hu', 'Hungarian'], ['cs', 'Czech'], ['uk', 'Ukrainian']
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
  const inMap = (map, p) => { const k = plainKey(p); for (const r in map) if (plainKey(r) === k) return map[r]; return null; };
  const regionState = p => inMap(REGION_STATES, p);
  const regionCity = p => inMap(REGION_CITIES, p);
  // Australian state codes after a city; WA and SA only next to an Australian city, since WA is also Washington
  const AU_CODES = { NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory', WA: 'Western Australia', SA: 'South Australia' };
  const auState = (q, auCity) => { const c = norm(q).toUpperCase().replace(/\./g, ''); return AU_CODES[c] && (auCity || (c !== 'WA' && c !== 'SA')) ? AU_CODES[c] : null; };
  const titleCase = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase());
  const nice = p => p === p.toLowerCase() ? titleCase(p) : p;
  const isKnownPlace = p => !!(findCountry(p) || usState(p, false) || province(p, false) || regionState(p) || regionCity(p));

  const AND_NAMES = /\b(?:trinidad and tobago|bosnia and herzegovina|antigua and barbuda|saint kitts and nevis|st\.? kitts and nevis|saint vincent and the grenadines|st\.? vincent and the grenadines|sao tome and principe|são tomé and príncipe|newfoundland and labrador|turks and caicos(?: islands)?|heard island and mcdonald islands|saint pierre and miquelon|wallis and futuna)\b/gi;

  function parseLocations(value) {
    let v = norm(value);
    const info = { presence: null, notes: [] };
    if (/\bpresence\b/i.test(v)) info.presence = !/\binterest\b/i.test(v) || /presence only/i.test(v);
    const ex = v.match(/[,;(]?\s*\b(?:excluding|exclude[sd]?|except|but not|not including|minus|without)\b\s*:?\s*([^)]*)\)?\s*$/i);
    if (ex) { info.notes.push('Excluded locations (' + norm(ex[1]) + ') are not exported. Add them in Ads Editor as excluded locations.'); v = v.slice(0, ex.index); }
    // "Per campaign below." or "See the campaign table": the places are given elsewhere
    if (/^(?:per campaign|by campaign|varies by campaign|see (?:below|above|the campaign|campaign|each campaign)|set per campaign|tbd|tbc|to be (?:confirmed|decided))\b/i.test(v)) return { list: [], presence: info.presence, notes: [] };
    // "Nigeria, Cameroon, The Gambia. Add Ghana and Liberia if offered.": the places end at the first full sentence
    v = v.replace(/\bD\.\s?C\.?(?=\s|,|;|$)/g, 'DC');
    const sb = v.match(/\b(?!(?:ste|sta|sto|mte|mts|mtn|ave|blvd|hwy|dept|govt|est|inc|ltd|corp)\.)([\p{L}]{3,}|[A-Z]{2})\.\s+(?=\p{Lu})/u);
    if (sb) {
      const rest = norm(v.slice(sb.index + sb[0].length));
      if (/\p{L}/u.test(rest)) info.notes.push('Not used from the locations: "' + rest + '" Add those places by hand if you want them.');
      v = v.slice(0, sb.index + sb[1].length);
    }
    const rad = v.match(/\b(\d+(?:\.\d+)?)\s*(mi|miles?|km|kms|kilomet(?:er|re)s?)\b\s*(?:radius)?\s*(?:of|around|from)?\s*/i);
    if (rad) { info.notes.push('Radius targeting (' + rad[1] + ' ' + rad[2] + ') is not exported. The place itself is targeted; set the radius in Ads Editor.'); v = norm(v.replace(rad[0], ' ')); }
    // "UAE (Dubai & Abu Dhabi only)": the places in brackets replace the country
    v = v.replace(/([^,;()]+?)\s*\(([^)]*?)\s+only\)/gi, (m, outer, inner) => {
      const c = findCountry(norm(outer));
      return c && !/\b(?:presence|interest|people|search|targeting|location|radius|mile|km)\b/i.test(inner) ? inner.split(/\s*(?:,|&|\band\b)\s*/i).map(norm).filter(Boolean).map(x => x + ', ' + c.name).join('; ') : m;
    });
    // "Pan India", "Pan-India", "All of India", "Nationwide (UK)"
    v = v.replace(/\b(?:pan[\s-]+|all (?:of |over )?|whole (?:of )?|entire |across (?:the )?)(?=[\p{L}])([\p{L} ]+?)(?=$|[,;()])/giu, (m, name) => findCountry(norm(name)) ? name : m);
    let listQual = null;
    (v.match(/\(([^)]*)\)/g) || []).forEach(x => {
      const q = norm(x.slice(1, -1));
      const stq = usState(q, true), prq = province(q, true), rsq = regionState(q), cq = findCountry(q);
      if (stq) listQual = { region: stq, country: 'United States' };
      else if (prq) listQual = { region: prq, country: 'Canada' };
      else if (rsq) listQual = { region: nice(q), country: rsq };
      else if (cq) listQual = { region: null, country: cq.name };
    });
    v = v.replace(/\([^)]*\)/g, ' ').replace(/\b(?:presence only|presence or interest|people in(?: or regularly in)?)\b/gi, ' ');
    // a sentence-ending full stop is not part of the last place ("St. Charles." -> "St. Charles"), but "D.C." keeps its dots
    v = norm(v).replace(/(?<!\b[A-Z]\.[A-Z])[.;,]+$/, '');
    const out = [];
    const push = loc => { if (loc.name && !out.some(o => o.name.toLowerCase() === loc.name.toLowerCase())) out.push(loc); };
    // "plus", "along with" and "as well as" always separate places; "and" and "&" only when every side is a known place,
    // so "Trinidad and Tobago" stays whole
    v.split(/\s*(?:;|\||\n|\/)\s*|\s+(?:plus|along with|as well as|together with)\s+/i).map(norm).filter(Boolean).forEach(chunk => {
      // place names that contain "and" are protected before splitting a list on "and" / "&"
      const kept = [];
      const masked = chunk.replace(AND_NAMES, m => { kept.push(m); return '\u0000' + (kept.length - 1) + '\u0000'; });
      const pieces = masked.split(/\s+(?:and|&|\+)\s+/i).map(x => norm(x.replace(/\u0000(\d+)\u0000/g, (_, n) => kept[+n]))).filter(Boolean);
      pieces.forEach(piece => {
        const parts = [];
        piece.split(',').map(p => norm(p).replace(/^(?:and|&)\s+/i, '')).filter(Boolean).forEach(p => {
          // "Bloomingdale IL" written without a comma
          const m = p.match(/^(.+?)\s+([A-Z]{2})$/);
          if (m && (US_STATES[m[2]] || CA_PROVINCES[m[2]]) && !findCountry(p)) { parts.push(m[1], m[2]); } else parts.push(p);
        });
        const usCtx = parts.filter(p => usState(p, true)).length >= 2 && !parts.some(p => findCountry(p) && !usState(p, true));
        let i = 0;
        while (i < parts.length) {
          const p = parts[i];
          const next = parts[i + 1];
          // "New York, NY" and "Washington, DC" are cities: a state name followed by a state code is not the state itself
          const cityFirst = p.length > 2 && next && /^[A-Za-z]{2}$/.test(next) && !!(US_STATES[next.toUpperCase()] || CA_PROVINCES[next.toUpperCase()]);
          const st = cityFirst ? null : usState(p, usCtx);
          const c = st ? null : findCountry(p);
          if (c) { push({ name: c.name, id: c.id, kind: 'country' }); i++; continue; }
          const pr = st || cityFirst ? null : province(p, false);
          const rs = st || pr || cityFirst ? null : regionState(p);
          let name, region = null, country = null, j = i + 1, kind;
          if (st || pr || rs) {
            kind = 'region';
            name = st || pr || nice(p);
            country = st ? 'United States' : pr ? 'Canada' : rs;
            const qc = j < parts.length ? findCountry(parts[j]) : null;
            if (qc) { country = qc.name; j++; }
          } else {
            // a city: take the region and/or country written after it
            kind = 'city';
            name = nice(p);
            while (j < parts.length) {
              const q = parts[j];
              const au = !region && !country ? auState(q, regionCity(p) === 'Australia') : null;
              if (au) { region = au; country = 'Australia'; j++; continue; }
              const qs = !region && !country ? (usState(q, true) || province(q, true) || (regionState(q) ? nice(q) : null)) : null;
              if (qs) {
                region = qs; j++;
                country = usState(q, true) ? 'United States' : province(q, true) ? 'Canada' : regionState(q);
                continue;
              }
              const qc = findCountry(q);
              if (qc) { country = qc.name; j++; break; }
              if (region || country) break;
              // a region the tool knows for that country: "Monterrey, Nuevo León, Mexico", "Guadalajara, Jalisco"
              const nc = j + 1 < parts.length ? findCountry(parts[j + 1]) : null;
              const wr = worldRegion(q);
              if (nc && j + 2 === parts.length && wr && wr.includes(nc.name)) { region = nice(q); country = nc.name; j += 2; break; }
              if (!nc && parts.length === 2 && j === 1 && wr && wr.length === 1) { region = nice(q); country = wr[0]; j++; break; }
              break;
            }
            if (!country && !region) { const known = regionCity(p); if (known) { country = known; kind = 'known-city'; } }
            else if (region && !findCountry(parts[j - 1] || '')) { const known = regionCity(p); if (known) country = known; }
          }
          push({ name, region, country, kind, id: '' });
          i = j;
        }
      });
    });
    // One state or country written once for a list of towns applies to all of them:
    // "Bloomingdale, IL plus Roselle, Carol Stream" -> every town is in Illinois.
    if (listQual) out.forEach(o => { if (o.kind === 'city' && !o.region && !o.country) { o.region = listQual.region; o.country = listQual.country; } });
    const quals = [...new Set(out.filter(o => o.kind === 'city' && (o.region || o.country)).map(o => (o.region || '') + '|' + (o.country || '')))];
    if (quals.length === 1) {
      const [region, country] = quals[0].split('|');
      out.forEach(o => { if (o.kind === 'city' && !o.region && !o.country) { o.region = region || null; o.country = country || null; } });
    }
    const list = out.map(o => {
      if (o.kind === 'country') return { name: o.name, id: o.id };
      let name = o.name;
      const has = part => name.toLowerCase().endsWith(', ' + part.toLowerCase()) || (o.kind !== 'city' && name.toLowerCase() === part.toLowerCase());
      if (o.region && !has(o.region)) name += ', ' + o.region;
      if (o.country && !has(o.country)) name += ', ' + o.country;
      return { name, id: '' };
    }).filter((l, i, a) => a.findIndex(x => x.name.toLowerCase() === l.name.toLowerCase()) === i);
    return { list, presence: info.presence, notes: info.notes };
  }

  /* Amounts in any currency: the Ads Editor file has no currency, so only the number matters.
     "$1,500", "1.500 €", "1 500 zł", "CHF 1'200", "₹2,00,000", "R$ 2.500,50", "AED 18,000", "١٢٠٠", "1.5k", "₹1.5L", "₹1.2 Cr", "1.2M", "Rp 1,5 juta" */
  const asciiDigits = s => String(s || '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6F0));
  // currencies written with three decimals, where "1.500" is one and a half
  const THREE_DECIMALS = /\b(?:kwd|bhd|omr|jod|tnd|lyd|iqd)\b|د\.ك|ب\.د|ر\.ع/i;
  const MULTIPLIERS = [[/^(?:k|thousand|ribu)$/i, 1e3], [/^(?:lakhs?|lacs?|l)$/i, 1e5], [/^(?:crores?|cr)$/i, 1e7], [/^(?:m|mn|mio|million|millions|juta)$/i, 1e6], [/^[万萬]$/, 1e4], [/^[億亿]$/, 1e8]];
  function findAmount(text) {
    const t = asciiDigits(text);
    // digits with separators; a space only separates thousands when exactly three digits follow it
    const m = t.match(/\d(?:\d|[.,'’](?=\d)|[   ](?=\d{3}(?!\d)))*/);
    if (!m) return null;
    let raw = m[0].replace(/[   '’]/g, '');
    const dots = (raw.match(/\./g) || []).length, commas = (raw.match(/,/g) || []).length;
    if (dots && commas) {
      const dec = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
      raw = raw.split(dec === '.' ? ',' : '.').join('').replace(',', '.');
    } else if (commas) {
      // "1,500" and Indian "2,00,000" group thousands; "12,5" and "13,16" are decimals
      raw = /^\d{1,3}(?:,\d{3})+$|^\d{1,2}(?:,\d{2})*,\d{3}$/.test(raw) || commas > 1 ? raw.replace(/,/g, '') : raw.replace(',', '.');
    } else if (dots > 1 || (dots === 1 && /^\d{1,3}\.\d{3}$/.test(raw) && !THREE_DECIMALS.test(t))) {
      // "1.500.000" and "1.500 €" group thousands; nobody writes money with three decimals
      raw = raw.replace(/\./g, '');
    }
    let n = parseFloat(raw);
    if (!isFinite(n)) return null;
    let end = m.index + m[0].length;
    const mult = t.slice(end).match(/^\s*([a-z]+|[万萬億亿])(?![a-z\d])/i);
    if (mult) {
      const hit = MULTIPLIERS.find(([rx]) => rx.test(mult[1]));
      // "/m" after a number is "per month", not million
      if (hit && !(hit[1] === 1e6 && /^m$/i.test(mult[1]) && /\/\s*$/.test(t.slice(0, m.index)))) { n *= hit[1]; end += mult[0].length; }
    }
    return { n: Math.round(n * 100) / 100, index: m.index, end, text: t };
  }
  const money = s => { const a = findAmount(s); return a ? a.n : null; };

  // "$1,500/month", "50 per day", "Monthly budget: 1500 (about 49/day)" -> { daily, basis, amount }
  function parseBudget(label, value) {
    // "£1,500 pcm", "£900 p/m", "₹2,00,000 p.m." are monthly
    const t = asciiDigits(value)
      .replace(/(^|[\s\d])(?:pcm|p\.\s?m\.?|p\/m|per calendar month)(?=[\s).;]|$)/gi, '$1 per month')
      .replace(/(^|[\s\d])(?:p\.\s?a\.?|p\/a)(?=[\s).;]|$)/gi, '$1 per year')
      .replace(/(^|[\s\d])(?:p\/d|p\.\s?d\.)(?=[\s).;]|$)/gi, '$1 per day')
      // "$3k/m", and day or month words in other languages: Polish, Turkish, Malay/Indonesian, Arabic, Urdu, Hindi, Chinese, Japanese
      .replace(/\/\s*m(?![\p{L}])/giu, ' per month')
      .replace(/(?<![\p{L}])(?:dziennie|dzie[nń]|günlük|gün|harian|sehari|hari)(?![\p{L}])|يومياً|يوميا|يومي|في اليوم|روزانہ|روزانه|प्रतिदिन|दैनिक|每天|每日|\/\s*[日天]/giu, ' per day')
      .replace(/(?<![\p{L}])(?:miesięcznie|miesiąc|mies|aylık|bulanan|sebulan|bulan)(?![\p{L}])|شهرياً|شهريا|شهري|في الشهر|ماہانہ|ماهانه|मासिक|प्रति माह|每月|\/\s*月/giu, ' per month');
    const a = findAmount(t);
    if (!a) return null;
    const m = { index: a.index, 0: t.slice(a.index, a.end) };
    const amount = a.n;
    // English plus the common Spanish, Portuguese, French, German, Italian and Dutch words
    const unitOf = w => /^(?:d|tag|jour|giorno|dag)/i.test(w) ? 'daily' : /^(?:mo|mth|month|mes|mês|monat|mois|mese|maand)/i.test(w) ? 'monthly' : /^(?:w|semana|semaine|woche)/i.test(w) ? 'weekly' : 'yearly';
    const UNIT = /(?:\/\s*|per\s+|a\s+|an\s+|each\s+|every\s+|por\s+|al\s+|par\s+|pro\s+)?(?<![\p{L}\d])(day|daily|d|month|monthly|mo|mth|week|weekly|wk|year|yr|annual|annually|d[ií]a|diario|tag|t[äa]glich|jour|giorno|dag|mes|mês|mensual|mensal|monat|monatlich|mois|mensuel|mese|maand|semana|semaine|woche|año|ano|jahr|an)(?![\p{L}\d])/iu;
    let basis = null;
    const after = t.slice(m.index + m[0].length).match(new RegExp('^\\s*' + UNIT.source, 'iu'));
    if (after) basis = unitOf(after[1]);
    const before = t.slice(0, m.index);
    if (!basis && /\b(?:daily|per day|a day)\b/i.test(before)) basis = 'daily';
    if (!basis && /\b(?:monthly|per month|a month)\b/i.test(before)) basis = 'monthly';
    if (!basis && /\bweekly\b/i.test(before)) basis = 'weekly';
    if (!basis) {
      const l = String(label || '').toLowerCase();
      if (/month/.test(l)) basis = 'monthly'; else if (/week/.test(l)) basis = 'weekly'; else if (/annual|year/.test(l)) basis = 'yearly'; else if (/\bday\b|daily/.test(l)) basis = 'daily';
    }
    if (!basis) {
      // only trust a unit elsewhere in the value when it is not inside an aside like "(about $1,520/month)"
      const bare = t.replace(/\([^)]*\)/g, ' ');
      const units = bare.match(new RegExp(UNIT.source, 'giu')) || [];
      if (units.length === 1) basis = unitOf(units[0].replace(/^(?:\/\s*|per\s+|a\s+|an\s+|each\s+|every\s+|por\s+|al\s+|par\s+|pro\s+)/i, ''));
    }
    const div = { daily: 1, monthly: 30.4, weekly: 7, yearly: 365 }[basis || 'daily'];
    return { daily: Math.round((amount / div) * 100) / 100, basis: basis || 'unlabeled', amount };
  }

  const BID_NAMES = { maxclicks: 'Maximize clicks', maxconv: 'Maximize conversions', tcpa: 'Maximize conversions with a target CPA', manual: 'Manual CPC' };
  // Every bid strategy the text mentions, in the order written.
  function bidMentions(v) {
    const t = String(v);
    const found = [];
    const add = (k, rx) => { let m; const r = new RegExp(rx.source, 'gi'); while ((m = r.exec(t))) found.push({ k, at: m.index }); };
    add('tcpa', /target\s*cpa|\btcpa\b|target cost per (?:acquisition|conversion|lead)/);
    add('maxconv', /maxim\w*\s*conv/);
    add('maxclicks', /maxim\w*\s*clicks?/);
    // "a manual CPC ceiling" is a limit on Maximize clicks, not the Manual CPC strategy
    add('manual', /\bmanual\s*(?:cpc|bidding|bids?)\b(?!\s*(?:ceiling|cap|limit|bid limit))|^\s*manual\s*$|\benhanced\s*cpc\b/);
    found.sort((a, b) => a.at - b.at);
    // "Maximize conversions with a target CPA of $45" is one strategy: target CPA
    const joined = /maxim\w*\s*conv\w*\s*(?:\(|with|using|at|and|plus)\s*(?:an?\s*)?(?:target\s*cpa|tcpa)/i.exec(t);
    if (joined) { const i = found.findIndex(f => f.at === joined.index); if (i >= 0) found[i].k = 'tcpa'; }
    // "..., starting on Maximize clicks" names the launch strategy even when it is written second
    const start = found.find(f => /\b(?:start(?:ing|s)?|launch(?:ing)?|begin(?:ning)?|initially|first|open(?:ing)?)\s+(?:\w+\s+){0,2}(?:on|with|using)?\s*$/i.test(t.slice(Math.max(0, f.at - 30), f.at)));
    if (start && start !== found[0]) { found.splice(found.indexOf(start), 1); found.unshift(start); }
    return found;
  }
  function parseBid(v) {
    const list = bidMentions(v);
    return list.length ? list[0].k : null;
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
    ['displayPath', /^(?:display\s+)?(?:url\s+)?paths?$|^display\s+url$/],
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
  // "/ac-repair/plano" or "site.com/Truck-Accident/Lawyer" -> ['ac-repair', 'plano']
  const splitDisplayPath = v => {
    let t = norm(v).replace(/^https?:\/\//i, '');
    if (/^[\w-]+(?:\.[\w-]+)+\//.test(t)) t = t.slice(t.indexOf('/'));
    const parts = t.split('/').map(x => cleanPath(x)).filter(Boolean);
    return [parts[0] || '', parts[1] || ''];
  };
  const cleanPath = v => norm(v).replace(/[.;,]+$/, '').replace(/^\/+|\/+$/g, '').replace(/\s+/g, '-');

  function settingFrom(label, value) {
    const k = settingLabel(label);
    if (!k) return null;
    const v = norm(value);
    if (!v) return null;
    switch (k) {
      case 'budget': { const b = parseBudget(label, v); return b ? { k, v: b } : null; }
      case 'targetCpa': case 'maxCpc': { const n = money(v); return n == null ? null : { k, v: n }; }
      case 'bidStrategy': {
        const list = bidMentions(v);
        if (!list.length) return null;
        const b = list[0].k;
        const n = b === 'tcpa' ? money(v.slice(list[0].at)) : null;
        const later = list.map(x => x.k).find(x => x !== b) || null;
        const ceiling = b === 'maxclicks' && /(?:cpc|bid)\s*(?:ceiling|cap|limit)|max(?:imum)?\s*cpc\s*(?:bid\s*)?limit/i.test(v);
        return { k, v: b, targetCpa: n, later, ceiling };
      }
      case 'matchType': { const mt = parseMatch(v); return mt ? { k, v: mt } : null; }
      case 'finalUrl': { const u = findUrl(v); return u ? { k, v: u } : null; }
      case 'locations': {
        const r = parseLocations(v);
        // a long sentence is not a place; "Dubai Hills Estate, Dubai, United Arab Emirates" is
        const list = r.list.filter(l => l.id || l.name.split(',')[0].trim().split(' ').length <= 5);
        return list.length || r.presence != null ? { k, v: list, presence: r.presence, notes: r.notes } : null;
      }
      case 'languages': {
        const parts = v.split(/,|;|\/|\band\b|&|\+/i).map(x => norm(x).replace(/[.!:;]+$/, '')).filter(Boolean);
        const find = p => { const f = LANGS.find(([c, n]) => c.toLowerCase() === p.toLowerCase() || n.toLowerCase() === p.toLowerCase() || n.toLowerCase().split(' ')[0] === p.toLowerCase()); return f ? f[0] : null; };
        const codes = parts.map(find).filter(Boolean);
        const unknown = parts.filter(p => !find(p) && /^[\p{L} ()-]{3,30}$/u.test(p) && p.split(' ').length <= 3);
        return codes.length ? { k, v: [...new Set(codes)], unknown } : null;
      }
      case 'networks': {
        const no = /\b(no|exclude[sd]?|off|without|not|disabled?|false)\b/i.test(v);
        if (/partner/i.test(label)) return { k, v: !no && /\b(yes|on|include[sd]?|enabled?|true)\b/i.test(v) };
        return { k, v: /partner/i.test(v) && !no };
      }
      case 'presence': return /presence|interest/i.test(v) ? { k, v: !/interest/i.test(v) || /presence only/i.test(v) } : null;
      case 'startDate': { const d = parseDate(v); return d ? { k, v: d.date, ambiguous: !!d.ambiguous, raw: v } : null; }
      case 'path1': case 'path2': return { k, v: cleanPath(v) };
      case 'displayPath': { const p = splitDisplayPath(v); return p[0] ? { k, v: p } : null; }
    }
    return null;
  }

  function matchSetting(line) {
    const t = norm(line).replace(/\*\*|__/g, '');
    const m = t.match(/^([^:=]{1,60}?)\s*(?::|=|\s[-–—]\s|[–—]|\t)\s*(.+)$/);
    if (m) return settingFrom(m[1], m[2]);
    // "Budget 20/day", "Daily budget $40" written without a colon
    const b = t.match(/^((?:daily |monthly |weekly |total )?budget)\s+(?=[$€£₹¥\d]|(?:usd|aed|gbp|eur|inr|pkr|cad|aud|rs\.?)\s*\d)(.{1,60})$/i);
    return b ? settingFrom(b[1], b[2]) : null;
  }

  /* ---------- keywords and ad text ---------- */

  function parseKeyword(raw, matchHint) {
    // "-truck rental": the minus that marks a negative is not part of the keyword
    let t = norm(raw).replace(STRIP_NUM, '').replace(TRAIL_COUNT, '').replace(/^-(?=[^\s-])/, '');
    let match = null, m;
    if ((m = t.match(/^\[(.+)\]$/))) { t = m[1]; match = 'exact'; }
    else if ((m = t.match(/^"(.+)"$/))) { t = m[1]; match = 'phrase'; }
    else if (/^\+\S/.test(t)) { t = t.replace(/(^|\s)\+/g, '$1'); match = 'broad'; }
    else if ((m = t.match(/^(.*?)\s*(?:[([]\s*(exact|phrase|broad)(?:\s*match)?\s*[)\]]|[|–—]\s*(exact|phrase|broad)(?:\s*match)?|\s-\s(exact|phrase|broad)(?:\s*match)?)$/i))) {
      t = m[1]; match = (m[2] || m[3] || m[4]).toLowerCase();
    }
    // a list's or table's match type fills in keywords without one; [exact] or "phrase" written on the keyword wins
    if (matchHint && !match) { const mh = parseMatch(matchHint); if (mh && mh !== 'phrase+exact') match = mh; }
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
    // "Boiler Repair - Manchester (campaign negatives)"
    if (/\(\s*(?:campaign |account |ad ?group |shared )?(?:level )?negatives?(?: key ?words?)?\s*\)/i.test(norm(cell))) return 'negatives';
    // a column header is a few words; "Search Network only, no Search Partners at this budget." is a value
    if (!t || t.split(' ').length > 8 || /[.!?]$/.test(norm(cell))) return null;
    if (/^(?:#|no|no\.|sr|sr\.|s\.? ?no\.?|sl|serial|chars?|characters?|char(?:acter)? count|count|length|len|character length|status|notes?|comments?|why|reasons?|rationale|explanation|purpose|pin(?:ned)?|position|priority|rank|volume|search volume|avg\.? monthly searches|monthly searches|searches|competition|competition index|cpc|avg\.? cpc|est\.? cpc|top of page bid.*|bid range|intent|difficulty|kd|trend|source|type|value)$/.test(t)) return 'ignore';
    if (/^(?:sitelinks?(?: text| title| name| link text)?|callouts?(?: text)?|structured snippets?|snippets?(?: values?| header)?|extensions?|assets?(?: type)?|promotions?(?: text)?|price(?: assets?)?|image(?: assets?)?|call (?:asset|extension)s?)$/.test(t)) return 'asset';
    if (/^(?:platform|channel|network|ad platform|media|source platform)$/.test(t)) return 'platform';
    if (/^(?:applied to|apply to|applies to|scope|level|used in|use in|campaigns? applied)$/.test(t)) return 'scope';
    if (/^(?:bid(?:ding)?(?: strategy)?|bidding strategy|bid type|strategy)$/.test(t)) return 'bid';
    if (/^(?:target cpa|tcpa|cpa target|target cost per (?:acquisition|conversion|lead))$/.test(t)) return 'tcpa';
    if (/^campaigns?(?: name)?$/.test(t)) return 'campaign';
    if (/^(?:ad ?groups?|adgroup)(?: name| theme)?$|^theme$|^ag$/.test(t)) return 'adgroup';
    if (/negative|^negs?$/.test(t)) return 'negatives';
    if (/^(?:match(?: type)?|criterion type|kw match type|keyword match type)$/.test(t)) return 'match';
    if (/^(?:exact|phrase|broad)(?: match)?(?: key ?words?| kws?| terms?)?$/.test(t)) return 'keywords';
    if (/^(?:target |core |primary |seed |suggested |recommended )?(?:key ?words?|key ?phrases?|search terms?|kws?)(?: text| list)?$/.test(t)) return 'keywords';
    if (/^(?:rsa |ad )?headlines?(?: ?\d{1,2})?(?: text)?$|^h ?\d{1,2}$|^titles?$/.test(t)) return 'headlines';
    if (/^(?:rsa |ad )?(?:descriptions?|description lines?|desc)(?: ?\d{1,2})?(?: line \d)?(?: text)?$|^d ?\d{1,2}$/.test(t)) return 'descriptions';
    if (/^(?:final ?urls?|landing pages?(?: urls?)?|lp(?: url)?|destination(?: url)?|urls?)$/.test(t)) return 'finalUrl';
    if (/^(?:display )?(?:url )?paths?$|^display url$/.test(t)) return 'displayPath';
    if (/^(?:display )?(?:url )?path ?1$/.test(t)) return 'path1';
    if (/^(?:display )?(?:url )?path ?2$/.test(t)) return 'path2';
    if (/budget/.test(t) && t.split(' ').length <= 5) return 'budget';
    if (/^(?:target )?(?:locations?|geos?|geo targeting|location targeting|geography|countries|cities|regions?|markets?)$/.test(t)) return 'locations';
    if (/^(?:target )?languages?$/.test(t)) return 'languages';
    if (/^(?:(?:starting|initial|default|ad group|campaign|launch)\s+)?(?:max\.? ?cpc|max(?:imum)? cpc(?: bid)?|cpc bid|default bid|max bid)$/.test(t)) return 'maxCpc';
    return null;
  }
  const COPY_FIELDS = new Set(['keywords', 'negatives', 'headlines', 'descriptions']);
  // the budget column to read: the doc's own daily figure when it gives one
  const budgetCol = (head, fields) => {
    const cols = fields.map((f, i) => f === 'budget' ? i : -1).filter(i => i >= 0);
    return cols.find(i => /daily|per day|\/\s*day/i.test(head[i] || '')) ?? (cols.length ? cols[0] : -1);
  };

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
    // a key that explains the doc's own layout: "Section | Table Headers | One Row Equals", or cells listing "Campaign | Ad Group | Keyword"
    const h0 = (rows[0] || []).map(c => norm(c).toLowerCase());
    const legendHead = /^(?:sections?|tables?|tabs?|sheets?|parts?|blocks?|terms?|columns?|fields?)$/.test(h0[0] || '')
      && h0.slice(1).some(c => /\b(?:headers?|columns?|format|meaning|means|description|explanation|purpose|contains|equals|definition)\b/.test(c));
    if (legendHead) return { kind: 'legend', rows };
    // header row: the first of the first 3 rows with the most recognised field columns
    let hi = -1, best = 0;
    for (let r = 0; r < Math.min(3, rows.length); r++) {
      const f = rows[r].map(hdrField).filter(x => x && x !== 'ignore').length;
      if (f > best) { best = f; hi = r; }
    }
    // with no header the tool knows, cells that list "Campaign | Ad Group | Keyword" describe a layout
    // ("MH | Cancer | Search" as a campaign name under a Campaign header is data)
    const pipeRows = rows.slice(1).filter(r => r.some(c => /\S \| \S/.test(c))).length;
    if (hi < 0 && rows.length >= 4 && pipeRows >= (rows.length - 1) * 0.6) return { kind: 'legend', rows };
    const fields = hi >= 0 ? rows[hi].map(hdrField) : [];
    const has = f => fields.includes(f);
    if (hi >= 0) {
      const head = rows[hi].map(c => norm(c).toLowerCase());
      const ei = head.findIndex(c => /^(?:assets?|asset type|elements?|fields?|components?|types?|items?|ad elements?|copy elements?)$/.test(c));
      const vi = head.findIndex(c => /^(?:text|copy|value|content|asset text|ad text|copy text)$/.test(c));
      if (ei >= 0 && vi >= 0) {
        const labels = rows.slice(hi + 1).map(r => norm(r[ei] || '')).filter(Boolean);
        const copyish = labels.filter(l => NUMBERED_ONLY.test(l) || /^(?:headline|description|desc|h|d)\s*\d{1,2}$|^(?:headlines?|descriptions?|keywords?|kws?|negatives?|negative keywords?|final url|landing page|path\s*[12]|display path)$/i.test(l)).length;
        if (labels.length && copyish >= labels.length * 0.5) return { kind: 'longcopy', rows: rows.slice(hi), ei, vi, ci: fields.indexOf('campaign'), ai: fields.indexOf('adgroup') };
      }
    }
    if (has('asset')) return { kind: 'assets', rows };
    // "Attribute | Meta | Google": a comparison between platforms, not ad content
    const head0 = rows[0] || [];
    const PLAT = /^(?:meta|facebook|instagram|fb|ig|google(?: ads| search)?|search|microsoft(?: ads| advertising)?|bing|linkedin|tik ?tok|youtube|pinterest|snapchat|social|display|pmax|performance max)$/i;
    const valueHeads = head0.slice(1).filter(Boolean);
    if (valueHeads.length && valueHeads.every(c => PLAT.test(norm(c))) && (valueHeads.length >= 2 || !head0[0] || /attribute|item|element|setting|feature|platform/i.test(head0[0]))) return { kind: 'comparison', rows };
    const headCells = hi >= 0 ? rows[hi].filter(Boolean) : [];
    const headerish = hi >= 0 && (fields.filter(f => f && f !== 'ignore').length >= 2
      || ((has('campaign') || has('adgroup')) && headCells.every(c => hdrField(c) || isFieldLabel(c) || HEADER_CELL.test(c))));
    const firstCol = rows.map(r => r[0] || '').filter(Boolean);
    const labels = firstCol.filter(isFieldLabel).length;
    if (!headerish && labels >= 2 && labels >= firstCol.length * 0.5) {
      const head = rows[0];
      const rest = head.slice(1).filter(Boolean);
      const cornerOk = !head[0] || /^(?:fields?|elements?|items?|assets?|components?|types?|labels?|attributes?|parts?|sections?|ad groups?)$/i.test(head[0]);
      const multi = cornerOk && rest.length >= 1 && rest.every(c => !isFieldLabel(c) && hdrField(c) !== 'ignore')
        && (rest.length >= 2 || !head[0] || /ad groups?/i.test(head[0]));
      // does it hold ad content, or only settings ("Website | ...", "Bid strategy | ...")?
      const hasCopy = firstCol.some(c => { const t = norm(c); if (NUMBERED_ONLY.test(t) || /^(?:headline|description|desc|h|d)\s*\d{1,2}$/i.test(t)) return true; const sl = sectionLabel(t); return !!(sl && !sl.inline && COPY.has(sl.sec)); });
      return { kind: 'kv', rows, multi, hasCopy };
    }
    if (hi < 0) return { kind: 'plain', rows };
    const copy = [...COPY_FIELDS].some(has);
    const agCol = has('adgroup'), campCol = has('campaign');
    if (campCol && agCol && !copy && !has('finalUrl')) return { kind: 'mapping', rows, hi, fields };
    if (campCol && has('budget') && !copy && !agCol) return { kind: 'budgets', rows, hi, fields };
    if (copy || has('finalUrl') || has('path1') || has('path2') || has('displayPath') || has('maxCpc')) return { kind: 'records', rows, hi, fields, copy, agCol, campCol };
    return { kind: 'plain', rows };
  }

  /* ---------- 3. Blocks -> parse result ---------- */

  // "1.3 Campaign 1: ..." or "2. Meta Ads" -> drop the outline number before reading the label
  const OUTLINE = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[ivx]{1,4}\.)\s+(?=\S)/i;
  const stripOutline = t => norm(t).replace(OUTLINE, '');

  // Sections for other ad platforms or other Google campaign types. Their content is skipped as one unit so that,
  // for example, Meta "Headlines" never end up in a Google Search ad.
  const PLATFORMS = [
    ['Meta', /\b(?:meta|facebook|fb|instagram|ig)\b/i],
    ['LinkedIn', /\blinkedin\b/i], ['TikTok', /\btik\s?tok\b/i], ['Pinterest', /\bpinterest\b/i], ['Snapchat', /\bsnapchat\b/i],
    ['X (Twitter)', /\b(?:twitter|x ads)\b/i], ['Reddit', /\breddit\b/i],
    ['Microsoft Ads', /\b(?:microsoft\s+(?:ads|advertising)|bing(?:\s+ads)?)\b/i],
    ['Google Display', /\bdisplay\b/i], ['Performance Max', /\b(?:performance max|p\s?max)\b/i], ['YouTube', /\byoutube\b/i],
    ['Demand Gen', /\b(?:demand gen|discovery)\b/i], ['Google Shopping', /\bshopping\b/i], ['social media', /\bsocial(?: media)?\b/i]
  ];
  const PLAIN_PLATFORM = /^(?:facebook|meta|instagram|fb|tik\s?tok|linkedin|pinterest|snapchat|twitter|reddit|microsoft|bing|youtube)\b/i;
  const PLATFORM_CONTEXT = /\b(?:ads?|advertising|campaigns?|targeting|ad sets?|audiences?|creatives?|retargeting|remarketing|funnel|placements?)\b/i;
  function platformOf(text) {
    const t = stripOutline(text);
    const hasPlat = PLATFORMS.some(([, rx]) => rx.test(t));
    if (hasPlat && /\b(?:vs\.?|versus|compared?|comparison)\b/i.test(t)) return 'comparison';
    // "Google Search & Meta Ads" or "Google + Meta Campaign Structure" also covers Search
    if (/\b(?:search|google|ppc|sem|adwords)\b/i.test(t)) return null;
    for (const [name, rx] of PLATFORMS) {
      const m = t.match(rx);
      if (!m) continue;
      const rest = t.replace(m[0], ' ').replace(/[^\p{L}\s]/gu, ' ').trim();
      if (PLATFORM_CONTEXT.test(t) || !rest) return name;
    }
    return null;
  }

  function classify(b, mem) {
    if (b.t === 'table') return { k: 'table', level: 99 };
    const text = b.t === 'li' ? b.text : stripOutline(b.text);
    const isLi = b.t === 'li';
    const level = b.t === 'h' ? b.level : (b.t === 'p' && b.bold ? 7 : (isLi ? 10 : 9));
    // "{KeyWord:Dental Implants}" is a headline with keyword insertion, not a "Keyword:" label
    if (/^\{\s*keyword\s*:/i.test(text)) return { k: 'text', level };
    const lk = labelKey(text);
    const role = mem && lk && Object.prototype.hasOwnProperty.call(mem, lk) ? mem[lk] : null;
    if (role) {
      if (ROLE_SECTIONS.has(role)) return { k: 'section', sec: role, inline: '', level, taught: true, hint: role === 'settings' ? settingsHint(lk) : null, matchHint: parseMatch(text) };
      if (role === 'adgroup') return { k: 'adgroup', name: cleanName(text), level, taught: true };
      if (role === 'campaign') return { k: 'campaign', name: cleanCampaignName(text), level, taught: true };
      if (role === 'ignore') return { k: 'note', level };
    }
    let m;
    const sl = sectionLabel(text);
    if (text.length <= 140) {
      if (!isLi || AG_NUM.test(text)) {
        if ((m = text.match(AG_NUM)) || (!isLi && ((m = text.match(AG_ABBR)) || (m = text.match(AG_NAMED))))) {
          const name = cleanName(m[m.length - 1]);
          const asSection = sectionLabel(name);
          if (asSection && !asSection.inline && !asSection.weak) return { k: 'section', sec: asSection.sec, inline: '', level, matchHint: parseMatch(text) };
          if (name && !/^level\b/i.test(name)) return { k: 'adgroup', name, level };
        }
        if (!isLi && (m = text.match(AG_ONLY))) return { k: 'adgroup', name: 'Ad group ' + m[1], level };
        if (!isLi && (m = text.match(AG_LIST))) return { k: 'aglist', names: m[1], level };
        if (!isLi && ((m = text.match(CAMP_NUM)) || (m = text.match(CAMP_NAMED)))) {
          const name = tidyCampaign(cleanName(m[1]));
          const asSection = sectionLabel(name);
          if (name && !/^level\b/i.test(name) && !(asSection && !asSection.weak) && !settingLabel(name)) return { k: 'campaign', name, level };
        }
      }
      if ((m = text.match(NUMBERED)) || (!(b.t === 'h') && (m = text.match(NUMBERED_HD)))) {
        return { k: 'numbered', sec: /^h/i.test(m[1]) ? 'headlines' : 'descriptions', text: m[3], level };
      }
      if (!isLi && (m = text.match(NUMBERED_ONLY))) return { k: 'section', sec: /^h/i.test(m[1]) ? 'headlines' : 'descriptions', inline: '', level, single: true };
      if (sl && !sl.inline && (!isLi || /:\s*$/.test(text))) {
        return { k: 'section', sec: sl.sec, weak: sl.weak, inline: '', level, hint: sl.sec === 'settings' ? settingsHint(lk) : null, matchHint: parseMatch(text) };
      }
    }
    {
      const s = matchSetting(text);
      if (s) return { k: 'setting', s, level };
      const kv = norm(text).match(/^([^:=]{1,60}?)\s*(?::|=|\s[-–—]\s|[–—])\s*(.+)$/);
      if (kv && settingLabel(kv[1]) === 'finalUrl') return { k: 'lpnote', level };
      // "Note: ..." or "Sitelinks: ..." on one line is a single note; it does not start a section
      if (sl && sl.inline && sl.sec === 'other') return { k: 'inlineNote', label: sl.label, level };
      // "Sample RSA Headlines (30 char max) — 12 of 15": a count after the label is not an ad group or an item
      if (sl && sl.inline && sl.sec !== 'settings' && isCountNote(sl.inline)) return { k: 'section', sec: sl.sec, weak: sl.weak, inline: '', level, matchHint: parseMatch(sl.label || '') };
      if (sl && sl.inline && sl.sec !== 'settings') {
        if (sl.sep === 'dash' && (b.t === 'h' || (b.t === 'p' && b.bold))) {
          return { k: 'section', sec: sl.sec, weak: sl.weak, inline: '', qualifier: sl.inline, level, matchHint: parseMatch(sl.inline) || parseMatch(sl.label || '') };
        }
        return { k: 'section', sec: sl.sec, weak: sl.weak, inline: sl.inline, level, matchHint: parseMatch(sl.label || '') };
      }
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
      // each spreadsheet tab is its own range
      for (let j = i + 1; j < n; j++) if (((cls[j].k === 'heading' || cls[j].k === 'adgroup' || cls[j].k === 'campaign') && lvl(j) <= L) || blocks[j].sheet) return j;
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
          if ((t.kind === 'records' && t.agCol) || (t.kind === 'kv' && t.multi)) ags++;
          else if ((t.kind === 'records' && t.copy && t.fields.some(f => f === 'keywords' || f === 'headlines' || f === 'descriptions')) || (t.kind === 'kv' && t.hasCopy)) copy++;
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

  const isCaps = x => { const l = String(x).replace(/[^A-Za-z]/g, ''); return l.length >= 4 && l === l.toUpperCase(); };

  function markPlatforms(blocks, cls, shapes) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i], c = cls[i];
      // a plain-text paste has no headings, so "Meta Ads" or "Facebook / Meta Ads (for reference only)" on its own line counts too
      const plainHead = b.t === 'p' && !b.bold && PLAIN_PLATFORM.test(b.text) && b.text.split(/\s+/).length <= 14 && !/[.!?]$/.test(b.text);
      if (!(b.t === 'h' || (b.t === 'p' && b.bold) || plainHead) || c.taught || c.k === 'platformSkip') continue;
      const name = platformOf(b.text);
      if (!name || (plainHead && name === 'comparison')) continue;
      const L = c.level;
      let end = i + 1;
      if (b.t === 'h') {
        while (end < blocks.length && !((blocks[end].t === 'h' || (blocks[end].t === 'p' && blocks[end].bold)) && cls[end].level <= L)) end++;
      } else if (plainHead) {
        // runs to the next Google part: a campaign, ad group, keyword, negative, settings or notes label, or a line about Google
        while (end < blocks.length) {
          const e = blocks[end], ec = cls[end];
          if (e.t === 'h' || (e.t === 'p' && e.bold) || e.t === 'table') break;
          if (ec.k === 'campaign' || ec.k === 'adgroup' || ec.k === 'aglist') break;
          if (ec.k === 'section' && /^(?:keywords|negatives|settings|other)$/.test(ec.sec) && !ec.inline) break;
          if (/\b(?:google|search ads?|ppc|adwords)\b/i.test(e.text || '')) break;
          end++;
        }
      } else {
        // a bold-line doc: the section runs to the next heading, the next ALL-CAPS divider when this one is in capitals,
        // or the next bold line about Google or another platform
        const caps = isCaps(b.text);
        while (end < blocks.length) {
          const e = blocks[end];
          if (e.t === 'h') break;
          if (e.t === 'p' && e.bold && (caps ? isCaps(e.text) : (platformOf(e.text) || /\b(?:google|search|ppc|adwords)\b/i.test(e.text)))) break;
          end++;
        }
      }
      // a section with keyword lists is Google Search content about that platform (e.g. "Instagram Marketing Services")
      let hasKeywords = false;
      for (let j = i + 1; j < end; j++) {
        if ((cls[j].k === 'section' && cls[j].sec === 'keywords') || (shapes[j] && shapes[j].kind === 'records' && shapes[j].fields.includes('keywords'))) hasKeywords = true;
      }
      if (hasKeywords) continue;
      cls[i] = { k: 'platform', name, level: L, count: end - i - 1, comparison: name === 'comparison' };
      for (let j = i + 1; j < end; j++) cls[j] = { k: 'platformSkip', level: cls[j].level };
      i = end - 1;
    }
  }

  function parseBlocks(blocks, opts) {
    opts = opts || {};
    const res = {
      title: '', campaignHint: '', mapping: [], adGroups: [], accountNegatives: [], campaignNegatives: {}, campaignNegNames: {}, campaignLocations: {},
      settings: {}, campaignBudgets: {}, campaignBids: {}, campaignUrls: {}, campaignLangs: {}, campaignMaxCpc: {}, globalBudget: null, agProps: [], notes: [], skipped: []
    };
    const cls = blocks.map(b => classify(b, opts.memory));
    const shapes = blocks.map(b => b.t === 'table' ? tableShape(b.rows) : null);
    markPlatforms(blocks, cls, shapes);
    inferStructure(blocks, cls, shapes);
    // blank lines only mark sections in a paste where most lines run together
    const gapsMean = blocks.filter(b => b.gapBefore).length < blocks.length * 0.4;

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
      const a = Object.assign({ name: nm, campHint: ch, keywords: [], negatives: [], headlines: [], descriptions: [], finalUrl: '', path1: '', path2: '', maxCpc: null, matchType: null }, flags || {});
      res.adGroups.push(a);
      return a;
    };
    const ensureAg = () => {
      if (!ag && secInfo && secInfo.pendingAg) ag = getAg(secInfo.pendingAg, campCtx);
      if (!ag) ag = getAg(campCtx || res.campaignHint || ('Ad group ' + (res.adGroups.length + 1)), campCtx, { implicit: true });
      return ag;
    };
    const campBucket = name => {
      const k = key(name);
      if (!res.campaignNegNames[k]) res.campaignNegNames[k] = norm(name);
      return (res.campaignNegatives[k] = res.campaignNegatives[k] || []);
    };
    const negList = (scope, target) => {
      if (scope === 'account') return res.accountNegatives;
      if (scope === 'campaign') {
        const name = target || campCtx;
        return name ? campBucket(name) : res.accountNegatives;
      }
      if (scope === 'adgroup' && target) return getAg(target, campCtx).negatives;
      return ensureAg().negatives;
    };
    const ACCOUNT_WORDS = /\b(?:all|every|both|each)\b[^.]*\bcampaigns?\b|\b(?:account|shared|global|universal|master|common)\b/i;
    // "Account level (all campaigns):", "Panchakarma – Bengaluru only:", "Apply at the account level:" inside a negatives list
    const retargetNegatives = text => {
      const t = norm(text).replace(/:\s*$/, '');
      if (ACCOUNT_WORDS.test(t) || /^(?:all|every)\b/i.test(t)) { secInfo.scope = 'account'; secInfo.target = null; return true; }
      const name = norm(t.replace(/\([^)]*\)/g, ' ').replace(/\b(?:only|negatives?|negative key ?words?|key ?words?|level|list|for|apply to|applied to|add to|campaign|ad ?group)\b/gi, ' ').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, ''));
      if (!name || !isNameLike(name)) return false;
      // a campaign and an ad group can share a name ("Ayurvedic Doctor – Pune"); "only" lists are usually for the campaign
      const isCamp = res.mapping.some(m => key(m.campaign) === key(name)) || res.adGroups.some(a => a.campHint && key(a.campHint) === key(name));
      if (/\bad ?group\b/i.test(t) || (!isCamp && res.adGroups.some(a => key(a.name) === key(name)))) { secInfo.scope = 'adgroup'; secInfo.target = name; return true; }
      if (isCamp || /\b(?:only|campaign)\b/i.test(t)) { secInfo.scope = 'campaign'; secInfo.target = name; return true; }
      // "Competitor Names": a named list, not a campaign; it keeps the scope of the list it sits in
      secInfo.scope = secInfo.baseScope; secInfo.target = secInfo.baseTarget;
      return true;
    };
    const negScope = (b, text) => {
      if (/\bad[\s-]?groups?\b/i.test(text)) return 'adgroup';
      if (ACCOUNT_WORDS.test(text)) return 'account';
      if (/\bcampaigns?\b/i.test(text)) return 'campaign';
      if (/\b(?:all|every)\b/i.test(text)) return 'account';
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
      const n = adLen(t);
      if (s === 'headlines') {
        if (n > (isLi ? 45 : 40)) return 'too long for a headline (' + n + ' characters)';
        return null;
      }
      if (n < (isLi ? 15 : 20)) return 'too short for a description (' + n + ' characters)';
      if (n > (isLi ? 120 : 110)) return 'too long for a description (' + n + ' characters)';
      return null;
    };

    const addItem = (sec, rawText, isLi, matchHint, scope) => {
      const text = norm(rawText);
      if (!text) return {};
      let last = {};
      if (sec === 'keywords' || sec === 'negatives') {
        // [exact] keywords are wrapped in brackets, so only spelled-out notes and placeholders count here
        if (/^\(.*\)$/.test(text) || /^(?:note|notes|tip|tips|important|reminder|n\.?b\.?|todo|to do)\b\s*[:\-–—]/i.test(text)
          || /^(?:tbd|tba|todo|to do|n\/?a|none|total|subtotal|grand total)\b/i.test(text)) {
          return { skipIdx: skip(text, 'a note or placeholder, not a keyword', { kind: 'note' }) };
        }
        const core = keywordCore(text.replace(STRIP_NUM, ''));
        let parts = [core];
        if (core.includes(',') || /\s\/\s/.test(core)) {
          const p = core.split(/,(?!\d{3}\b)|\s+\/\s+/).map(norm).filter(Boolean);
          if (p.length > 1 && p.every(x => x.split(' ').length <= 8)) parts = p;
        }
        parts.forEach(p0 => {
          let p = keywordCore(p0);
          let s = sec;
          if (s === 'keywords' && /^-\S/.test(p)) { s = 'negatives'; p = p.slice(1); }
          const why = rejectKeyword(p, isLi);
          if (why) { last = { skipIdx: skip(p0, why) }; return; }
          const both = matchHint && parseMatch(matchHint) === 'phrase+exact';
          const kw = parseKeyword(p, both ? null : matchHint);
          if (!kw) return;
          const list = s === 'negatives'
            ? negList(scope || (secInfo && secInfo.scope) || (ag ? 'adgroup' : 'account'), secInfo && s === secInfo.sec ? secInfo.target : null)
            : ensureAg().keywords;
          const variants = both && !kw.match ? [{ text: kw.text, match: 'exact' }, { text: kw.text, match: 'phrase' }] : [kw];
          variants.forEach(v => { if (!list.some(x => x.text.toLowerCase() === v.text.toLowerCase() && x.match === v.match)) { list.push(v); last = { added: { list, value: v } }; } });
        });
        return last;
      }
      // judge the line once its pin note and character count are off: "Portland Dog Grooming (21) — Pin to position 1" is a headline
      const c = cleanCopy(text);
      if (!c && !isNoteLine(text)) return {};
      if (!c || isNoteLine(c)) return { skipIdx: skip(text, 'looks like a note, not ad text', { kind: /^(?:note|notes|tip|tips|important|reminder|n\.?b\.?|todo|tbd)\b/i.test(text) ? 'note' : 'item' }) };
      let pieces = [c];
      if ((sec === 'headlines' || sec === 'adcopy') && /\s\|\s/.test(c)) {
        const p = c.split(/\s+\|\s+/).map(norm).filter(Boolean);
        if (p.length > 1 && p.every(x => x.length <= 35)) pieces = p;
      }
      pieces.forEach(piece => {
        const s = sec === 'adcopy' ? (adLen(piece) <= 30 ? 'headlines' : 'descriptions') : sec;
        const why = rejectCopy(s, piece, isLi);
        if (why) {
          const suggest = s === 'headlines' && adLen(piece) <= 90 ? 'description' : s === 'descriptions' && adLen(piece) <= 30 ? 'headline' : null;
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
      if (k === 'displayPath') { if (ag) { ag.path1 = s.v[0]; ag.path2 = s.v[1]; } return; }
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
      if (k === 'bidStrategy') {
        if (campCtx) res.campaignBids[key(campCtx)] = { bid: s.v, targetCpa: s.targetCpa || null };
        else { res.settings.bidStrategy = s.v; if (s.targetCpa) res.settings.targetCpa = s.targetCpa; }
        if (s.later) res.notes.push({ level: 'info', msg: 'Bidding starts on ' + BID_NAMES[s.v] + ', as the doc says. The doc also plans a later move to ' + BID_NAMES[s.later] + '; make that change in Google Ads when the time comes.' });
        if (s.ceiling) res.notes.push({ level: 'info', msg: 'The doc mentions a CPC ceiling for Maximize clicks. Set the maximum CPC bid limit on each campaign in Ads Editor after import.' });
        return;
      }
      if (k === 'presence') { res.settings.presenceOnly = s.v; return; }
      if (k === 'startDate') {
        if (s.v) res.settings.startDate = s.v;
        else res.notes.push({ level: 'warn', msg: 'Start date "' + s.raw + '" could be day/month or month/day, so it was not used. Set it in Account defaults.' });
        return;
      }
      // languages under one campaign of several ("Campaign | Off-Plan" then "Languages | English, Arabic")
      if (k === 'languages' && s.unknown && s.unknown.length) res.notes.push({ level: 'warn', msg: 'Language "' + s.unknown.join('", "') + '" is not in the tool\'s list, so it was left out. Add it in Ads Editor if Google Ads offers it.' });
      if (k === 'languages' && campCtx) { res.campaignLangs[key(campCtx)] = { name: campCtx, v: s.v }; return; }
      if (k === 'languages' && inSettingsSection && secInfo && secInfo.langSeen && res.settings.languages) {
        res.settings.languages = [...new Set(res.settings.languages.concat(s.v))];
        return;
      }
      if (k === 'languages' && secInfo) secInfo.langSeen = true;
      if (k === 'matchType' && ag) { ag.matchType = s.v; return; }
      res.settings[k] = s.v;
    };
    // Settings that may sit inside an ad group's copy sections without ending them
    const COPY_SAFE_SETTINGS = new Set(['finalUrl', 'path1', 'path2', 'displayPath', 'maxCpc', 'budget', 'bidStrategy', 'targetCpa', 'matchType', 'startDate']);

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
      if (ag && b.t === 'li') ag.listLabels = true;
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
      // "Sitelinks" or "Account Settings" as a heading at the ad group's level closes that ad group
      if ((sec === 'other' || sec === 'settings') && b.t === 'h') {
        if (b.level <= agLevel) { ag = null; agLevel = 99; }
        if (b.level <= campLevel) { campCtx = null; campLevel = 99; }
      }
      // a bold divider such as "GOOGLE CAMPAIGN SETTINGS" in a bold-label doc ends the last campaign too
      if ((sec === 'other' || sec === 'settings') && b.t === 'p' && b.bold && (isCaps(b.text) || /\b(?:google|search|account|global|general|shared)\b/i.test(b.text))) {
        if (7 <= agLevel) { ag = null; agLevel = 99; }
        if (7 <= campLevel) { campCtx = null; campLevel = 99; }
      }
      // "Negative Keywords" as a heading above the campaign headings belongs to no campaign; "Ad Group Negatives" keeps its ad group
      if (sec === 'negatives' && b.t === 'h' && !/\bad[\s-]?groups?\b/i.test(b.text) && (ACCOUNT_WORDS.test(b.text) || !/\bcampaigns?\b/i.test(b.text))) {
        if (b.level <= campLevel) { campCtx = null; campLevel = 99; ag = null; agLevel = 99; }
      }
      // "Account Settings" speaks for the whole account, whatever heading sits above it
      if ((sec === 'settings' || sec === 'other') && ACCOUNT_WORDS.test(b.text)) { ag = null; agLevel = 99; campCtx = null; campLevel = 99; }
      section = sec;
      const outer = secInfo;
      secInfo = { sec, label: b.text, matchHint: c.matchHint || null, hint: c.hint || null, scope: null, target: null, itemTypes: new Set(), sheet: !!b.sheet,
        headLevel: b.t === 'h' ? b.level : (b.t === 'p' && b.bold ? 7 : null) };
      // "Shared Negative Keyword Lists" > "Master Negatives" > "Competitor Names": the lists under the top heading belong together
      if (sec === 'negatives' && b.t === 'h' && outer && outer.sec === 'negatives' && outer.headLevel != null && outer.headLevel < b.level) {
        secInfo.rootLevel = outer.rootLevel != null ? outer.rootLevel : outer.headLevel;
      }
      if (sec === 'negatives') {
        secInfo.scope = negScope(b, b.text);
        const q = c.qualifier ? norm(c.qualifier) : '';
        if (q && !parseMatch(q)) {
          const name = norm(q.replace(/\b(?:campaign|ad ?group|level|negatives?|keywords?)\b/gi, ' ').replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, ''));
          if (/\bad ?group\b/i.test(q)) { secInfo.scope = 'adgroup'; if (name) secInfo.target = name; }
          else if (ACCOUNT_WORDS.test(q) || /^(?:all|every)\b/i.test(q)) secInfo.scope = 'account';
          else if (name && res.adGroups.some(a => key(a.name) === key(name))) { secInfo.scope = 'adgroup'; secInfo.target = name; }
          else if (name) { secInfo.scope = 'campaign'; secInfo.target = name; }
        }
        secInfo.baseScope = secInfo.scope; secInfo.baseTarget = secInfo.target;
      } else if (c.qualifier && !parseMatch(c.qualifier) && (sec === 'keywords' || sec === 'headlines' || sec === 'descriptions' || sec === 'adcopy')) {
        // "Keywords – Emergency Plumbing": the qualifier is the ad group. On a tab name it only is when the tab
        // holds one list; a tab with an ad group per column ("Keywords - Repair") names a group of ad groups.
        const name = cleanName(c.qualifier);
        if (isNameLike(name)) { if (b.sheet) secInfo.pendingAg = name; else { ag = getAg(name, campCtx); agLevel = c.level; } }
      }
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
            skip(text, isNoteLine(text) ? 'a note for the team, not ad text' : 'unbulleted note between bulleted items', { kind: isNoteLine(text) ? 'note' : 'item' });
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
      if (section === 'negatives' && secInfo && b.t !== 'h' && /:\s*$/.test(text) && (c.k === 'text' || c.k === 'heading') && retargetNegatives(text)) {
        skip(text, 'says where the negatives below it go', { kind: 'note' }); lastPlain = null; return;
      }
      switch (c.k) {
        case 'campaign': {
          campCtx = c.name; campLevel = c.level; ag = null; agLevel = 99; section = null; secInfo = null; lastPlain = null;
          // "Campaign 1: Teen Driver's Ed ($40/day)" or "Campaign 2 – Long Distance – $80/day"
          const nb = text.match(/\(([^)]*\d[^)]*)\)\s*$|\s[-–—|]\s*([^-–—|]*\d[^-–—|]*)$/);
          const bt = nb ? nb[1] || nb[2] : '';
          if (bt && /[$€£₹¥]|\b(?:usd|eur|gbp|inr|aed|sar|pkr|cad|aud|rs\.?|budget)\b|\/\s*(?:day|mo|month)|\bper\s+(?:day|month)|\b(?:daily|monthly|pcm|p\/m)\b/i.test(bt)) {
            const b2 = parseBudget('', bt);
            if (b2 && !res.campaignBudgets[key(c.name)]) res.campaignBudgets[key(c.name)] = b2;
          }
          if (!res.campaignHint) res.campaignHint = c.name;
          return;
        }
        case 'adgroup':
          ag = getAg(c.name, campCtx); agLevel = c.level; section = null; secInfo = null; lastPlain = null;
          return;
        case 'aglist':
          if (campCtx) res.mapping.push({ campaign: campCtx, adGroups: splitList(c.names).map(cleanName), budget: null });
          else skip(text, 'ad group list outside a campaign', { kind: 'prose' });
          lastPlain = null;
          return;
        case 'numbered':
          // "H1: ..." after "KWs: ..." starts the headlines, so a line after "D2: ..." is not read as a keyword
          if (section !== c.sec && section !== 'adcopy') {
            section = c.sec;
            secInfo = { sec: c.sec, label: text, matchHint: null, hint: null, scope: null, target: null, itemTypes: new Set(), sheet: false, headLevel: null };
          }
          // "- H1: ..." items make this a bulleted list, so a plain line after them is not ad text
          if (secInfo) secInfo.itemTypes.add(b.t);
          addItem(c.sec, c.text, true); lastPlain = null;
          return;
        case 'section': {
          const bulletedSection = secInfo && secInfo.itemTypes && secInfo.itemTypes.has('li') && !secInfo.itemTypes.has('p');
          // in a plain-text paste a blank line before a label is the only sign of a new section
          if (c.weak && !c.taught && inCopy && plainLine && !(b.t === 'p' && bulletedSection) && !(b.t === 'p' && b.gapBefore && gapsMean)) break;
          if (b.sheet) { ag = null; agLevel = 99; campCtx = null; campLevel = 99; }
          startSection(c, b, step); lastPlain = null;
          return;
        }
        case 'setting': {
          const k = c.s.k;
          const apply = !inCopy ? true : b.t === 'li' ? /^(?:finalUrl|path1|path2|displayPath|maxCpc)$/.test(k) : COPY_SAFE_SETTINGS.has(k);
          if (apply) { applySetting(c.s, section === 'settings'); lastPlain = null; return; }
          break;
        }
        case 'note':
          skip(text, 'ignored because you taught the tool to skip it', { kind: 'taught' }); lastPlain = null;
          return;
        case 'platform': {
          if (c.level <= agLevel) { ag = null; agLevel = 99; }
          if (c.level <= campLevel) { campCtx = null; campLevel = 99; }
          section = null; secInfo = null; lastPlain = null;
          const google = /^(?:Google|Performance Max|YouTube|Demand Gen)/.test(c.name);
          const why = c.comparison ? 'it compares platforms rather than listing Search ads'
            : google ? c.name + ' campaigns are not part of this Search import' : c.name + ' ads are not part of a Google Ads Editor import';
          res.notes.push({ level: 'info', msg: 'Skipped the "' + norm(b.text) + '" section (' + c.count + ' ' + (c.count === 1 ? 'line' : 'lines') + '): ' + why + '.' });
          skip(text, (c.comparison ? 'platform comparison' : 'section for ' + c.name) + ', skipped with the ' + c.count + ' lines under it', { kind: 'platform' });
          return;
        }
        case 'inlineNote': {
          const isNote = /^(?:notes?|tips?|reminders?|important|nb|todo|why|rationale|reasoning|strategy)$/i.test(labelKey(c.label));
          skip(text, isNote ? 'a note for the team, not ad text' : 'the "' + norm(c.label) + '" line, which is not exported', { kind: isNote ? 'note' : 'other' });
          lastPlain = null;
          return;
        }
        case 'lpnote':
          skip(text, 'describes the landing page but gives no URL. Put the page address in this ad group\'s Final URL box.', { kind: 'lp' });
          lastPlain = null;
          return;
        case 'heading':
          // a sub-heading inside a heading-based section: a named list of negatives, or the ad group of a keyword list
          const subOf = secInfo && secInfo.rootLevel != null ? secInfo.rootLevel : secInfo && secInfo.headLevel;
          if (section && secInfo && subOf != null && c.level > subOf && b.t === 'h' || (section && secInfo && secInfo.headLevel != null && secInfo.headLevel < 7 && b.t === 'p' && b.bold)) {
            if (section === 'keywords' || section === 'headlines' || section === 'descriptions' || section === 'adcopy') {
              const name = cleanName(text);
              if (isNameLike(name)) { ag = getAg(name, campCtx); agLevel = c.level; lastPlain = null; return; }
            } else {
              if (section === 'other') skip(text, 'in the "' + norm(secInfo.label).replace(/:$/, '') + '" section, which is not exported', { kind: 'other' });
              if (section === 'negatives') retargetNegatives(text);
              lastPlain = null;
              return;
            }
          }
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
      const prevAg = ag, prevCamp = campCtx;
      try { readTable(rowsRaw); } catch (e) {
        ag = prevAg; campCtx = prevCamp;
        skip((rowsRaw[0] || []).filter(Boolean).join(' | '), 'table the tool could not read (' + (e && e.message ? e.message : 'unknown error') + ')', { kind: 'table' });
      }
    };
    const OTHER_PLATFORM = /\b(?:meta|facebook|instagram|fb|ig|linkedin|tik ?tok|pinterest|snapchat|twitter|reddit|microsoft|bing|youtube|display|pmax|performance max|demand gen|social)\b/i;
    const isGoogleRow = v => !v || /\b(?:google|search|adwords|ppc|sem)\b/i.test(v) || !OTHER_PLATFORM.test(v);
    const isTotalRow = v => /^(?:grand\s+)?(?:sub)?totals?\b/i.test(norm(v));
    const readTable = rowsRaw => {
      const shape = tableShape(rowsRaw);
      const rows = shape.rows;
      lastPlain = null;
      const firstRow = (rows[0] || []).filter(Boolean).join(' | ');
      // a Pin column with values: pins are not exported, so say so once
      const pinCol = (rows[shape.hi || 0] || []).findIndex(c => /^pin(?:ned)?(?:\s+(?:to|position))?$/i.test(norm(c)));
      if (pinCol >= 0 && !res.pinNote && rows.slice((shape.hi || 0) + 1).some(r => norm(r[pinCol] || '') && !/^[-–—]$/.test(norm(r[pinCol])))) {
        res.pinNote = true;
        res.notes.push({ level: 'info', msg: 'The doc pins some headlines or descriptions. Pins are not exported; set them in Ads Editor after import if you want them.' });
      }
      if (shape.kind === 'legend') { skip(firstRow, 'explains how the doc is laid out, so it is not imported', { kind: 'other' }); return; }
      if (shape.kind === 'assets') { skip(firstRow, 'sitelink, callout or other asset table, which is not exported', { kind: 'other' }); return; }
      if (shape.kind === 'comparison') { skip(firstRow, 'comparison table between platforms, not ad content', { kind: 'other' }); return; }
      // an "Overview" or "Brief" tab that lists settings: read the settings, report the rest
      if (section === 'other' && shape.kind === 'kv' && !shape.multi && secInfo && secInfo.sheet) {
        rows.forEach(r => {
          const label = norm(r[0] || ''), v = r.slice(1).filter(Boolean).join(', ');
          if (!label && !v) return;
          const st = label && v ? settingFrom(label, v) : null;
          if (st) applySetting(st, false);
          else skip(label && v ? label + ': ' + v : label || v, 'in the "' + norm(secInfo.label) + '" tab, which is not exported', { kind: 'other' });
        });
        return;
      }
      // inside "Sitelinks", "Notes" or "Overview" only campaign tables are read
      if (section === 'other' && shape.kind !== 'mapping' && shape.kind !== 'budgets') {
        skip(firstRow, 'table in the "' + norm(secInfo.label).replace(/:$/, '') + '" section, which is not exported', { kind: 'other' });
        return;
      }
      let otherRows = 0;
      const keepRow = (r, fields) => {
        const pi = fields ? fields.indexOf('platform') : -1;
        if (pi >= 0 && !isGoogleRow(r[pi])) { otherRows++; return false; }
        return true;
      };
      const bidFrom = (fields, r) => {
        const bi = fields.indexOf('bid'), ti = fields.indexOf('tcpa');
        const cpa = ti >= 0 && r[ti] ? money(r[ti]) : null;
        const s = bi >= 0 && r[bi] ? settingFrom('Bid strategy', r[bi]) : null;
        // a Target CPA column: the amount, and the strategy when the bid column is empty
        if (!s) return cpa > 0 ? { bid: 'tcpa', targetCpa: cpa } : null;
        return { bid: s.v, targetCpa: s.targetCpa || (s.v === 'tcpa' && cpa > 0 ? cpa : null) };
      };
      // a campaign table's own Locations and Languages columns
      const campCols = (fields, r, camp) => {
        const ci2 = fields.indexOf('maxCpc');
        if (ci2 >= 0 && r[ci2]) { const n = money(r[ci2]); if (n > 0) res.campaignMaxCpc[key(camp)] = n; }
        const li = fields.indexOf('locations'), gi = fields.indexOf('languages');
        if (li >= 0 && r[li]) { const st = settingFrom('Locations', r[li]); if (st && st.v.length) res.campaignLocations[key(camp)] = st.v; (st && st.notes || []).forEach(msg => res.notes.push({ level: 'warn', msg: camp + ': ' + msg })); }
        if (gi >= 0 && r[gi]) { const st = settingFrom('Languages', r[gi]); if (st && st.v.length) res.campaignLangs[key(camp)] = { name: camp, v: st.v }; }
      };
      const finishOther = () => { if (otherRows) res.notes.push({ level: 'info', msg: 'Skipped ' + otherRows + ' table ' + (otherRows === 1 ? 'row' : 'rows') + ' for other platforms.' }); };
      if (shape.kind === 'lines') {
        rows.forEach(r => r.filter(Boolean).forEach(cell => cell.split('\n').map(norm).filter(Boolean).forEach(line => {
          const blk = { t: 'p', text: line, bold: false };
          handleBlock(blk, classify(blk, opts.memory));
        })));
        return;
      }
      const kvApply = (label, value) => {
        const v = String(value || '');
        if (!norm(v)) return;
        if (!label) { skip(norm(v), 'table cell without a label', { kind: 'table' }); return; }
        if (/^(?:ad ?group|adgroup)(?:\s+(?:name|theme))?$/i.test(label)) { ag = getAg(norm(v), campCtx); return; }
        if (/^campaign(?:\s+name)?$/i.test(label)) {
          campCtx = tidyCampaign(norm(v)); ag = null;
          if (!res.campaignHint) res.campaignHint = campCtx;
          // a campaign block in a settings tab is a campaign even before its ad groups are read
          if (!res.mapping.some(m => key(m.campaign) === key(campCtx))) res.mapping.push({ campaign: campCtx, adGroups: [], budget: null });
          return;
        }
        let m;
        if ((m = label.match(NUMBERED_ONLY)) || (m = label.match(/^(headline|description|desc|h|d)\s*(\d{1,2})$/i))) {
          addItem(/^h/i.test(m[1]) ? 'headlines' : 'descriptions', v.replace(/\n/g, ' '), true);
          return;
        }
        if (/\b(?:suffix|template|tracking|utm|parameters?)\b/i.test(label)) { skip(label + ': ' + norm(v), 'tracking setting, not exported. Set it in Ads Editor if you use it.', { kind: 'other' }); return; }
        if (/\b(?:final url|landing page|lp|url)\b/i.test(label) && !findUrl(v)) { skip(label + ': ' + norm(v), 'describes the landing page but gives no URL. Put the page address in this ad group\'s Final URL box.', { kind: 'lp' }); return; }
        if (/^(?:sitelinks?|callouts?|structured snippets?|snippets?)\b/i.test(label)) { skip(label + ': ' + norm(v), 'in the "' + label + '" row, which is not exported', { kind: 'other' }); return; }
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
      // "Campaign | Ad Group | Asset | Text": one row per headline, description, URL or path
      if (shape.kind === 'longcopy') {
        const { ei, vi, ci, ai } = shape;
        const prevAg = ag, prevCamp = campCtx;
        let curCamp = null, curAg = null;
        rows.slice(1).forEach(r => {
          if (ci >= 0 && r[ci] && !isTotalRow(r[ci])) { curCamp = tidyCampaign(r[ci]); if (ai < 0) curAg = null; }
          if (ai >= 0 && r[ai]) curAg = getAg(r[ai], curCamp || prevCamp);
          campCtx = curCamp || prevCamp; ag = curAg || prevAg;
          kvApply(norm(r[ei] || ''), r[vi] || '');
        });
        // a table that names its own ad groups leaves none open: "Total ad rows: 440" or a negatives list after it is not theirs
        if (ai >= 0) { ag = null; agLevel = 99; section = null; secInfo = null; } else ag = prevAg;
        campCtx = prevCamp;
        return;
      }
      if (shape.kind === 'kv') {
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
          // "Element | Copy | Chars": the header row is not content and the count column is not ad text
          const head = rows[0] || [];
          const headerRow = /^(?:fields?|elements?|items?|assets?|components?|types?|labels?|attributes?|parts?|sections?|settings?|parameters?|keys?|names?)$/i.test(norm(head[0] || ''))
            && head.slice(1).filter(Boolean).every(c => !isFieldLabel(c) || hdrField(c) === 'ignore');
          // the first value column is always read ("Setting | Value"); later count or note columns are not
          const ignoreCols = headerRow ? head.map((c, j) => (j > 1 && hdrField(c) === 'ignore' ? j : -1)).filter(j => j > 1) : [];
          // several "Campaign | ..." blocks: a setting that only the last block has (written after it) is for every campaign
          const isCampRow = r => /^campaign(?:\s+name)?$/i.test(norm(r[0] || ''));
          const starts = rows.map((r, i) => isCampRow(r) ? i : -1).filter(i => i >= 0);
          const lastStart = starts.length >= 2 ? starts[starts.length - 1] : -1;
          const earlier = new Set(lastStart >= 0 ? rows.slice(starts[0], lastStart).map(r => settingLabel(r[0] || '')).filter(Boolean) : []);
          rows.forEach((r, ri) => {
            if (ri === 0 && headerRow) return;
            const val = r.slice(1).filter((x, j) => !ignoreCols.includes(j + 1)).filter(Boolean).join('\n');
            const sk = lastStart >= 0 && ri > lastStart ? settingLabel(r[0] || '') : null;
            if (sk && !earlier.has(sk)) { const pc = campCtx, pa = ag; campCtx = null; ag = null; kvApply(norm(r[0] || ''), val); campCtx = pc; ag = pa; return; }
            kvApply(norm(r[0] || ''), val);
          });
        }
        return;
      }
      if (shape.kind === 'mapping') {
        const { hi, fields } = shape;
        const ci = fields.indexOf('campaign'), ai = fields.indexOf('adgroup'), bi = budgetCol(rows[hi], fields);
        rows.slice(hi + 1).forEach(r => {
          if (!keepRow(r, fields)) return;
          const camp = r[ci], ags = r[ai];
          if (camp && isTotalRow(camp)) return;
          if (!camp && ags && res.mapping.length) { res.mapping[res.mapping.length - 1].adGroups.push(...splitList(ags).map(cleanName)); return; }
          if (!camp) return;
          // "Campaign | Ad Group | Note": notes go to the report
          rows[hi].forEach((h, ix) => { if (r[ix] && /^(?:notes?|comments?|remarks?|rationale|why)$/i.test(norm(h))) skip(r[ix], 'a note for the team, not ad text', { kind: 'note' }); });
          // a campaign listed again (a second table, or one row per ad group) adds to the same entry
          const prevEntry = res.mapping.find(x => key(x.campaign) === key(tidyCampaign(camp)));
          if (prevEntry) {
            splitList(ags).map(cleanName).forEach(n => { if (!prevEntry.adGroups.some(a => key(a) === key(n))) prevEntry.adGroups.push(n); });
            if (!prevEntry.budget && bi >= 0 && r[bi]) prevEntry.budget = parseBudget(rows[hi][bi], r[bi]);
            return;
          }
          res.mapping.push({ campaign: tidyCampaign(camp), adGroups: splitList(ags).map(cleanName), budget: bi >= 0 && r[bi] ? parseBudget(rows[hi][bi], r[bi]) : null });
          const bid = bidFrom(fields, r);
          if (bid) res.campaignBids[key(tidyCampaign(camp))] = bid;
          campCols(fields, r, tidyCampaign(camp));
        });
        finishOther();
        return;
      }
      if (shape.kind === 'budgets') {
        const { hi, fields } = shape;
        const ci = fields.indexOf('campaign'), bi = budgetCol(rows[hi], fields);
        rows.slice(hi + 1).forEach(r => {
          if (!keepRow(r, fields) || !r[ci] || isTotalRow(r[ci])) return;
          const b = r[bi] ? parseBudget(rows[hi][bi], r[bi]) : null;
          if (b) res.campaignBudgets[key(tidyCampaign(r[ci]))] = b;
          const bid = bidFrom(fields, r);
          if (bid) res.campaignBids[key(tidyCampaign(r[ci]))] = bid;
          campCols(fields, r, tidyCampaign(r[ci]));
        });
        finishOther();
        return;
      }
      if (shape.kind === 'records') {
        const { hi, fields } = shape;
        const col = f => fields.indexOf(f);
        const head = rows[hi];
        const prevAg = ag;
        let curAg = null, curCamp = null;
        rows.slice(hi + 1).forEach(r => {
          if (!keepRow(r, fields)) return;
          const campName = col('campaign') >= 0 ? (r[col('campaign')] || '') : '';
          if (campName && isTotalRow(campName)) return;
          // "All campaigns" in the campaign column is account level, not a campaign
          const allCamps = /^(?:all\b|every\b|account|shared|global)/i.test(norm(campName));
          if (campName && !allCamps) curCamp = tidyCampaign(campName);
          if (allCamps) curCamp = null;
          const rowBid = curCamp ? bidFrom(fields, r) : null;
          if (rowBid) res.campaignBids[key(curCamp)] = rowBid;
          if (curCamp && campName) campCols(fields, r, curCamp);
          const agName = col('adgroup') >= 0 ? r[col('adgroup')] : '';
          const rowHasCopy = fields.some((f, ix) => COPY_FIELDS.has(f) && r[ix] && !/^\d+$/.test(r[ix]));
          const bc = budgetCol(head, fields);
          if (curCamp && bc >= 0 && r[bc]) { const b = parseBudget(head[bc], r[bc]); if (b) res.campaignBudgets[key(curCamp)] = b; }
          if (agName && !rowHasCopy) {
            const props = { name: cleanName(agName), campHint: curCamp || campCtx };
            fields.forEach((f, ix) => {
              if (!r[ix]) return;
              if (f === 'finalUrl') props.finalUrl = findUrl(r[ix]);
              if (f === 'path1' || f === 'path2') props[f] = cleanPath(r[ix]);
              if (f === 'displayPath') { const pp = splitDisplayPath(r[ix]); props.path1 = pp[0]; props.path2 = pp[1]; }
              if (f === 'maxCpc') props.maxCpc = money(r[ix]);
            });
            res.agProps.push(props);
            return;
          }
          if (agName) curAg = getAg(agName, curCamp || campCtx);
          ag = col('adgroup') >= 0 ? (curAg || prevAg) : prevAg;
          const mi = col('match');
          const matchCell = (mi >= 0 ? r[mi] : '') || '';
          const negRow = /negative/i.test(matchCell);
          // where negatives in this row go: the "Applied To" column, the campaign column, the heading, then the open ad group
          const si = col('scope');
          const scopeCell = si >= 0 ? (r[si] || '') : '';
          const negTargets = () => {
            if (scopeCell) {
              if (/\bad ?groups?\b/i.test(scopeCell)) return [['adgroup', null]];
              if (ACCOUNT_WORDS.test(scopeCell) || /^(?:all|every)\b/i.test(scopeCell)) return [['account', null]];
              // a "Level" column: "Campaign" means the campaign in this row
              if (/^campaigns?(?:[\s-]*level)?$/i.test(norm(scopeCell))) return [['campaign', curCamp]];
              return splitList(scopeCell.replace(/\s+(?:and|&)\s+/gi, ', ')).map(n => ['campaign', n.replace(/\bcampaigns?\b/gi, '').trim() || n]);
            }
            if (allCamps) return [['account', null]];
            if (/campaign/i.test(matchCell) || (col('campaign') >= 0 && curCamp && col('adgroup') < 0)) return [['campaign', curCamp]];
            if (section === 'negatives' && secInfo && secInfo.scope) return [[secInfo.scope, secInfo.target || null]];
            return [[ag ? 'adgroup' : 'account', null]];
          };
          const addNegs = (v, hint) => negTargets().forEach(([sc, target]) => v.split('\n').forEach(line => {
            if (sc === 'campaign' && target) { const prev = campCtx; campCtx = target; addItem('negatives', line, true, hint, 'campaign'); campCtx = prev; }
            else addItem('negatives', line, true, hint, sc);
          }));
          const prevCamp = campCtx;
          if (curCamp) campCtx = curCamp;
          fields.forEach((f, ix) => {
            const v = r[ix];
            if (!v || /^\d+$/.test(v)) return;
            if (f === 'keywords') {
              if (negRow) addNegs(v, matchCell.replace(/(?:campaign\s+)?negative/i, ''));
              else v.split('\n').forEach(line => addItem('keywords', line, true, matchCell || (parseMatch(head[ix]) && !/^(?:key ?words?|kws?)$/i.test(norm(head[ix])) ? head[ix] : '')));
            }
            else if (f === 'negatives') {
              const headScope = /campaign/i.test(head[ix]) ? 'campaign' : /account|shared|all/i.test(head[ix]) ? 'account' : null;
              // "Campaign negatives - Residential Solar - Lahore" or "Boiler Repair - Manchester (campaign negatives)" names its campaign
              const headTarget = headScope === 'campaign' ? norm(String(head[ix]).replace(/\([^)]*\)/g, ' ')
                .replace(/\b(?:campaign|level|negatives?|negative key ?words?|key ?words?|negs?|list|only|for)\b/gi, ' ')
                .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '')) : '';
              if (headScope && !scopeCell && col('campaign') < 0) v.split('\n').forEach(line => {
                const prev = campCtx;
                if (headTarget) campCtx = tidyCampaign(headTarget);
                addItem('negatives', line, true, matchCell, headScope);
                campCtx = prev;
              });
              else addNegs(v, matchCell);
            }
            else if (f === 'headlines') v.split('\n').forEach(line => addItem('headlines', line, true));
            else if (f === 'descriptions') v.split('\n').forEach(line => addItem('descriptions', line, true));
            else if (f === 'finalUrl') { const u = findUrl(v); if (u) ensureAg().finalUrl = u; }
            else if (f === 'path1' || f === 'path2') ensureAg()[f] = cleanPath(v);
            else if (f === 'displayPath') { const pp = splitDisplayPath(v); if (pp[0]) { const t = ensureAg(); t.path1 = pp[0]; t.path2 = pp[1]; } }
            else if (f === 'maxCpc') { const n = money(v); if (n != null) ensureAg().maxCpc = n; }
          });
          campCtx = prevCamp;
        });
        if (col('adgroup') >= 0) { ag = null; agLevel = 99; if (section && COPY.has(section)) { section = null; secInfo = null; } }
        finishOther();
        return;
      }
      // plain table: columns may be ad groups, or it is a list inside the current section
      if (section && COPY.has(section)) {
        // "Campaign: Boiler Installation - Manchester | all phrase match unless shown" above the table
        const t0 = (rows[0] || []).filter(Boolean);
        const cm = t0.length && t0.length <= 2 ? norm(t0[0]).match(/^campaign\s*(?:name)?\s*[:\-–—]\s*(.+)$/i) : null;
        if (cm && rows.length > 2) {
          const parts = cm[1].split(/\s+\|\s+/);
          campCtx = tidyCampaign(parts[0]); campLevel = 1;
          if (!res.campaignHint) res.campaignHint = campCtx;
          const mt = parseMatch(parts.slice(1).concat(t0.slice(1)).join(' '));
          if (mt && secInfo) secInfo.matchHint = mt;
          rows.splice(0, 1);
        }
        const head = rows[0];
        const named = head.filter(c => c && !/^\d+$/.test(c) && hdrField(c) == null && c.length <= 60);
        const dataCells = rows.slice(1).flat().filter(Boolean);
        const lowerShare = dataCells.length ? dataCells.filter(c => /^[\["+]*[\p{Ll}\d]/u.test(c)).length / dataCells.length : 0;
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
      if (cls[i].k === 'platformSkip') { step++; return; }
      // "---" then "Negative Keywords": the rule ends the ad group above, so the list is not that ad group's
      if (b.afterRule && ag && cls[i].k === 'section' && (cls[i].sec === 'negatives' || cls[i].sec === 'other' || cls[i].sec === 'settings') && !cls[i].qualifier) { ag = null; agLevel = 99; }
      // same for a blank line before a plain "Negative Keywords" once the ad group's ad is written
      else if (b.t === 'p' && ag && ag.listLabels && (ag.headlines.length || ag.descriptions.length) && cls[i].k === 'section' && cls[i].sec === 'negatives' && !cls[i].qualifier) { ag = null; agLevel = 99; }
      else if (b.gapBefore && gapsMean && b.t === 'p' && !b.bold && ag && (ag.headlines.length || ag.descriptions.length) && cls[i].k === 'section' && cls[i].sec === 'negatives' && !cls[i].qualifier && !cls[i].inline) { ag = null; agLevel = 99; }
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
    ['campaignNegatives', 'campaignNegNames', 'campaignLocations', 'campaignBudgets', 'campaignBids', 'campaignUrls', 'campaignLangs', 'campaignMaxCpc'].forEach(f => { res[f] = res[f] || {}; });
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
      const c = { id: nid('c'), name, budget: b ? b.daily : null, budgetBasis: b ? b.basis : null, negatives: (res.campaignNegatives[k] || []).slice(), locations: res.campaignLocations[k] ? res.campaignLocations[k].slice() : null, finalUrl: res.campaignUrls[k] || '',
        bidStrategy: res.campaignBids[k] ? res.campaignBids[k].bid : null, targetCpa: res.campaignBids[k] ? res.campaignBids[k].targetCpa : null,
        languages: res.campaignLangs[k] ? res.campaignLangs[k].v.slice() : null };
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
    // a heading read as an ad group that ended up with nothing in it ("Pro Tips" with only advice lines)
    res.adGroups = res.adGroups.filter(a => {
      if (a.keywords.length || a.headlines.length || a.descriptions.length || a.negatives.length) return true;
      if (a.implicit) return false;
      model.notes.push({ level: 'info', msg: '"' + a.name + '" looked like an ad group but had no keywords or ads, so it was left out.' });
      return false;
    });
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
        matchType: a.matchType || null,
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
    // "Match type: Phrase, Exact" under every ad group is really the account default
    const agMts = model.adGroups.map(g => g.matchType).filter(Boolean);
    if (agMts.length && agMts.length === model.adGroups.length && new Set(agMts).size === 1 && (!res.settings.matchType || res.settings.matchType === agMts[0])) {
      res.settings.matchType = agMts[0];
      model.adGroups.forEach(g => { g.matchType = null; });
    }
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
      // "Medical Weight Loss" for the "Medical Weight Loss Campaign", "Implants" for "DBD – Implants & Cosmetic"
      const label = res.campaignNegNames[k] || k;
      const scored = model.campaigns.map(c => [c, Math.max(sim(label, c.name), key(c.name).includes(key(label)) || key(label).includes(key(c.name)) ? 0.8 : 0)]).sort((a, b) => b[1] - a[1]);
      const unique = scored.length && scored[0][1] >= 0.6 && !(scored[1] && scored[1][1] === scored[0][1]);
      const into = unique ? scored[0][0].negatives : model.accountNegatives;
      res.campaignNegatives[k].forEach(n => { if (!into.some(x => x.text === n.text && x.match === n.match)) into.push(n); });
      if (!unique && model.campaigns.length > 1) model.notes.push({ level: 'warn', msg: 'Negatives listed for "' + label + '" match no campaign here, so they were added for every campaign. Move them if that is wrong.' });
    });
    Object.keys(res.campaignUrls).forEach(k => { if (!byKey.has(k) && !res.settings.finalUrl) res.settings.finalUrl = res.campaignUrls[k]; });
    Object.keys(res.campaignLocations).forEach(k => { if (!byKey.has(k) && !res.settings.locations) res.settings.locations = res.campaignLocations[k]; });
    // a budget given for a campaign heading the campaign table later replaced; only when there is exactly one such budget
    // bidding given under a heading that is not a campaign in the end: one such line, or several that agree, is the account default
    const strayBids = Object.keys(res.campaignBids).filter(k => !byKey.has(k)).map(k => res.campaignBids[k]);
    if (strayBids.length && !res.settings.bidStrategy && strayBids.every(x => x.bid === strayBids[0].bid && x.targetCpa === strayBids[0].targetCpa)) {
      res.settings.bidStrategy = strayBids[0].bid;
      if (strayBids[0].targetCpa) res.settings.targetCpa = strayBids[0].targetCpa;
    }
    // languages: given only per campaign and all the same, or under a heading that is not a campaign, they are the account default
    const strayLangs = Object.keys(res.campaignLangs).filter(k => !byKey.has(k)).map(k => res.campaignLangs[k].v);
    if (strayLangs.length && !res.settings.languages) res.settings.languages = [...new Set([].concat(...strayLangs))];
    const cLangs = model.campaigns.map(c => c.languages ? c.languages.slice().sort().join(',') : '');
    if (model.campaigns.length && cLangs.every(x => x && x === cLangs[0]) && (!res.settings.languages || res.settings.languages.slice().sort().join(',') === cLangs[0])) {
      res.settings.languages = model.campaigns[0].languages;
      model.campaigns.forEach(c => { c.languages = null; });
    }
    // the same bidding on every campaign is really the account default
    const cBids = model.campaigns.map(c => c.bidStrategy ? c.bidStrategy + '|' + (c.targetCpa || '') : '');
    if (model.campaigns.length && cBids.every(x => x && x === cBids[0]) && (!res.settings.bidStrategy || (res.settings.bidStrategy + '|' + (res.settings.targetCpa || '')) === cBids[0])) {
      res.settings.bidStrategy = model.campaigns[0].bidStrategy;
      if (model.campaigns[0].targetCpa) res.settings.targetCpa = model.campaigns[0].targetCpa;
      model.campaigns.forEach(c => { c.bidStrategy = null; c.targetCpa = null; });
    }
    // a doc with one campaign that writes its settings under it: they also fill the empty account defaults
    if (model.campaigns.length === 1) {
      const c = model.campaigns[0];
      if (c.locations && c.locations.length && !res.settings.locations) res.settings.locations = c.locations.map(l => Object.assign({}, l));
      if (c.finalUrl && !res.settings.finalUrl) res.settings.finalUrl = c.finalUrl;
      if (c.languages && c.languages.length && !res.settings.languages) res.settings.languages = c.languages.slice();
    }
    // "Mississauga; Brampton" for one campaign when every account location is in Ontario, Canada
    const acctLocs = res.settings.locations || [];
    const suffixes = [...new Set(acctLocs.map(l => (l.name.match(/,\s*(.+)$/) || [])[1]).filter(Boolean))];
    if (acctLocs.length && suffixes.length === 1 && acctLocs.every(l => !l.id)) {
      model.campaigns.forEach(c => (c.locations || []).forEach(l => { if (!l.id && !/,/.test(l.name)) l.name += ', ' + suffixes[0]; }));
    }
    // "Starting max CPC" per campaign: one value for all is the account default, otherwise each ad group takes its campaign's
    const cpcs = model.campaigns.map(c => res.campaignMaxCpc[key(c.name)]).filter(n => n > 0);
    if (cpcs.length && cpcs.length === model.campaigns.length && new Set(cpcs).size === 1 && !res.settings.maxCpc) res.settings.maxCpc = cpcs[0];
    else model.campaigns.forEach(c => { const n = res.campaignMaxCpc[key(c.name)]; if (n > 0) model.adGroups.forEach(g => { if (g.campaignId === c.id && g.maxCpc == null) g.maxCpc = n; }); });
    // a campaign setting that matches the account default is not shown twice
    model.campaigns.forEach(c => {
      if (c.languages && res.settings.languages && c.languages.slice().sort().join(',') === res.settings.languages.slice().sort().join(',')) c.languages = null;
      if (c.bidStrategy && c.bidStrategy === res.settings.bidStrategy && (c.targetCpa || null) === (res.settings.targetCpa || null)) { c.bidStrategy = null; c.targetCpa = null; }
    });
    const strayBudgets = Object.keys(res.campaignBudgets).filter(k => !byKey.has(k));
    if (strayBudgets.length === 1 && !res.globalBudget) res.globalBudget = res.campaignBudgets[strayBudgets[0]];
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

  // A campaign's own bidding from the doc, or the account default
  const bidFor = (c, S) => c && c.bidStrategy
    ? { bid: c.bidStrategy, targetCpa: +c.targetCpa > 0 ? c.targetCpa : S.targetCpa, own: true }
    : { bid: S.bidStrategy, targetCpa: S.targetCpa, own: false };

  function validate(model, S, today) {
    const errors = [], warnings = [];
    const E = (o, msg) => errors.push(Object.assign({ msg }, o));
    const W = (o, msg) => warnings.push(Object.assign({ msg }, o));
    const urlOk = u => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u || '');
    const camp = id => model.campaigns.find(c => c.id === id);

    const used = model.campaigns.filter(c => model.adGroups.some(g => g.campaignId === c.id));
    if (!model.adGroups.length) E({ scope: 'doc' }, 'No ad groups found yet. Load a campaign doc or add an ad group.');
    if (!urlOk(S.finalUrl) && model.adGroups.some(g => !urlOk(g.finalUrl))) E({ scope: 'settings', field: 'finalUrl' }, 'Add a final URL that starts with https://');
    const defBid = used.filter(c => !bidFor(c, S).own);
    if (S.bidStrategy === 'tcpa' && !(+S.targetCpa > 0) && (defBid.length || !used.length)) E({ scope: 'settings', field: 'targetCpa' }, 'Target CPA needs an amount.');
    used.filter(c => bidFor(c, S).own && c.bidStrategy === 'tcpa' && !(+bidFor(c, S).targetCpa > 0)).forEach(c => E({ scope: 'campaign', id: c.id, field: 'tcpa' }, c.name + ': Target CPA needs an amount.'));
    const manualGaps = used.filter(c => bidFor(c, S).bid === 'manual' && model.adGroups.some(g => g.campaignId === c.id && !(+g.maxCpc > 0)));
    if (!(+S.maxCpc > 0) && (manualGaps.length || (S.bidStrategy === 'manual' && !used.length))) E({ scope: 'settings', field: 'maxCpc' }, 'Manual CPC needs a default max CPC' + (manualGaps.some(c => bidFor(c, S).own) ? ' (' + manualGaps.map(c => c.name).join(', ') + ' bid manually)' : '') + '.');
    const usesDefaultLocs = used.some(c => !(c.locations && c.locations.length));
    if (usesDefaultLocs && !S.allLocations && !S.locations.length) E({ scope: 'settings', field: 'locations' }, 'Add at least one location, or choose "All countries" if that is really the plan.');
    const allLocs = (usesDefaultLocs && !S.allLocations ? S.locations : []).concat(...used.map(c => c.locations || []));
    const noId = [...new Set(allLocs.filter(l => !l.id).map(l => l.name))];
    if (noId.length === 1) W({ scope: 'settings', field: 'locations' }, '"' + noId[0] + '" has no location ID, so Ads Editor will match it by name. Check it landed on the right place after import.');
    else if (noId.length > 1) W({ scope: 'settings', field: 'locations' }, noId.length + ' locations have no location ID (' + noId.slice(0, 4).join('; ') + (noId.length > 4 ? '; and ' + (noId.length - 4) + ' more' : '') + '), so Ads Editor will match them by name. Check they landed on the right places after import.');
    if (!S.languages.length && used.some(c => !(c.languages && c.languages.length))) W({ scope: 'settings', field: 'languages' }, 'No language set, so campaigns will target all languages.');
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
        if (adLen(t) > 30) E(oi, label + ': headline ' + (i + 1) + ' is ' + adLen(t) + ' characters (limit 30).');
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
        if (adLen(t) > 90) E(oi, label + ': description ' + (i + 1) + ' is ' + adLen(t) + ' characters (limit 90).');
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
        matchTypesFor(k, g.matchType || S.matchType).forEach(mt => {
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
    // thin ads still pass Google's minimum, but Ad strength usually wants more variety
    const thin = model.adGroups.filter(g => {
      const h = g.headlines.filter(x => norm(x)).length, d = g.descriptions.filter(x => norm(x)).length;
      return h >= 3 && d >= 2 && (h < 8 || d < 4);
    });
    if (thin.length) W({ scope: 'doc' }, (thin.length === 1 ? '1 ad has' : thin.length + ' ads have') + ' fewer than 8 headlines or 4 descriptions (' + thin.slice(0, 4).map(g => g.name).join(', ') + (thin.length > 4 ? ' and ' + (thin.length - 4) + ' more' : '') + '). More unique headlines and all 4 descriptions usually give a better Ad strength.');
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
      const bid = bidFor(c, S);
      row({
        kind: 'campaign', Campaign: cn, 'Campaign Type': 'Search', Networks: S.searchPartners ? 'Google search;Search Partners' : 'Google search', Budget: num(c.budget), 'Budget type': 'Daily',
        'Bid Strategy Type': BID_LABEL[bid.bid], 'Target CPA': bid.bid === 'tcpa' ? num(bid.targetCpa) : '', Languages: (c.languages && c.languages.length ? c.languages : S.languages).join(';'),
        'Targeting method': S.presenceOnly ? 'Location of presence' : '', 'Start Date': S.startDate || '', 'Campaign Status': S.campaignStatus
      });
      const locs = c.locations && c.locations.length ? c.locations : (S.allLocations ? [] : S.locations);
      locs.forEach(L => row({ kind: 'location', Campaign: cn, Location: L.name, 'Location ID': L.id || '' }));
      ags.forEach(g => {
        const gn = g.name.trim();
        row({ kind: 'adgroup', Campaign: cn, 'Ad Group': gn, 'Max CPC': bid.bid === 'manual' ? num(+g.maxCpc > 0 ? g.maxCpc : S.maxCpc) : '', 'Ad Group Status': 'Enabled' });
        g.keywords.forEach(k => matchTypesFor(k, g.matchType || S.matchType).forEach(mt => row({ kind: 'keyword', Campaign: cn, 'Ad Group': gn, Keyword: k.text, 'Criterion Type': cap(mt), Status: 'Enabled' })));
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
    norm, key, labelKey, sim, htmlToBlocks, textToBlocks, csvToRows, rowsToBlocks, classify, tableShape, parseBlocks, buildModel, parseBlocksToModel,
    parseHTML, parseText, parseSheets, validate, exportRows, toCSV, toTSV, suggestPaths, COUNTRIES, LANGS, findCountry, parseLocations,
    parseBudget, adLen, matchSetting, sectionLabel, kwToLine, linesToKw, matchTypesFor, negBlocks, nid, parseKeyword, deriveName, blocksToText, tidyCampaign,
    settingFrom
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CBEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
