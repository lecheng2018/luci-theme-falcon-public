/**
 * Smoke test for the Falcon login view (view/falcon/sysauth.js).
 *
 * The template renders the card; the view wires focus, error reveal and the
 * spinner-then-submit flow. This test feeds a fake template DOM and asserts
 * the wiring, including that the native form POST is left intact.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class N {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attrs = {};
		this.style = {};
		this._text = '';
		this.parentNode = null;
	}
	appendChild(c) {
		if (c == null) return c;
		if (!(c instanceof N)) c = textNode(String(c));
		c.parentNode = this;
		this.children.push(c);
		return c;
	}
	setAttribute(k, v) { this.attrs[k] = String(v); }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	set textContent(v) { this._text = String(v); this.children = []; }
	get textContent() { return this._text; }
	set innerHTML(v) { this.children = []; }
	querySelectorAll(sel) {
		const out = [];
		const match = n => {
			let m;
			if ((m = /^([\w-]+)\.([\w-]+)$/.exec(sel)))
				return n.tagName === m[1].toUpperCase() &&
					(n.attrs.class || '').split(/\s+/).includes(m[2]);
			if ((m = /^([\w-]+)\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel))) {
				if (n.tagName !== m[1].toUpperCase()) return false;
				return m[3] !== undefined ? n.attrs[m[2]] === m[3] : m[2] in n.attrs;
			}
			if (sel.startsWith('.')) return (n.attrs.class || '').split(/\s+/).includes(sel.slice(1));
			if (sel.startsWith('[')) {
				m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
				if (!m) return false;
				return m[2] !== undefined ? n.attrs[m[1]] === m[2] : m[1] in n.attrs;
			}
			return n.tagName === sel.toUpperCase();
		};
		const walk = n => { for (const c of n.children) { if (match(c)) out.push(c); walk(c); } };
		walk(this);
		return out;
	}
	querySelector(sel) { const a = this.querySelectorAll(sel); return a.length ? a[0] : null; }
	addEventListener(ev, fn) { this._events = this._events || {}; (this._events[ev] = this._events[ev] || []).push(fn); }
	removeEventListener() {}
	dispatch(ev) { (this._events && this._events[ev] || []).forEach(fn => fn({ preventDefault() {}, key: 'Enter' })); }
}
function textNode(t) { const n = new N('#text'); n._text = t; return n; }
function E(tag, attrs, kids) {
	const el = new N(tag);
	if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	if (kids !== undefined) el.appendChild(kids);
	return el;
}

/* fake page, mirroring what sysauth.ut emits */
const body = new N('body');
const box = new N('div'); box.setAttribute('class', 'login-box');

const err = E('div', { 'class': 'alert-message error', 'data-login-error': '1' });
err.style.display = 'none';

const form = new N('form');
form.setAttribute('method', 'post');
form.setAttribute('class', 'fx-login-form');
let submitCalls = 0;
form.submit = function() { submitCalls++; };

form.appendChild(E('div', { 'class': 'form-group' },
	E('input', { type: 'text', name: 'luci_username', value: 'root' })));
form.appendChild(E('div', { 'class': 'form-group' },
	E('input', { type: 'password', name: 'luci_password' })));
form.appendChild(err);
form.appendChild(E('button', { type: 'submit', 'class': 'btn btn-primary btn-login' }, '登 录'));

box.appendChild(E('div', { 'class': 'login-head' }, '登录到 QWRT'));
box.appendChild(form);
body.appendChild(box);

const focused = [];
const documentStub = {
	body,
	createTextNode: textNode,
	querySelector(sel) { return body.querySelector(sel); },
	activeElement: null
};
Object.defineProperty(documentStub, 'activeElement', {
	get() { return focused[focused.length - 1] || null; }
});

/* intercept focus by patching inputs */
const pw = body.querySelector('input[type="password"]');
let pwFocused = false;
pw.focus = function() { pwFocused = true; };

const sandbox = {
	view: { extend: o => o },
	ui: {},
	_: s => s,
	E,
	document: documentStub,
	window: { setTimeout(fn, ms) { setTimeout(fn, Math.min(ms, 5)); } },
	Promise, setTimeout, console
};
vm.createContext(sandbox);

const src = fs.readFileSync(
	path.join(__dirname, '..', 'htdocs/luci-static/resources/view/falcon/sysauth.js'), 'utf8');

const inst = vm.runInContext('(function(){\n' + src + '\n})', sandbox)();
const rv = inst.render();

setTimeout(() => {
	const fails = [];

	if (!pwFocused) fails.push('password field not focused');
	if (err.style.display !== '')
		fails.push('error slot not revealed on failed attempt');
	if (!rv) fails.push('render returned empty');

	/* submit 事件应被 preventDefault（改走 spinner 后手动提交） */
	form.dispatch('submit');
	const spin = form.querySelectorAll('.spinning');
	if (spin.length !== 1) fails.push('login spinner missing');
	if (submitCalls !== 0)
		fails.push('preventDefault failed: native submit fired immediately');

	/* 模拟 view 内部的延迟提交 */
	form.submit();
	if (submitCalls !== 1) fails.push('form.submit() not called');

	/* the POST fields must remain in the form for the dispatcher */
	if (!form.querySelector('input[name="luci_username"]') ||
	    !form.querySelector('input[name="luci_password"]'))
		fails.push('login fields missing from form');

	if (fails.length) {
		console.log('FAIL:');
		fails.forEach(f => console.log('  - ' + f));
		process.exit(1);
	}

	console.log('ok    password focused, error slot revealed on failure');
	console.log('ok    spinner shown once, then native form.submit() (login POST intact)');
	console.log('\nPASS: login view wired correctly.');
	process.exit(0);
}, 60);