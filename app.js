/**
 * 价格详情 H5 主逻辑
 *
 * 数据流：URL 参数 / APP init payload -> state -> 四个 render 函数 -> DOM。
 * 对外能力：window.PriceDetailH5.init / setStrategy / setTerminal。
 * 维护原则：策略差异统一收敛在 STRATEGY_CONFIG，避免在模板中散落多层判断。
 */
(() => {
  "use strict";

  /**
   * @typedef {"immediate"|"ordered"|"economy"|"discharge"} StrategyId
   *
   * @typedef {Object} Terminal
   * @property {string} id - APP 与 H5 之间使用的稳定标识。
   * @property {string} label - 页面展示名称。
   * @property {[number, number, number]} serviceFees - 会员、优惠、挂牌三档服务费，单位元/度。
   *
   * @typedef {Object} ScheduleItem
   * @property {string} start - 起始时间，包含该时刻，格式 HH:mm。
   * @property {string} end - 结束时间，不包含该时刻；仅当天末尾允许 24:00。
   * @property {string} tier - 必须能在 TIER_META 中找到。
   * @property {number} [chargeService] - 经济充放策略使用的充电服务费。
   * @property {number} [dischargeService] - 经济充放/立即放电策略使用的放电服务费。
   *
   * @typedef {Object} PriceRow
   * @property {string} type - 用于 CSS 状态类。
   * @property {string} label - 价格行名称。
   * @property {number} total - 总价，必须等于 electricity + service。
   * @property {number} electricity - 电费。
   * @property {number} service - 服务费。
   * @property {boolean} [featured] - 是否使用红色强调总价。
   * @property {string} [icon] - 可选的充/放方向图标。
   */

  // ---------------------------------------------------------------------------
  // 1. 稳定业务枚举与演示数据
  // ---------------------------------------------------------------------------

  /**
   * 策略 id 同时用于 URL、APP Bridge 和 DOM data-strategy，属于稳定接口字段。
   * label 仅负责页面展示，业务判断必须使用 id。
   */
  const STRATEGIES = [
    { id: "immediate", label: "立即充电" },
    { id: "ordered", label: "有序充电" },
    { id: "economy", label: "经济充放" },
    { id: "discharge", label: "立即放电" },
  ];

  /**
   * 默认终端仅用于本地预览和未下发终端数据时的兜底。
   * serviceFees 顺序固定为：[黑钻会员价服务费, 优惠价服务费, 挂牌价服务费]。
   */
  const TERMINALS = [
    { id: "dc", label: "直流快充", serviceFees: [0.28, 0.35, 0.4] },
    { id: "super", label: "超级快充", serviceFees: [0.32, 0.4, 0.45] },
    { id: "megawatt", label: "兆瓦特快", serviceFees: [0.38, 0.46, 0.52] },
  ];

  /**
   * 峰谷等级元数据。electricity 是虚拟电费，正式接接口后可由后台时段数据覆盖。
   * icon 必须继续引用 assets 中的透明 @3x PNG，不要改回 SVG。
   */
  const TIER_META = {
    tip: { label: "尖", icon: "./assets/tip@3x.png", electricity: 1.35 },
    peak: { label: "峰", icon: "./assets/peak@3x.png", electricity: 1.05 },
    flat: { label: "平", icon: "./assets/flat@3x.png", electricity: 0.72 },
    valley: { label: "谷", icon: "./assets/valley@3x.png", electricity: 0.45 },
    deepValley: { label: "深谷", icon: "./assets/deep-valley@3x.png", electricity: 0.28 },
  };

  // 立即充电：完整覆盖 00:00-24:00，相邻时段必须首尾衔接且不可重叠。
  const IMMEDIATE_SCHEDULE = [
    { start: "00:00", end: "05:00", tier: "deepValley" },
    { start: "05:00", end: "07:00", tier: "valley" },
    { start: "07:00", end: "09:00", tier: "flat" },
    { start: "09:00", end: "11:00", tier: "peak" },
    { start: "11:00", end: "14:00", tier: "valley" },
    { start: "14:00", end: "17:00", tier: "flat" },
    { start: "17:00", end: "19:00", tier: "peak" },
    { start: "19:00", end: "21:00", tier: "tip" },
    { start: "21:00", end: "23:00", tier: "peak" },
    { start: "23:00", end: "24:00", tier: "valley" },
  ];

  // 有序充电：使用精简四时段，卡片仅展示优惠价与挂牌价。
  const ORDERED_SCHEDULE = [
    { start: "00:00", end: "07:00", tier: "deepValley" },
    { start: "07:00", end: "10:00", tier: "peak" },
    { start: "10:00", end: "17:00", tier: "flat" },
    { start: "17:00", end: "24:00", tier: "peak" },
  ];

  // 有序充电不区分终端，使用策略级固定服务费演示数据。
  const ORDERED_SERVICE_FEES = {
    discount: 0.32,
    listed: 0.46,
  };

  // 经济充放：低谷鼓励充电，高峰提高放电回馈价格。
  // 每一行仍严格满足“价格 = 电费 + 服务费”。
  const ECONOMY_SCHEDULE = [
    { start: "00:00", end: "07:00", tier: "deepValley", chargeService: 0.28, dischargeService: 0.34 },
    { start: "07:00", end: "10:00", tier: "peak", chargeService: 0.36, dischargeService: 0.42 },
    { start: "10:00", end: "17:00", tier: "flat", chargeService: 0.3, dischargeService: 0.36 },
    { start: "17:00", end: "21:00", tier: "tip", chargeService: 0.42, dischargeService: 0.5 },
    { start: "21:00", end: "24:00", tier: "peak", chargeService: 0.36, dischargeService: 0.42 },
  ];

  // 立即放电：按电网负荷设置五个连续时段，晚高峰回馈价格最高。
  const DISCHARGE_SCHEDULE = [
    { start: "00:00", end: "07:00", tier: "deepValley", dischargeService: 0.3 },
    { start: "07:00", end: "10:00", tier: "peak", dischargeService: 0.42 },
    { start: "10:00", end: "17:00", tier: "flat", dischargeService: 0.36 },
    { start: "17:00", end: "21:00", tier: "tip", dischargeService: 0.5 },
    { start: "21:00", end: "24:00", tier: "peak", dischargeService: 0.42 },
  ];

  /**
   * 策略能力总表，新增策略或调整策略差异时优先修改这里：
   * - schedule：当日时段数据；
   * - usesTerminal：是否显示终端选择；
   * - showsTierBadge：卡片左侧是否展示尖峰平谷角标；
   * - definitions：费用说明区允许显示的 data-definition；
   * - buildPrices：把时段数据转换为卡片价格行。
   */
  const STRATEGY_CONFIG = {
    immediate: {
      schedule: IMMEDIATE_SCHEDULE,
      usesTerminal: true,
      showsTierBadge: true,
      definitions: ["electricity", "service", "listed", "discount", "member"],
      buildPrices(item, terminal) {
        return buildImmediatePrices(TIER_META[item.tier].electricity, terminal.serviceFees);
      },
    },
    ordered: {
      schedule: ORDERED_SCHEDULE,
      usesTerminal: false,
      showsTierBadge: true,
      definitions: ["electricity", "service", "listed", "discount"],
      buildPrices(item) {
        return buildOrderedPrices(TIER_META[item.tier].electricity);
      },
    },
    economy: {
      schedule: ECONOMY_SCHEDULE,
      usesTerminal: false,
      showsTierBadge: false,
      definitions: ["electricity", "service"],
      buildPrices(item) {
        return buildEconomyPrices(item);
      },
    },
    discharge: {
      schedule: DISCHARGE_SCHEDULE,
      usesTerminal: false,
      showsTierBadge: false,
      definitions: ["electricity", "service"],
      buildPrices(item) {
        return buildDischargePrices(item);
      },
    },
  };

  // 只有进入配置表的策略才允许点击，避免展示“空 Tab”。
  const IMPLEMENTED_STRATEGIES = new Set(Object.keys(STRATEGY_CONFIG));

  // 首屏滚动在 DOM 稳定后启动；终端折叠总时长为 40ms 延迟 + 320ms 动画。
  const SCROLL_START_DELAY = 100;
  const HEADER_TRANSITION_DELAY = 380;

  // 固定 DOM 查询集中管理；这些 id/class 与 index.html 构成内部契约。
  const dom = {
    priceDetail: document.querySelector("#priceDetail"),
    stickyHeader: document.querySelector("#stickyHeader"),
    topMenu: document.querySelector("#topMenu"),
    strategySection: document.querySelector("#strategySection"),
    strategyTabs: document.querySelector("#strategyTabs"),
    terminalSection: document.querySelector("#terminalSection"),
    terminalTabs: document.querySelector("#terminalTabs"),
    scheduleList: document.querySelector("#scheduleList"),
    definitionCard: document.querySelector(".definition-card"),
  };

  // URL 参数用于独立预览和联调；后续 APP init payload 可以覆盖对应状态。
  const params = new URLSearchParams(window.location.search);

  /**
   * 页面运行态。currentTime 为空时读取设备当前时间；联调可传 HH:mm 强制命中时段。
   */
  const state = {
    strategies: resolveStrategies(params.get("strategies")),
    strategy: normalizeStrategy(params.get("strategy")) || "immediate",
    terminals: resolveTerminals(params.get("terminals")),
    terminalId: params.get("terminal") || "dc",
    currentTime: params.get("currentTime") || null,
  };

  // 首屏自动滚动的异步句柄；token 用于废弃上一轮回调，防止多个 init 相互抢滚动。
  let autoScrollTimer = 0;
  let autoScrollFrame = 0;
  let autoScrollToken = 0;

  // 每次进入都从列表顶部开始，再由首屏动画定位当前时段。
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.scrollTo(0, 0);

  // ---------------------------------------------------------------------------
  // 2. 外部入参与基础工具
  // ---------------------------------------------------------------------------

  // 策略兼容英文 id 和中文 label；正式 APP 接入建议始终传稳定英文 id。
  function normalizeStrategy(value) {
    if (!value) return null;
    const match = STRATEGIES.find((item) => item.id === value || item.label === value);
    return match ? match.id : null;
  }

  function resolveStrategies(rawValue) {
    if (!rawValue) return [...STRATEGIES];
    const values = rawValue.split(",").map((item) => item.trim()).filter(Boolean);
    const resolved = values
      .map((value) => STRATEGIES.find((item) => item.id === value || item.label === value))
      .filter(Boolean);
    return resolved.length ? Array.from(new Map(resolved.map((item) => [item.id, item])).values()) : [...STRATEGIES];
  }

  function resolveTerminals(rawValue) {
    if (!rawValue) return [...TERMINALS];
    const values = rawValue.split(",").map((item) => item.trim()).filter(Boolean);
    if (!values.length) return [...TERMINALS];
    return values.map((value, index) => {
      const preset = TERMINALS.find((item) => item.id === value || item.label === value);
      return preset || {
        id: `terminal-${index + 1}`,
        label: value,
        serviceFees: [...TERMINALS[0].serviceFees],
      };
    });
  }

  /**
   * 归一化 APP 下发的终端对象。
   * serviceFees 缺失或不是三档时回退到预设值；正式数据还需确保三项均可转为有限数值。
   * @param {string|Partial<Terminal>} item
   * @param {number} index
   * @returns {Terminal}
   */
  function normalizeTerminal(item, index) {
    const fallback = TERMINALS[index] || TERMINALS[0];
    if (typeof item === "string") {
      return resolveTerminals(item)[0];
    }
    return {
      id: item.id || `terminal-${index + 1}`,
      label: item.label || `终端${index + 1}`,
      serviceFees: Array.isArray(item.serviceFees) && item.serviceFees.length === 3
        ? item.serviceFees.map(Number)
        : [...fallback.serviceFees],
    };
  }

  // 将 HH:mm 转换为当天分钟数；24:00 只作为结束边界处理。
  function toMinutes(time) {
    if (time === "24:00") return 24 * 60;
    const match = /^(\d{1,2}):(\d{2})$/.exec(time || "");
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  // currentTime 是联调覆盖值，未提供时使用 WebView 所在设备的本地时间。
  function getCurrentMinutes() {
    const overridden = toMinutes(state.currentTime);
    if (overridden !== null) return overridden;
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  // 时段使用左闭右开区间 [start, end)，避免交界时刻同时命中两张卡。
  function isCurrentPeriod(item, currentMinutes) {
    const start = toMinutes(item.start);
    const end = toMinutes(item.end);
    return currentMinutes >= start && currentMinutes < end;
  }

  function formatPrice(value) {
    return Number(value).toFixed(4);
  }

  function getActiveTerminal() {
    return state.terminals.find((item) => item.id === state.terminalId) || state.terminals[0];
  }

  // ---------------------------------------------------------------------------
  // 3. 价格视图模型
  // 所有策略最终都转换为统一 PriceRow[]，模板无需了解具体计价规则。
  // 当前数值为原型虚拟数据；正式接入时仍需保证 total = electricity + service。
  // ---------------------------------------------------------------------------

  function buildImmediatePrices(electricity, serviceFees) {
    const [memberFee, discountFee, listedFee] = serviceFees;
    return [
      { type: "member", featured: true, label: "黑钻会员价", total: electricity + memberFee, electricity, service: memberFee },
      { type: "discount", label: "优惠价", total: electricity + discountFee, electricity, service: discountFee },
      { type: "listed", label: "挂牌价", total: electricity + listedFee, electricity, service: listedFee },
    ];
  }

  function buildOrderedPrices(electricity) {
    return [
      {
        type: "discount",
        featured: true,
        label: "优惠价",
        total: electricity + ORDERED_SERVICE_FEES.discount,
        electricity,
        service: ORDERED_SERVICE_FEES.discount,
      },
      {
        type: "listed",
        label: "挂牌价",
        total: electricity + ORDERED_SERVICE_FEES.listed,
        electricity,
        service: ORDERED_SERVICE_FEES.listed,
      },
    ];
  }

  function buildEconomyPrices(item) {
    const electricity = TIER_META[item.tier].electricity;
    return [
      {
        type: "charge",
        featured: true,
        label: "充电价",
        icon: "./assets/charge@3x.png",
        total: electricity + item.chargeService,
        electricity,
        service: item.chargeService,
      },
      {
        type: "discharge",
        featured: true,
        label: "放电价",
        icon: "./assets/discharge@3x.png",
        total: electricity + item.dischargeService,
        electricity,
        service: item.dischargeService,
      },
    ];
  }

  function buildDischargePrices(item) {
    const electricity = TIER_META[item.tier].electricity;
    return [
      {
        type: "discharge",
        featured: true,
        label: "放电价",
        icon: "./assets/discharge@3x.png",
        total: electricity + item.dischargeService,
        electricity,
        service: item.dischargeService,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // 4. 顶部筛选区域渲染
  // ---------------------------------------------------------------------------

  function renderStrategies() {
    const availableIds = state.strategies.map((item) => item.id);
    if (!availableIds.includes(state.strategy)) state.strategy = availableIds[0] || "immediate";

    const activeIndex = Math.max(0, availableIds.indexOf(state.strategy));
    dom.strategyTabs.style.setProperty("--tab-count", Math.max(1, state.strategies.length));
    dom.strategyTabs.style.setProperty("--tab-index", activeIndex);
    // 仅移除旧按钮，不能 replaceChildren()，否则会误删固定的白色 slider。
    dom.strategyTabs.querySelectorAll(".strategy-tab").forEach((item) => item.remove());

    state.strategies.forEach((strategy) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `strategy-tab${strategy.id === state.strategy ? " is-active" : ""}`;
      button.dataset.strategy = strategy.id;
      button.textContent = strategy.label;
      button.setAttribute("aria-pressed", strategy.id === state.strategy ? "true" : "false");
      const interactive = IMPLEMENTED_STRATEGIES.has(strategy.id);
      button.setAttribute("aria-disabled", interactive ? "false" : "true");
      if (interactive) button.addEventListener("click", () => setStrategy(strategy.id));
      dom.strategyTabs.appendChild(button);
    });

    dom.strategySection.hidden = state.strategies.length <= 1;
    updateTopMenuVisibility();
  }

  function renderTerminals() {
    if (!state.terminals.some((item) => item.id === state.terminalId)) {
      state.terminalId = state.terminals[0]?.id || "";
    }

    dom.terminalTabs.replaceChildren();
    state.terminals.forEach((terminal) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `terminal-tab${terminal.id === state.terminalId ? " is-active" : ""}`;
      button.dataset.terminal = terminal.id;
      button.textContent = terminal.label;
      button.setAttribute("aria-pressed", terminal.id === state.terminalId ? "true" : "false");
      button.addEventListener("click", () => setTerminal(terminal.id));
      dom.terminalTabs.appendChild(button);
    });

    const config = STRATEGY_CONFIG[state.strategy];
    const shouldCollapse = !config?.usesTerminal || state.terminals.length <= 1;
    // 始终保留节点，通过 is-collapsed 播放高度动画；直接 hidden 会造成表头跳变。
    dom.terminalSection.hidden = false;
    dom.terminalSection.classList.toggle("is-collapsed", shouldCollapse);
    dom.terminalSection.setAttribute("aria-hidden", shouldCollapse ? "true" : "false");
    // aria-hidden / inert 同步移除辅助技术与键盘访问能力。
    if ("inert" in dom.terminalSection) dom.terminalSection.inert = shouldCollapse;
    updateTopMenuVisibility();
  }

  function updateTopMenuVisibility() {
    // 策略和终端都无需展示时，隐藏整个顶部菜单，仅保留价格表头。
    const terminalCollapsed = dom.terminalSection.classList.contains("is-collapsed");
    dom.topMenu.hidden = dom.strategySection.hidden && terminalCollapsed;
  }

  // ---------------------------------------------------------------------------
  // 5. 当前时段定位与滚动
  // - 首次 init 使用缓动动画；Tab 切换使用即时定位。
  // - 用户主动触摸、滚轮、指针或键盘操作拥有最高优先级，可立即取消动画。
  // - 减少动态效果模式下跳过缓动，直接定位。
  // ---------------------------------------------------------------------------

  /**
   * 同时取消 timeout、RAF，并通过 token 让已进入任务队列的旧回调失效。
   */
  function cancelCurrentPeriodScroll() {
    autoScrollToken += 1;
    window.clearTimeout(autoScrollTimer);
    window.cancelAnimationFrame(autoScrollFrame);
    autoScrollTimer = 0;
    autoScrollFrame = 0;
  }

  /**
   * 计算当前卡片的页面滚动目标，并在页面尾部空间不足时写入最小补位高度。
   * anticipatedHeightLoss 用于预补偿终端即将折叠造成的页面高度减少，避免滚动上限回收。
   * @param {HTMLElement} currentCard
   * @param {number} anticipatedHeightLoss
   * @returns {number}
   */
  function getCurrentPeriodScrollTarget(currentCard, anticipatedHeightLoss = 0) {
    dom.priceDetail.style.setProperty("--current-scroll-reserve", "0px");
    // 强制刷新布局，避免沿用上一个策略为末段时留下的补位高度。
    void dom.priceDetail.offsetHeight;

    const listPaddingTop = Number.parseFloat(getComputedStyle(dom.scheduleList).paddingTop) || 0;
    const headerHeight = dom.stickyHeader.getBoundingClientRect().height;
    const cardDocumentTop = window.scrollY + currentCard.getBoundingClientRect().top;
    const target = Math.max(0, cardDocumentTop - headerHeight - listPaddingTop);
    let reserve = 0;

    // 当当前时段接近当天末尾时补足滚动空间，使目标卡片仍能定位到吸顶表头下方。
    // 这里只改变页面 scrollY，不会重排配置中的时段数组。
    // 短页面的首段补位可能先被 min-height 吸收，因此按实际最大滚动值迭代校准。
    for (let index = 0; index < 3; index += 1) {
      const scrollRoot = document.scrollingElement || document.documentElement;
      const maxScroll = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
      const missing = target + anticipatedHeightLoss - maxScroll;
      if (missing <= 0.5) break;
      reserve += Math.ceil(missing + 1);
      dom.priceDetail.style.setProperty("--current-scroll-reserve", `${reserve}px`);
      void dom.priceDetail.offsetHeight;
    }

    return target;
  }

  function animateToCurrentPeriod(token) {
    const currentCard = dom.scheduleList.querySelector(".price-card.is-current");
    if (!currentCard || token !== autoScrollToken) return;

    const target = getCurrentPeriodScrollTarget(currentCard);
    const start = window.scrollY;
    const distance = target - start;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduceMotion || Math.abs(distance) < 1) {
      window.scrollTo(0, target);
      return;
    }

    // 距离越长动画越久，但限制在 420-680ms，兼顾可见性和等待成本。
    const duration = Math.min(680, Math.max(420, Math.abs(distance) * 0.32));
    const startedAt = performance.now();

    const step = (now) => {
      if (token !== autoScrollToken) return;
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      window.scrollTo(0, start + distance * eased);
      if (progress < 1) {
        autoScrollFrame = window.requestAnimationFrame(step);
      } else {
        autoScrollFrame = 0;
        window.scrollTo(0, target);
      }
    };

    autoScrollFrame = window.requestAnimationFrame(step);
  }

  /**
   * 安排首屏动画。双 RAF 用于等待模板写入和样式计算完成，减少首帧跳动。
   */
  function scheduleCurrentPeriodScroll(waitForHeader = false) {
    cancelCurrentPeriodScroll();
    const token = autoScrollToken;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const delay = reduceMotion ? 0 : (waitForHeader ? HEADER_TRANSITION_DELAY : SCROLL_START_DELAY);

    autoScrollTimer = window.setTimeout(() => {
      autoScrollTimer = 0;
      autoScrollFrame = window.requestAnimationFrame(() => {
        autoScrollFrame = window.requestAnimationFrame(() => animateToCurrentPeriod(token));
      });
    }, delay);
  }

  /**
   * Tab 切换后的无动画定位，避免多个策略间来回切换时列表持续滚动。
   */
  function positionCurrentPeriodImmediately(anticipatedHeightLoss = 0) {
    cancelCurrentPeriodScroll();
    const currentCard = dom.scheduleList.querySelector(".price-card.is-current");
    if (!currentCard) return;
    window.scrollTo(0, getCurrentPeriodScrollTarget(currentCard, anticipatedHeightLoss));
  }

  // ---------------------------------------------------------------------------
  // 6. 卡片模板与内容区渲染
  // 当前模板只拼接本文件内的受控数据；若未来直接使用后台文案或图片地址，必须先转义/校验。
  // .price-grid / .price-values 的层级与 CSS 表头列对齐绑定，不应单独改动。
  // ---------------------------------------------------------------------------

  /** @param {PriceRow} price */
  function priceRowTemplate(price) {
    return `
      <div class="price-row ${price.type}${price.featured ? " is-featured" : ""}">
        <p class="price-name">
          ${price.icon ? `<img src="${price.icon}" alt="" />` : ""}
          <span>${price.label}</span>
        </p>
        <div class="price-values">
          <span class="total">${formatPrice(price.total)}</span>
          <span>${formatPrice(price.electricity)}</span>
          <span>${formatPrice(price.service)}</span>
        </div>
      </div>
    `;
  }

  /**
   * @param {ScheduleItem} item
   * @param {number} currentMinutes
   * @param {Terminal|null} terminal
   * @param {Object} config
   */
  function scheduleCardTemplate(item, currentMinutes, terminal, config) {
    const tier = TIER_META[item.tier];
    const current = isCurrentPeriod(item, currentMinutes);
    const prices = config.buildPrices(item, terminal);
    const badges = [
      current ? '<img class="period-badge" src="./assets/current-period@3x.png" alt="当前时段" />' : "",
      config.showsTierBadge ? `<img class="period-badge" src="${tier.icon}" alt="${tier.label}" />` : "",
    ].filter(Boolean).join("");
    return `
      <article class="price-card price-grid${current ? " is-current" : ""}" data-strategy="${state.strategy}" data-tier="${item.tier}"${current ? ' aria-current="time"' : ""}>
        <div class="period-cell">
          ${badges ? `<div class="period-badges">${badges}</div>` : ""}
          <time class="period-time">${item.start}-${item.end}</time>
        </div>
        <div class="price-rows">
          ${prices.map(priceRowTemplate).join("")}
        </div>
      </article>
    `;
  }

  // 每次策略或终端变化均全量重建当日卡片，确保价格行和当前时段状态一致。
  function renderSchedule() {
    const config = STRATEGY_CONFIG[state.strategy];
    if (!config) {
      dom.scheduleList.replaceChildren();
      return;
    }

    const terminal = config.usesTerminal ? getActiveTerminal() : null;
    if (config.usesTerminal && !terminal) {
      dom.scheduleList.replaceChildren();
      return;
    }

    const currentMinutes = getCurrentMinutes();
    dom.scheduleList.innerHTML = config.schedule
      .map((item) => scheduleCardTemplate(item, currentMinutes, terminal, config))
      .join("");
  }

  // data-definition 由策略配置控制；is-last-visible 用于修正动态末行分隔线。
  function renderDefinitions() {
    const visibleDefinitions = new Set(STRATEGY_CONFIG[state.strategy]?.definitions || []);
    const rows = Array.from(dom.definitionCard.querySelectorAll("[data-definition]"));
    rows.forEach((row) => {
      row.hidden = !visibleDefinitions.has(row.dataset.definition);
      row.classList.remove("is-last-visible");
    });
    const visibleRows = rows.filter((row) => !row.hidden);
    visibleRows[visibleRows.length - 1]?.classList.add("is-last-visible");
  }

  // ---------------------------------------------------------------------------
  // 7. 状态切换与 APP Bridge
  // ---------------------------------------------------------------------------

  /**
   * 切换策略。仅接受当前场站支持且已实现的策略，返回值供 APP 判断是否执行成功。
   * 首次进入走滚动动画；Tab 切换仅即时定位当前时段。
   * @param {StrategyId|string} value
   * @returns {boolean}
   */
  function setStrategy(value) {
    const normalized = normalizeStrategy(value);
    if (!normalized || !IMPLEMENTED_STRATEGIES.has(normalized) || !state.strategies.some((item) => item.id === normalized)) return false;
    if (normalized === state.strategy) return true;
    const terminalWasCollapsed = dom.terminalSection.classList.contains("is-collapsed");
    const terminalHeightBefore = dom.terminalSection.getBoundingClientRect().height;
    state.strategy = normalized;
    const activeIndex = state.strategies.findIndex((item) => item.id === state.strategy);
    dom.strategyTabs.style.setProperty("--tab-index", activeIndex);
    dom.strategyTabs.querySelectorAll(".strategy-tab").forEach((button) => {
      const active = button.dataset.strategy === state.strategy;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    renderTerminals();
    renderSchedule();
    renderDefinitions();
    const terminalIsCollapsed = dom.terminalSection.classList.contains("is-collapsed");
    // 从立即充电切到无终端策略时，预留即将折叠的终端高度，避免浏览器回收 scrollY。
    const anticipatedHeightLoss = !terminalWasCollapsed && terminalIsCollapsed ? terminalHeightBefore : 0;
    positionCurrentPeriodImmediately(anticipatedHeightLoss);
    return true;
  }

  /**
   * 切换终端后只重新计算当前策略价格，不改变策略和页面滚动位置。
   * @param {string} value
   * @returns {boolean}
   */
  function setTerminal(value) {
    const terminal = state.terminals.find((item) => item.id === value || item.label === value);
    if (!terminal) return false;
    state.terminalId = terminal.id;
    renderTerminals();
    renderSchedule();
    return true;
  }

  /**
   * 初始化或刷新页面状态。payload 会覆盖 URL 提供的首屏默认值。
   *
   * @param {Object} [payload]
   * @param {Array<StrategyId|string>} [payload.supportedStrategies]
   * @param {Array<string|Partial<Terminal>>} [payload.terminals]
   * @param {StrategyId|string} [payload.strategy]
   * @param {string} [payload.terminalId]
   * @param {string|null} [payload.currentTime] - HH:mm；传 null 恢复设备当前时间。
   */
  function init(payload = {}) {
    const terminalWasCollapsed = dom.terminalSection.classList.contains("is-collapsed");
    if (Array.isArray(payload.supportedStrategies)) {
      state.strategies = payload.supportedStrategies
        .map((value) => STRATEGIES.find((item) => item.id === value || item.label === value))
        .filter(Boolean);
      if (!state.strategies.length) state.strategies = [STRATEGIES[0]];
    }

    if (Array.isArray(payload.terminals) && payload.terminals.length) {
      state.terminals = payload.terminals.map(normalizeTerminal);
    }

    const incomingStrategy = normalizeStrategy(payload.strategy);
    if (incomingStrategy) state.strategy = incomingStrategy;
    if (payload.terminalId) state.terminalId = payload.terminalId;
    if (payload.currentTime !== undefined) state.currentTime = payload.currentTime;

    renderStrategies();
    renderTerminals();
    renderSchedule();
    renderDefinitions();
    const terminalIsCollapsed = dom.terminalSection.classList.contains("is-collapsed");
    scheduleCurrentPeriodScroll(terminalWasCollapsed !== terminalIsCollapsed);
  }

  // 直接调用接口：APP 可通过 WebView 注入脚本调用以下三个方法。
  window.PriceDetailH5 = Object.freeze({ init, setStrategy, setTerminal });

  /**
   * postMessage 兼容接口：
   * - PRICE_DETAIL_INIT：支持 { type, payload }，也兼容字段直接放在 message 上；
   * - PRICE_DETAIL_SET_STRATEGY：读取 message.strategy；
   * - PRICE_DETAIL_SET_TERMINAL：读取 message.terminalId。
   * 当前默认运行在受控 APP WebView；若部署到普通网页，应增加 event.origin/source 白名单校验。
   */
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "PRICE_DETAIL_INIT") init(message.payload || message);
    if (message.type === "PRICE_DETAIL_SET_STRATEGY") setStrategy(message.strategy);
    if (message.type === "PRICE_DETAIL_SET_TERMINAL") setTerminal(message.terminalId);
  });

  // 任何明确的用户滚动意图都会取消首屏自动动画，避免与用户争夺页面控制权。
  ["touchstart", "wheel", "pointerdown"].forEach((eventName) => {
    window.addEventListener(eventName, cancelCurrentPeriodScroll, { capture: true, passive: true });
  });

  window.addEventListener("keydown", (event) => {
    const scrollKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"];
    if (scrollKeys.includes(event.key)) cancelCurrentPeriodScroll();
  }, { capture: true });

  // 使用 URL 与默认数据完成首次渲染；APP 可随后再次调用 init(payload) 覆盖。
  init();
})();
