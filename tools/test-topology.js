/**
 * Headless render test for the Falcon topology view (整机内部详情).
 *
 * Encodes the bugs found while building it:
 *   - E(...).innerHTML assignments left orphan nodes: the topology host and
 *     gauge host were never mounted, and updateTopology crashed on null
 *   - tiles got two canvases; the drawn one was not in the DOM
 *   - the iface dump fallback was an object, so forEach crashed
 *
 * The harness also captures every innerHTML assignment so the SVG schematic
 * (which the fake DOM cannot parse) can still be asserted on.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* 默认用仓库内脱敏夹具，真实快照可通过 FALCON_FIXTURE 指定 */
const FIXTURE_PATH = process.env.FALCON_FIXTURE
	|| path.join(__dirname, 'fixture.example.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
fixture.firewall = { flow_offloading: '1', flow_offloading_hw: '1', flow_offloading_hw_ipv6: '0' };
fixture.hints = {
	'AA:BB:CC:DD:EE:01': { ipaddrs: [ '10.0.0.11' ], ip6addrs: [ '2001:db8::11' ] }
};
fixture.rateRequests = [];
fixture.dev = fixture.dev || {};
fixture.dev.pon0 = { statistics: { rx_bytes: 9_837_451_075, tx_bytes: 19_086_178_927 } };
fixture.dev['pon0.66'] = { statistics: { rx_bytes: 7_379_290_676, tx_bytes: 17_336_316_781 } };
fixture.clientRates = {
	source: 'conntrack', incomplete: false, interval_ms: 2000, window_ms: 6000, age_ms: 1500,
	rates: {}, totals: { 'AA:BB:CC:DD:EE:01': 1_000_000 },
	traffic: { 'AA:BB:CC:DD:EE:01': { upload: 400_000, download: 600_000 } },
	connections: { 'AA:BB:CC:DD:EE:01': 5 },
	routed_connections: { 'AA:BB:CC:DD:EE:01': 4 }
};
fixture.leases = { dhcp_leases: [
	{ ipaddr: '10.0.0.11', macaddr: 'AA:BB:CC:DD:EE:01', hostname: 'host-a' } /* pii-scan:ignore 测试假数据 */
] };
fixture.ifaceDump = {
	interface: [
		{ 'interface': 'lan', 'device': 'br-lan', 'up': true,
		  'ipv4-address': [ { address: '192.168.1.1', mask: 24 } ] },  // pii-scan:ignore 测试假数据
		{ 'interface': 'wan', 'device': 'pppoe-wan', 'up': true,
		  'ipv4-address': [ { address: '203.0.113.10', mask: 32 } ] }  // pii-scan:ignore 测试假数据(TEST-NET-3)
	]
};

/* ----------------------------------------------------------------- fake DOM */
let htmlLog = [];

class N {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attrs = {};
		this.style = {};
		this._text = '';
		this._html = '';
		this.parentNode = null;
		this.id = '';
	}
	appendChild(c) {
		if (c == null || c === false) return c;
		if (Array.isArray(c)) { c.forEach(x => this.appendChild(x)); return c; }
		if (!(c instanceof N)) c = textNode(String(c));
		c.parentNode = this;
		this.children.push(c);
		return c;
	}
	insertBefore(c, ref) {
		if (!(c instanceof N)) c = textNode(String(c));
		const i = ref ? this.children.indexOf(ref) : -1;
		c.parentNode = this;
		if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
		return c;
	}
	replaceChild(nw, old) {
		const i = this.children.indexOf(old);
		if (i < 0) return old;
		nw.parentNode = this;
		this.children[i] = nw;
		old.parentNode = null;
		return old;
	}
	setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	set textContent(v) { this._text = String(v); this.children = []; }
	get textContent() {
		if (this._text) return this._text;
		let out = '';
		const walk = n => { for (const c of n.children) { if (c._text) out += c._text; else out += c.textContent || ''; } };
		walk(this);
		return out;
	}
	set innerHTML(v) { this.children = []; this._html = String(v); htmlLog.push(String(v)); }
	get innerHTML() { return this._html; }
	querySelectorAll(sel) {
		const out = [];
		const match = n => {
			if (sel.startsWith('.')) return (n.attrs.class || '').split(/\s+/).includes(sel.slice(1));
			if (sel.startsWith('#')) return n.id === sel.slice(1);
			if (sel.startsWith('[')) {
				const m = /^\[([-\w]+)(?:="([^"]*)")?\]$/.exec(sel);
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
	get classList() {
		const self = this;
		return {
			add(c) { const s = new Set((self.attrs.class || '').split(/\s+/).filter(Boolean)); s.add(c); self.attrs.class = [...s].join(' '); },
			contains(c) { return (self.attrs.class || '').split(/\s+/).includes(c); }
		};
	}
	get firstChild() { return this.children[0] || null; }
	/* canvas stub */
	getContext() {
		return {
			clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
			arc() {}, fill() {},
			set fillStyle(v) {}, set strokeStyle(v) {},
			set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {}
		};
	}
}
function textNode(t) { const n = new N('#text'); n._text = t; return n; }

function E(tag, attrs, kids) {
	if (Array.isArray(tag)) {
		const wrap = new N('div');
		wrap.appendChild(tag);
		return wrap;
	}
	const el = new N(tag);
	if (attrs && typeof attrs === 'object') {
		for (const [k, v] of Object.entries(attrs)) {
			if (k === 'style' && typeof v === 'string') {
				v.split(';').forEach(p => { const [a, b] = p.split(':'); if (a && b) el.style[a.trim()] = b.trim(); });
			}
			else if (v != null && v !== false) el.setAttribute(k, v);
		}
	}
	if (kids !== undefined) el.appendChild(kids);
	return el;
}

/* ------------------------------------------------------------- LuCI stubs */
let htmlLogGlobal = htmlLog;

function applyExpect(raw, expect) {
	if (!expect) return raw;
	let ret = raw;
	for (const key in expect) {
		if (ret != null && key !== '') ret = ret[key];
		if (ret == null || (Array.isArray(ret) !== Array.isArray(expect[key])))
			ret = expect[key];
		break;
	}
	return ret;
}

function makeRpc() {
	return {
		declare(spec) {
			return function (...args) {
				const key = spec.object + '.' + spec.method;
				let raw = {};
				if (key === 'system.board') raw = fixture.board;
				else if (key === 'system.info') raw = fixture.info;
				else if (key === 'luci.getCPUUsage') raw = fixture.cpuusage;
				else if (key === 'luci.getCPUInfo') raw = fixture.cpuinfo;
				else if (key === 'luci.getCPUBench') raw = fixture.cpubench;
				else if (key === 'network.interface.dump') raw = fixture.ifaceDump;
				else if (key === 'luci.getBuiltinEthernetPorts') raw = fixture.ports;
		else if (key === 'luci-rpc.getDHCPLeases') raw = fixture.leases;
		else if (key === 'luci-rpc.getHostHints') raw = fixture.hints;
				else if (spec.object === 'luci.client-rates' && spec.method === 'get') {
					fixture.rateRequests.push(Array.isArray(args[0]) ? args[0].slice() : []);
					Object.keys(fixture.clientRates.traffic).forEach(mac => {
						fixture.clientRates.traffic[mac].upload += 500_000;
						fixture.clientRates.traffic[mac].download += 2_500_000;
					});
					fixture.clientRates.rates = {};
					(Array.isArray(args[0]) ? args[0] : []).forEach(ip => {
						fixture.clientRates.rates[ip] = { ready: true, mac: 'AA:BB:CC:DD:EE:01',
							upload: 900_000, download: 4_800_000 };
					});
					raw = fixture.clientRates;
				}
				else if (key === 'network.device.status') {
					if (!(args.length && args[0])) {
						/* no-arg 全量口径：真实路由器计数器随流量自然增长，这里同步推进 */
						const all = {};
						Object.keys(fixture.dev).forEach(k => {
							const st = fixture.dev[k];
							if (st && st.statistics) {
								st.statistics.rx_bytes = (st.statistics.rx_bytes || 0) + 1_500_000;
								st.statistics.tx_bytes = (st.statistics.tx_bytes || 0) + 400_000;
							}
							all[k] = st;
						});
						return Promise.resolve(all);
					}
					/* advance pon0/lan counters so a second sample yields rates */
					const d = fixture.dev[args[0]];
					if (d && d.statistics && key) {
						d.statistics.rx_bytes = (d.statistics.rx_bytes || 0) + 1_500_000;
						d.statistics.tx_bytes = (d.statistics.tx_bytes || 0) + 400_000;
					}
					raw = d || {};
				}
				return Promise.resolve(applyExpect(raw, spec.expect));
			};
		}
	};
}

const L = {
	env: { requestpath: ['admin', 'status', 'topology'], sessionid: 'x' },
	url: p => '/cgi-bin/luci/' + p,
	resolveDefault(p, d) { return p.then(v => (v == null ? d : v), () => d); },
	require(dep) {
		if (dep === 'rpc') return Promise.resolve(makeRpc());
		if (dep === 'fs') return Promise.resolve({
			exec(cmd) {
				if (cmd === '/usr/sbin/ponctl')
					return Promise.resolve({ code: 0, stdout: JSON.stringify(fixture.pon) });
				return Promise.resolve({ code: 127 });
			}
		});
			if (dep === 'poll') return Promise.resolve({
				add(fn) { polls.push(fn); }, start() {}
			});
			if (dep === 'uci') return Promise.resolve({
				load: () => Promise.resolve(),
				get: (pkg, sec, opt) => (fixture.firewall || {})[opt]
			});
			return Promise.resolve({});
	}
};
const polls = [];

/* ------------------------------------------------------------------ run it */
const src = fs.readFileSync(
	path.join(__dirname, '..', 'htdocs/luci-static/resources/view/status/topology-falcon.js'), 'utf8');

const sandbox = {
	view: { extend: o => o },
	rpc: makeRpc(),
	poll: { add(fn) { polls.push(fn); }, start() {} },
	fs: { exec: () => Promise.resolve({ code: 127 }) },
	ui: {}, _: s => s,
	document: { createTextNode: textNode },
	E, L, Promise, console, Date, Math, JSON,
	isFinite, isNaN, parseInt, parseFloat, String, Array, Object
};
vm.createContext(sandbox);

let instance;
try {
	instance = vm.runInContext('(function(){\n' + src + '\n})', sandbox)();
}
catch (e) {
	console.error('FAIL: view did not evaluate:', e.message);
	process.exit(1);
}

instance.load().then(data => {
	const host = instance.render(data);

	/* first paint is async (refreshAll fetches RPCs); wait for it */
	return new Promise(resolve => setTimeout(resolve, 150)).then(() => {
		runAssertions(host);
	});
}).catch(e => {
	console.error('FAIL: load/render threw:', e && e.stack || e);
	process.exit(1);
});

function runAssertions(host) {
	const svgAll = htmlLog.join('\n');
	const fails = [];

	/* 1. 结构挂载（孤儿节点回归） */
	if (host.querySelector('#falcon-topo') === null)
		fails.push('topology host not mounted (orphan-node regression)');
	if (host.querySelectorAll('.spark-card').length !== 9)
		fails.push('expected 9 spark tiles, got ' + host.querySelectorAll('.spark-card').length);
	if (host.querySelectorAll('canvas').length !== 9)
		fails.push('expected 9 in-DOM canvases (drawn canvas must be the mounted one)');
	const expectedRows = fixture.ports.result.length;
	if (host.querySelectorAll('.irq-row').length !== expectedRows)
		fails.push('expected ' + expectedRows + ' port traffic rows (dynamic builtin ports)');
	if (host.querySelectorAll('.vpe-block').length !== 3)
		fails.push('expected 3 interface blocks');
	if (host.querySelectorAll('.topology-zoom-tools').length !== 1)
		fails.push('topology zoom controls missing');
		if (host.querySelectorAll('.topology-legend').length !== 0)
		fails.push('redundant topology legend should be removed');
		if (!host.querySelectorAll('.vpe-block-pon').some(function(n) {
			return (n.attrs.class || '').split(/\s+/).includes('is-connected');
		}))
			fails.push('O5 PON block should use the connected state');

	/* 2. 拓扑 SVG（通过 innerHTML 日志断言） */
	for (const marker of ['Airoha AN7581 Quad-Core SoC', 'BOSA 光器件', 'XGTC', 'PPE / HWNAT', 'Switch / PHY']) {
		if (!svgAll.includes(marker)) fails.push('topology svg missing: ' + marker);
	}

	/* 3. 仪表盘 */
	if (!svgAll.includes('data-gauge="cpu"') || !svgAll.includes('data-gauge="mem"'))
		fails.push('gauges missing');

	/* 4. 实时数值进 DOM */
	const norm = x => String(x).replace(/\s+/g, ' ');
	const text = norm(host.textContent);
	for (const marker of ['整机内部详情', '实时流量，按端口', '接口状态']) {
		if (!text.includes(marker)) fails.push('page text missing: ' + marker);
	}
	const modT = fixture.pon.frontend.temperature_celsius.toFixed(1);
			if (!text.includes(modT)) fails.push('module temperature missing from tiles');
			if (!svgAll.includes('data-bind="offload"')) fails.push('offload status binding missing');
			if (!svgAll.includes('data-bind="wanname"')) fails.push('WAN source binding missing');
			if (!fixture.rateRequests.some(a => a.includes('2001:db8::11')))
				fails.push('IPv6 HostHint was not sent to client-rates');

	if (fails.length) {
		console.log('FAIL:');
		fails.forEach(f => console.log('  - ' + f));
		process.exit(1);
	}

	console.log('ok    topology host mounted, 9 tiles, 9 canvases in DOM');
	console.log('ok    schematic svg rendered (AN7581 / BOSA / XGTC / PPE / Switch)');
	console.log('ok    gauges present, ' + expectedRows + ' dynamic port-traffic rows, 3 interface blocks');
	console.log('ok    live module temperature in tiles:', modT);

	/* 5. 第二次轮询：吞吐行出现真实速率 */
	if (polls.length) {
			return polls[0]().then(function() {
				const rowText = Array.from(host.querySelectorAll('.irq-row'))
					.map(r => r.textContent).join(' ');
				if (!/↓ [\d.]+ Mbps/.test(rowText))
					throw new Error('port traffic rows never went live: ' + rowText);
				if (!instance.offload || !instance.offload.known || !instance.offload.sw)
					throw new Error('enabled flow offload status was not loaded');
				if (!fixture.rateRequests.some(a => a.includes('2001:db8::11')))
					throw new Error('IPv6 HostHint was not sent to client-rates');
				if (!svgAll.includes('data-bind="wanname"') || instance.wanDev !== 'pppoe-wan')
					throw new Error('WAN topology counter source not identified');
				const unitProbe = instance.rateTotal({ source: 'conntrack', incomplete: false,
					rates: { probe: { ready: true, upload: 1000000, download: 250000 } } });
				if (!unitProbe || unitProbe.up !== 8000000 || unitProbe.down !== 2000000)
					throw new Error('topology B/s unit conversion is wrong');
				return instance.refreshAll(false);
			}).then(function() {
				fixture.pon.registration.onu_state = 'O1';
				return instance.refreshAll(false);
			}).then(function() {
				if (host.querySelectorAll('.vpe-block-pon').some(function(n) {
					return (n.attrs.class || '').split(/\s+/).includes('is-connected');
				})) throw new Error('disconnected PON retained connected styling');
				fixture.pon.registration.onu_state = 'O5';
				return instance.refreshAll(false);
			}).then(function() {
				fixture.pon = null;
				return instance.refreshAll(false);
			}).then(function() {
				if (host.querySelectorAll('.vpe-block-pon').some(function(n) {
					return (n.attrs.class || '').split(/\s+/).includes('is-connected');
				})) throw new Error('PON read failure retained connected styling');
				console.log('ok    topology throughput, offload, IPv6, units and PON state transitions');
				console.log('');
				console.log('PASS: topology page renders with live data.');
				process.exit(0);
			}).catch(e => {
				console.error('FAIL: topology refresh:', e.message);
				process.exit(1);
			});
	}

	console.log('');
	console.log('PASS: topology page renders with live data.');
	process.exit(0);
}
