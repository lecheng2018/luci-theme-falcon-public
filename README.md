# luci-theme-falcon

OpenWrt / LuCI 主题：在官方 `cascade.css` 之上叠加一层现代化卡片外观，并给「状态 → 概览」增加一张**实时**光纤链路卡片。

## 目录内没有预览页

这个仓库里**不存在**任何手写的 HTML mockup。之前有过的 `demo/index.html` 是我自己画的假页面，和路由器上真实渲染的结果毫无关系，已经删除。

想看效果只有一条路：装到路由器上，用浏览器打开 `http://<router-ip>/`。

## 架构

```
htdocs/luci-static/falcon/
├── cascade.css       ← 官方 LuCI 样式表，原样镜像，未做任何修改
├── mobile.css        ← 官方移动端样式表，原样镜像
├── theme.css         ← 唯一的自定义层（重新声明设计令牌 + 补卡片表面 + 修 inline 样式）
├── hardware-card.js  ← 概览页的实时光纤卡片
├── logo.svg / logo_48.png
```

`theme.css` 只做三件事：

1. **重新声明 `cascade.css` 使用的 HSL 设计令牌**
   （`--background-color-l` / `--text-color-*` / `--primary-color-*` …），一处改动全局生效；
2. **补上 `cascade.css` 缺失的卡片表面定义**
   `.cbi-section` / `.cbi-title` / `.cbi-section-node` 的背景、圆角、阴影、分隔线，
   并显式区分 `--falcon-page`（页面灰）与 `--falcon-surface`（卡片白），
   不依赖会随深浅模式翻转的派生变量；
3. **修补官方视图里写死的 inline 样式**
   （例如端口状态那段 `grid-template-columns:repeat(auto-fit,minmax(100px,1fr))` + `width:100px`）。

## 实时光纤卡片

`hardware-card.js` 在「状态 → 概览」中插入一个与官方区块 DOM 结构完全一致的 section：

```
div.cbi-section
  div.cbi-title > h3   ← 标题 + 显示/隐藏
  div                  ← 内容
```

- 上下行速率取自 `network.device status()` 的单个 WAN 设备 `rx_bytes` / `tx_bytes` 计数，两次采样差分后换算为 bit/s；显示的来源设备会在页面标明。
- 客户端速率取自厂商 `luci.client-rates` RPC。它是内核已记录的客户端样本，不保证包含被 PPE 硬件卸载的流量；页面不会将它与 WAN 设备计数拼成所谓的整机总速率。
- UCI 中的 `flow_offloading`、`flow_offloading_hw`、`flow_offloading_hw_ipv6` 仅用于提示配置状态，不是硬件计数准确性的证明。分载开启时内核计数可能漏计；关闭时也不声称未经实测的绝对精确。
- 不使用 XGEM 帧计数估算业务字节速率；PON 空闲帧/PLOAM 会造成虚高。

## 构建

```sh
python3 build-ipk.py          # → dist/luci-theme-falcon_1.5.5-1_all.ipk
```

生成的是标准 OpenWrt `.ipk`（外层 gzip tar，内含 `debian-binary` /
`control.tar.gz` / `data.tar.gz`），可直接 `opkg install`。

## 安装

```sh
opkg install luci-theme-falcon_1.5.5-1_all.ipk
```

安装脚本会写入 `luci.themes.Falcon` 并把 `luci.main.mediaurlbase` 指向
`/luci-static/falcon`。卸载时会自动回退到 bootstrap。

也可以只在「系统 → 系统 → 语言和界面」里手动切换主题，不影响网络配置。

## 兼容性

- 需要 `luci-base`；
- 同时提供 `ucode/template/themes/falcon/*.ut`（OpenWrt 23.05+ / 25.x）
  和 `luasrc/view/themes/falcon/*.htm`（旧版 Lua 模板）；
- 光纤卡片依赖 `ponctl`，在没有该二进制的设备上会降级显示「读取失败」，不影响页面其余部分。
## 本地验证

仓库里有 `tools/test-card.js`，用 Node 模拟 LuCI 浏览器环境（`E()`、`L.require`、
DOM）真实执行 `hardware-card.js`，断言：

- 卡片能挂载到概览页，DOM 结构与官方概览区块一致；
- 六个指标都渲染出真实值（光功率 / 温度 / ONU 状态 / 模式 / 偏置）；
- **首次绘制速率显示 `—`**（还没有历史采样），第二次刷新才出现真实速率。

```sh
node tools/test-card.js
```

这个测试最初抓到两个真 bug：卡片依赖了 `String.prototype.format`
（并非标准方法），以及无采样时把速率显示成 `0 bit/秒`（假数据）。
两者都已修复。

## 数据来源说明

| 指标 | 来源 | 备注 |
| :--- | :--- | :--- |
| 光功率 / 温度 / 偏置 / ONU 状态 / 模式 | `ponctl --device pon0 status --json` | 驱动直读 |
| WAN 上下行实时速率 | `network.device status()` 的 WAN 设备 `rx_bytes` / `tx_bytes` | 单一设备采样差分 ×8 ÷ 时长；PPE 卸载可能使内核计数不完整 |
| 客户端实时速率/累计量 | `luci.client-rates.get(addresses)` | 已记录客户端数据；只有后端硬件统计实际生效时才能覆盖 PPE 流量 |

`flow_offloading` / `flow_offloading_hw` / `flow_offloading_hw_ipv6` 仅表示配置，不证明统计完整。`ponctl` 的 `counters.xgem_rx` / `xgem_tx` 是 GEM 帧计数，不能换算为业务字节速率。

## 自行验证（无需路由器）

仓库自带一份**脱敏**的设备快照 `tools/fixture.example.json`，可直接跑渲染测试：

```sh
node tools/check-css.js        # CSS 结构
node tools/test-layout.js      # 布局与响应式守卫
node tools/test-dashboard.js   # 概览页渲染（含在线设备与限速）
node tools/test-topology.js    # 整机详情页渲染
node tools/test-sysauth.js     # 登录页
python3 tools/test-ipk.py      # IPK 结构（需先 build-ipk.py）
```

测试默认读取仓库内夹具。若想用自己设备的快照，设置环境变量：

```sh
FALCON_FIXTURE=/path/to/fixture.json node tools/test-dashboard.js
```

## 许可

Apache License 2.0，详见 `LICENSE` 与 `NOTICE`。
其中 `htdocs/luci-static/falcon/cascade.css` 派生自 LuCI（Apache-2.0），
署名信息见 `NOTICE`。
