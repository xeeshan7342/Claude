/* File readers: turn a loaded file into engine blocks.
   Word (.docx) through mammoth, Excel (.xlsx) through JSZip, plus CSV, TSV, text, Markdown and HTML.
   Everything runs in the browser; files are never uploaded. */
(function (root) {
  'use strict';
  const E = root.CBEngine || (typeof require === 'function' ? require('./engine.js') : null);

  // Ads Editor exports are UTF-16 with a byte order mark; most other files are UTF-8.
  function decodeText(buf) {
    const b = new Uint8Array(buf);
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
    return new TextDecoder('utf-8').decode(b);
  }

  const colIndex = ref => {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  // .xlsx -> [{name, rows}] for every visible tab, in workbook order
  async function xlsxToSheets(buf, JSZip, ParserCtor) {
    const zip = await JSZip.loadAsync(buf);
    const P = ParserCtor || root.DOMParser;
    const xml = async path => {
      const f = zip.file(path);
      return f ? new P().parseFromString(await f.async('string'), 'application/xml') : null;
    };
    const tags = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
    const textOf = node => tags(node, 't').map(t => t.textContent).join('');
    const sst = await xml('xl/sharedStrings.xml');
    const shared = sst ? tags(sst, 'si').map(textOf) : [];
    const wb = await xml('xl/workbook.xml');
    if (!wb) throw new Error('This .xlsx file has no workbook inside. Re-save it from Excel or Google Sheets.');
    const rels = await xml('xl/_rels/workbook.xml.rels');
    const target = {};
    if (rels) tags(rels, 'Relationship').forEach(r => { target[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const sheets = [];
    for (const sh of tags(wb, 'sheet')) {
      if (sh.getAttribute('state') === 'hidden' || sh.getAttribute('state') === 'veryHidden') continue;
      const rid = sh.getAttribute('r:id') || sh.getAttributeNS(REL_NS, 'id');
      const t = target[rid] || '';
      const path = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      const doc = await xml(path);
      if (!doc) continue;
      const rows = [];
      tags(doc, 'row').forEach(rowEl => {
        const r = [];
        tags(rowEl, 'c').forEach(c => {
          const ix = colIndex(c.getAttribute('r'));
          const type = c.getAttribute('t');
          const v = tags(c, 'v')[0];
          let val = '';
          if (type === 's') val = v ? shared[+v.textContent] || '' : '';
          else if (type === 'inlineStr') val = textOf(c);
          else if (type === 'b') val = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
          else val = v ? v.textContent : '';
          r[ix >= 0 ? ix : r.length] = val;
        });
        rows.push(Array.from(r, x => (x == null ? '' : String(x))));
      });
      sheets.push({ name: sh.getAttribute('name') || '', rows });
    }
    return sheets;
  }

  const looksTabular = rows => rows.length >= 2 && rows.filter(r => r.filter(Boolean).length >= 2).length >= rows.length * 0.5;

  // file: a File (or anything with name + arrayBuffer()). deps: { mammoth, JSZip, DOMParser }
  async function readFile(file, deps) {
    deps = deps || {};
    const name = file.name || 'document';
    const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
    const e = (ext || '').toLowerCase();
    const buf = await file.arrayBuffer();
    if (e === 'docx') {
      const mammoth = deps.mammoth || root.mammoth;
      if (!mammoth) throw new Error('The Word reader did not load. Reload the page, or use Paste text.');
      const r = await mammoth.convertToHtml({ arrayBuffer: buf });
      return { name, kind: 'docx', blocks: E.htmlToBlocks(r.value, deps.DOMParser) };
    }
    if (e === 'xlsx' || e === 'xlsm') {
      const JSZip = deps.JSZip || root.JSZip;
      if (!JSZip) throw new Error('The Excel reader did not load. Reload the page.');
      const sheets = await xlsxToSheets(buf, JSZip, deps.DOMParser);
      const blocks = [];
      sheets.forEach(s => E.rowsToBlocks(s.rows, sheets.length > 1 || !/^sheet\s*\d*$/i.test(s.name) ? s.name : '').forEach(b => blocks.push(b)));
      return { name, kind: 'xlsx', blocks };
    }
    if (e === 'csv' || e === 'tsv') {
      const text = decodeText(buf);
      const rows = E.csvToRows(text);
      return { name, kind: e, blocks: looksTabular(rows) ? E.rowsToBlocks(rows, '') : E.textToBlocks(text) };
    }
    if (e === 'txt' || e === 'md' || e === 'markdown' || e === 'text') return { name, kind: 'text', blocks: E.textToBlocks(decodeText(buf)) };
    if (e === 'html' || e === 'htm') return { name, kind: 'html', blocks: E.htmlToBlocks(decodeText(buf), deps.DOMParser) };
    if (e === 'doc') throw new Error('Old .doc files are not supported. Open it in Word and save it as .docx.');
    if (e === 'xls') throw new Error('Old .xls files are not supported. Save it as .xlsx.');
    if (e === 'pdf') throw new Error('PDFs are not supported. Copy the text out of the PDF and use Paste text.');
    if (e === 'gdoc' || e === 'gsheet') throw new Error('That is a shortcut to a Google file. In Google Docs use File, Download, Microsoft Word (.docx); in Sheets use .xlsx.');
    throw new Error('Use a .docx, .xlsx, .csv, .txt or .md file. From Google Docs: File, Download, Microsoft Word (.docx).');
  }

  const api = { readFile, xlsxToSheets, decodeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CBReaders = api;
})(typeof window !== 'undefined' ? window : globalThis);
