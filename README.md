# 价格详情 H5 开发交接

## 1. 页面边界与文件职责

本页面运行在 APP WebView 中，只实现策略切换、终端切换、价格时段列表和费用说明；顶部 APP 原生导航不在 H5 内重复实现。

| 文件 | 职责 |
|---|---|
| `index.html` | 提供稳定 DOM 锚点、静态表头和费用说明文案 |
| `styles.css` | 负责吸顶布局、响应式列对齐、Tab/终端动效与当前时段样式 |
| `app.js` | 负责入参归一化、策略状态、价格视图模型、渲染、当前时段判断及 APP Bridge |
| `assets/` | 透明背景三倍 PNG 切图 |
| `fonts/` | 页面数字使用的 D-DIN WOFF2 字体 |

当前时段和价格均为原型演示数据。正式接入后台后，应替换 `app.js` 中的时段与计价数据，但保留现有视图模型和 DOM/CSS 契约。

## 2. 本地运行

在本目录启动静态服务：

```bash
python3 -m http.server 4173
```

浏览器访问：

```text
http://127.0.0.1:4173/?currentTime=08:15
```

`08:15` 会命中“立即充电”的第 3 个时段，便于观察首屏自动滚动；URL 只用于本地预览和联调。

## 3. 四种策略差异

| 策略 ID | 页面名称 | 终端区 | 每个时段的价格行 | 档位图标 | 费用说明 |
|---|---|---|---:|---|---|
| `immediate` | 立即充电 | 多终端时显示 | 3 | 显示 | 电费、服务费、挂牌价、优惠价、黑钻会员价 |
| `ordered` | 有序充电 | 不显示 | 2 | 显示 | 电费、服务费、挂牌价、优惠价 |
| `economy` | 经济充放 | 不显示 | 2 | 不显示 | 电费、服务费 |
| `discharge` | 立即放电 | 不显示 | 1 | 不显示 | 电费、服务费 |

- APP 只下发一个可用策略时，整个策略 Tab 隐藏。
- “立即充电”只有一个终端时，整个终端标签区折叠。
- 策略白色选中块使用位移动画；从“立即充电”切到其他策略时，终端区折叠，表头随文档流平滑上移。

## 4. APP 直接调用

页面加载后会暴露 `window.PriceDetailH5`：

```js
window.PriceDetailH5.init({
  strategy: "immediate",
  supportedStrategies: ["immediate", "ordered", "economy", "discharge"],
  terminals: [
    {
      id: "dc",
      label: "直流快充",
      // 固定顺序：[黑钻会员价服务费, 优惠价服务费, 挂牌价服务费]
      serviceFees: [0.28, 0.35, 0.4],
    },
    {
      id: "super",
      label: "超级快充",
      serviceFees: [0.32, 0.4, 0.45],
    },
  ],
  terminalId: "dc",
  // 可选，HH:mm；不传或传 null 时读取 WebView 所在设备的本地时间
  currentTime: "08:15",
});
```

也可单独切换状态：

```js
window.PriceDetailH5.setStrategy("ordered");
window.PriceDetailH5.setTerminal("super");
```

`setStrategy()` 和 `setTerminal()` 返回布尔值：`true` 表示请求已接受，`false` 表示策略不受当前场站支持或终端不存在。接口兼容中文展示名，但正式 APP 接入应始终传稳定英文 ID。

### `init(payload)` 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `supportedStrategies` | `string[]` | 场站支持的策略及 Tab 顺序；空数组会回退到“立即充电” |
| `terminals` | `Array<string \| object>` | 终端名称或 `{ id, label, serviceFees }` 对象 |
| `strategy` | `string` | 初始策略 ID；默认 `immediate` |
| `terminalId` | `string` | 初始选中的终端 ID |
| `currentTime` | `string \| null` | `HH:mm` 联调覆盖值；`null` 表示恢复设备本地时间 |

## 5. `postMessage` 接入

APP 也可通过 WebView 注入消息：

```js
window.postMessage({
  type: "PRICE_DETAIL_INIT",
  payload: {
    strategy: "economy",
    supportedStrategies: ["immediate", "ordered", "economy", "discharge"],
    currentTime: "18:30",
  },
}, "*");

window.postMessage({
  type: "PRICE_DETAIL_SET_STRATEGY",
  strategy: "discharge",
}, "*");

window.postMessage({
  type: "PRICE_DETAIL_SET_TERMINAL",
  terminalId: "dc",
}, "*");
```

`PRICE_DETAIL_INIT` 同时兼容 `{ type, payload }` 和把初始化字段直接放在 message 顶层的形式。

当前实现默认信任受控 APP WebView 容器。若以后部署为普通网页，必须为 `message` 监听增加 `event.origin` / `event.source` 白名单校验，不能直接沿用当前信任模型。

## 6. URL 联调参数

