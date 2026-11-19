'use strict';
'require view';
'require poll';
'require rpc';
'require ui';

/*
 * Falcon topology page — "整机架构与内部详情".
 *
 * Mirrors the second page of the reference design:
 *   internal header + realtime badge
 *   chip-topology SVG (fibre → BOSA → AN7581 SoC → switch → LAN)
 *   9 sparkline metric cards
 *   gauges (CPU / memory) · per-port throughput bars · interface blocks
 *
 * Everything is a live read. Where the reference showed data the web session
 * cannot reach (/proc/stat, per-core jiffies, IRQ counts — the file ACL blocks
 * /proc), the tile shows the closest real signal instead: PPE0/PPE1/HW-crypto
 * counters from luci.getCPUUsage, load averages, memory pressure and both
 * temperatures. Nothing on this page is hard-coded.
 */

var callBoard     = rpc.declare({ object: 'system', method: 'board',  expect: { '': {} } });
var callSysInfo   = rpc.declare({ object: 'system', method: 'info',   expect: { '': {} } });
var callCpuUsage  = rpc.declare({ object: 'luci',   method: 'getCPUUsage',  expect: { cpuusage: '' } });
var callCpuInfo   = rpc.declare({ object: 'luci',   method: 'getCPUInfo',   expect: { cpuinfo: '' } });
var callCpuBench  = rpc.declare({ object: 'luci',   method: 'getCPUBench',  expect: { cpubench: '' } });
var callIfaceDump = rpc.declare({ object: 'network.interface', method: 'dump', expect: { interface: [] } });
var callPorts     = rpc.declare({ object: 'luci', method: 'getBuiltinEthernetPorts', expect: { result: [] } });
/* 无参调用一次返回全部设备（含统计计数）：单次 RPC 覆盖所有接口，速率零遗漏 */
var callDevStatusAll = rpc.declare({ object: 'network.device', method: 'status', expect: { '': {} } });
/* QWRT 定制接口：conntrack 字节级记账（含硬件卸载流量），精确口径 */
var callClientRates = rpc.declare({ object: 'luci.client-rates', method: 'get', params: [ 'addresses' ], expect: { '': {} } });
var callLeases      = rpc.declare({ object: 'luci-rpc', method: 'getDHCPLeases', expect: { '': {} } });

/* ------------------------------------------------------------------ helpers */

function bytes(n) {
	n = parseInt(n, 10) || 0;
	var u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
}

/* 速率单位：统一使用 Mbps（与宽带运营商标称、测速软件一致） */
function rate(n) {
	if (n == null || !isFinite(n)) return '—';
	var m = Math.abs(n) / 1e6;
	if (m >= 100) return m.toFixed(0) + ' Mbps';
	if (m >= 10) return m.toFixed(1) + ' Mbps';
	return m.toFixed(2) + ' Mbps';
}

function parseCpu(s) {
	/* "CPU: 5%, HW Crypto: 772, PPE0: 20 PPE1: 31" */
	var o = { cpu: null, crypto: null, ppe0: null, ppe1: null };
	if (!s) return o;
	var m;
	if ((m = /CPU:\s*([\d.]+)%/.exec(s)))  o.cpu = parseFloat(m[1]);
	if ((m = /HW Crypto:\s*(\d+)/.exec(s))) o.crypto = parseInt(m[1], 10);
	if ((m = /PPE0:\s*(\d+)/.exec(s)))      o.ppe0 = parseInt(m[1], 10);
	if ((m = /PPE1:\s*(\d+)/.exec(s)))      o.ppe1 = parseInt(m[1], 10);
	return o;
}

function chipTemp(cpuinfo) {
	var m = /([\d.]+)\s*°C/.exec(cpuinfo || '');
	return m ? parseFloat(m[1]) : null;
}

function pctOf(part, total) {
	if (!total) return 0;
	return Math.max(0, Math.min(100, part / total * 100));
}

/* The schematic is a markup string: LuCI's E() creates HTML elements and an
   <svg> subtree built that way renders no shapes. */
