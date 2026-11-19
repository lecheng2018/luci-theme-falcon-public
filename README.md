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

数据来源与刷新方式：

- 通过 `fs.exec('/usr/sbin/ponctl', ['--device', 'pon0', 'status', '--json'])` 读取驱动上报；
- 注册到 LuCI 自己的 `poll` 周期（5 秒），与其他概览区块同步刷新；
- 上下行速率由 `xgem_rx` / `xgem_tx` 计数器两次采样差分得出，
  首次刷新显示 `—`，之后才是真实速率。

卡片展示项：PON 注册状态、接收光功率（含 -28 ~ -8 dBm 渐变标尺）、发送光功率与偏置、
光前端温度、物理光路模式与同步状态、实时链路吞吐。

## 构建

```sh
python3 build-ipk.py          # → dist/luci-theme-falcon_1.1.0-1_all.ipk
```

生成的是标准 OpenWrt `.ipk`（外层 gzip tar，内含 `debian-binary` /
`control.tar.gz` / `data.tar.gz`），可直接 `opkg install`。

## 安装

```sh
opkg install luci-theme-falcon_1.1.0-1_all.ipk
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
| 上下行速率 | `network.device status('pon0').statistics` 的 `rx_bytes` / `tx_bytes` | 两次采样差分 ×8 ÷ 时长 |

速率**不使用** `ponctl` 的 `counters.xgem_rx` / `xgem_tx`：那是 GEM **帧**计数，
不是字节数，换算成 bit/s 是错误的。也**不使用** `fs.read('/sys/...')`，
因为默认 ACL 不放行该路径。

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
