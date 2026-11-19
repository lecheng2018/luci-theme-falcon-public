/**
 * Minimal CSS cascade checker.
 *
 * Parses cascade.css (stock) and theme.css (override) in load order and
 * reports the winning declaration for a property on a given selector, so we
 * can prove things like "dropdown menus are still hidden by default" without
 * a full browser.
 *
 * Usage:
 *   node tools/cascade-check.js ".dropdown-menu" left
 *   node tools/cascade-check.js "header .nav .dropdown-menu" left
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'htdocs', 'luci-static', 'falcon');

function stripComments(css) {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* split a stylesheet into { selector, decls, atrule } entries, in order */
function parse(css) {
	css = stripComments(css);
	const out = [];
	let i = 0;
	let atRule = null;

	while (i < css.length) {
		const brace = css.indexOf('{', i);
		if (brace < 0) break;

		let prelude = css.slice(i, brace).trim();

		if (prelude.startsWith('@')) {
			// at-rule block: record its name, skip to matching close
			atRule = prelude;
			let depth = 1;
			let j = brace + 1;
			while (j < css.length && depth > 0) {
				if (css[j] === '{') depth++;
				else if (css[j] === '}') depth--;
				j++;
			}
			i = j;
			atRule = null;
			continue;
		}

		const close = css.indexOf('}', brace + 1);
		if (close < 0) break;

		const body = css.slice(brace + 1, close);

		out.push({
			selectors: prelude.split(',').map(s => s.trim()).filter(Boolean),
			body,
			order: out.length
		});

		i = close + 1;
	}

	return out;
}

function declarations(body) {
	const map = {};
	for (const part of body.split(';')) {
		const idx = part.indexOf(':');
		if (idx < 0) continue;
		const prop = part.slice(0, idx).trim();
		const val = part.slice(idx + 1).trim();
		if (prop) map[prop] = val;
	}
	return map;
}

const files = ['cascade.css', 'mobile.css', 'theme.css'];

const rules = [];
for (const f of files) {
	const full = path.join(ROOT, f);
	if (!fs.existsSync(full)) continue;
	parse(fs.readFileSync(full, 'utf8')).forEach((r, idx) => {
		rules.push({ ...r, file: f, order: rules.length });
	});
}

const targetSel = process.argv[2];
const targetProp = process.argv[3];

if (!targetSel || !targetProp) {
	console.error('usage: node tools/cascade-check.js <selector> <property>');
	process.exit(2);
}

const norm = s => s.replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, '$1').trim();

/* which declarations apply to exactly this selector, in order? */
const hits = [];
for (const r of rules) {
	for (const sel of r.selectors) {
		if (norm(sel) === norm(targetSel)) {
			const d = declarations(r.body);
			if (targetProp in d) {
				hits.push({ file: r.file, sel: norm(sel), val: d[targetProp] });
			}
		}
	}
}

console.log(`selector: ${targetSel}`);
console.log(`property: ${targetProp}\n`);

if (!hits.length) {
	console.log('no declarations found');
	process.exit(0);
}

for (const h of hits) {
	console.log(`  ${h.file.padEnd(12)} ${h.val}`);
}

const winner = hits[hits.length - 1];
console.log(`\nWINNER (last in load order): ${winner.val}  [${winner.file}]`);

/* guardrails for the specific regression we hit */
if (targetProp === 'left' && /dropdown-menu$/.test(targetSel)) {
	if (winner.val === '0' || winner.val === '0px') {
		console.log('\nFAIL: dropdown would render open by default (left:0 with no :hover)');
		process.exit(1);
	}
	console.log('\nPASS: dropdown stays off-canvas until :hover');
}