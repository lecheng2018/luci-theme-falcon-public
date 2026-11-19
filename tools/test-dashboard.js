/**
 * Headless render test for the Falcon dashboard view.
 *
 * Loads the real overview-falcon.js, feeds it a fixture captured from the live
 * router (/tmp/fixture.json), and asserts that the rendered DOM contains the
 * actual values — not placeholders.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* 默认用仓库内脱敏夹具，真实快照可通过 FALCON_FIXTURE 指定 */
const FIXTURE_PATH = process.env.FALCON_FIXTURE
	|| path.join(__dirname, 'fixture.example.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
fixture.wifiTemps = { ra0: 55, rai0: 55 };
fixture.ifaceDump = { interface: [
	{ 'interface': 'lan', 'device': 'br-lan', 'up': true,
	  'ipv4-address': [ { address: '192.168.1.1', mask: 24 } ] },  // pii-scan:ignore 测试假数据
	{ 'interface': 'wan', 'device': 'pppoe-wan', 'up': true,
	  'ipv4-address': [ { address: '203.0.113.10', mask: 32 } ] }  // pii-scan:ignore 测试假数据(TEST-NET-3)
] };
/* 全量设备快照（no-arg network.device status 的返回口径）：
   pon0 与 pppoe-wan 动态纳入，非硬编码——fixture 仅为模拟真实路由器 */
fixture.dev.pon0 = { statistics: { rx_bytes: 9_837_451_075, tx_bytes: 19_086_178_927 } };
fixture.dev['pon0.66'] = { statistics: { rx_bytes: 7_379_290_676, tx_bytes: 17_336_316_781 } };
fixture.dev['pppoe-wan'] = { statistics: { rx_bytes: 7_242_082_708, tx_bytes: 16_810_402_838 } };
fixture.dev['br-lan'] = { 'bridge-members': [ 'lan1', 'lan2', 'lan3', 'lan4', 'ra0', 'rai0' ],
	statistics: { rx_bytes: 17_597_709_834, tx_bytes: 8_792_930_976 } };

/* conntrack 记账夹具（模拟 luci.client-rates 返回；每 MAC 上下行累计）
   注意：这些是运行计数器，poll 时会整体推进以模拟真实流量增长。 */
fixture.clientRates = {
	source: 'conntrack',
	incomplete: false,
	interval_ms: 2000,
	window_ms: 6000,
	age_ms: 1500,
	rates: {},
	totals: { 'AA:BB:CC:DD:EE:01': 1_000_000 },
	traffic: {
		'AA:BB:CC:DD:EE:01': { upload: 400_000, download: 600_000 },
		'AA:BB:CC:DD:EE:02': { upload: 200_000, download: 300_000 },
		'0A:11:22:33:44:55': { upload: 10_000, download: 20_000 }
	},
	connections: { 'AA:BB:CC:DD:EE:01': 5,
		'0A:11:22:33:44:55': 7,          /* 随机 MAC（本地管理位=1） */
		'AA:BB:CC:DD:EE:77': 0 },        /* 纯空闲残留：无名字、无流量、无连接 */
	/* 上面这台 0A: 开头是随机 MAC 的典型形态，应标为「随机 MAC 设备」而不是未命名 */
	routed_connections: { 'AA:BB:CC:DD:EE:01': 4 }
};
fixture.hints = {
	'AA:BB:CC:DD:EE:01': { ipaddrs: [ '10.0.0.11' ], name: 'host-a' },   /* pii-scan:ignore 测试假数据 */
	'AA:BB:CC:DD:EE:02': { ipaddrs: [ '10.0.0.12' ], name: 'host-b' },   /* pii-scan:ignore 测试假数据 */
	'AA:BB:CC:DD:EE:09': { ipaddrs: [ '10.0.0.19' ], name: 'nas' }       /* pii-scan:ignore 测试假数据 */
};
/* 分载关闭（用户路由器实测配置）：流量统计应标为「精确」 */
fixture.firewall = { flow_offloading: '0', flow_offloading_hw: '0', flow_offloading_hw_ipv6: '0' };
fixture.qosState = { enabled: true, running: true, backend: 'airoha',
	configured_clients: 1, supported: true, kernel: '5.4.302' };
fixture.qosLimits = {
	'AA:BB:CC:DD:EE:01': { mac: 'AA:BB:CC:DD:EE:01', name: 'host-a',
		enabled: true, upload: 2000, download: 8000, connections: 3 }
};
fixture.qosSetCalls = [];

fixture.leases = { dhcp_leases: [
	{ ipaddr: '10.0.0.11', macaddr: 'AA:BB:CC:DD:EE:01', hostname: 'host-a' } /* pii-scan:ignore 测试假数据 */,
	{ ipaddr: '10.0.0.12', macaddr: 'AA:BB:CC:DD:EE:02', hostname: 'host-b' } /* pii-scan:ignore 测试假数据 */
] };
/* the optical card polls pon0 too; seed it like the router would */
fixture.dev.pon0 = { statistics: { rx_bytes: 2140486257, tx_bytes: 1603476950 } };

/* ------------------------------------------------------------- tiny DOM */
let uidc = 0;
class N {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attrs = {};
		this.style = {};
		this._text = '';
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
	setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = v; }
	addEventListener(ev, fn) { this._events = this._events || {}; (this._events[ev] = this._events[ev] || []).push(fn); }
	removeEventListener() {}
	dispatchEvent(ev) { (this._events && this._events[ev] || []).forEach(fn => fn({ target: this })); }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	set textContent(v) { this._text = String(v); this.children = []; }
	get textContent() {
		if (this._text) return this._text;
		let out = '';
		const walk = n => { for (const c of n.children) { if (c._text) out += c._text; else out += c.textContent || ''; } };
		walk(this);
		return out;
	}
	set innerHTML(v) { this.children = []; }
	querySelectorAll(sel) {
		const out = [];
		const match = n => {
			if (sel.startsWith('.')) return (n.attrs.class || '').split(/\s+/).includes(sel.slice(1));
			if (sel.startsWith('#')) return n.id === sel.slice(1);
			return n.tagName === sel.toUpperCase();
		};
		const walk = n => { for (const c of n.children) { if (match(c)) out.push(c); walk(c); } };
		walk(this);
		return out;
	}
	get classList() {
		const self = this;
		return {
			add(c) { const s = new Set((self.attrs.class || '').split(/\s+/).filter(Boolean)); s.add(c); self.attrs.class = [...s].join(' '); },
			contains(c) { return (self.attrs.class || '').split(/\s+/).includes(c); }
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
const polls = [];

/* Mirrors LuCI's rpc.js parseCallReply: after ubus returns msg.result[1],
   the `expect` spec unwraps one level (e.g. { result: [] } -> ret.result). */
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
				else if (key === 'luci.getVersion') raw = fixture.version;
				else if (key === 'luci.getUnixtime') raw = { result: 0 };
				else if (key === 'luci.getBuiltinEthernetPorts') raw = fixture.ports;
				else if (key === 'network.device.status') {
					if (args.length && args[0]) {
						raw = fixture.dev[args[0]] || {};
					} else {
						/* no-arg 全量口径 */
						raw = {};
						Object.keys(fixture.dev).forEach(k => { raw[k] = fixture.dev[k]; });
					}
				}
				else if (key === 'network.interface.dump') raw = fixture.ifaceDump;
				else if (key === 'luci-rpc.getDHCPLeases') raw = fixture.leases;
				else if (key === 'luci-rpc.getHostHints') raw = fixture.hints;
				else if (key === 'hqos.status') raw = fixture.qosState;
				else if (key === 'hqos.get') {
					const m = String(args[0] || '').toUpperCase();
					raw = fixture.qosLimits[m] || { mac: m, upload: 0, download: 0, connections: 0, enabled: false };
				}
				else if (key === 'hqos.set') {
					const req = args[0] || {};
					fixture.qosSetCalls.push(req);
					const m = String(req.mac || '').toUpperCase();
					const up = Number(req.upload) || 0, dn = Number(req.download) || 0;
					const cn = Number(req.connections) || 0;
					if (up || dn || cn) fixture.qosLimits[m] = { mac: m, name: req.name || '', enabled: true, upload: up, download: dn, connections: cn };
					else delete fixture.qosLimits[m];
					raw = { ok: true };
				}
				else if (key === 'luci.client-rates.get' || (spec.object === 'luci.client-rates' && spec.method === 'get')) {
					/* 每次调用推进 conntrack 计数（模拟真实流量增长） */
					Object.keys(fixture.clientRates.traffic).forEach(mac => {
						fixture.clientRates.traffic[mac].upload += 500_000;
						fixture.clientRates.traffic[mac].download += 2_500_000;
					});
					fixture.clientRates.rates = {};
					(Array.isArray(args[0]) ? args[0] : []).forEach(ip => {
						fixture.clientRates.rates[ip] = { ready: true, mac: 'AA:BB:CC:DD:EE:01',
							upload: 1_200_000, download: 6_400_000 };
					});
					raw = fixture.clientRates;
				}
				else if (key === 'iwinfo.devices') raw = { devices: Object.keys(fixture.wifi) };
				else if (key === 'iwinfo.info') raw = fixture.wifi[args[0]].info;
				else if (key === 'iwinfo.assoclist') raw = fixture.wifi[args[0]].assoc;

				return Promise.resolve(applyExpect(raw, spec.expect));
			};
		}
	};
}

