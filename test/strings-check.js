// Checks the app's string resources against the Kotlin and layout code, before Gradle.
// Usage: node test/strings-check.js [repo root]
//
// Errors (exit 1): a key missing in one language, different placeholders in en/it, an
// unescaped apostrophe or quote, a stray % in a formatted string, an R.string / @string
// reference that does not exist, a Tr.s/getString call with the wrong number of args.
// Warnings: unused keys, Italian-looking literals left in the code, literal layout text.
'use strict';
const fs = require('fs');
const path = require('path');

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

const root = path.resolve(process.argv[2] || '.');
const MAIN = path.join(root, 'android/app/src/main');
const RES = path.join(MAIN, 'res');
const KT = path.join(MAIN, 'kotlin/com/rawbtprint/bridge');
const errors = [];
const warnings = [];

const PH = new RegExp('%([0-9]+)[$]([-#+ 0,(]*[0-9]*(?:[.][0-9]+)?[a-zA-Z])', 'g');
function placeholders(t) {
  const out = [];
  let m;
  PH.lastIndex = 0;
  while ((m = PH.exec(t))) out.push(m[1] + '$' + m[2]);
  return out.sort();
}

function readRes(dir) {
  const file = path.join(RES, dir, 'strings.xml');
  const out = {};
  const txt = fs.readFileSync(file, 'utf8');
  const re = new RegExp('<string name="([a-zA-Z0-9_]+)"([^>]*)>([^<]*)</string>', 'g');
  let m;
  while ((m = re.exec(txt))) {
    if (out[m[1]]) errors.push(dir + ': duplicate key ' + m[1]);
    out[m[1]] = { attrs: m[2], raw: m[3] };
  }
  Object.keys(out).forEach((k) => {
    const raw = out[k].raw;
    const quoted = raw.length > 1 && raw[0] === '"' && raw[raw.length - 1] === '"';
    const body = quoted ? raw.slice(1, -1) : raw;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if ((c === "'" || c === '"') && body[i - 1] !== BS) errors.push(dir + '/' + k + ': unescaped ' + c + ' (write ' + BS + c + ')');
    }
    const ph = placeholders(raw);
    out[k].ph = ph;
    out[k].nargs = new Set(ph.map((p) => p.split('$')[0])).size;
    const stray = raw.split('%%').join('').replace(PH, '').indexOf('%') >= 0;
    if (stray && out[k].nargs > 0) errors.push(dir + '/' + k + ': a literal % in a formatted string must be %%');
    if (stray && out[k].nargs === 0 && out[k].attrs.indexOf('formatted="false"') < 0) {
      warnings.push(dir + '/' + k + ': contains % without placeholders, add formatted="false"');
    }
  });
  return out;
}

const en = readRes('values');
const it = readRes('values-it');
Object.keys(en).forEach((k) => {
  if (en[k].attrs.indexOf('translatable="false"') >= 0) {
    if (it[k]) errors.push('values-it/' + k + ': translated, but marked translatable="false" in values');
    return;
  }
  if (!it[k]) errors.push('values-it: missing Italian translation of ' + k);
  else if (en[k].ph.join(',') !== it[k].ph.join(',')) {
    errors.push(k + ': placeholders differ, en [' + en[k].ph + '] it [' + it[k].ph + ']');
  }
});
Object.keys(it).forEach((k) => { if (!en[k]) errors.push('values-it/' + k + ': no English default in values'); });

const ktFiles = fs.readdirSync(KT).filter((f) => f.endsWith('.kt')).map((f) => path.join(KT, f));
const xmlFiles = fs.readdirSync(path.join(RES, 'layout')).map((f) => path.join(RES, 'layout', f))
  .concat([path.join(MAIN, 'AndroidManifest.xml')]);
