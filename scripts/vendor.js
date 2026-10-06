// Copies third-party browser libraries into app/vendor so the app runs with no build step
// and no internet connection. Run after `npm install` when bumping a dependency.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'app', 'vendor');
fs.mkdirSync(out, { recursive: true });

const copy = (from, to) => {
  fs.copyFileSync(path.join(root, 'node_modules', from), path.join(out, to));
  console.log('copied', from, '->', 'app/vendor/' + to);
};
copy('mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js');
copy('jszip/dist/jszip.min.js', 'jszip.min.js');

// The Anthropic SDK ships as modules; bundle it into one classic script that sets
// window.Anthropic, so it also loads when index.html is opened from disk (file://).
const esbuild = require('esbuild');
const entry = path.join(root, 'scripts', '.sdk-entry.js');
fs.writeFileSync(entry, "import Anthropic from '@anthropic-ai/sdk';\nwindow.Anthropic = Anthropic;\n");
try {
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    outfile: path.join(out, 'anthropic-sdk.min.js'),
    legalComments: 'none',
    logLevel: 'warning'
  });
  console.log('bundled @anthropic-ai/sdk -> app/vendor/anthropic-sdk.min.js');
} finally {
  fs.unlinkSync(entry);
}
const pkg = name => require(path.join(root, 'node_modules', name, 'package.json')).version;
fs.writeFileSync(path.join(out, 'VERSIONS.txt'),
  ['mammoth ' + pkg('mammoth'), 'jszip ' + pkg('jszip'), '@anthropic-ai/sdk ' + pkg('@anthropic-ai/sdk')].join('\n') + '\n');