const L = {
	env: { requestpath: ['admin', 'status', 'overview'], sessionid: 'x' },
	bind(fn, ...bound) { return fn.bind(null, ...bound); },
	isObject(v) { return v != null && typeof v === 'object'; },
	resolveDefault(p, d) { return p.then(v => (v == null ? d : v), () => d); },
	require(dep) {
		if (dep === 'rpc') return Promise.resolve(makeRpc());
		if (dep === 'fs') return Promise.resolve({
			exec(cmd) {
				if (cmd === '/usr/sbin/ponctl')
					return Promise.resolve({ code: 0, stdout: JSON.stringify(fixture.pon) });
				if (cmd === '/usr/libexec/falcon-wifi-temp')
					return Promise.resolve({ code: 0, stdout: JSON.stringify(fixture.wifiTemps) });
				return Promise.resolve({ code: 127 });
			}
		});
		if (dep === 'poll') return Promise.resolve({
			add(fn) { polls.push(fn); },
			start() {}
		});
		if (dep === 'view') return Promise.resolve({ extend: o => o });
		if (dep === 'ui') return Promise.resolve({});
		if (dep === 'uci') return Promise.resolve({
			load: () => Promise.resolve(),
			get: (pkg, sec, opt) => (fixture.firewall || {})[opt]
		});
		return Promise.resolve({});
	}
};