| 参数 | 示例 | 说明 |
|---|---|---|
| `strategy` | `ordered` | 初始策略 |
| `strategies` | `immediate,ordered` | 可用策略及顺序，英文逗号分隔 |
| `terminal` | `dc` | 初始终端 ID |
| `terminals` | `直流快充,超级快充` | 终端 ID 或名称，英文逗号分隔；URL 方式不能自定义服务费 |
| `currentTime` | `08:15` | 强制命中的当前时间，格式 `HH:mm` |

完整示例：

```text
?strategy=ordered&strategies=immediate,ordered&terminals=直流快充&terminal=dc&currentTime=08:15
```

URL 只决定首屏默认状态，页面加载后的 `PriceDetailH5.init(payload)` 可以覆盖这些值。

## 7. 时段与价格数据契约

- 每个策略的时段必须无空档、无重叠地连续覆盖 `00:00-24:00`。
- 时段按左闭右开区间 `[start, end)` 判断；例如 `07:00-09:00` 包含 `07:00`，不包含 `09:00`。
- `24:00` 只能作为当天最后一个时段的结束时间。
- `tier` 必须存在于 `TIER_META`；图标只从 `assets/` 读取。
- 任意时刻只能命中一个当前时段。
- 每一行必须满足 `总价 = 电费 + 服务费`，页面统一保留 4 位小数。
- 立即充电终端的 `serviceFees` 必须恰好包含 3 个可转为有限数值的成员，顺序不可调整。
- `chargeService` 和 `dischargeService` 表示服务费，不是已经计算完成的总价。

当前脚本会对缺失的终端数据做基础回退，但不会代替完整的后台数据校验；正式数据进入 H5 前仍应完成上述校验。

## 8. 当前时段定位规则

- 页面首次初始化会先从列表顶部渲染，再以缓动动画定位到当前时段卡片。
- 切换策略时即时定位，不重复播放列表滚动动画，避免用户来回切换时页面持续滚动。
- 定位只改变页面 `scrollY`，不会把当前时段重排成数据数组的第一项。
- 目标卡片接近页面末尾时，JS 会通过 `--current-scroll-reserve` 增加最小必要滚动空间。
- 触摸、滚轮、指针按下或键盘滚动会立即取消首屏自动动画。
- 系统开启“减少动态效果”后直接定位，不播放缓动。

## 9. DOM / CSS 不可破坏约束

- `index.html` 中的固定 `id` 是 `app.js` 查询锚点；改名时必须同步更新 `dom` 映射。
- `.strategy-slider` 是 `#strategyTabs` 的固定子节点。策略重渲染只能清理 `.strategy-tab`，不能整体清空容器。
- 终端区依赖 `.is-collapsed` 播放高度与透明度动画，不能用 `hidden`、`display:none` 直接替代。
- `.price-grid`、`.price-columns`、`.price-values` 的 DOM 层级共同保证表头与卡片列对齐，不应单独改变其中一侧。
- `.table-head-grid` 和 `.price-card` 的左内边距均为 `10px`，属于必须同步维护的配对值。
- `--period-ratio`、`--price-ratio`、`--column-gap` 同时服务表头和卡片；调整后需在全部目标宽度下复测。
- `HEADER_TRANSITION_DELAY = 380` 与终端区 `40ms` 延迟加 `320ms` 折叠动画耦合；修改 CSS 动画时必须同步检查 JS。
- `[data-definition]` 的值必须与 `STRATEGY_CONFIG.definitions` 一致。
- 当前卡片由 `.is-current` 和 `aria-current="time"` 共同标识，滚动代码依赖 `.is-current` 查询目标。
- `overflow-anchor: none` 和 `prefers-reduced-motion` 分别用于避免浏览器抢滚动、提供无障碍动效降级，请勿删除。

## 10. 资源规范

- `assets/` 只保留用户提供的透明背景三倍 PNG，不保留 SVG 或旧下载资源。
- CSS 按逻辑尺寸展示三倍图；不能把 PNG 原始像素直接作为页面尺寸。
- `fonts/` 只保留转换后的 D-DIN WOFF2，不保留原始 OTF。
- 新增图标时沿用 `name@3x.png` 命名，并确认透明通道和清晰度。

## 11. 交付前验收

- 在 `280 / 320 / 375 / 430px` 宽度下无横向溢出，时段与三列价格均未错位。
- 四个策略的终端区、价格行数、图标和费用说明符合策略差异表。
- 只有一个策略时策略 Tab 隐藏；立即充电只有一个终端时终端区折叠。
- Tab 白色滑块平滑移动，终端折叠时表头平滑上移。
- 表头和每张价格卡的四列严格对齐。
- 当前时段唯一高亮；首屏有定位动画，Tab 切换不重复播放滚动动画。
- 用户主动滚动能取消自动定位；“减少动态效果”模式可正常降级。
- 控制台无 JavaScript error、资源 404 或布局 warning。