const used = {};
ktFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const re = new RegExp('R[.]string[.]([a-zA-Z0-9_]+)', 'g');
  let m;
  while ((m = re.exec(src))) {
    used[m[1]] = true;
    if (!en[m[1]]) errors.push(path.basename(f) + ': R.string.' + m[1] + ' is not defined');
  }
});
xmlFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const re = new RegExp('@string[/]([a-zA-Z0-9_]+)', 'g');
  let m;
  while ((m = re.exec(src))) {
    used[m[1]] = true;
    if (!en[m[1]]) errors.push(path.basename(f) + ': @string/' + m[1] + ' is not defined');
  }
});
Object.keys(en).forEach((k) => { if (!used[k]) warnings.push('unused string: ' + k); });

// Arguments of Tr.s(R.string.x, ...) and getString(R.string.x, ...): split on top-level
// commas, skipping string literals and their ${...} templates.
function callArgs(src, open) {
  let depth = 0, cur = '', inStr = false;
  const tpl = []; // depth at which each open ${...} template returns to its string
  const parts = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      cur += c;
      if (c === BS) { cur += src[++i]; continue; }
      if (c === '$' && src[i + 1] === '{') { tpl.push(depth); depth++; cur += src[++i]; inStr = false; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; if (depth === 1 && c === '(') continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (c === '}' && tpl.length && depth === tpl[tpl.length - 1]) { tpl.pop(); cur += c; inStr = true; continue; }
      if (depth === 0) { parts.push(cur.trim()); return parts; }
    }
    if (c === ',' && depth === 1) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return parts;
}
ktFiles.forEach((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const re = new RegExp('(Tr[.]s|getString)[(]', 'g');
  let m;
  while ((m = re.exec(src))) {
    const parts = callArgs(src, m.index + m[0].length - 1);
    const km = new RegExp('^R[.]string[.]([a-zA-Z0-9_]+)$').exec(parts[0] || '');
    if (!km || !en[km[1]]) continue;
    if (parts.slice(1).some((p) => p.startsWith('*'))) continue;
    const given = parts.length - 1;
    if (given !== en[km[1]].nargs) {
      const line = src.slice(0, m.index).split(NL).length;
      errors.push(path.basename(f) + ':' + line + ': ' + m[1] + '(R.string.' + km[1] + ') passes ' + given + ' args, the string has ' + en[km[1]].nargs);
    }
  }
});

const ITALIAN = new RegExp("[àèéìòùÀÈÉÌÒÙ]|(^|[^A-Za-z])(non|della|delle|degli|nella|stampante|stampa|nessun[ao]?|errore|attesa|avvio|avviato|collegat[ao]|sospes[ao]|batteria|ricevut[ao]|scegli|riprova|chiamat[ae]|servizio|impostazioni|permesso|risolvi|pronto|pronta)([^A-Za-z]|$)", 'i');
ktFiles.forEach((f) => {
  fs.readFileSync(f, 'utf8').split(NL).forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    const re = new RegExp('"([^"]*)"', 'g');
    let m;
    while ((m = re.exec(l.split('//')[0]))) {
      if (m[1].length > 2 && ITALIAN.test(m[1])) warnings.push(path.basename(f) + ':' + (i + 1) + ': Italian-looking literal "' + m[1].slice(0, 70) + '" (move it to the resources)');
    }
  });
});
xmlFiles.forEach((f) => {
  fs.readFileSync(f, 'utf8').split(NL).forEach((l, i) => {
    const m = new RegExp('android:(text|hint|contentDescription|label)="([^@"][^"]*)"').exec(l);
    if (m && m[2].length > 3) warnings.push(path.basename(f) + ':' + (i + 1) + ': literal text "' + m[2] + '" (use @string)');
  });
});

console.log('strings: ' + Object.keys(en).length + ' en, ' + Object.keys(it).length + ' it');
warnings.forEach((w) => console.log('warning: ' + w));
errors.forEach((e) => console.log('ERROR: ' + e));
if (errors.length) {
  console.log(errors.length + ' error(s) in the string resources');
  process.exit(1);
}
console.log('string resources OK');