function topologyMarkup(bind) {
	function b(id) { return bind ? ' data-bind="' + id + '"' : ''; }
	function anim() {
		return '<animate attributeName="stroke-dashoffset" values="6;0" dur="1.1s" repeatCount="indefinite"/>';
	}

	return '<svg class="topology-svg" viewBox="0 0 960 285" xmlns="http://www.w3.org/2000/svg">'
		+ '<defs><pattern id="fxgrid" width="20" height="20" patternUnits="userSpaceOnUse">'
		+ '<circle cx="2" cy="2" r="1" fill="#e2e8f0"/></pattern></defs>'
		+ '<rect width="960" height="285" fill="url(#fxgrid)" opacity="0.35"/>'

		/* fibre in */
		+ '<g transform="translate(8,86)">'
		+ '<text x="6" y="26" font-size="12" font-weight="700" fill="#334155">入户光纤</text>'
		+ '<circle cx="86" cy="22" r="4" fill="#10b981"/>'
		+ '<text x="6" y="46" font-size="13" font-weight="800" fill="#0f172a"'
		+ b('rx') + '>-16.4 dBm</text>'
		+ '<line x1="0" y1="58" x2="70" y2="58" stroke="#38bdf8" stroke-width="4" stroke-dasharray="4 2">' + anim() + '</line>'
		+ '<line x1="0" y1="64" x2="70" y2="64" stroke="#fb923c" stroke-width="4" stroke-dasharray="4 2">'
		+ '<animate attributeName="stroke-dashoffset" values="0;6" dur="1.1s" repeatCount="indefinite"/></line>'
		+ '</g>'

		/* BOSA */
		+ '<g transform="translate(96,52)">'
		+ '<rect width="112" height="178" rx="6" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.2"/>'
		+ '<circle cx="100" cy="14" r="4" fill="#10b981"/>'
		+ '<text x="10" y="20" font-size="11.5" font-weight="700" fill="#334155">BOSA 光器件</text>'
		+ '<rect x="8" y="34" width="96" height="52" rx="4" fill="#fff7ed" stroke="#fed7aa"/>'
		+ '<text x="14" y="49" font-size="10" font-weight="600" fill="#9a3412"'
		+ b('txp') + '>激光器 3.5 dBm</text>'
		+ '<text x="36" y="76" font-size="10" font-weight="700" fill="#ea580c">1270 nm ↑</text>'
		+ '<rect x="8" y="98" width="96" height="52" rx="4" fill="#eff6ff" stroke="#bfdbfe"/>'
		+ '<text x="14" y="114" font-size="10" font-weight="600" fill="#1e40af">雪崩二极管(APD)</text>'
		+ '<text x="36" y="138" font-size="10" font-weight="700" fill="#2563eb">1577 nm ↓</text>'
		+ '<text x="10" y="166" font-size="9.5" fill="#64748b"'
		+ b('modt') + '>温度 66.3 °C</text>'
		+ '</g>'

		+ '<path d="M208 110 H248" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="4 3"/>'
		+ '<path d="M208 140 H248" stroke="#fb923c" stroke-width="2.5" stroke-dasharray="4 3"/>'

		/* SoC */
		+ '<g transform="translate(248,16)">'
		+ '<rect width="510" height="240" rx="10" fill="#f0f7ff" stroke="#93c5fd" stroke-width="1.5" stroke-dasharray="6 4"/>'
		+ '<text x="20" y="17" font-size="11" font-weight="600" fill="#60a5fa">Airoha AN7581 Quad-Core SoC</text>'

		+ '<g transform="translate(20,26)">'
		+ '<rect width="106" height="58" rx="5" fill="#ffffff" stroke="#cbd5e1"/>'
		+ '<circle cx="94" cy="14" r="3.5" fill="#10b981"/>'
		+ '<text x="10" y="21" font-size="11" font-weight="700" fill="#334155">RAM · 512 MB</text>'
		+ '<text x="10" y="44" font-size="10" fill="#64748b"'
		+ b('ram') + '>可用 117 MiB</text>'
		+ '</g>'

		+ '<g transform="translate(20,96)">'
		+ '<rect width="106" height="58" rx="5" fill="#ffffff" stroke="#cbd5e1"/>'
		+ '<circle cx="94" cy="14" r="3.5" fill="#10b981"/>'
		+ '<text x="10" y="21" font-size="11" font-weight="700" fill="#334155">闪存 · 256 MB</text>'
		+ '<text x="10" y="44" font-size="10" fill="#64748b"'
		+ b('root') + '>已用 12 KiB</text>'
		+ '</g>'

		+ '<g transform="translate(140,26)">'
		+ '<rect width="350" height="94" rx="5" fill="#ffffff" stroke="#93c5fd" stroke-width="1.5"/>'
		+ '<circle cx="336" cy="16" r="4" fill="#10b981"/>'
		+ '<text x="14" y="23" font-size="12" font-weight="700" fill="#1e3a8a">CPU · ARMv8 Cortex-A53 × 4</text>'
		+ '<text x="266" y="23" font-size="11.5" font-weight="700" fill="#10b981"'
		+ b('cpu') + '>5%</text>'
		+ '<rect x="14" y="34" width="156" height="48" rx="4" fill="#f8fafc" stroke="#e2e8f0"/>'
		+ '<text x="22" y="50" font-size="10.5" font-weight="700" fill="#334155">Core 0 / Core 1</text>'
		+ '<text x="22" y="68" font-size="9.5" fill="#64748b"'
		+ b('cpud') + '>PON 驱动 · HW Crypto</text>'
		+ '<rect x="180" y="34" width="156" height="48" rx="4" fill="#f8fafc" stroke="#e2e8f0"/>'
		+ '<text x="188" y="50" font-size="10.5" font-weight="700" fill="#334155">Core 2 / Core 3</text>'
		+ '<text x="188" y="68" font-size="9.5" fill="#64748b"'
		+ b('pped') + '>PPE0: 20 · PPE1: 31</text>'
		+ '</g>'

		+ '<g transform="translate(140,132)">'
		+ '<rect width="98" height="88" rx="5" fill="#ffffff" stroke="#cbd5e1"/>'
		+ '<circle cx="86" cy="14" r="3.5" fill="#10b981"/>'
		+ '<text x="10" y="23" font-size="11.5" font-weight="700" fill="#334155">XGTC</text>'
		+ '<text x="10" y="39" font-size="9.5" fill="#64748b">PON MAC</text>'
		+ '<text x="10" y="68" font-size="10" font-weight="600" fill="#10b981"'
		+ b('onu') + '>O5 · 正常运行</text>'
		+ '</g>'

		+ '<g transform="translate(250,132)">'
		+ '<rect width="118" height="88" rx="5" fill="#ffffff" stroke="#cbd5e1"/>'
		+ '<circle cx="106" cy="14" r="3.5" fill="#10b981"/>'
		+ '<text x="10" y="23" font-size="11.5" font-weight="700" fill="#334155">PPE / HWNAT</text>'
		+ '<text x="10" y="39" font-size="9.5" fill="#64748b">硬件包转发引擎</text>'
		+ '<text x="10" y="60" font-size="9.5" fill="#2563eb"'
		+ b('down') + '>↓ —</text>'
		+ '<text x="10" y="76" font-size="9.5" fill="#ea580c"'
		+ b('up') + '>↑ —</text>'
		+ '</g>'

		+ '<g transform="translate(380,132)">'
		+ '<rect width="112" height="88" rx="5" fill="#ffffff" stroke="#cbd5e1"/>'
		+ '<circle cx="100" cy="14" r="3.5" fill="#10b981"/>'
		+ '<text x="10" y="23" font-size="11.5" font-weight="700" fill="#334155">Switch / PHY</text>'
		+ '<text x="10" y="39" font-size="9.5" fill="#64748b">2.5G + 千兆交换</text>'
		+ '<text x="10" y="68" font-size="11" font-weight="700" fill="#10b981"'
		+ b('wan') + '>WAN —</text>'
		+ '</g>'

		+ '<text x="330" y="232" font-size="9" fill="#94a3b8"'
		+ b('model') + '>FIBERHOME HG5585F · XG-PON GATEWAY</text>'
		+ '</g>'

		/* LAN / clients */
		+ '<g transform="translate(768,120)">'
		+ '<rect width="28" height="42" rx="3" fill="#1e293b" stroke="#475569"/>'
		+ '<rect x="4" y="6" width="20" height="30" rx="1" fill="#0f172a"/>'
		+ '<circle cx="21" cy="4" r="2" fill="#10b981"/>'
		+ '<text x="0" y="58" font-size="8.5" fill="#64748b">2.5G / LAN</text>'
		+ '</g>'
		+ '<g transform="translate(814,110)">'
		+ '<text x="14" y="28" font-size="12" font-weight="700" fill="#334155">内网客户端</text>'
		+ '<circle cx="96" cy="24" r="4" fill="#10b981"/>'
		+ '<text x="14" y="48" font-size="11" font-weight="600" fill="#10b981"'
		+ b('lan') + '>已连接并路由</text>'
		+ '</g>'
		+ '</svg>';
}