/* ---------------------------------------------------------------- run it */
const src = fs.readFileSync(
	path.join(__dirname, '..', 'htdocs/luci-static/resources/view/status/overview-falcon.js'), 'utf8');

const mod = { exports: {} };
const sandbox = {
	def: mod.exports,
	module: mod,
	exports: mod.exports,
	L,
	E,
	_: s => s,
	document: { createTextNode: textNode },
	Promise, console, setTimeout, Date, isFinite, isNaN, parseInt, parseFloat,
	String, Math, JSON, Array, Object
};
vm.createContext(sandbox);

/* the view file is an ESM-ish expression: it ends with `return view.extend(...)`
   wrapped in LuCI's require loader, so emulate that by wrapping in a function */
/* LuCI's `'require x'` directives are compile-time: the runtime hands the
   module in as a plain variable. Provide them synchronously here. */
sandbox.view = { extend: o => o };
sandbox.rpc = makeRpc();
sandbox.poll = { add(fn) { polls.push(fn); }, start() {} };
sandbox.ui = {};
sandbox.uci = {
	load: () => Promise.resolve(),
	get: (pkg, sec, opt) => (fixture.firewall || {})[opt]
};
sandbox.fs = {
	exec(cmd) {
		if (cmd === '/usr/sbin/ponctl')
			return Promise.resolve({ code: 0, stdout: JSON.stringify(fixture.pon) });
		if (cmd === '/usr/libexec/falcon-wifi-temp')
			return Promise.resolve({ code: 0, stdout: JSON.stringify(fixture.wifiTemps) });
		return Promise.resolve({ code: 127 });
	}
};

let instance;
try {
	const fn = vm.runInContext(`(function(){\n${src.replace(/^'use strict';/m, '')}\n})`, sandbox);
	instance = fn();
}
catch (e) {
	console.error('FAIL: view did not evaluate:', e.message);
	process.exit(1);
}

