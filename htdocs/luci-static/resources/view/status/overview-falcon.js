'use strict';
'require view';
'require poll';
'require rpc';
'require ui';
'require uci';

/*
 * Falcon dashboard — Status → Overview.
 *
 * DOM mirrors the reference design class-for-class (see theme.css, the
 * .fx-root-scoped block). Values are live RPC reads.
 *
 * Note on the panel illustration: LuCI's E() creates HTML elements, which
 * cannot render SVG shapes. The schematic is therefore built as a markup
 * string and assigned via innerHTML — the HTML parser handles the SVG
 * namespace correctly.
 */

var callBoard     = rpc.declare({ object: 'system', method: 'board',  expect: { '': {} } });
var callSysInfo   = rpc.declare({ object: 'system', method: 'info',   expect: { '': {} } });
var callCpuUsage  = rpc.declare({ object: 'luci',   method: 'getCPUUsage',  expect: { cpuusage: '' } });
var callCpuInfo   = rpc.declare({ object: 'luci',   method: 'getCPUInfo',   expect: { cpuinfo: '' } });
var callCpuBench  = rpc.declare({ object: 'luci',   method: 'getCPUBench',  expect: { cpubench: '' } });
var callVersion   = rpc.declare({ object: 'luci',   method: 'getVersion', expect: { '': {} } });
var callPorts     = rpc.declare({ object: 'luci',   method: 'getBuiltinEthernetPorts', expect: { result: [] } });
var callIfaceDump = rpc.declare({ object: 'network.interface', method: 'dump', expect: { interface: [] } });
/* 无参调用一次返回全部设备（含统计计数），替代逐设备轮询：单次 RPC 覆盖所有接口 */
var callDevStatusAll = rpc.declare({ object: 'network.device', method: 'status', expect: { '': {} } });
var callWifiDevs  = rpc.declare({ object: 'iwinfo', method: 'devices',   expect: { devices: [] } });
/* QWRT 定制接口：conntrack 字节级记账（含硬件卸载流量），精确口径。
   rates 字段只对传入的 addresses 返回，故需先取租约里的客户端 IP。 */
var callClientRates = rpc.declare({ object: 'luci.client-rates', method: 'get', params: [ 'addresses' ], expect: { '': {} } });
var callLeases      = rpc.declare({ object: 'luci-rpc', method: 'getDHCPLeases', expect: { '': {} } });
var callHostHints   = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
/* 反查主机名：为没有 DHCP 租约/主机提示的客户端补名字 */
var callRrdns       = rpc.declare({ object: 'network.rrdns', method: 'lookup', params: [ 'addrs', 'timeout', 'limit' ], expect: { '': {} } });
/* hqos：厂商「客户端限速」引擎（luci-app-hqos），限速单位 kbps */
var callQosState    = rpc.declare({ object: 'hqos', method: 'status', expect: { '': {} } });
var callQosGet      = rpc.declare({ object: 'hqos', method: 'get', params: [ 'mac' ], expect: { '': {} } });
var callQosSet      = rpc.declare({ object: 'hqos', method: 'set', params: [ 'mac', 'name', 'upload', 'download', 'connections' ], expect: { '': {} } });
var callWifiInfo  = rpc.declare({ object: 'iwinfo', method: 'info',      params: [ 'device' ], expect: { '': {} } });
var callWifiAssoc = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device' ], expect: { results: [] } });

/* --------------------------------------------------------------- formatting */

/* 归一化地址：去掉 /mask，IPv6 转小写 */
function normAddr(ip) {
	ip = (ip || '').replace(/\/\d+$/, '');
	if (!ip) return null;
	if (ip.indexOf(':') < 0) {
		var p = ip.split('.');
		if (p.length !== 4) return null;
		for (var i = 0; i < 4; i++) {
			var v = parseInt(p[i], 10);
			if (isNaN(v) || v < 0 || v > 255) return null;
		}
		return p.join('.');
	}
	return ip.toLowerCase();
}

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

function duration(sec) {
	sec = parseInt(sec, 10) || 0;
	var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600);
	var m = Math.floor(sec % 3600 / 60), s = sec % 60;
	if (d) return d + 'd ' + h + 'h ' + m + 'm';
	if (h) return h + 'h ' + m + 'm ' + s + 's';
	return m + 'm ' + s + 's';
}

function pctOf(part, total) {
	if (!total) return 0;
	return Math.max(0, Math.min(100, part / total * 100));
}

