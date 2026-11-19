/**
 * Strict CSS structure validator.
 *
 * Catches the class of bug that silently disabled the whole dashboard skin:
 * a rule nested inside another plain rule (CSS nesting syntax that browsers
 * without native nesting support drop entirely). Rules are only allowed to
 * nest inside at-rules (@media / @supports / @keyframes / @font-face).
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'htdocs/luci-static/falcon');
const file = process.argv[2] || path.join(dir, 'theme.css');

/* merge every sheet the browser loads, in link order, so var() coverage and
   structure are checked against what the page really sees */
const src = ['cascade.css', 'mobile.css', path.basename(file)]
	.map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
	.join('\n')
	.replace(/\/\*[\s\S]*?\*\//g, '');

const stack = [];   // { kind: 'rule'|'at', prelude, line }
const errors = [];
let line = 1, buf = '', preludeLine = 1;

for (let i = 0; i < src.length; i++) {
	const ch = src[i];
	if (ch === '\n') line++;

	if (ch === '{') {
		const prelude = buf.trim();
		const isAt = prelude.startsWith('@');
		const parent = stack[stack.length - 1];

		if (parent && parent.kind === 'rule') {
			errors.push({
				line: preludeLine,
				msg: `rule nested inside rule "${parent.prelude.split('\n').pop().trim()}"`,
				prelude: prelude.split('\n').pop().trim()
			});
		}

		stack.push({ kind: isAt ? 'at' : 'rule', prelude, line: preludeLine });
		buf = '';
		preludeLine = line;
		continue;
	}

	if (ch === '}') {
		stack.pop();
		buf = '';
		preludeLine = line;
		continue;
	}

	if (ch === ';' && (!stack.length || stack[stack.length - 1].kind === 'at')) {
		buf = '';
		preludeLine = line;
		continue;
	}

	if (!buf.trim() && !/\s/.test(ch)) preludeLine = line;
	buf += ch;
}

if (stack.length) {
	errors.push({ line: stack[0].line, msg: `unclosed block: ${stack[0].prelude.slice(0, 50)}` });
}

/* also flag the specific dark-pattern that broke us: `.x { .x .y { ... } }` */
if (/\.fx-root\s*\{\s*[^}]*\.fx-root\s/.test(src)) {
	errors.push({ line: 0, msg: '.fx-root used as a nesting wrapper instead of a selector prefix' });
}

if (errors.length) {
	console.log(`FAIL: ${errors.length} structural problem(s) in ${path.basename(file)}`);
	errors.slice(0, 12).forEach(e =>
		console.log(`  line ${e.line}: ${e.msg}${e.prelude ? ' -> ' + e.prelude : ''}`));
	process.exit(1);
}

const rules = (src.match(/\{/g) || []).length;
console.log(`PASS: ${path.basename(file)} is flat, valid CSS (${rules} blocks).`);
