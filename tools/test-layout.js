/**
 * Layout regression checks on theme.css.
 *
 * These encode the four defects seen on the phone screenshots, so they cannot
 * silently come back:
 *   1. header must not pin a fixed height (wrapped nav would be clipped)
 *   2. dropdowns must outrank the dashboard cards (z-index) and scroll
 *   3. long stat readouts must not use nowrap+ellipsis
 *   4. mobile block must not force a fixed header height
 */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(
	path.join(__dirname, '..', 'htdocs/luci-static/falcon/theme.css'), 'utf8')
	.replace(/\/\*[\s\S]*?\*\//g, '');

function findRule(selectorRegex, opts) {
	opts = opts || {};
	const out = [];
	let depth = 0, media = null, buf = '', name = null;

	for (let i = 0; i < css.length; i++) {
		const ch = css[i];

		if (ch === '{') {
			depth++;
			const prelude = buf.trim();
			buf = '';
			if (depth === 1 && prelude.startsWith('@')) { media = prelude; name = null; }
			else if (selectorRegex.test(prelude)) { name = { sel: prelude, media, body: '' }; out.push(name); }
			else name = null;
			continue;
		}
		if (ch === '}') {
			if (depth === 1) { media = null; name = null; }
			depth--;
			buf = '';
			continue;
		}
		if (depth === 0) { buf += ch; continue; }
		if (name && depth === 1) name.body += ch;
	}
	return out;
}

let fails = 0;
const check = (label, cond, detail) => {
	if (cond) { console.log('  ok    ' + label); return; }
	fails++;
	console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : ''));
};

console.log('\n1. layout architecture');
const sidebar = findRule(/\.falcon-sidebar$/).filter(r => !r.media);
check('sidebar is fixed positioned', sidebar.some(r => /position\s*:\s*fixed/.test(r.body)));
const topbar = findRule(/\.falcon-top-bar$/).filter(r => !r.media);
check('topbar is sticky/fixed', topbar.some(r => /position\s*:\s*(sticky|fixed)/.test(r.body)));

console.log('\n2. sidebar & dropdown navigation');
const drops = findRule(/\.dropdown-menu$/);
check('dropdown rules exist for navigation', drops.length > 0);
const mobileDrops = findRule(/dropdown-menu/).filter(r => r.media && /854px/.test(r.media));
const hasZ = /@media \(max-width: 854px\)[\s\S]*?z-index:\s*2000/.test(css);
check('mobile dropdown has high z-index (>=2000)', hasZ);

console.log('\n3. long stat values');
const num = findRule(/^\.fstat-num$/).filter(r => !r.media);
check('fstat-num does not clip with ellipsis',
	!num.some(r => /text-overflow\s*:\s*ellipsis/.test(r.body)),
	num.map(r => r.body.replace(/\s+/g, ' ')).join(' | ').slice(0, 140));

console.log('\n4. mobile header');
const mob = findRule(/^header$/).filter(r => r.media && /max-width/.test(r.media));
check('mobile header block does not set fixed height',
	!mob.some(r => /(^|;)\s*height\s*:/.test(r.body)),
	mob.map(r => r.body.replace(/\s+/g, ' ')).join(' | ').slice(0, 160));

console.log('\n5. stylesheet integrity');
const { execSync } = require('child_process');
try {
	execSync('node ' + path.join(__dirname, 'check-css.js'), { stdio: 'pipe' });
	console.log('  ok    theme.css is flat, valid CSS');
} catch (e) {
	fails++;
	console.log('  FAIL  theme.css has structural errors');
	console.log('        ' + String(e.stdout || e.message).split('\n').slice(0, 4).join('\n        '));
}

/* var() coverage across the merged sheet set the browser actually loads.
   Whitelist: stock cascade internals that ship undefined upstream
   (zone-color-rgb is set inline by LuCI's firewall/wifi JS). */
const stockInternal = new Set([
	'--zone-color-rgb',
	'--border-color-low-h', '--border-color-low-s', '--border-color-low-l',
	'--border-color-hsl',
	'--tab-inactive-background-color-hsl'
]);
const merged = ['cascade.css', 'mobile.css', 'theme.css']
	.map(f => fs.readFileSync(path.join(__dirname, '..', 'htdocs/luci-static/falcon', f), 'utf8'))
	.join('\n')
	.replace(/\/\*[\s\S]*?\*\//g, '');
const varsUsed = [...merged.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]);
const varsDefined = new Set([...merged.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
const undef = [...new Set(varsUsed)]
	.filter(v => !varsDefined.has(v) && !stockInternal.has(v));
check('every var(--x) is defined', undef.length === 0, 'undefined: ' + undef.join(', '));

const scoped = (css.match(/\.fx-root/g) || []).length;
check('dashboard rules are scoped under .fx-root', scoped > 50, 'found ' + scoped + ' references');
check('.fx-root is not used as a nesting wrapper',
	!/\.fx-root\s*\{\s*[^}]*\.fx-root\s/.test(css));

/* 在线设备页：窄屏必须堆叠，否则限速输入行会横向溢出。
   注：findRule 不累积 @media 内部的选择器文本，故此处用区间正则。 */
/* 文件里有多个 640px 块；取包含 client-limit-row 的那个 */
let clientMedia = null;
for (const m of css.matchAll(/@media \(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/g)) {
	if (/client-limit-row/.test(m[1])) { clientMedia = m; break; }
}
check('clients page has a <=640px block', !!clientMedia);
if (clientMedia) {
	const block = clientMedia[1];
	check('client-limit-row stacks on narrow screens',
		/\.client-limit-row\s*\{[^}]*flex-direction:\s*column/.test(block),
		'no column stacking at <=640px');
	check('client-limit-input goes full width on narrow screens',
		/\.client-limit-input\s*\{[^}]*width:\s*100%/.test(block),
		'input keeps fixed width on phones');
	check('client head stacks on narrow screens',
		/\.client-head\s*\{[^}]*flex-direction:\s*column/.test(block),
		'header row stays side-by-side on phones');
}

/* 侧边栏菜单顺序：概览 → 在线设备 → 整机详情 */
const menu = JSON.parse(fs.readFileSync(
	path.join(__dirname, '..', 'root/usr/share/luci/menu.d/zz-luci-theme-falcon.json'), 'utf8'));
const order = Object.keys(menu).sort((a, b) => menu[a].order - menu[b].order);
check('sidebar keeps 概览 → 整机详情（在线设备并入概览页）',
	order.join() === 'admin/status/overview,admin/status/topology',
	'got: ' + order.map(k => menu[k].title).join(' → '));

/* 端口区并入光纤卡后，窄屏必须单列且去掉缩进，否则会横向溢出 */
const portMedia = [...css.matchAll(/@media \(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/g)]
	.map(m => m[1]).find(b => /port-strip/.test(b));
check('port strip has a <=640px rule', !!portMedia);
if (portMedia) {
	check('port strip collapses to one column on narrow screens',
		/\.port-strip\s*\{[^}]*grid-template-columns:\s*1fr/.test(portMedia),
		'still multi-column on phones');
	check('port stats drop their indent on narrow screens',
		/\.iface-stats\s*\{[^}]*padding-left:\s*0/.test(portMedia),
		'42px indent kept on phones');
}

console.log('\n' + (fails ? `FAILED (${fails})` : 'PASS: all layout guards hold'));
process.exit(fails ? 1 : 0);