function localTime(unixtime) {
	if (!unixtime) return '—';
	var d = new Date((unixtime + (new Date().getTimezoneOffset() * -60)) * 1000);
	var p = function(v) { return (v < 10 ? '0' : '') + v; };
	return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 '
		+ p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ------------------------------------------------------------- DOM builders */

/* 折叠状态持久化：跨刷新/跨轮询保持（localStorage 失败时静默降级为内存态） */
var collapsedCards = (function() {
	try { return JSON.parse(window.localStorage.getItem('falcon-collapsed-cards') || '{}') || {}; }
	catch (e) { return {}; }
})();

function persistCollapsed() {
	try { window.localStorage.setItem('falcon-collapsed-cards', JSON.stringify(collapsedCards)); }
	catch (e) { /* 私隐模式等场景下静默降级 */ }
}

function card(title, body) {
	var isCollapsed = !!collapsedCards[title];

	var toggleBtn = E('button', {
		'class': 'card-toggle-btn',
		'type': 'button',
		'aria-label': isCollapsed ? '展开' : '折叠'
	}, [
		E('span', { 'class': 'toggle-chevron' }, '^')
	]);

	var header = E('div', { 'class': 'card-header' }, [
		E('span', { 'class': 'card-title' }, title),
		toggleBtn
	]);

	var cardBody = E('div', { 'class': 'card-body' }, body);

	var cardEl = E('div', {
		'class': 'card' + (isCollapsed ? ' card-collapsed' : '')
	}, [ header, cardBody ]);

	if (header && header.addEventListener) {
		header.addEventListener('click', function(ev) {
			if (ev.target && (ev.target.tagName === 'A' || (ev.target.closest && ev.target.closest('a'))))
				return;
			isCollapsed = !isCollapsed;
			collapsedCards[title] = isCollapsed;
			persistCollapsed();
			cardEl.classList.toggle('card-collapsed', isCollapsed);
			toggleBtn.setAttribute('aria-label', isCollapsed ? '展开' : '折叠');
		});
	}

	return cardEl;
}

function progressRow(label, valueText, percent, fill) {
	return E('div', { 'class': 'progress-bar-container' }, [
		E('div', { 'class': 'progress-label-row' }, [
			E('span', { style: 'color:#6b7280' }, label),
			E('span', { style: 'font-weight:500' }, valueText)
		]),
		E('div', { 'class': 'progress-track' }, E('div', {
			'class': 'progress-fill ' + fill,
			style: 'width:' + percent.toFixed(1) + '%'
		}))
	]);
}

function metric(caption, text, sub, warn) {
	var kids = [
		E('span', { 'class': 'metric-caption' }, caption),
		E('div', { 'class': 'metric-value-row' }, [
			E('span', { 'class': warn ? 'status-dot status-dot-warn' : 'status-dot' }),
			E('span', {}, text)
		])
	];
	if (sub) kids.push(E('div', { 'class': 'metric-sub-caption' }, sub));
	return E('div', {}, kids);
}

/* The schematic must be built as a string: LuCI's E() produces HTML elements
   and an <svg> subtree created that way renders nothing but stray text. */
function panelSvgMarkup() {
	function rj45(x, label, primary, up) {
		return '<g transform="translate(' + x + ',0)">'
			+ '<rect x="0" y="8" width="28" height="36" rx="3" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>'
			+ '<rect x="4" y="15" width="20" height="22" rx="2" fill="' + (up ? '#1e293b' : '#475569') + '"/>'
			+ '<circle cx="21" cy="5" r="1.5" fill="' + (up ? '#10b981' : '#94a3b8') + '"/>'
			+ '<text x="14" y="54" text-anchor="middle" font-size="8.5" fill="'
			+ (primary ? '#0284c7' : '#475569') + '" font-weight="' + (primary ? 700 : 600) + '">'
			+ label + '</text></g>';
	}

	return '<svg class="router-panel-svg" viewBox="0 0 350 115" xmlns="http://www.w3.org/2000/svg">'
		+ '<rect x="6" y="10" width="338" height="95" rx="8" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.2"/>'

		/* fibre in */
		+ '<path d="M0 52 H28" stroke="#16a34a" stroke-width="3.5" stroke-linecap="round"/>'
		+ '<path d="M0 52 H28" stroke="#86efac" stroke-width="1.8" stroke-dasharray="3 3">'
		+ '<animate attributeName="stroke-dashoffset" values="6;0" dur="1s" repeatCount="indefinite"/></path>'
		+ '<rect x="28" y="36" width="22" height="32" rx="2.5" fill="#15803d" stroke="#16a34a"/>'
		+ '<rect x="33" y="42" width="12" height="20" rx="1" fill="#14532d"/>'
		+ '<circle cx="39" cy="52" r="2.5" fill="#4ade80">'
		+ '<animate attributeName="opacity" values="0.6;1;0.6" dur="2s" repeatCount="indefinite"/></circle>'
		+ '<text x="39" y="82" font-size="9" fill="#15803d" font-weight="700" text-anchor="middle">PON 光口</text>'
		+ '<text x="39" y="93" font-size="7.5" fill="#64748b" text-anchor="middle">SC/APC</text>'

		+ '<path d="M50 52 H68" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="2 2"/>'

		/* BOSA */
		+ '<g transform="translate(68,22)">'
		+ '<rect x="0" y="0" width="102" height="66" rx="5" fill="#ffffff" stroke="#cbd5e1"/>'
		+ '<text x="8" y="14" font-size="8.5" fill="#475569" font-weight="700">BOSA 光器件</text>'
		+ '<circle cx="94" cy="11" r="2.5" fill="#10b981"/>'
		+ '<rect x="6" y="20" width="90" height="18" rx="3" fill="#fff7ed" stroke="#fed7aa"/>'
		+ '<text x="12" y="32" font-size="8.5" fill="#c2410c" font-weight="700">1270 nm ↑</text>'
		+ '<text x="62" y="32" font-size="7.5" fill="#ea580c">激光发射</text>'
		+ '<rect x="6" y="42" width="90" height="18" rx="3" fill="#eff6ff" stroke="#bfdbfe"/>'
		+ '<text x="12" y="54" font-size="8.5" fill="#0369a1" font-weight="700">1577 nm ↓</text>'
		+ '<text x="62" y="54" font-size="7.5" fill="#0284c7">光电接收</text>'
		+ '</g>'

		+ '<path d="M170 55 H184" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="2 2"/>'

		/* ports */
		+ '<g transform="translate(184,20)">'
		+ rj45(0, '2.5G', true, true)
		+ rj45(36, 'LAN 1', false, true)
		+ rj45(72, 'LAN 2', false, true)
		+ rj45(108, 'LAN 3', false, false)
		+ '</g>'

		+ '<text x="334" y="22" font-size="8" fill="#94a3b8" text-anchor="end" font-family="monospace">HG5585F · AN7581</text>'
		+ '</svg>';
}

/* ------------------------------------------------------------------- pages */

return view.extend({
	samples: {},
	devStatus: {},
	wifiInfos: [],
	rates: {},

	/* 设备计数器 → 客户端视角方向换算。
	   LAN 口：路由器从客户端「收进」= 客户端上传（rx），向客户端「发出」= 客户端下载（tx）；
	   WAN 口：路由器「收进」= 客户端下载（rx），「发出」= 客户端上传（tx）。
	   统一成 (upload, download) 后，界面标签在全站含义一致。 */
	dirOf: function(isWan, stats, rates) {
		var rx = (rates && rates.rx) || 0;
		var tx = (rates && rates.tx) || 0;
		var s = stats || {};
		var crx = parseInt(s.rx_bytes, 10) || 0;
		var ctx = parseInt(s.tx_bytes, 10) || 0;
		return isWan
			? { up: tx, down: rx, cumUp: ctx, cumDown: crx, upLabel: '↑', downLabel: '↓' }
			: { up: rx, down: tx, cumUp: crx, cumDown: ctx, upLabel: '↑', downLabel: '↓' };
	},

	/* 汇总 conntrack 累计字节（用于累计量显示）；
	   速率则取厂商接口的 rates 字段——它已按 interval/window 平滑，
	   比在浏览器侧对累计值做差分稳定得多。 */
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

	/* 从租约里收集客户端 IPv4 地址（去重，限 1024 与厂商视图同口径） */
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

	/* 请求 rates 用的全量地址：租约 ∪ HostHints ∪ conntrack 已见 MAC。
	   只传租约会漏掉静态 IP 设备（如 NAS），其流量仍计入 conntrack。 */
	clientAddresses: function() {
		var self = this;
		var out = {}, seen = {};
		function add(list) {
			[].concat(list || []).forEach(function(ip) {
				var n = normAddr(ip);
				if (n && !seen[n]) { seen[n] = 1; out[n] = 1; }
			});
		}
		Object.keys(this.leaseIps || {}).forEach(function(m) { add(self.leaseIps[m]); });
		Object.keys(this.hints || {}).forEach(function(m) {
			var h = self.hints[m] || {};
			add([].concat(h.ipaddrs || [], h.ip6addrs || []));
		});
		Object.keys(this.live || {}).forEach(function(m) { add(self.addressesOf(m)); });
		Object.keys(this.qosLimits || {}).forEach(function(m) { add(self.addressesOf(m)); });
		return Object.keys(out).slice(0, 1024);
	},

	/* 取某 MAC 的已知地址（租约 ∪ HostHints） */
	addressesOf: function(mac) {
		var host = (this.hints && (this.hints[mac] || this.hints[mac.toUpperCase()] || this.hints[mac.toLowerCase()])) || {};
		var out = [], seen = {};
		[].concat(host.ipaddrs || [], host.ip6addrs || [], (this.leaseIps && this.leaseIps[mac]) || []).forEach(function(ip) {
			var n = normAddr(ip);
			if (n && !seen[n]) { seen[n] = 1; out.push(n); }
		});
		return out;
	},

	/* 第二低比特为 1 表示本地管理地址——手机/平板的 MAC 随机化就是这个特征，
	   这类设备不会有稳定主机名，强行显示「未命名」只会制造噪音。 */
	isRandomMac: function(mac) {
		var first = parseInt((mac || '').substr(0, 2), 16);
		if (isNaN(first)) return false;
		return (first & 0x02) !== 0;
	},

	/* 名称解析：租约/HostHints 已知的直接用；其余按 IP 反查一次并缓存。
	   解析结果回来后触发一次列表重建。 */
	resolveNames: function(clients) {
		var self = this;
		if (self.dnsBusy) return;
		var want = [], seen = {};
		clients.forEach(function(c) {
			if (c.name) return;
			c.ips.forEach(function(ip) {
				if (ip.indexOf(':') >= 0) return;            /* rrdns 主要走 IPv4 */
				if (self.dnsCache[ip] !== undefined || seen[ip]) return;
				seen[ip] = 1;
				want.push(ip);
			});
		});
		if (!want.length) return;

		self.dnsBusy = true;
		L.resolveDefault(callRrdns(want.slice(0, 64), 3000, 64), {}).then(function (res) {
			var got = false;
			Object.keys(res || {}).forEach(function (ip) {
				var name = res[ip];
				if (name == null) return;
				name = String(name).replace(/\.$/, '').trim();
				if (!name || name === ip) return;
				self.dnsCache[ip] = name;
				got = true;
			});
			/* 查不到也记下，避免每次轮询重复请求 */
			want.forEach(function (ip) { if (self.dnsCache[ip] === undefined) self.dnsCache[ip] = null; });
			if (got && self.rebuildClientList) self.rebuildClientList();
		}).catch(function () {
			want.forEach(function (ip) { if (self.dnsCache[ip] === undefined) self.dnsCache[ip] = null; });
		}).then(function () { self.dnsBusy = false; });
	},

	/* 组装客户端清单：DHCP 租约 ∪ conntrack 见过的 MAC ∪ HostHints ∪ 已配限速者 */
	buildClientList: function() {
		var self = this;
		var map = {};

		function touch(mac) {
			mac = (mac || '').toUpperCase();
			if (!mac || mac === '00:00:00:00:00:00') return null;
			if (!map[mac]) map[mac] = { mac: mac, name: '', ips: [] };
			return map[mac];
		}

		((this.leases && this.leases.dhcp_leases) || []).forEach(function(l) {
			var c = touch(l.macaddr);
			if (!c) return;
			if (l.hostname && !c.name) c.name = l.hostname;
			[].concat(l.ipaddr || [], l.ipaddrs || [], l.ip6addr || [], l.ip6addrs || []).forEach(function(ip) {
				var n = normAddr(ip);
				if (n && c.ips.indexOf(n) < 0) c.ips.push(n);
			});
		});

		Object.keys((this.clientRates && this.clientRates.traffic) || {}).forEach(function(mac) {
			var c = touch(mac);
			if (!c) return;
			(self.addressesOf(mac) || []).forEach(function(ip) { if (c.ips.indexOf(ip) < 0) c.ips.push(ip); });
		});

		Object.keys(this.hints || {}).forEach(function(mac) {
			var c = touch(mac);
			if (!c) return;
			var h = self.hints[mac] || {};
			if (!c.name && h.name) c.name = h.name;
			/* 地址也要一并收集：否则静态 IP 设备会被误判为「离线」 */
			[].concat(h.ipaddrs || [], h.ip6addrs || []).forEach(function(ip) {
				var n = normAddr(ip);
				if (n && c.ips.indexOf(n) < 0) c.ips.push(n);
			});
		});

		/* 已配置限速的客户端即使离线也要显示，否则无法取消规则 */
		Object.keys(this.qosLimits || {}).forEach(function(mac) {
			var c = touch(mac);
			if (!c) return;
			if (!c.name && self.qosLimits[mac] && self.qosLimits[mac].name) c.name = self.qosLimits[mac].name;
		});

		var list = Object.keys(map).map(function(k) { return map[k]; });

		list.forEach(function(c) {
			/* 反查结果补齐名字 */
			if (!c.name) {
				for (var i = 0; i < c.ips.length; i++) {
					var n = self.dnsCache && self.dnsCache[c.ips[i]];
					if (n) { c.name = n; break; }
				}
			}
			/* 仍然没名字的，标出随机 MAC，避免一排「未命名」 */
			c.random = self.isRandomMac(c.mac);
			c.display = c.name || (c.random ? '随机 MAC 设备' : '未知设备');
		});

		/* 过滤纯空闲条目：既无名称、又无流量、又无连接、也没配限速——
		   这些是 conntrack 里的历史残留，留着只会淹没真正的设备。 */
		list = list.filter(function(c) {
			if (c.name || (self.qosLimits && self.qosLimits[c.mac])) return true;
			var lv = self.live[c.mac];
			if (!lv) return false;
			return (lv.cumUp + lv.cumDown) > 0 || lv.conns > 0;
		});

		/* 排序：有名字的真实设备在前，随机 MAC / 未知在后；组内按实时流量 */
		function rank(c) { return c.name ? 0 : (c.random ? 1 : 2); }
		list.sort(function(a, b) {
			var ra = rank(a), rb = rank(b);
			if (ra !== rb) return ra - rb;
			var la = self.live[a.mac] ? (self.live[a.mac].up + self.live[a.mac].down) : -1;
			var lb = self.live[b.mac] ? (self.live[b.mac].up + self.live[b.mac].down) : -1;
			if (lb !== la) return lb - la;
			return (a.display || a.mac) > (b.display || b.mac) ? 1 : -1;
		});
		return list;
	},

	/* 把 conntrack 结果落到 this.live */
	ingestClients: function(rates) {
		var self = this;
		var traffic = (rates && rates.traffic) || {};
		var totals  = (rates && rates.totals) || {};
		var conns   = (rates && rates.connections) || {};
		var rr      = (rates && rates.rates) || {};

		self.live = {};
		Object.keys(traffic).forEach(function(mac) {
			var t = traffic[mac] || {};
			self.live[(mac || '').toUpperCase()] = {
				up: 0, down: 0,
				cumUp: parseInt(t.upload, 10) || 0,
				cumDown: parseInt(t.download, 10) || 0,
				total: parseInt(totals[mac], 10) || 0,
				conns: parseInt(conns[mac], 10) || 0
			};
		});

		Object.keys(rr).forEach(function(ip) {
			var v = rr[ip] || {};
			if (!v.ready || !v.mac) return;
			var m = (v.mac || '').toUpperCase();
			if (!self.live[m]) self.live[m] = { up: 0, down: 0, cumUp: 0, cumDown: 0, total: 0, conns: 0 };
			self.live[m].up += Number(v.upload || 0) * 8;
			self.live[m].down += Number(v.download || 0) * 8;
		});

		/* 整机活动连接数：conntrack 按 MAC 汇总，相加即全部活动连接。
		   routed_connections 只计经三层路由的条目（纯二层交换不计入）。 */
		var routed = (rates && rates.routed_connections) || {};
		var connSum = 0, routedSum = 0;
		Object.keys(conns).forEach(function(m) { connSum += parseInt(conns[m], 10) || 0; });
		Object.keys(routed).forEach(function(m) { routedSum += parseInt(routed[m], 10) || 0; });
		self.connTotal = connSum;
		self.connRouted = routedSum;
	},

	/* 从 rates[ip] 汇总当前速率（厂商已平滑）。
	   注意：rates 只对请求时传入的 addresses 返回，未传 IP 时为空对象。 */
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

	load: function() {
		var self = this;

		var ponPromise = L.require('fs').then(function(fs) {
			return fs.exec('/usr/sbin/ponctl', [ '--device', 'pon0', 'status', '--json' ]);
		}).then(function(r) {
			if (!r || r.code !== 0 || !r.stdout) return null;
			try { return JSON.parse(r.stdout); } catch (e) { return null; }
		}).catch(function() { return null; });

		/* the RPC returns [lan2, lan3, lan4, lan1]; sort so ports read 1234 */
		var portsPromise = L.resolveDefault(callPorts(), []).then(function(list) {
			list.sort(function(a, b) {
				return a.device < b.device ? -1 : (a.device > b.device ? 1 : 0);
			});
			return list;
		});

		var wifiPromise = L.resolveDefault(callWifiDevs(), []).then(function(devs) {
			return Promise.all(devs.slice(0, 4).map(function(dev) {
				return Promise.all([
					L.resolveDefault(callWifiInfo(dev), {}),
					L.resolveDefault(callWifiAssoc(dev), [])
				]).then(function(r) {
					if (r[0] && r[0].ssid) {
						var clientList = Array.isArray(r[1]) ? r[1] : ((r[1] && Array.isArray(r[1].results)) ? r[1].results : []);
						self.wifiInfos.push({
							device: dev,
							info: r[0],
							clients: clientList
						});
					}
				});
			})).then(function() { return self.wifiInfos; });
		});

		var tempsPromise = L.require('fs').then(function(fs) {
			return fs.exec('/usr/libexec/falcon-wifi-temp');
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
			L.resolveDefault(callVersion(), {}),
			portsPromise,
			wifiPromise,
			ponPromise,
			tempsPromise,
			L.resolveDefault(callDevStatusAll(), {}),
			L.resolveDefault(callIfaceDump(), { interface: [] }),
			L.resolveDefault(callLeases(), {}).then(function(leases) {
				self.leases = leases || {};
				self.leaseAddrs = self.leaseAddresses(leases);
				return Promise.all([
					L.resolveDefault(callClientRates(self.leaseAddrs), {}),
					L.resolveDefault(callHostHints(), {}),
					L.resolveDefault(callQosState(), {})
				]);
			})
		]).then(function(r) {
			/* 把租约批次里的三个结果摊平进同一个数组，保持既有索引不变 */
			var tail = r[12] || [];
			r[19] = tail[0] || {};   /* conntrack rates */
			r[20] = tail[1] || {};   /* host hints */
			r[21] = tail[2] || {};   /* qos engine state */

			/* 已知 MAC 集合 → 逐个读已有 hqos 规则（用于预填输入框） */
			var macs = {};
			((self.leases && self.leases.dhcp_leases) || []).forEach(function(l) {
				if (l.macaddr) macs[String(l.macaddr).toUpperCase()] = 1;
			});
			Object.keys(r[20] || {}).forEach(function(m) { macs[String(m).toUpperCase()] = 1; });
			Object.keys((r[19] && r[19].traffic) || {}).forEach(function(m) { macs[String(m).toUpperCase()] = 1; });

			var macList = Object.keys(macs);
			return Promise.all(macList.map(function(m) {
				return L.resolveDefault(callQosGet(m), null).then(function(v) {
					if (v && (Number(v.upload) > 0 || Number(v.download) > 0 || Number(v.connections) > 0 || v.enabled))
						self.qosLimitsPre = self.qosLimitsPre || {}, self.qosLimitsPre[m] = v;
				});
			})).then(function() { return r; });
		});
	},

	/* --- 1. 系统 --- */
	cardSystem: function(board, version, info, cpuusage, cpuinfo, wifiTemps, pon) {
		var rel = board.release || {};

		/* SoC temperature rides along in the cpuinfo string */
		var tm = /([\d.]+)\s*°C/.exec(cpuinfo || '');
		var cpuTempStr = tm ? (parseFloat(tm[1]).toFixed(1) + ' °C') : '—';

		/* 清洗架构字符串：剔除混入其中的温度，避免与下方温度行重复展示 */
		var rawArch = cpuinfo || board.system || '';
		var cleanArch = rawArch
			.replace(/\s*[\d.]+\s*°C\s*/gi, '')
			.replace(/\(\s+/g, '(')
			.replace(/\s+\)/g, ')')
			.replace(/\(\s*\)/g, '')
			.replace(/\s+/g, ' ')
			.trim();

		/* wifi radio temperatures from the ACL-granted helper, which
		   auto-discovers radios via iwinfo. One reading per radio, in the order
		   the helper reports them. Band names are deliberately omitted: this row
		   is a temperature readout, not a radio listing, so "2.4G / 5G" prefixes
		   only add noise. */
		var wifiParts = [];
		Object.keys(wifiTemps || {}).forEach(function(dev) {
			var t = parseFloat(wifiTemps[dev]);
			if (!isFinite(t)) return;
			wifiParts.push(t.toFixed(1) + ' °C');
		});
		var wifiTempStr = wifiParts.length ? wifiParts.join(' · ') : '—';

		/* 主机核心温度：CPU 与 Wi-Fi 射频温度（PON 光前端温度在下方光纤卡片中专门展现） */
		var tempSummary = 'CPU: ' + cpuTempStr + ' · Wi-Fi: ' + wifiTempStr;

		var rows = [
			[ '主机名', board.hostname ],
			[ '型号', board.model ],
			[ '架构', cleanArch || board.system ],
			[ '温度', tempSummary ],
			[ '目标平台', rel.target ],
			[ '固件版本', (rel.description || '') + ' / ' + (version.branch || '') ],
			[ '内核版本', board.kernel ],
			[ '本地时间', localTime(info.localtime) ],
			[ '已运行时间', duration(info.uptime) ],
			[ '平均负载', (info.load || [ 0, 0, 0 ]).map(function(v) {
				return (v / 65535).toFixed(2);
			}).join(', ') ],
			[ '连接数', (this.connTotal != null ? this.connTotal : '—') ],
			[ 'CPU 与硬件加速', cpuusage || '—' ]
		];

		var table = E('table', { 'class': 'info-table' });
		rows.forEach(function(r) {
			table.appendChild(E('tr', {}, [
				E('td', { 'class': 'key' }, r[0]),
				E('td', { 'class': 'val' }, (r[1] != null && r[1] !== '') ? r[1] : '—')
			]));
		});

		return card('系统', table);
	},

	/* --- 2. 内存 --- */
	cardMemory: function(info) {
		var mem = info.memory || {};
		var used = (mem.total || 0) - (mem.available || mem.free || 0);
		var tot = mem.total || 1;

		return card('内存', [
			progressRow('可用总数',
				bytes(mem.available || mem.free) + ' / ' + bytes(tot) + ' (' +
				Math.round(pctOf(mem.available || mem.free, tot)) + '%)',
				pctOf(mem.available || mem.free, tot), 'fill-blue'),
			progressRow('已使用',
				bytes(used) + ' / ' + bytes(tot) + ' (' + Math.round(pctOf(used, tot)) + '%)',
				pctOf(used, tot), 'fill-red'),
			progressRow('已缓冲',
				bytes(mem.buffered) + ' / ' + bytes(tot) + ' (' + Math.round(pctOf(mem.buffered, tot)) + '%)',
				pctOf(mem.buffered, tot), 'fill-blue'),
			progressRow('已缓存',
				bytes(mem.cached) + ' / ' + bytes(tot) + ' (' + Math.round(pctOf(mem.cached, tot)) + '%)',
				pctOf(mem.cached, tot), 'fill-blue')
		]);
	},

	/* --- 3. 存储 --- */
	cardStorage: function(info) {
		var root = info.root || {};
		var tmp = info.tmp || {};
		var swap = info.swap || {};

		var rows = [
			progressRow('磁盘空间 (/overlay)',
				bytes(root.used) + ' / ' + bytes(root.total) + ' (' +
				Math.round(pctOf(root.used, root.total || 1)) + '%)',
				pctOf(root.used, root.total || 1), 'fill-blue'),
			progressRow('临时空间 (/tmp)',
				bytes(tmp.used) + ' / ' + bytes(tmp.total) + ' (' +
				Math.round(pctOf(tmp.used, tmp.total || 1)) + '%)',
				pctOf(tmp.used, tmp.total || 1), 'fill-blue')
		];

		if (swap.total > 0)
			rows.push(progressRow('交换空间',
				bytes(swap.total - swap.free) + ' / ' + bytes(swap.total) + ' (' +
				Math.round(pctOf(swap.total - swap.free, swap.total)) + '%)',
				pctOf(swap.total - swap.free, swap.total), 'fill-orange'));

		return card('存储', rows);
	},

	/* --- 4. 光纤 (GPON) — the signature card ---
	   Six metrics, captions and sub-captions copied from the reference. */
	cardOptical: function(pon, cpuinfo, rates, ports) {
		var fe = (pon && pon.frontend) || {};
		var line = (pon && pon.line) || {};
		var reg = (pon && pon.registration) || {};

		var rx = parseFloat(fe.rx_power_dbm);
		var tx = parseFloat(fe.tx_power_dbm);
		var temp = parseFloat(fe.temperature_celsius);
		var bias = parseFloat(fe.tx_bias_ma);

		/* chip temperature rides along in the cpuinfo string */
		var chipTemp = null;
		var tm = /([\d.]+)\s*°C/.exec(cpuinfo || '');
		if (tm) chipTemp = parseFloat(tm[1]);

		var onu = reg.onu_state || null;
		var mode = (line.active_mode || line.configured_mode || '').toUpperCase();
		var modeText = mode === 'XGPON' ? 'XG-PON (10G/2.5G)' : (mode || '—');
		var rxPct = isFinite(rx) ? Math.max(0, Math.min(100, (rx + 28) / 20 * 100)) : 50;

		/* optical-quality word, same scale the reference used */
		var quality = '优秀';
		if (isFinite(rx)) {
			if (rx < -26 || rx > -8) quality = '异常';
			else if (rx < -24) quality = '良好';
		}

		/* 吞吐口径优先级（精度递减）：
		   ① conntrack 记账（精确，含硬件卸载与 Wi-Fi 流量）——首选；
		   ② WAN 物理端口 / 三层设备的内核计数器（未启用硬件卸载时准确）。
		   取两者最大值：任一口径看到流量都不会误显示为 0。
		   注意：不使用 XGEM 帧计数推算——PON 空闲帧与 PLOAM 会让它严重虚高。 */
		var r1 = (this.wanDev && rates && rates[this.wanDev]) || {};
		var r2 = (this.wanPortDev && rates && rates[this.wanPortDev]) || {};
		var ct = this.ctRate || {};
		var rxRate = Math.max(ct.rx || 0, r1.rx || 0, r2.rx || 0);
		var txRate = Math.max(ct.tx || 0, r1.tx || 0, r2.tx || 0);

		/* left: panel drawing (innerHTML keeps the SVG namespace intact) */
		var diagram = E('div', { 'class': 'router-panel-diagram' });
		diagram.innerHTML = panelSvgMarkup();

		/* right: the reference's six tiles */
		var grid = E('div', { 'class': 'gpon-metrics-grid' }, [
			metric('PON 注册状态',
				(onu || '—') + (line.lifecycle === 'operational' ? ' · 正常运行' : ''),
				onu + ', ' + (line.lifecycle === 'operational' ? '运行状态 (OLT 已认证)' : (line.lifecycle || '未就绪')),
				onu !== 'O5'),

			E('div', {}, [
				E('span', { 'class': 'metric-caption' }, '接收光功率 · ' + quality),
				E('div', { 'class': 'metric-value-row' }, [
					E('span', { 'class': 'status-dot' }),
					E('span', {}, isFinite(rx) ? rx.toFixed(2) + ' dBm' : '读取失败')
				]),
				E('div', { 'class': 'optical-scale-wrapper' }, [
					E('div', { 'class': 'optical-scale-track' }, [
						E('div', { 'class': 'scale-pointer', style: 'left:' + rxPct.toFixed(1) + '%' }, '▼')
					]),
					E('div', { 'class': 'scale-ticks' }, [
						E('span', {}, '-28'), E('span', {}, '-8 dBm')
					])
				])
			]),

			metric('发送光功率',
				isFinite(tx) ? tx.toFixed(2) + ' dBm' : '读取失败',
				'1270 nm, 突发上行' + (reg.upstream_tx_armed ? ' (armed)' : '')),

			metric('整机与芯片温度',
				(isFinite(temp) ? temp.toFixed(1) : '—') + ' °C / ' +
				(chipTemp != null ? chipTemp.toFixed(1) : '—') + ' °C',
				'光前端 / AN7581 主芯片'),

			metric('物理光路与模式', modeText,
				(line.xgtc_sync === 'in-sync' ? 'XGTC 同步成功' : (line.xgtc_sync || '未同步')) +
				(isFinite(bias) ? ' · 偏置 ' + bias.toFixed(2) + ' mA' : '')),

			metric('实时光链路吞吐',
				'↓ ' + rate(rxRate || null) + '  ↑ ' + rate(txRate || null),
				this.ctRate
					? '全房合计（conntrack 记账）· 含 Wi-Fi 与硬件卸载'
					: 'WAN 内核计数器 · 硬件卸载流量不可见')
		]);

		var portsBlock = this.portsSection(ports);

		return card('光纤物理链路与端口面板 (XG-PON / WAN / LAN)', [
			E('div', { 'class': 'router-physical-content' }, [ diagram, grid ]),
			portsBlock,
			E('div', { 'class': 'gpon-card-footer' }, [
				E('div', {}, [
					E('a', {
						'class': 'gpon-link-internal',
						href: (typeof L !== 'undefined' && L.url) ? L.url('admin/status/topology') : '#'
					}, 'Airoha AN7581 四核平台 · 整机架构与内部详情 >')
				]),
				E('div', {},
					'ONU-ID: ' + (reg.onu_id_valid ? reg.onu_id : '—') +
					' · 模块: ' + (line.device || '—'))
			])
		]);
	},

	/* --- 5. 端口子区块（并入光纤物理链路卡，不再单独成卡） --- */
	portsSection: function(ports) {
		var self = this;

		/* 动态过滤：WAN 端口若不具备以太网 PHY 属性（无 speed / link-advertising /
		   link-supported，如光纤 PON 口），由上方光纤卡专门呈现，此处不重复展示；
		   常规以太网 WAN 口（标准路由器）照常显示。 */
		var ethPorts = (ports || []).filter(function(p) {
			if (p.device === self.wanPortDev) {
				var st = self.devStatus[p.device] || {};
				var isEth = (st.speed != null) ||
					Array.isArray(st['link-advertising']) ||
					Array.isArray(st['link-supported']);
				if (!isEth) return false;
			}
			return true;
		});

		if (!ethPorts.length) return null;

		var tiles = ethPorts.map(function(p) {
			var st = self.devStatus[p.device] || {};
			var stats = st.statistics || {};
			var up = st.carrier === true;
			var speed = parseInt(st.speed, 10);
			var r = self.rates[p.device] || {};
			var speedText = (!up || isNaN(speed) || speed < 0) ? '未连接'
				: (speed >= 1000 ? (speed / 1000) + 'G' : speed + 'M');

			var roleName = (p.role ? p.role.toUpperCase() : 'LAN');
			var isWan = (p.role === 'wan') && (self.brMembers || []).indexOf(p.device) === -1;
			var d = self.dirOf(isWan, stats, r);

			return E('div', { 'class': 'iface-card' }, [
				E('div', { 'class': 'iface-main' }, [
					E('div', {
						'class': 'iface-badge-icon ' + (isWan ? 'iface-icon-wan' : 'iface-icon-lan')
					}, up ? '●' : '○'),
					E('div', { 'class': 'iface-meta' }, [
						E('h3', {}, p.device + ' ',
							E('span', { 'class': 'badge ' + (up ? 'badge-success' : 'badge-orange') },
								up ? '已连接' : '未连接')),
						E('span', {}, '角色: ' + roleName + ' · 速率: ' + speedText),
						E('br'),
						E('span', { style: 'font-family:monospace;font-size:11px' },
							'收 ' + bytes(d.cumUp) + '   发 ' + bytes(d.cumDown))
					])
				]),
				up ? E('div', { 'class': 'iface-stats' },
					E('div', {}, [
						E('span', { style: 'color:#6b7280;font-size:11px' }, '本口实时（不含 Wi-Fi）'),
						E('br'),
						E('strong', {}, '↑ ' + rate(d.up) + ' · ↓ ' + rate(d.down))
					])) : ''
			]);
		});

		return E('div', { 'class': 'port-block' }, [
			E('div', { 'class': 'port-block-title' }, [
				E('span', {}, '以太网端口'),
				E('span', { 'class': 'port-block-count' }, ethPorts.length + ' 个')
			]),
			E('div', { 'class': 'port-strip' }, tiles)
		]);
	},

	/* --- 7. 在线设备与限速（移植自 design 主题的 Online Hosts + luci-app-hqos） ---
	   实时速率来自 conntrack 记账（与上方光链路吞吐同源），限速走 hqos。
	   卡片只构建一次，轮询仅更新文本节点——避免覆盖用户正在输入的限速值。 */
	cardClients: function() {
		var self = this;

		var nodes = self.clientNodes = {};
		var host = E('div', { 'class': 'client-list' });

		/* 引擎状态徽标 */
		var q = self.qosState || {};
		var running = !!q.running;
		var enabled = q.enabled !== false;
		var configured = parseInt(q.configured_clients, 10) || 0;
		var engineText = running ? '运行中'
			: (!enabled ? '已停用'
			: (configured === 0 ? '已启用 · 等待规则' : '未运行'));
		var engineClass = running ? 'badge-success' : (enabled && configured === 0 ? 'badge-blue' : 'badge-orange');

		var engineLine = E('div', { 'class': 'client-engine' }, [
			E('span', { 'class': 'client-engine-label' }, '限速引擎'),
			E('span', { 'class': 'badge ' + engineClass }, engineText),
			E('span', { 'class': 'client-engine-meta' },
				'后端 ' + (q.backend || '—') + ' · 已配置 ' + configured + ' 台')
		]);

		/* 校验：后端是否支持限速 */
		if (q.supported === false)
			engineLine.appendChild(E('span', { 'class': 'badge badge-orange' }, '该平台不支持'));

		/* 把 Live 数据写入既有节点（不重建 DOM） */
		function paint() {
			var clients = self.buildClientList();
			clients.forEach(function(c) {
				var n = nodes[c.mac];
				if (!n) return;
				var live = self.live[c.mac] || {};
				n.up.textContent = '↑ ' + rate(live.up || 0);
				n.down.textContent = '↓ ' + rate(live.down || 0);
				n.cum.textContent = '累计 ↑ ' + bytes(live.cumUp || 0) + '  ↓ ' + bytes(live.cumDown || 0);
				n.conn.textContent = '连接 ' + (live.conns != null ? live.conns : '—');
				n.dot.className = 'status-dot' + (c.ips.length ? '' : ' status-dot-warn');
			});
		}

		/* 构建（首次或客户端集合变化时） */
		function build() {
			host.innerHTML = '';
			nodes = self.clientNodes = {};

			var clients = self.buildClientList();
			if (!clients.length) {
				host.appendChild(E('p', { 'class': 'metric-sub-caption' },
					'未发现客户端（需要 DHCP 租约或 conntrack 记录）。'));
				return;
			}

			clients.forEach(function(c) {
				var lim = self.qosLimits[c.mac] || {};
				var hasLimit = (Number(lim.upload) > 0 || Number(lim.download) > 0 || Number(lim.connections) > 0);

				var upIn = E('input', { 'type': 'number', 'min': '0', 'step': '1',
					'class': 'client-limit-input', 'placeholder': '不限',
					'value': Number(lim.upload) > 0 ? String(lim.upload) : '' });
				var downIn = E('input', { 'type': 'number', 'min': '0', 'step': '1',
					'class': 'client-limit-input', 'placeholder': '不限',
					'value': Number(lim.download) > 0 ? String(lim.download) : '' });
				var connIn = E('input', { 'type': 'number', 'min': '0', 'max': '65535', 'step': '1',
					'class': 'client-limit-input', 'placeholder': '不限',
					'value': Number(lim.connections) > 0 ? String(lim.connections) : '' });

				var badge = E('span', { 'class': 'badge ' + (hasLimit ? 'badge-blue' : 'badge-orange') },
					hasLimit
						? ('↑' + (Number(lim.upload) > 0 ? lim.upload + 'k' : '不限') +
						   ' ↓' + (Number(lim.download) > 0 ? lim.download + 'k' : '不限') +
						   (Number(lim.connections) > 0 ? ' · ' + lim.connections + '连接' : ''))
						: '未限速');

				var msg = E('span', { 'class': 'client-limit-msg' }, '');

				var save = E('button', {
					'class': 'btn cbi-button cbi-button-apply client-limit-save',
					'click': function() {
						var up = parseInt(upIn.value, 10) || 0;
						var down = parseInt(downIn.value, 10) || 0;
						var cn = parseInt(connIn.value, 10) || 0;
						msg.textContent = '保存中…';
						msg.style.color = '#6b7280';

						return callQosSet({ mac: c.mac, name: c.name || '',
							upload: up, download: down, connections: cn
						}).then(function() {
							if (up || down || cn)
								self.qosLimits[c.mac] = { mac: c.mac, name: c.name,
									upload: up, download: down, connections: cn, enabled: true };
							else
								delete self.qosLimits[c.mac];

							badge.className = 'badge ' + ((up || down || cn) ? 'badge-blue' : 'badge-orange');
							badge.textContent = (up || down || cn)
								? ('↑' + (up > 0 ? up + 'k' : '不限') + ' ↓' + (down > 0 ? down + 'k' : '不限') +
								   (cn > 0 ? ' · ' + cn + '连接' : ''))
								: '未限速';
							msg.textContent = (up || down || cn) ? '已生效' : '已取消限速';
							msg.style.color = '#059669';

							return L.resolveDefault(callQosState(), {}).then(function(st) {
								if (st) { self.qosState = st; refreshEngine(); }
							});
						}).catch(function(e) {
							msg.textContent = '失败: ' + (e && e.message ? e.message : e);
							msg.style.color = '#dc2626';
						});
					}
				}, '保存限速');

				var clear = E('button', {
					'class': 'btn cbi-button client-limit-clear',
					'click': function() { upIn.value = ''; downIn.value = ''; connIn.value = ''; }
				}, '清空');

				var upEl = E('span', { 'class': 'client-live-val' }, '↑ —');
				var downEl = E('span', { 'class': 'client-live-val' }, '↓ —');
				var cumEl = E('span', {}, '累计 —');
				var connEl = E('span', {}, '连接 —');
				var dotEl = E('span', { 'class': 'status-dot' });

				nodes[c.mac] = { up: upEl, down: downEl, cum: cumEl, conn: connEl, dot: dotEl };

				host.appendChild(E('div', { 'class': 'client-card', 'data-mac': c.mac }, [
					E('div', { 'class': 'client-head' }, [
						E('div', { 'class': 'client-head-main' }, [
							dotEl,
							E('strong', { 'class': 'client-name' }, c.display || c.name || '未知设备'),
							E('span', { 'class': 'badge ' + (c.ips.length ? 'badge-success' : 'badge-orange') },
								c.ips.length ? '在线' : '离线')
						]),
						E('div', { 'class': 'client-meta' }, [
							E('span', { 'class': 'client-mac' }, c.mac),
							c.ips.length ? E('span', { 'class': 'client-ip' }, c.ips.join(' · ')) : null
						])
					]),
					E('div', { 'class': 'client-live' }, [
						E('span', { 'class': 'client-live-label' }, '实时'),
						upEl, downEl
					]),
					E('div', { 'class': 'client-cum' }, [ cumEl, connEl ]),
					E('div', { 'class': 'client-limit' }, [
						E('div', { 'class': 'client-limit-title' }, [
							E('span', {}, '限速设置'), badge
						]),
						E('div', { 'class': 'client-limit-row' }, [
							E('label', {}, [ E('span', {}, '上传'), upIn, E('small', {}, 'kbps') ]),
							E('label', {}, [ E('span', {}, '下载'), downIn, E('small', {}, 'kbps') ]),
							E('label', {}, [ E('span', {}, '连接'), connIn, E('small', {}, '个') ])
						]),
						E('div', { 'class': 'client-limit-actions' }, [ save, clear, msg ])
					])
				]));
			});

			paint();

			/* 对没有名字的客户端做一次反查（结果回来后重建列表） */
			self.resolveNames(clients);
		}

		/* 引擎行需要在状态变化时单独重绘 */
		var engineHost = E('div', {});
		var refreshEngine = function() { engineHost.innerHTML = ''; engineHost.appendChild(engineLine); };
		engineHost.appendChild(engineLine);
		self.refreshClientEngine = refreshEngine;
		self.rebuildClientList = build;
		self.paintClientList = paint;

		build();

		return card('在线设备与限速', [ engineHost, host ]);
	},

	/* --- 6. 无线 --- */
	cardWifi: function(infos) {
		if (!infos.length) return null;

		var tiles = infos.map(function(w) {
			var i = w.info || {};
			var clients = w.clients || [];
			var enc = (i.encryption && i.encryption.enabled)
				? ((i.encryption.wpa && i.encryption.wpa.length) ? 'WPA' + i.encryption.wpa[0] : '加密')
				: '开放';
			var band = i.frequency
				? ((i.frequency >= 5000 ? '5 GHz' : '2.4 GHz') + ' · ch ' + i.channel)
				: '—';

			var kids = [
				E('div', { 'class': 'iface-main' }, [
					E('div', { 'class': 'iface-badge-icon iface-icon-vpn' },
						i.frequency >= 5000 ? '5G' : '2G'),
					E('div', { 'class': 'iface-meta' }, [
						E('h3', {}, i.ssid || i.phy || '—'),
						E('span', {}, band + ' · ' + enc + ' · ' +
							(i.txpower != null ? i.txpower + ' dBm' : '—')),
						E('br'),
						E('span', {}, '已连终端: ' + clients.length + ' 台')
					])
				])
			];

			if (clients.length) {
				kids.push(E('div', { 'class': 'iface-stats' },
					E('div', {}, [
						E('span', { style: 'color:#6b7280;font-size:11px' }, '信号最强'),
						E('br'),
						E('strong', {}, (function() {
							var best = clients.reduce(function(a, b) {
								return (parseInt(b.signal, 10) > parseInt(a.signal, 10)) ? b : a;
							});
							return parseInt(best.signal, 10) + ' dBm';
						})())
					])));
			}

			return E('div', { 'class': 'iface-card' }, kids);
		});

		return card('无线网络 (Wi-Fi)', tiles);
	},

	/* --- view --- */
	render: function(data) {
		var self = this;

		var state = {
			board:    data[0] || {},
			info:     data[1] || {},
			cpuusage: data[2] || '',
			cpuinfo:  data[3] || '',
			cpubench: data[4] || '',
			version:  data[5] || {},
			ports:    data[6] || [],
			wifi:     data[7] || [],
			pon:      data[8],
			wifiTemps: data[9],
			allDev:   data[10] || {},
			ifaceDump: Array.isArray(data[11]) ? data[11] : [],
			clientRates: data[19] || {},
			hints:    data[20] || {},
			qos:      data[21] || {}
		};

		self.hints = state.hints;
		self.qosState = state.qos;

		/* 已有 hqos 规则（按 MAC），用于预填限速输入框 */
		self.qosLimits = {};
		/* 在线设备：把 conntrack 结果归集到 MAC，并接手 load 里读到的规则 */
		self.qosLimits = self.qosLimitsPre || {};
		self.dnsCache = self.dnsCache || {};
		/* buildClientList 读取 self.clientRates；必须与 state 同步，
		   否则 conntrack 里那些没有租约/主机提示的设备不会进列表 */
		self.clientRates = state.clientRates || {};
		self.ingestClients(state.clientRates);

		/* ── 动态接口发现（零硬编码）──────────────────────────────
		   WAN 三层设备：network.interface dump 中 'wan' 逻辑接口绑定的设备
		   （如 pppoe-wan），是真实互联网吞吐的口径；
		   WAN 物理端口：getBuiltinEthernetPorts 中 role==='wan' 的条目；
		   LAN 成员：br-lan 桥接成员（全量设备快照中读取）。            */
		var wanIf = null;
		state.ifaceDump.forEach(function(x) {
			if (x['interface'] === 'wan') wanIf = x;
		});
		self.wanDev = (wanIf && wanIf.device) || null;

		self.wanPortDev = null;
		state.ports.forEach(function(p) {
			if (p.role === 'wan' && (!self.wanPortDev || p.device < self.wanPortDev))
				self.wanPortDev = p.device;
		});

		var brStatus = state.allDev['br-lan'] || {};
		self.brMembers = brStatus['bridge-members'] || [];

		state.ports.forEach(function(p) {
			/* 角色校准：桥接成员一律是 LAN（板级配置残留 wan 指向网口时纠偏） */
			if (self.brMembers.indexOf(p.device) >= 0)
				p.role = 'lan';
			if (state.allDev[p.device])
				self.devStatus[p.device] = state.allDev[p.device];
		});

		/* 用全量设备快照播种采样基线（第二个采样周期即可给出真实速率） */
		Object.keys(state.allDev).forEach(function(name) {
			var st = state.allDev[name] || {};
			var s = st.statistics || {};
			self.samples[name] = {
				rx: parseInt(s.rx_bytes, 10) || 0,
				tx: parseInt(s.tx_bytes, 10) || 0,
				t: Date.now()
			};
		});

		/* conntrack 累计播种（精确吞吐的主数据源）：
		   对 totals 求和得到全房流量累计，差分即真实 WAN 吞吐，
		   不受 PPE 硬件卸载影响。 */
		self.ctSamples = self.sumConntrack(state.clientRates, Date.now());

		var host = E('div', { 'class': 'fx-root' });
		var main = E('main', { 'class': 'luci-container' });

		/* 在线设备卡只构建一次：fill() 每次轮询都会重跑（5 秒），
		   若每轮重建就会把用户正在输入的限速值清空。该节点跨轮次复用，
		   数字由 paintClientList 就地更新。 */
		var clientsCard = null;

		var fill = function() {
			main.innerHTML = '';

			main.appendChild(E('div', { 'class': 'dashboard-top-grid' }, [
				self.cardSystem(state.board, state.version, state.info, state.cpuusage, state.cpuinfo, state.wifiTemps, state.pon),
				E('div', { style: 'display:flex;flex-direction:column;gap:16px' }, [
					self.cardMemory(state.info),
					self.cardStorage(state.info)
				])
			]));

			main.appendChild(self.cardOptical(state.pon, state.cpuinfo, self.rates, state.ports));

			if (!clientsCard) clientsCard = self.cardClients();
			main.appendChild(clientsCard);

			var wifi = self.cardWifi(state.wifi);
			if (wifi) main.appendChild(wifi);
		};

		fill();
		host.appendChild(main);

		poll.add(function() {
			return Promise.all([
				L.resolveDefault(callSysInfo(), {}),
				L.resolveDefault(callCpuUsage(), ''),
				L.resolveDefault(L.require('fs').then(function(fs) {
					return Promise.all([
						fs.exec('/usr/sbin/ponctl', [ '--device', 'pon0', 'status', '--json' ]),
						fs.exec('/usr/libexec/falcon-wifi-temp')
					]);
				}).then(function(rr) {
					function parse(r) {
						if (!r || r.code !== 0 || !r.stdout) return null;
						try { return JSON.parse(r.stdout); } catch (e) { return null; }
					}
					return { pon: parse(rr[0]), temps: parse(rr[1]) };
				}).catch(function() { return null; }), null),
				L.resolveDefault(callDevStatusAll(), {}),
				L.resolveDefault(callClientRates(self.clientAddresses()), {}),
				Promise.all(self.wifiInfos.map(function(w) {
					return L.resolveDefault(callWifiAssoc(w.device), []).then(function(assoc) {
						w.clients = Array.isArray(assoc) ? assoc : ((assoc && Array.isArray(assoc.results)) ? assoc.results : []);
					});
				}))
			]).then(function(r) {
				if (r[0]) state.info = r[0];
				if (r[1]) state.cpuusage = r[1];
				if (r[2] && r[2].pon) state.pon = r[2].pon;
				if (r[2] && r[2].temps) state.wifiTemps = r[2].temps;


				/* 精确口径：优先用厂商已平滑的 rates（按客户端 IP 求和）；
				   rates 不可用时回退到累计值差分。均含硬件卸载流量。 */
				var ct = r[4] || {};
				if (ct && ct.source === 'conntrack') {
					state.clientRates = ct;
					self.clientRates = ct;

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
					self.ctTotals = self.sumConntrack(ct, Date.now());

					/* 在线设备实时速率（同源 conntrack，含硬件卸载） */
					self.ingestClients(ct);
					if (self.paintClientList) {
						var beforeMacs = Object.keys(self.clientNodes || {}).sort().join();
						var nowMacs = Object.keys(self.live || {}).sort().join();
						/* 出现新客户端才重建，否则只刷文本（保住用户正在输入的值） */
						var nowList = self.buildClientList().map(function(c) { return c.mac; }).sort().join();
						var haveList = Object.keys(self.clientNodes || {}).sort().join();
						if (nowList !== haveList && self.rebuildClientList) self.rebuildClientList();
						else self.paintClientList();
					}
				}

				/* 单次全量差分：所有设备一次 RPC 全部算出速率，不存在重复采样互踩 */
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

				state.ports.forEach(function(p) {
					if (all[p.device]) self.devStatus[p.device] = all[p.device];
				});

				fill();
			});
		}, 5);

		poll.start();

		return host;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});