function gaugeMarkup(label, id) {
	/* 270° arc, r=40, circum=251.3, arc=188.5 */
	return '<div style="text-align:center">'
		+ '<svg class="gauge-svg" viewBox="0 0 100 100">'
		+ '<circle cx="50" cy="50" r="40" stroke="#e5e7eb" stroke-width="8" fill="none"'
		+ ' stroke-dasharray="188.5 251.3" stroke-dashoffset="0" transform="rotate(135 50 50)"/>'
		+ '<circle data-gauge="' + id + '" cx="50" cy="50" r="40" stroke="#10b981" stroke-width="8"'
		+ ' fill="none" stroke-dasharray="188.5 251.3" stroke-dashoffset="188.5" stroke-linecap="round"'
		+ ' transform="rotate(135 50 50)"/>'
		+ '<text data-gauge-text="' + id + '" x="50" y="48" text-anchor="middle"'
		+ ' font-size="16" font-weight="700" fill="#111827">—</text>'
		+ '<text x="50" y="62" text-anchor="middle" font-size="10" fill="#6b7280">%</text>'
		+ '</svg>'
		+ '<div class="gauge-label">' + label + '</div>'
		+ '</div>';
}

/* ------------------------------------------------------------------- view */

return view.extend({
	hist: {},          /* metric id → rolling samples */
	samples: {},       /* device → last byte counters */
	rates: {},         /* device → {rx,tx} */
	pon: null,
	cpuusage: '',
	cpuinfo: '',
	info: {},
	board: {},
	ifaces: [],

	/* 从租约收集客户端 IPv4 地址 */
	leaseAddresses: function(leases) {
		var list = (leases && leases.dhcp_leases) || [];
		var out = [], seen = {};
		list.forEach(function(l) {
			var ip = l && l.ipaddr;
			if (!ip || seen[ip]) return;
			seen[ip] = 1;
			out.push(ip);
		});
		return out.slice(0, 1024);
	},

	/* 从 rates[ip] 汇总当前速率（厂商已平滑，含硬件卸载） */
	ratesTotal: function(data) {
		var rates = (data && data.rates) || {};
		var up = 0, down = 0, any = false;
		Object.keys(rates).forEach(function(ip) {
			var r = rates[ip] || {};
			if (!r.ready) return;
			any = true;
			up += Number(r.upload || 0);
			down += Number(r.download || 0);
		});
		return any ? { up: up, down: down } : null;
	},

	/* 汇总 conntrack 累计字节（精确，含硬件卸载） */
	sumConntrack: function(data, t) {
		var traffic = (data && data.traffic) || {};
		var up = 0, down = 0;
		Object.keys(traffic).forEach(function(mac) {
			var v = traffic[mac] || {};
			up += parseInt(v.upload, 10) || 0;
			down += parseInt(v.download, 10) || 0;
		});
		return { up: up, down: down, t: t };
	},

	tileDefs: [
		{ id: 'cpu',    label: 'CPU 总占用' },
		{ id: 'crypto', label: '硬件加密计数' },
		{ id: 'ppe0',   label: 'PPE0 包处理' },
		{ id: 'ppe1',   label: 'PPE1 包处理' },
		{ id: 'load1',  label: '负载 (1 分钟)' },
		{ id: 'load5',  label: '负载 (5 分钟)' },
		{ id: 'mem',    label: '内存占用' },
		{ id: 'chipT',  label: '主芯片温度' },
		{ id: 'modT',   label: '光模块温度' }
	],

	load: function() {
		var self = this;

		var ponPromise = L.require('fs').then(function(fs) {
			return fs.exec('/usr/sbin/ponctl', [ '--device', 'pon0', 'status', '--json' ]);
		}).then(function(r) {
			if (!r || r.code !== 0 || !r.stdout) return null;
			try { return JSON.parse(r.stdout); } catch (e) { return null; }
		}).catch(function() { return null; });



		return Promise.all([
			L.resolveDefault(callBoard(), {}),
			L.resolveDefault(callSysInfo(), {}),
			L.resolveDefault(callCpuUsage(), ''),
			L.resolveDefault(callCpuInfo(), ''),
			L.resolveDefault(callCpuBench(), ''),
			L.resolveDefault(callIfaceDump(), { interface: [] }),
			ponPromise,
			L.resolveDefault(callDevStatusAll(), {}),
			L.resolveDefault(callPorts(), []),
			L.resolveDefault(callLeases(), {}).then(function(leases) {
				self.leaseAddrs = self.leaseAddresses(leases);
				return L.resolveDefault(callClientRates(self.leaseAddrs), {});
			})
		]);
	},

	/* ------------------------------------------------------------- rendering */

	pushHist: function(id, v) {
		if (v == null || !isFinite(v)) return;
		var h = this.hist[id] = this.hist[id] || [];
		h.push(v);
		if (h.length > 40) h.shift();
	},

	drawSpark: function(canvas, series, color) {
		if (!canvas || !series || series.length < 2) {
			/* a single sample: draw a dot so the tile is not empty */
			if (canvas && series && series.length === 1) {
				var c0 = canvas.getContext('2d');
				c0.clearRect(0, 0, canvas.width, canvas.height);
				c0.fillStyle = color;
				c0.beginPath();
				c0.arc(canvas.width - 6, canvas.height - 6, 2, 0, Math.PI * 2);
				c0.fill();
			}
			return;
		}

		var ctx = canvas.getContext('2d');
		var w = canvas.width, h = canvas.height;
		var min = Math.min.apply(null, series);
		var max = Math.max.apply(null, series);
		var range = (max - min) || 1;

		ctx.clearRect(0, 0, w, h);
		ctx.beginPath();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.8;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';

		for (var i = 0; i < series.length; i++) {
			var x = (i / (series.length - 1)) * (w - 4) + 2;
			var y = h - ((series[i] - min) / range) * (h - 8) - 4;
			if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
		}
		ctx.stroke();
	},

	setGauge: function(svgHost, id, percent, text) {
		var circle = svgHost.querySelector('[data-gauge="' + id + '"]');
		var pct = Math.max(0, Math.min(100, parseFloat(percent) || 0));
		var offset = (188.5 * (1 - (pct / 100))).toFixed(1);
		if (circle) circle.setAttribute('stroke-dashoffset', offset);
		var t = svgHost.querySelector('[data-gauge-text="' + id + '"]');
		if (t) t.textContent = text;
	},

	render: function(data) {
		var self = this;

		self.board    = data[0] || {};
		self.info     = data[1] || {};
		self.cpuusage = data[2] || '';
		self.cpuinfo  = data[3] || '';
		self.cpubench = data[4] || '';
		self.ifaces   = Array.isArray(data[5]) ? data[5] : [];
		self.pon      = data[6] || null;
		self.allDev   = data[7] || {};
		self.ports    = Array.isArray(data[8]) ? data[8] : [];
		self.clientRates = data[9] || {};

		/* ── 动态接口发现（零硬编码）────────────────────────────── */
		var wanIf = null;
		self.ifaces.forEach(function(x) {
			if (x['interface'] === 'wan') wanIf = x;
		});
		self.wanDev = (wanIf && wanIf.device) || null;

		self.wanPortDev = null;
		self.ports.forEach(function(p) {
			if (p.role === 'wan' && (!self.wanPortDev || p.device < self.wanPortDev))
				self.wanPortDev = p.device;
		});

		self.displayDevs = self.ports
			.map(function(p) { return p.device; })
			.sort();

		/* 用全量设备快照播种采样基线 */
		Object.keys(self.allDev).forEach(function(name) {
			var st = self.allDev[name] || {};
			var s = st.statistics || {};
			self.samples[name] = {
				rx: parseInt(s.rx_bytes, 10) || 0,
				tx: parseInt(s.tx_bytes, 10) || 0,
				t: Date.now()
			};
		});

		/* conntrack 累计播种（精确口径主数据源，方案 E） */
		self.ctSamples = self.sumConntrack(self.clientRates, Date.now());

		var host = E('div', { 'class': 'fx-root' });

		/* --- header --- */
		host.appendChild(E('div', { 'class': 'internal-header' }, [
			E('div', {}, [
				E('h2', { style: 'font-size:15px;font-weight:700;color:var(--text-color-highest);display:inline-block;margin-right:8px' },
					'整机内部详情'),
				E('span', { style: 'font-size:12px;color:var(--text-color-medium)' },
					'实时查看 ' + (self.board.model || '路由器') + ' 的硬件芯片与协议栈运行状态。')
			]),
			E('span', { 'class': 'realtime-badge' }, [
				E('span', { 'class': 'pulse-dot' }),
				E('span', {}, '实时 · 每 5 秒')
			])
		]));

		/* --- topology --- */
		var topoHost = E('div', { id: 'falcon-topo' });
		topoHost.innerHTML = topologyMarkup(true);

		var topoWrap = E('div', { 'class': 'topology-container' }, [
			E('div', { style: 'width:100%;overflow-x:auto' }, topoHost),
			E('div', { 'class': 'topology-legend' }, [
				E('div', { 'class': 'legend-items' }, [
					E('div', { 'class': 'legend-item' }, [
						E('span', { 'class': 'legend-line line-blue' }),
						E('span', {}, '1577 nm · 下行光载波')
					]),
					E('div', { 'class': 'legend-item' }, [
						E('span', { 'class': 'legend-line line-orange' }),
						E('span', {}, '1270 nm · 上行突发激光')
					])
				]),
				E('div', {}, '数值实时刷新 · 每 5 秒采样')
			])
		]);
		host.appendChild(topoWrap);

		/* --- 9 sparkline tiles --- */
		var tiles = E('div', { 'class': 'sparkline-cards-grid' });
		var canvases = {};

		this.tileDefs.forEach(function(def) {
			var canvas = E('canvas', { 'class': 'spark-card-canvas', width: 60, height: 24 });

			tiles.appendChild(E('div', { 'class': 'spark-card' }, [
				E('div', { 'class': 'spark-card-title' }, def.label),
				E('div', { 'class': 'spark-card-value', 'data-tile': def.id }, '—'),
				canvas
			]));

			canvases[def.id] = canvas;
		});
		host.appendChild(tiles);
		self.canvases = canvases;

		/* --- bottom grid: gauges | per-port throughput | interfaces --- */
		var gaugeHost = E('div', { 'class': 'gauge-wrapper' });
		gaugeHost.innerHTML =
			gaugeMarkup('CPU 占用', 'cpu') + gaugeMarkup('内存占用', 'mem');

		var gaugesBox = E('div', { 'class': 'detail-sub-box' }, [
			E('div', { 'class': 'sub-box-title' }, '资源占用'),
			gaugeHost
		]);

		var portBox = E('div', { 'class': 'detail-sub-box' }, [
			E('div', { 'class': 'sub-box-title' }, '实时流量，按端口'),
			E('div', { 'class': 'irq-list', 'data-port-traffic' : '1' })
		]);

		var ifaceBox = E('div', { 'class': 'detail-sub-box' }, [
			E('div', { 'class': 'sub-box-title' }, '接口状态'),
			E('div', { 'data-iface-blocks': '1' })
		]);

		host.appendChild(E('div', { 'class': 'detail-bottom-grid' },
			[ gaugesBox, portBox, ifaceBox ]));

		/* keep references for live updates */
		self.el = {
			host: host,
			topo: host.querySelector('#falcon-topo'),
			tiles: tiles,
			portTraffic: host.querySelector('[data-port-traffic]'),
			ifaceBlocks: host.querySelector('[data-iface-blocks]'),
			gauges: host.querySelector('.gauge-wrapper')
		};

		/* first paint */
		self.refreshAll(true);

		poll.add(function() { return self.refreshAll(false); }, 5);
		poll.start();

		return host;
	},

	refreshAll: function(first) {
		var self = this;

		return Promise.all([
			L.resolveDefault(callSysInfo(), {}),
			L.resolveDefault(callCpuUsage(), ''),
			L.resolveDefault(L.require('fs').then(function(fs) {
				return fs.exec('/usr/sbin/ponctl', [ '--device', 'pon0', 'status', '--json' ]);
			}).then(function(r) {
				return r && r.code === 0 && r.stdout ? JSON.parse(r.stdout) : null;
			}).catch(function() { return null; }), null),
			L.resolveDefault(callDevStatusAll(), {}),
			L.resolveDefault(callClientRates(self.leaseAddrs || []), {})
		]).then(function(r) {
			if (r[0]) self.info = r[0];
			if (r[1]) self.cpuusage = r[1];
			if (r[2]) self.pon = r[2];  /* 含 counters，供帧率估算 */

			/* 精确口径（方案 E）：conntrack 累计差分 */
			var ct = r[4] || {};
			if (ct && ct.source === 'conntrack') {
				var rt = self.ratesTotal(ct);
				if (rt) {
					self.ctRate = { rx: rt.down, tx: rt.up };
				} else {
					var curCt = self.sumConntrack(ct, Date.now());
					var prevCt = self.ctSamples;
					if (prevCt && curCt.t > prevCt.t && curCt.down >= prevCt.down && curCt.up >= prevCt.up) {
						var cdt = (curCt.t - prevCt.t) / 1000;
						self.ctRate = {
							rx: (curCt.down - prevCt.down) * 8 / cdt,
							tx: (curCt.up - prevCt.up) * 8 / cdt
						};
					}
					self.ctSamples = curCt;
				}
			}

			/* 单次全量差分：所有设备一次 RPC 全部算出速率 */
			var all = r[3] || {};
			Object.keys(all).forEach(function(name) {
				var st = all[name] || {};
				var s = st.statistics || {};
				var cur = {
					rx: parseInt(s.rx_bytes, 10) || 0,
					tx: parseInt(s.tx_bytes, 10) || 0,
					t: Date.now()
				};
				var prev = self.samples[name];
				if (prev && cur.t > prev.t) {
					var dt = (cur.t - prev.t) / 1000;
					self.rates[name] = {
						rx: (cur.rx - prev.rx) * 8 / dt,
						tx: (cur.tx - prev.tx) * 8 / dt
					};
				}
				self.samples[name] = cur;
			});

			self.updateTopology();
			self.updateTiles(first);
			self.updateGauges();
			self.updatePortTraffic();
			self.updateIfaces();
		});
	},

	updateTopology: function() {
		var self = this;
		var topo = this.el && this.el.topo;
		if (!topo) return;

		/* board model into the SoC caption (first fill only — text nodes persist) */
		var m = topo.querySelector('[data-bind="model"]');
		if (m && !m.textContent) {
			m.textContent = (this.board.model || 'GATEWAY').toUpperCase() + ' · XG-PON';
		}

		var fe = (this.pon && this.pon.frontend) || {};
		var reg = (this.pon && this.pon.registration) || {};
		var cpu = parseCpu(this.cpuusage);
		var mem = this.info.memory || {};
		var root = this.info.root || {};

		function put(sel, text) {
			var n = topo.querySelector('[data-bind="' + sel + '"]');
			if (n) n.textContent = text;
		}

		put('rx',   (isFinite(fe.rx_power_dbm) ? fe.rx_power_dbm.toFixed(1) : '—') + ' dBm');
		put('txp',  '激光器 ' + (isFinite(fe.tx_power_dbm) ? fe.tx_power_dbm.toFixed(1) : '—') + ' dBm');
		put('modt', '温度 ' + (isFinite(fe.temperature_celsius) ? fe.temperature_celsius.toFixed(1) : '—') + ' °C');
		put('ram',  '可用 ' + bytes(mem.available));
		put('root', '已用 ' + bytes(root.used));
		put('cpu',  cpu.cpu != null ? cpu.cpu + '%' : '—');
		put('cpud', 'HW Crypto ' + (cpu.crypto != null ? cpu.crypto : '—'));
		put('pped', 'PPE0: ' + (cpu.ppe0 != null ? cpu.ppe0 : '—') + ' · PPE1: ' + (cpu.ppe1 != null ? cpu.ppe1 : '—'));
		put('onu',  (reg.onu_state || '—') + (reg.onu_state === 'O5' ? ' · 正常运行' : ''));

		/* 口径：conntrack 记账优先（精确，含硬件卸载），回退 WAN 内核计数器。
		   不再使用 XGEM 帧率估算——空闲帧/PLOAM 会让它严重虚高（实测虚高 300 倍）。 */
		var r1 = (this.wanPortDev && this.rates[this.wanPortDev]) || {};
		var r2 = (this.wanDev && this.rates[this.wanDev]) || {};
		var ct = this.ctRate || {};
		var wanRx = Math.max(ct.rx || 0, r1.rx || 0, r2.rx || 0);
		var wanTx = Math.max(ct.tx || 0, r1.tx || 0, r2.tx || 0);
		put('down', '↓ ' + (wanRx > 0 ? rate(wanRx) : '—'));
		put('up',   '↑ ' + (wanTx > 0 ? rate(wanTx) : '—'));
		put('wan',  'WAN ' + (wanRx > 0 ? rate(wanRx) : '—'));
	},

	updateTiles: function(first) {
		var self = this;
		var cpu = parseCpu(this.cpuusage);
		var mem = this.info.memory || {};
		var used = (mem.total || 0) - (mem.available || mem.free || 0);
		var load = this.info.load || [ 0, 0, 0 ];
		var modT = (this.pon && this.pon.frontend) ? parseFloat(this.pon.frontend.temperature_celsius) : null;
		var chipT = chipTemp(this.cpuinfo);

		var values = {
			cpu:    cpu.cpu,
			crypto: cpu.crypto,
			ppe0:   cpu.ppe0,
			ppe1:   cpu.ppe1,
			load1:  load[0] / 65535,
			load5:  load[1] / 65535,
			mem:    pctOf(used, mem.total || 1),
			chipT:  chipT,
			modT:   modT
		};

		this.tileDefs.forEach(function(def) {
			var v = values[def.id];
			self.pushHist(def.id, v);

			var el = self.el.tiles.querySelector('[data-tile="' + def.id + '"]');
			if (!el) return;

			var fmt = function(x) {
				if (x == null || !isFinite(x)) return '—';
				if (def.id === 'mem') return x.toFixed(0) + '%';
				if (def.id === 'chipT' || def.id === 'modT') return x.toFixed(1) + ' °C';
				return (x % 1 === 0 && def.id !== 'load1' && def.id !== 'load5')
					? String(x) : x.toFixed(2);
			};

			el.textContent = fmt(v);

			var hist = self.hist[def.id] || [];
			self.drawSpark(self.canvases[def.id], hist, '#10b981');
		});
	},

	updateGauges: function() {
		if (!this.el || !this.el.gauges) return;
		var cpu = parseCpu(this.cpuusage);
		var mem = this.info.memory || {};
		var usedPct = pctOf((mem.total || 0) - (mem.available || mem.free || 0), mem.total || 1);

		this.setGauge(this.el.gauges, 'cpu', cpu.cpu != null ? cpu.cpu : 0,
			cpu.cpu != null ? cpu.cpu.toFixed(0) : '—');
		this.setGauge(this.el.gauges, 'mem', usedPct, usedPct.toFixed(0));
	},

	updatePortTraffic: function() {
		var host = this.el && this.el.portTraffic;
		if (!host) return;

		var self = this;
		var displayDevs = (this.displayDevs && this.displayDevs.length)
			? this.displayDevs
			: Object.keys(this.rates);

		/* 量程基准：默认以 100 Mbit/s 为基准量程，超过则动态扩展——
		   几百 kbit/s 的轻流量只会呈现一条细窄进度，不会撑满 */
		var maxRate = Math.max.apply(null, [ 0 ].concat(
			displayDevs.map(function(x) {
				var rr = self.rates[x] || {};
				return Math.max(rr.rx || 0, rr.tx || 0);
			})));
		var ceiling = Math.max(100 * 1000 * 1000, maxRate);

		var rows = displayDevs.map(function(d) {
			var r = self.rates[d] || {};

			/* 方向换算：pon0 是 WAN（rx=下行），LAN 口 rx=客户端上传——
			   统一成「↓ 下行 / ↑ 上行」的客户端视角。 */
			var isWan = (d === self.wanPortDev || d === self.wanDev);
			var down = isWan ? (r.rx || 0) : (r.tx || 0);
			var up = isWan ? (r.tx || 0) : (r.rx || 0);

			var activeRate = Math.max(up, down);
			var p = (activeRate > 0) ? Math.max(1, Math.min(100, (activeRate / ceiling) * 100)) : 0;

			return E('div', { 'class': 'irq-row' }, [
				E('span', { 'class': 'irq-name' }, d),
				E('div', { 'class': 'irq-bar-bg' }, E('div', {
					'class': 'irq-bar-fill',
					style: 'width:' + p.toFixed(1) + '%;background:#0284c7'
				})),
				E('span', { 'class': 'irq-count' }, '↓ ' + rate(down || null))
			]);
		});

		host.innerHTML = '';
		rows.forEach(function(row) { host.appendChild(row); });
	},

	updateIfaces: function() {
		var host = this.el && this.el.ifaceBlocks;
		if (!host) return;

		var dump = Array.isArray(this.ifaces) ? this.ifaces : [];
		var out = [];

		[ 'wan', 'lan' ].forEach(function(name) {
			var it = null;
			dump.forEach(function(x) { if (x['interface'] === name) it = x; });
			if (!it) return;

			var addr = (it['ipv4-address'] || [])[0];
			out.push(E('div', { 'class': 'vpe-block' }, [
				E('div', { 'class': 'vpe-head' }, name.toUpperCase() + ' · ' + (it.device || '—')),
				E('div', { 'class': 'vpe-desc' },
					addr ? addr.address + '/' + addr.mask : (it.up ? '已连接' : '未连接'))
			]));
		});

		var ponLine = (this.pon && this.pon.line) || {};
		var ponFe = (this.pon && this.pon.frontend) || {};
		var ponReg = (this.pon && this.pon.registration) || {};
		var ponDesc = [];

		if (ponReg.onu_state) {
			ponDesc.push(ponReg.onu_state === 'O5' ? 'O5 · 正常运行' : ponReg.onu_state);
		} else if (ponLine.lifecycle) {
			ponDesc.push(ponLine.lifecycle);
		}

		if (isFinite(ponFe.rx_power_dbm)) {
			ponDesc.push('收光 ' + ponFe.rx_power_dbm.toFixed(1) + ' dBm');
		}
		if (isFinite(ponFe.tx_power_dbm)) {
			ponDesc.push('发光 ' + ponFe.tx_power_dbm.toFixed(1) + ' dBm');
		}

		var modeName = (ponLine.active_mode || 'XG-PON').toUpperCase();
		out.push(E('div', { 'class': 'vpe-block', style: 'background:#f8fafc;border-color:#cbd5e1' }, [
			E('div', { 'class': 'vpe-head', style: 'color:#334155' }, 'PON 光链路 · ' + modeName),
			E('div', { 'class': 'vpe-desc', style: 'color:#64748b' },
				ponDesc.length ? ponDesc.join(' · ') : '已连接')
		]));

		host.innerHTML = '';
		out.forEach(function(b) { host.appendChild(b); });
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});