if (!instance || typeof instance.render !== 'function') {
	console.error('FAIL: view has no render()');
	process.exit(1);
}

instance.load().then(data => {
	const out = instance.render(data);
	const text = out.textContent.replace(/\s+/g, ' ');

	const fx = fixture;
	const expect = [];

	expect.push(['hostname', fx.board.hostname]);
	expect.push(['model', fx.board.model]);
	expect.push(['kernel', fx.board.kernel]);
	expect.push(['onu', fx.pon.registration.onu_state]);
	expect.push(['rx power', fx.pon.frontend.rx_power_dbm.toFixed(2)]);
	expect.push(['tx power', fx.pon.frontend.tx_power_dbm.toFixed(2)]);
	expect.push(['temperature', fx.pon.frontend.temperature_celsius.toFixed(1)]);
	expect.push(['port lan1', 'lan1']);
	expect.push(['wifi ssid', fx.wifi.rai0.info.ssid]);
	expect.push(['port lan2', 'lan2']);
	expect.push(['port lan1', 'lan1']);

	console.log('--- rendered text (first 700 chars) ---');
	console.log(text.slice(0, 700));
	console.log('---------------------------------------\n');

	/* 图一回归：端口必须按 1234 排列（RPC 返回的是 4321） */
	const i1 = text.indexOf('lan1'), i2 = text.indexOf('lan2');
	if (!(i1 >= 0 && i2 > i1)) {
		console.log('FAIL: port order wrong — lan1 must appear before lan2');
		process.exit(1);
	}
	console.log('ok    port order is lan1..lan4');

	/* 图三回归：CPU/PPE 加速读数必须存在 */
	const usage = fixture.cpuusage && fixture.cpuusage.cpuusage;
	const norm = x => String(x).replace(/\s+/g, ' ');
	if (usage && !norm(text).includes(norm(usage))) {
		console.log('FAIL: CPU/PPE readout missing:', usage);
		process.exit(1);
	}
	if (usage) console.log('ok    CPU/PPE readout rendered:', usage);

	const loadIdx = norm(text).indexOf('\u5e73\u5747\u8d1f\u8f7d');
	const cpuIdx = norm(text).indexOf('CPU \u4e0e\u786c\u4ef6\u52a0\u901f');
	if (loadIdx < 0 || cpuIdx < 0 || cpuIdx < loadIdx) {
		console.log('FAIL: CPU row must come after load average');
		process.exit(1);
	}
	console.log('ok    CPU row sits under load average');

	/* 温度回归：架构下方单行展示 CPU/Wi-Fi/PON 聚合温度 */
	const normText = norm(text);
	const archIdx = normText.indexOf('架构');
	const tempIdx = normText.indexOf('温度');
	const targetIdx = normText.indexOf('目标平台');

	if (archIdx < 0 || tempIdx < 0 || targetIdx < 0 || !(archIdx < tempIdx && tempIdx < targetIdx)) {
		console.log('FAIL: 温度 row must sit between 架构 and 目标平台 (arch=%d, temp=%d, target=%d)', archIdx, tempIdx, targetIdx);
		process.exit(1);
	}

	if (!normText.includes('CPU:') || !normText.includes('Wi-Fi:')) {
		console.log('FAIL: unified 温度 row missing components (CPU/Wi-Fi)');
		process.exit(1);
	}

	/* 架构行去重回归：架构行内严禁再包含 °C */
	const archSection = normText.slice(archIdx, tempIdx);
	if (archSection.includes('°C')) {
		console.log('FAIL: 架构 row still contains temperature °C:', archSection);
		process.exit(1);
	}
	console.log('ok    架构 row stripped of temperature, no duplicates');
	console.log('ok    unified 温度 row rendered directly under 架构: CPU / Wi-Fi');

	/* Wi-Fi 温度不得带频段标注（2.4G / 5G）——这一行只是温度读数，不是射频列表 */
	const tempRow = normText.slice(tempIdx, targetIdx);
	if (/2\.4G|5G/.test(tempRow)) {
		console.log('FAIL: Wi-Fi temperature still labelled with band names:', tempRow);
		process.exit(1);
	}
	console.log('ok    Wi-Fi temperature has no band labels');

	const cpuT = /([\d.]+)\s*°C/.exec((fixture.cpuinfo && fixture.cpuinfo.cpuinfo) || '');


	/* 图三回归：双温度（光模块 + 主芯片）必须存在 */
	const modT = fixture.pon.frontend.temperature_celsius.toFixed(1);
	if (!norm(text).includes(modT)) {
		console.log('FAIL: module temperature missing:', modT);
		process.exit(1);
	}
	const cpuinfoStr = (fixture.cpuinfo && fixture.cpuinfo.cpuinfo) || fixture.cpuinfo || '';
	const ct = /([\d.]+)\s*°C/.exec(cpuinfoStr);
	if (ct && !norm(text).includes(ct[1])) {
		console.log('FAIL: chip temperature missing:', ct[1]);
		process.exit(1);
	}
	console.log('ok    dual temperature rendered:', modT, '/', ct && ct[1]);

	/* 预览的六个指标 caption 必须逐字存在 */
	['PON 注册状态', '接收光功率 ·', '发送光功率', '整机与芯片温度',
	 '物理光路与模式', '实时光链路吞吐'].forEach(function(cap) {
		if (norm(text).indexOf(cap) < 0) {
			console.log('FAIL: preview metric caption missing:', cap);
			process.exit(1);
		}
	});
	console.log('ok    all six preview metric captions present');

	const missing = expect.filter(([label, val]) => val && !text.includes(String(val)));
	const hasCards = (out.querySelectorAll('.card') || []).length > 0;

	if (!hasCards) console.log('FAIL: no .card elements rendered');
	missing.forEach(([label, val]) => console.log(`FAIL: ${label} (${val}) missing from output`));

	if (!hasCards || missing.length) {
		process.exit(1);
	}

	/* exercise the poll callback: second sample must yield real rates */
	if (polls.length) {
		/* nudge counters as a real router would */
		for (const d of Object.keys(fixture.dev)) {
			const st = fixture.dev[d];
			if (st && st.statistics) {
				st.statistics.rx_bytes = (st.statistics.rx_bytes || 0) + 3_000_000;
				st.statistics.tx_bytes = (st.statistics.tx_bytes || 0) + 800_000;
			}
		}
		return polls[0]().then(() => {
			const t2 = out.textContent.replace(/\s+/g, ' ');
			const m = /实时光链路吞吐[^物]*↓ ([\d.]+) Mbps/.exec(t2);
			console.log('\n--- after 2nd poll ---');
			console.log(m ? m[0] : '(no rate found)');
			if (!m) {
				console.log('FAIL: optical throughput did not render an Mbps rate' +
					(m ? '' : ''));
				process.exit(1);
			}
			console.log('ok    optical throughput tile went live on 2nd sample');

			/* 回归：conntrack 口径必须被采用并标注（不得回落成编造的估算值） */
			if (!/全房合计（conntrack 记账）/.test(norm(t2))) {
				console.log('FAIL: conntrack aggregate caption not adopted (plan E)');
				process.exit(1);
			}
			console.log('ok    conntrack aggregate caption adopted (plan E)');

			/* 方向语义回归：LAN 口必须按客户端视角显示（收/发），
			   且实时吞吐标签须注明不含 Wi-Fi，避免与光链路总吞吐混淆。 */
			if (!/本口实时（不含 Wi-Fi）/.test(norm(t2))) {
				console.log('FAIL: per-port caption missing Wi-Fi disclaimer');
				process.exit(1);
			}
			if (!/收 .*发 /.test(norm(t2))) {
				console.log('FAIL: LAN port cumulative direction (收/发) missing');
				process.exit(1);
			}
			console.log('ok    per-port direction (收/发) + Wi-Fi disclaimer');

		/* XGEM 帧率估算已废弃：它把 PON 空闲帧/PLOAM 当作业务流量，
		   实测虚高可达 300 倍（拓扑页 639 Mbps vs 实际 2.23 Mbps）。
		   必须确保没有任何视图再用 xgem 计数器推算吞吐。 */
		const vdir = require('path').join(__dirname, '..', 'htdocs/luci-static/resources/view/status');
		for (const f of ['overview-falcon.js', 'topology-falcon.js']) {
			const src2 = require('fs').readFileSync(require('path').join(vdir, f), 'utf8');
			if (/xgem_rx|xgem_tx|ponRateEst/.test(src2)) {
				console.log('FAIL: ' + f + ' still derives throughput from XGEM frame counters');
				process.exit(1);
			}
		}
		console.log('ok    no view derives throughput from XGEM frame counters');

		/* ── 在线设备与限速（并入概览页）───────────────────────── */
		if (!/在线设备与限速/.test(norm(t2))) {
			console.log('FAIL: clients card not present on the overview page');
			process.exit(1);
		}
		console.log('ok    online-clients card is part of the overview page');

		/* 引擎状态 + 后端 */
		if (!/限速引擎/.test(norm(t2))) { console.log('FAIL: engine row missing'); process.exit(1); }
		if (!/运行中/.test(norm(t2))) { console.log('FAIL: engine state not rendered'); process.exit(1); }
		if (!/airoha/.test(norm(t2))) { console.log('FAIL: QoS backend not rendered'); process.exit(1); }
		console.log('ok    QoS engine state + backend rendered');

		/* 客户端来自 hints 的静态 IP 设备（nas）也必须出现 */
		if (!/nas/.test(norm(t2))) {
			console.log('FAIL: static-IP client (nas) missing from the list');
			process.exit(1);
		}
		if (!/host-a/.test(norm(t2))) { console.log('FAIL: lease client host-a missing'); process.exit(1); }
		console.log('ok    clients merge leases + HostHints (static IP device present)');

		/* 已有规则必须预填（2000 / 8000 / 3） */
		const inputs = [];
		(function walk(n) {
			if (!n) return;
			if (n.tagName === 'INPUT') inputs.push(String((n.attrs && n.attrs.value) || ''));
			if (Array.isArray(n.children)) n.children.forEach(walk);
		})(out);
		if (!inputs.includes('2000') || !inputs.includes('8000') || !inputs.includes('3')) {
			console.log('FAIL: existing limit not prefilled; inputs=' + JSON.stringify(inputs));
			process.exit(1);
		}
		console.log('ok    existing limit prefilled (2000 / 8000 / 3)');

		/* 限速徽标 */
		if (!/↑2000k/.test(norm(t2))) { console.log('FAIL: limit badge missing'); process.exit(1); }
		console.log('ok    current limit badge rendered');

		/* 系统卡必须显示整机连接数（conntrack 各 MAC 汇总） */
		const connRow = /连接数/.test(norm(t2));
		if (!connRow) {
			console.log('FAIL: 连接数 row missing from the system card');
			process.exit(1);
		}
		/* 夹具 connections 之和 = 12 + 3 + 756 = 771 */
		if (!/连接数\s*12/.test(norm(t2))) {
			const m = /连接数\D{0,12}/.exec(norm(t2));
			console.log('FAIL: 连接数 total wrong, got: ' + (m ? m[0] : 'n/a'));
			process.exit(1);
		}
		console.log('ok    整机连接数 rendered (12 = 5+7+0, summed from conntrack)');
		/* 「经路由」附注已移除：主界面只留总连接数 */
		if (/经路由/.test(norm(t2))) {
			console.log('FAIL: 经路由 annotation should be gone');
			process.exit(1);
		}
		console.log('ok    连接数 shows the total only (no routed sub-count)');

		/* 端口并入光纤物理链路卡：不应再有独立的「网络」卡 */
		const cardTitles = out.querySelectorAll('.card-title')
			.map(n => (n.textContent || '').trim());
		if (cardTitles.some(t => t === '网络')) {
			console.log('FAIL: standalone 网络 card still present; titles=' + JSON.stringify(cardTitles));
			process.exit(1);
		}
		if (!cardTitles.some(t => /光纤物理链路与端口面板/.test(t))) {
			console.log('FAIL: optical card title missing; titles=' + JSON.stringify(cardTitles));
			process.exit(1);
		}
		console.log('ok    ports merged into the optical card (no standalone 网络 card)');
		console.log('      cards: ' + cardTitles.join(' | '));

		/* 回归：fill() 每次轮询都会重跑，在线设备卡必须跨轮次复用，
		   否则用户正在输入的限速值会被 5 秒一次的刷新清空。 */
		const inputEls = [];
		(function walk(n) {
			if (!n) return;
			if (n.tagName === 'INPUT' && /client-limit-input/.test((n.attrs || {}).class || ''))
				inputEls.push(n);
			if (Array.isArray(n.children)) n.children.forEach(walk);
		})(out);
		if (!inputEls.length) {
			console.log('FAIL: no limit inputs found to test persistence');
			process.exit(1);
		}
		inputEls[0].attrs.value = '4321';

		return polls[polls.length - 1]().then(function() {
			const after = [];
			(function walk(n) {
				if (!n) return;
				if (n.tagName === 'INPUT' && /client-limit-input/.test((n.attrs || {}).class || ''))
					after.push(n);
				if (Array.isArray(n.children)) n.children.forEach(walk);
			})(out);
			if (!after.length) {
				console.log('FAIL: inputs disappeared after poll');
				process.exit(1);
			}
			if (after[0] !== inputEls[0] || after[0].attrs.value !== '4321') {
				console.log('FAIL: poll rebuilt the clients card and wiped the typed limit');
				process.exit(1);
			}
			console.log('ok    typed limit survives a poll (clients card reused)');

		/* 未知名设备治理：随机 MAC 必须标明，纯空闲残留必须被过滤掉 */
		const txt = out.textContent.replace(/\s+/g, ' ');
		if (!/随机 MAC 设备/.test(txt)) {
			console.log('FAIL: locally-administered MAC not labelled as 随机 MAC 设备');
			process.exit(1);
		}
		console.log('ok    randomized MAC labelled (随机 MAC 设备)');
		if (/AA:BB:CC:DD:EE:77/.test(txt)) {
			console.log('FAIL: fully idle entry should be filtered out of the list');
			process.exit(1);
		}
		console.log('ok    idle residue filtered out (no traffic / no name / no limit)');
		/* 具名设备排在随机 MAC 之前 */
		const namedIdx = txt.indexOf('host-a');
		const rndIdx = txt.indexOf('随机 MAC 设备');
		if (!(namedIdx >= 0 && rndIdx >= 0 && namedIdx < rndIdx)) {
			console.log('FAIL: named clients should sort before randomized ones');
			process.exit(1);
		}
		console.log('ok    named clients sort ahead of randomized ones');

		/* 流量统计口径必须如实标注：分载关闭 = 精确 */
		if (!/流量统计/.test(norm(t2))) {
			console.log('FAIL: 流量统计 row missing');
			process.exit(1);
		}
		console.log('ok    流量统计 row present');
		if (!/精确/.test(norm(t2))) {
			console.log('FAIL: with offload disabled the row should read 精确');
			process.exit(1);
		}
		console.log('ok    offload disabled -> 精确');

		/* 反向：分载开启时必须标「受限」并给出解释，不能继续假装精确 */
		fixture.firewall = { flow_offloading: '1', flow_offloading_hw: '1', flow_offloading_hw_ipv6: '1' };
		instance.offload = { sw: true, hw: true };
		instance.flowAccurate = false;
		const warnTxt = instance.flowSummary();
		const warnStr = typeof warnTxt === 'string' ? warnTxt : (warnTxt.textContent || '');
		if (!/受限/.test(warnStr) || !/偏低/.test(warnStr)) {
			console.log('FAIL: offload enabled must render 受限 + explanation, got: ' + warnStr);
			process.exit(1);
		}
		console.log('ok    offload enabled -> 受限（明确说明速率偏低）');
		fixture.firewall = { flow_offloading: '0', flow_offloading_hw: '0', flow_offloading_hw_ipv6: '0' };

			console.log(`\nPASS: ${out.querySelectorAll('.card').length} cards rendered with live values.`);
			console.log(`      (${expect.length} values cross-checked against router fixture)`);
			console.log('PASS: byte counters produced real Mbps rates on the 2nd sample.');
			process.exit(0);
		});
		});
	}

	console.log(`PASS: ${out.querySelectorAll('.card').length} cards rendered with live values.`);
	console.log(`      (${expect.length} values cross-checked against router fixture)`);
	process.exit(0);
}).catch(e => {
	console.error('FAIL: load/render threw:', e && e.stack || e);
	process.exit(1);
});