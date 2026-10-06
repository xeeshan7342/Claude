// Builds dist/campaign-builder.html: the whole app in one file, for double-click use with no internet
// (fonts fall back to system fonts offline). Run with `npm run build`.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = path.join(root, 'app');
let html = fs.readFileSync(path.join(app, 'index.html'), 'utf8');

const read = rel => fs.readFileSync(path.join(app, rel), 'utf8');
// keep "</script" inside inlined code from closing the tag early
const safeJs = js => js.replace(/<\/script/gi, '<\\/script');

html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, rel) => '<style>\n' + read(rel) + '\n</style>');
let first = true;
html = html.replace(/<script src="((?:js|vendor)\/[^"]+)"><\/script>/g, (_, rel) => {
  const flag = first ? '<script>window.CBB_SINGLE_FILE = true;</script>\n' : '';
  first = false;
  return flag + '<script>\n' + safeJs(read(rel)) + '\n</script>';
});
if (/<script src="(?:js|vendor)\//.test(html) || /href="css\//.test(html)) throw new Error('Some local files were not inlined.');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'campaign-builder.html');
fs.writeFileSync(out, html);
console.log('wrote', path.relative(root, out), (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
