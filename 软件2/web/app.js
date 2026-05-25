const NAV_ITEMS = [
  ["overview", "低压组态监测", "P0"],
  ["substation3d", "变电站可视化", "P0"],
  ["history", "历史数据", "P0"],
  ["alarms", "告警事件", "P0"],
  ["interfaces", "接口管理", "P0"],
  ["reports", "报表抄表", "P1"],
  ["analytics", "统计分析", "P1"],
  ["devices", "设备管理", "P1"],
  ["settings", "系统管理", "P2"],
  ["integrations", "第三方接入", "P2"],
];

const TOPOLOGY_CONFIG = globalThis.LOW_VOLTAGE_TOPOLOGY_CONFIG;
const STATION_CODE = TOPOLOGY_CONFIG.stationCode;
const TOPOLOGY_API_BASE_URL = normalizeApiBaseUrl(TOPOLOGY_CONFIG.apiBaseUrl);
const COLLECTOR_ONLINE_MAX_AGE_MS = 60 * 1000;
const ALARM_POLL_INTERVAL_MS = 5000;
const SUBSTATION_3D_HOVER_DELAY_MS = 2000;
const DEFAULT_VISUALIZATION_3D_CONFIG = {
  modelAsset: "./assets/models/AA1.glb?v=20260525-centered-1",
  cabinetCode: "AA1",
  ignoredObjects: ["Rectangle204"],
  camera: {
    position: [3.2, 2.4, 5.2],
    target: [0, 1.2, 0],
  },
  circuits: [
    {
      circuitId: "d010101",
      name: "路灯照明",
      meterId: "amc-001",
      pointCode: "dido_status",
      bitMask: 0x0100,
      lampObject: "AA1_C1_LAMP",
      handleObject: "AA1_C1_HANDLE",
      pickObjects: ["ct1", "AA1_C1_DRAWER"],
      openRotation: { x: -28 },
      closedRotation: { x: 28 },
    },
    {
      circuitId: "d010102",
      name: "3号楼照明",
      meterId: "amc-001",
      pointCode: "dido_status",
      bitMask: 0x0200,
      lampObject: "AA1_C2_LAMP",
      handleObject: "AA1_C2_HANDLE",
      pickObjects: ["ct2", "AA1_C2_DRAWER"],
      openRotation: { x: -28 },
      closedRotation: { x: 28 },
    },
    {
      circuitId: "d010103",
      name: "4、5号楼照明",
      meterId: "amc-001",
      pointCode: "dido_status",
      bitMask: 0x0400,
      lampObject: "AA1_C3_LAMP",
      handleObject: "AA1_C3_HANDLE",
      pickObjects: ["ct3", "AA1_C3_DRAWER"],
      openRotation: { x: -28 },
      closedRotation: { x: 28 },
    },
    {
      circuitId: "d010104",
      name: "1号楼照明",
      meterId: "amc-001",
      pointCode: "dido_status",
      bitMask: 0x0800,
      lampObject: "AA1_C4_LAMP",
      handleObject: "AA1_C4_HANDLE",
      pickObjects: ["gdb", "AA1_C4_DRAWER"],
      openRotation: { x: -28 },
      closedRotation: { x: 28 },
    },
  ],
};

const PLACEHOLDER_COPY = {
  history: "后续承接回路、电参量、时间范围和统计值查询。低压组态监测页弹窗中的回路编号会作为默认查询条件。",
  alarms: "用于展示越限、通信中断、恢复、确认和关闭记录，并联动组态图上的回路状态标记。",
  interfaces: "用于展示软件1接入状态、最近数据包、网关/仪表通信状态、点位字典和回路映射。",
  reports: "用于生成运行报表、定时抄表记录和导出文件，未接入项目会明确标注不适用。",
  analytics: "用于展示负载、电压偏差、三相不平衡和频率分析，并支持围绕告警事件查看前后趋势。",
  devices: "用于维护 AA0-AA11 柜体、内部回路、仪表、网关和维护记录。",
  settings: "用于配置用户、角色、告警阈值、数据字典、业务参数和操作日志。",
  integrations: "用于预留 UPS、继保、温控和管理中心上传接口的配置与状态展示。",
};

const circuits = buildCircuits();
let selectedCircuitId = null;
let activePage = "overview";
let realtimeSeed = 0;
let topologyZoom = 1.5;
const realtimeByMeter = new Map();
let latestTopologyPayload = { switches: [] };
let substation3dController = null;
let substation3dLoadingPromise = null;
let hoveredSubstation3dCircuitId = null;
let pendingSubstation3dHoverCircuitId = null;
let substation3dHoverTimer = null;
let lastSubstation3dPointer = null;
let activeDialogTab = "realtime";
let historyRequestId = 0;
let historyPageRequestId = 0;
const historyStateByCircuit = new Map();

const HISTORY_CHART_GROUPS = [
  {
    key: "voltage",
    title: "电压曲线",
    series: [
      ["ua", "A相电压", "Ua", "#2563eb"],
      ["ub", "B相电压", "Ub", "#16a34a"],
      ["uc", "C相电压", "Uc", "#dc2626"],
      ["uab", "AB线电压", "Uab", "#7c3aed"],
      ["ubc", "CB线电压", "Ucb", "#0891b2"],
      ["uac", "AC线电压", "Uac", "#ea580c"],
    ],
  },
  {
    key: "current",
    title: "电流曲线",
    series: [
      ["ia", "A相电流", "Ia", "#2563eb"],
      ["ib", "B相电流", "Ib", "#16a34a"],
      ["ic", "C相电流", "Ic", "#dc2626"],
    ],
  },
  {
    key: "power",
    title: "功率相关曲线",
    series: [
      ["p_total", "有功功率", "P", "#2563eb"],
      ["q_total", "无功功率", "Q", "#16a34a"],
      ["s_total", "视在功率", "S", "#dc2626"],
      ["pf_total", "功率因数", "PF", "#7c3aed"],
      ["frequency", "频率", "f", "#0891b2"],
      ["ep_import", "电度", "Ep", "#ea580c"],
    ],
  },
];

const HISTORY_POINT_CODES = HISTORY_CHART_GROUPS.flatMap((group) => group.series.map(([code]) => code));
const HISTORY_TABLE_COLUMNS = HISTORY_CHART_GROUPS.flatMap((group) => group.series.map(([code, name, symbol]) => ({
  code,
  name,
  symbol,
})));
const historyPageState = {
  initialized: false,
  circuitQuery: "",
  selectedCircuitId: "",
  startValue: "",
  endValue: "",
  pageSize: 20,
  order: "desc",
  page: 1,
  total: 0,
  hasNext: false,
  status: "idle",
  message: "",
  rows: [],
  columns: HISTORY_TABLE_COLUMNS,
};
const ALARM_STATUS_LABELS = {
  active: "活动",
  acknowledged: "已确认",
  recovered: "已恢复",
  closed: "已关闭",
};
const ALARM_LEVEL_LABELS = {
  critical: "严重",
  warning: "告警",
  info: "提示",
};
const EVENT_PLACEHOLDER_MESSAGE = "暂无事件记录。ION7650综合电表电压事件接入后在此显示。";
const alarmEventState = {
  initialized: false,
  activeTab: "alarms",
  actionType: "",
  actionAlarm: null,
  alarms: {
    page: 1,
    pageSize: 20,
    total: 0,
    hasNext: false,
    status: "idle",
    message: "",
    rows: [],
    summary: { active: "--", acknowledged: "--", recovered: "--", closed: "--" },
  },
  events: {
    page: 1,
    pageSize: 20,
    total: 0,
    hasNext: false,
    status: "success",
    message: "",
    rows: [],
  },
};
const seenActiveAlarmIds = new Set();
const dismissedAlarmToastIds = new Set();
const activeAlarmCircuitIds = new Set();
let alarmPopupPrimed = false;

function buildCircuits() {
  return TOPOLOGY_CONFIG.cabinets.flatMap((cabinet, cabinetIndex) => {
    const cabinetNumber = Number(cabinet.code.replace("AA", ""));
    return cabinet.circuits.map((displayName, index) => {
      const sequence = index + 1;
      const internalId = `d${STATION_CODE}${String(cabinetNumber).padStart(2, "0")}${String(sequence).padStart(2, "0")}`;
      const meter = cabinet.meters?.[sequence] ?? null;
      return {
        internalId,
        dbCircuitId: internalId,
        cabinetIndex,
        cabinetCode: cabinet.code,
        cabinetName: cabinet.name,
        cabinetType: cabinet.type,
        sequence,
        displayName,
        meter,
        source: meter ? "真实 AMC 采集" : "未接入",
        status: meter ? "real" : "pending",
        switchStatus: null,
        switchQuality: meter ? "unknown" : "not_connected",
        switchSampleTime: null,
        breakerClosed: false,
      };
    });
  });
}

async function init() {
  initCollectorStatusIndicator();
  refreshCollectorStatus();
  setInterval(refreshCollectorStatus, 5000);
  renderNavigation();
  renderSummary();
  initHistoryPage();
  initAlarmEventPage();
  await loadTopologySvg();
  renderDynamicLayers();
  refreshTopologyState();
  refreshRealtimeState();
  refreshAlarmPopupState();
  initZoomControls();
  tickRealtime();
  setInterval(tickRealtime, 2000);
  setInterval(refreshTopologyState, 2000);
  setInterval(refreshRealtimeState, 2000);
  setInterval(refreshAlarmPopupState, ALARM_POLL_INTERVAL_MS);
}

function initCollectorStatusIndicator() {
  const status = document.querySelector("#collectorStatus");
  if (!status) return;

  setCollectorStatus("正在检测采集状态", false);
}

async function refreshCollectorStatus() {
  if (!TOPOLOGY_API_BASE_URL) {
    setCollectorStatus("采集状态未知", false);
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(topologyApiUrl("/api/interfaces/status"), {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error("collector status unavailable");
    const payload = await response.json();
    applyCollectorStatus(payload.interfaces ?? []);
  } catch {
    setCollectorStatus("数据采集软件离线", false);
  }
}

function applyCollectorStatus(interfaces) {
  const latest = interfaces
    .map((item) => {
      const time = parseCollectorStatusTime(item.last_received_at ?? item.lastReceivedAt ?? item.last_packet_at ?? item.lastPacketAt ?? item.updated_at ?? item.updatedAt);
      return {
        status: String(item.status ?? "unknown").toLowerCase(),
        time,
      };
    })
    .filter((item) => item.time !== null)
    .sort((left, right) => right.time - left.time)[0];

  if (!latest) {
    setCollectorStatus("数据采集软件离线", false);
    return;
  }

  const isFresh = Date.now() - latest.time.getTime() <= COLLECTOR_ONLINE_MAX_AGE_MS;
  const isHealthy = ["online", "ok", "good"].includes(latest.status);
  setCollectorStatus(isFresh && isHealthy ? "数据采集软件在线" : "数据采集软件离线", isFresh && isHealthy, latest.time);
}

function setCollectorStatus(text, isOnline, sampleTime = null) {
  const status = document.querySelector("#collectorStatus");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("online", isOnline);
  status.classList.toggle("offline", !isOnline);
  if (sampleTime) {
    status.title = `最近接收: ${formatBeijingDateTime(sampleTime)}`;
  } else {
    status.removeAttribute("title");
  }
}

function parseCollectorStatusTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function renderNavigation() {
  const navList = document.querySelector("#navList");
  navList.innerHTML = NAV_ITEMS.map(([key, label, priority]) => {
    return `<button class="nav-item ${key === activePage ? "active" : ""}" data-page="${key}">
      ${label}<span class="nav-priority">${priority}</span>
    </button>`;
  }).join("");

  navList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page]");
    if (!button) return;
    setActivePage(button.dataset.page);
  });
}

function setActivePage(page) {
  activePage = page;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === page);
  });

  const isOverview = page === "overview";
  const isSubstation3d = page === "substation3d";
  const isHistory = page === "history";
  const isAlarmEvent = page === "alarms";
  document.querySelector("#overviewPage").classList.toggle("page-active", isOverview);
  document.querySelector("#substation3dPage").classList.toggle("page-active", isSubstation3d);
  document.querySelector("#historyPage").classList.toggle("page-active", isHistory);
  document.querySelector("#alarmEventPage").classList.toggle("page-active", isAlarmEvent);
  document.querySelector("#placeholderPage").classList.toggle("page-active", !isOverview && !isSubstation3d && !isHistory && !isAlarmEvent);
  const label = NAV_ITEMS.find(([key]) => key === page)?.[1] ?? "低压组态监测";
  document.querySelector("#pageTitle").textContent = label;

  if (isSubstation3d) {
    activateSubstation3dPage();
  } else if (isHistory) {
    hideSubstation3dHoverPopup();
    activateHistoryPage();
  } else if (isAlarmEvent) {
    hideSubstation3dHoverPopup();
    activateAlarmEventPage();
  } else if (!isOverview) {
    hideSubstation3dHoverPopup();
    document.querySelector("#placeholderTitle").textContent = label;
    document.querySelector("#placeholderBody").textContent = PLACEHOLDER_COPY[page] ?? "";
  } else {
    hideSubstation3dHoverPopup();
  }
}

function renderSummary() {
  const boundCount = circuits.filter((circuit) => circuit.meter).length;
  document.querySelector("#circuitCount").textContent = circuits.length;
  document.querySelector("#boundCount").textContent = boundCount;
  document.querySelector("#unboundCount").textContent = circuits.length - boundCount;
}

function initHistoryPage() {
  if (historyPageState.initialized) return;

  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  historyPageState.startValue = formatBeijingInputDateTime(start);
  historyPageState.endValue = formatBeijingInputDateTime(end);
  historyPageState.initialized = true;

  document.querySelector("#historyPageStartField").innerHTML = historyTimeField("开始时间", "historyPageStart", historyPageState.startValue);
  document.querySelector("#historyPageEndField").innerHTML = historyTimeField("结束时间", "historyPageEnd", historyPageState.endValue);

  const circuitInput = document.querySelector("#historyCircuitInput");
  const circuitToggle = document.querySelector("#historyCircuitToggle");
  const circuitDropdown = document.querySelector("#historyCircuitDropdown");
  const circuitField = document.querySelector(".history-circuit-field");
  renderHistoryCircuitOptions("");

  circuitInput.addEventListener("input", () => {
    historyPageState.circuitQuery = circuitInput.value.trim();
    renderHistoryCircuitOptions(historyPageState.circuitQuery);
    openHistoryCircuitDropdown();
  });
  circuitInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeHistoryCircuitDropdown();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      renderHistoryCircuitOptions("");
      openHistoryCircuitDropdown();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      closeHistoryCircuitDropdown();
      historyPageState.page = 1;
      loadHistoryPageData();
    }
  });
  circuitInput.addEventListener("focus", () => {
    renderHistoryCircuitOptions(historyPageState.circuitQuery);
  });
  circuitToggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (circuitDropdown.hidden) {
      renderHistoryCircuitOptions("");
      openHistoryCircuitDropdown();
    } else {
      closeHistoryCircuitDropdown();
    }
  });
  circuitDropdown.addEventListener("click", (event) => {
    const option = event.target.closest("[data-history-circuit-id]");
    if (!option) return;
    selectHistoryCircuit(option.dataset.historyCircuitId);
  });
  document.addEventListener("click", (event) => {
    if (!circuitField.contains(event.target)) closeHistoryCircuitDropdown();
  });

  document.querySelector("#historyPageQueryButton").addEventListener("click", () => {
    closeHistoryCircuitDropdown();
    historyPageState.page = 1;
    loadHistoryPageData();
  });

  document.querySelector("#historyPageSizeSelect").addEventListener("change", (event) => {
    historyPageState.pageSize = Number(event.target.value) || 20;
    historyPageState.page = 1;
    if (historyPageState.status === "success") loadHistoryPageData();
  });

  document.querySelector("#historyOrderSelect").addEventListener("change", (event) => {
    historyPageState.order = event.target.value === "desc" ? "desc" : "asc";
    historyPageState.page = 1;
    if (historyPageState.status === "success") loadHistoryPageData();
  });

  document.querySelector("#historyPrevPageButton").addEventListener("click", () => {
    if (historyPageState.page <= 1 || historyPageState.status === "loading") return;
    historyPageState.page -= 1;
    loadHistoryPageData();
  });

  document.querySelector("#historyNextPageButton").addEventListener("click", () => {
    if (!historyPageState.hasNext || historyPageState.status === "loading") return;
    historyPageState.page += 1;
    loadHistoryPageData();
  });

  renderHistoryPageState();
}

function renderHistoryCircuitOptions(filterText) {
  const dropdown = document.querySelector("#historyCircuitDropdown");
  const text = String(filterText || "").trim().toLowerCase();
  const matchedCircuits = circuits.filter((circuit) => {
    if (!text) return true;
    return circuit.internalId.toLowerCase().includes(text)
      || displayCircuitName(circuit).toLowerCase().includes(text)
      || circuit.cabinetCode.toLowerCase().includes(text);
  });

  dropdown.innerHTML = matchedCircuits.length > 0
    ? matchedCircuits.map((circuit) => `<button
        class="history-circuit-option"
        type="button"
        role="option"
        data-history-circuit-id="${escapeHtml(circuit.internalId)}"
      >
        <strong>${escapeHtml(circuit.internalId)}</strong>
        <span>${escapeHtml(historyCircuitOptionText(circuit))}</span>
      </button>`).join("")
    : `<div class="history-circuit-empty">没有匹配的回路</div>`;
}

function openHistoryCircuitDropdown() {
  const input = document.querySelector("#historyCircuitInput");
  const dropdown = document.querySelector("#historyCircuitDropdown");
  dropdown.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function closeHistoryCircuitDropdown() {
  const input = document.querySelector("#historyCircuitInput");
  const dropdown = document.querySelector("#historyCircuitDropdown");
  if (!input || !dropdown) return;
  dropdown.hidden = true;
  input.setAttribute("aria-expanded", "false");
}

function selectHistoryCircuit(circuitId) {
  const circuit = findCircuit(circuitId);
  if (!circuit) return;
  historyPageState.circuitQuery = circuit.internalId;
  historyPageState.selectedCircuitId = circuit.internalId;
  document.querySelector("#historyCircuitInput").value = circuit.internalId;
  closeHistoryCircuitDropdown();
  renderHistoryPageState();
}

function historyCircuitOptionText(circuit) {
  return `${displayCircuitName(circuit)} / ${circuit.cabinetCode} / ${circuit.meter ?? "未接入仪表"}`;
}

function activateHistoryPage() {
  if (!historyPageState.initialized) initHistoryPage();
  if (selectedCircuitId && !historyPageState.circuitQuery) {
    const circuit = findCircuit(selectedCircuitId);
    if (circuit) {
      historyPageState.circuitQuery = circuit.internalId;
      document.querySelector("#historyCircuitInput").value = circuit.internalId;
    }
  }
  if (historyPageState.status === "idle") {
    historyPageState.endValue = formatBeijingInputDateTime(new Date());
    document.querySelector("#historyPageEndField").innerHTML = historyTimeField("结束时间", "historyPageEnd", historyPageState.endValue);
  }
  renderHistoryPageState();
}

function resolveHistoryCircuit(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  return circuits.find((circuit) => circuit.internalId.toLowerCase() === text)
    ?? circuits.find((circuit) => displayCircuitName(circuit).toLowerCase() === text)
    ?? circuits.find((circuit) => `${circuit.cabinetCode}-${circuit.sequence}`.toLowerCase() === text)
    ?? circuits.find((circuit) => circuit.internalId.toLowerCase().includes(text) || displayCircuitName(circuit).toLowerCase().includes(text));
}

async function loadHistoryPageData() {
  const circuit = resolveHistoryCircuit(document.querySelector("#historyCircuitInput").value);
  historyPageState.startValue = readHistoryTimeValue("historyPageStart") ?? historyPageState.startValue;
  historyPageState.endValue = readHistoryTimeValue("historyPageEnd") ?? historyPageState.endValue;
  historyPageState.pageSize = Number(document.querySelector("#historyPageSizeSelect").value) || 20;
  historyPageState.order = document.querySelector("#historyOrderSelect").value === "desc" ? "desc" : "asc";

  if (!circuit) {
    historyPageState.status = "error";
    historyPageState.selectedCircuitId = "";
    historyPageState.message = "请选择或输入有效的回路编号、回路名称。";
    historyPageState.rows = [];
    historyPageState.total = 0;
    historyPageState.hasNext = false;
    renderHistoryPageState();
    return;
  }

  historyPageState.selectedCircuitId = circuit.internalId;
  historyPageState.circuitQuery = document.querySelector("#historyCircuitInput").value.trim();

  if (!circuit.meter) {
    historyPageState.status = "error";
    historyPageState.message = `${circuit.internalId} ${displayCircuitName(circuit)} 未绑定仪表，无法从数据库查询历史数据。`;
    historyPageState.rows = [];
    historyPageState.total = 0;
    historyPageState.hasNext = false;
    renderHistoryPageState();
    return;
  }

  const startTime = parseBeijingInputDateTime(historyPageState.startValue);
  const endTime = parseBeijingInputDateTime(historyPageState.endValue);
  if (!startTime || !endTime || startTime >= endTime) {
    historyPageState.status = "error";
    historyPageState.message = "请输入有效的起止时刻，且开始时间必须早于结束时间。";
    historyPageState.rows = [];
    historyPageState.total = 0;
    historyPageState.hasNext = false;
    renderHistoryPageState();
    return;
  }

  const requestId = ++historyPageRequestId;
  historyPageState.status = "loading";
  historyPageState.message = "";
  renderHistoryPageState();

  try {
    const params = new URLSearchParams({
      meterId: circuit.meter,
      circuitId: circuit.dbCircuitId,
      pointCodes: HISTORY_POINT_CODES.join(","),
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      page: String(historyPageState.page),
      pageSize: String(historyPageState.pageSize),
      order: historyPageState.order,
    });
    const payload = await fetchHistoryRecordsPayload(params, circuit, startTime, endTime);
    if (requestId !== historyPageRequestId) return;
    historyPageState.status = "success";
    historyPageState.rows = payload.rows ?? [];
    historyPageState.columns = mergeHistoryColumns(payload.columns ?? []);
    historyPageState.total = Number(payload.total ?? 0);
    historyPageState.hasNext = Boolean(payload.hasNext);
    historyPageState.message = "";
  } catch {
    if (requestId !== historyPageRequestId) return;
    historyPageState.status = "error";
    historyPageState.message = "历史数据查询失败，请检查时间范围和后台服务。";
    historyPageState.rows = [];
    historyPageState.total = 0;
    historyPageState.hasNext = false;
  }

  renderHistoryPageState();
}

async function fetchHistoryRecordsPayload(params, circuit, startTime, endTime) {
  const response = await fetch(topologyApiUrl(`/api/history/records?${params.toString()}`), { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (response.ok && payload.ok) return payload;
  if (response.status !== 404) {
    throw new Error(payload.error || "history records query failed");
  }

  const fallbackParams = new URLSearchParams({
    meterId: circuit.meter,
    pointCodes: HISTORY_POINT_CODES.join(","),
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    limitPerPoint: "5000",
  });
  const fallbackResponse = await fetch(topologyApiUrl(`/api/history?${fallbackParams.toString()}`), { cache: "no-store" });
  const fallbackPayload = await fallbackResponse.json();
  if (!fallbackResponse.ok || !fallbackPayload.ok) {
    throw new Error(fallbackPayload.error || "history query fallback failed");
  }
  return historySeriesToRecords(fallbackPayload.series ?? []);
}

function historySeriesToRecords(series) {
  const rowsByTime = new Map();
  const columns = [];
  series.forEach((item) => {
    if (!item?.pointCode) return;
    columns.push({
      code: item.pointCode,
      name: item.name || item.pointCode,
      unit: item.unit || "",
    });
    (item.samples ?? []).forEach((sample) => {
      const key = new Date(sample.sampleTime).toISOString();
      if (!rowsByTime.has(key)) {
        rowsByTime.set(key, { sampleTime: sample.sampleTime, points: {} });
      }
      rowsByTime.get(key).points[item.pointCode] = {
        code: item.pointCode,
        name: item.name || item.pointCode,
        value: sample.value,
        rawValue: sample.rawValue,
        unit: item.unit || "",
        quality: sample.quality,
      };
    });
  });

  const sortedRows = Array.from(rowsByTime.values()).sort((left, right) => {
    const diff = new Date(left.sampleTime).getTime() - new Date(right.sampleTime).getTime();
    return historyPageState.order === "desc" ? -diff : diff;
  });
  const offset = (historyPageState.page - 1) * historyPageState.pageSize;
  const rows = sortedRows.slice(offset, offset + historyPageState.pageSize);
  return {
    ok: true,
    page: historyPageState.page,
    pageSize: historyPageState.pageSize,
    order: historyPageState.order,
    total: sortedRows.length,
    hasNext: offset + rows.length < sortedRows.length,
    columns,
    rows,
  };
}

function mergeHistoryColumns(payloadColumns) {
  const byCode = new Map(HISTORY_TABLE_COLUMNS.map((column) => [column.code, { ...column }]));
  payloadColumns.forEach((column) => {
    if (!column?.code) return;
    const existing = byCode.get(column.code) ?? { code: column.code, symbol: column.code, name: column.name || column.code };
    byCode.set(column.code, {
      ...existing,
      name: column.name || existing.name,
      unit: column.unit || existing.unit || "",
    });
  });
  return Array.from(byCode.values());
}

function renderHistoryPageState() {
  const circuit = historyPageState.selectedCircuitId ? findCircuit(historyPageState.selectedCircuitId) : resolveHistoryCircuit(historyPageState.circuitQuery);
  const title = circuit ? `${circuit.internalId} / ${displayCircuitName(circuit)}` : "请选择回路并查询";
  const totalPage = historyPageState.total > 0 ? Math.ceil(historyPageState.total / historyPageState.pageSize) : 1;
  const startIndex = historyPageState.total === 0 ? 0 : (historyPageState.page - 1) * historyPageState.pageSize + 1;
  const endIndex = Math.min(historyPageState.total, historyPageState.page * historyPageState.pageSize);

  document.querySelector("#historyResultTitle").textContent = title;
  document.querySelector("#historyResultMeta").textContent = historyPageState.total > 0
    ? `共 ${historyPageState.total} 条，当前 ${startIndex}-${endIndex} 条`
    : "结束时间默认填写当前时间";
  document.querySelector("#historyPageInfo").textContent = `第 ${historyPageState.page} / ${totalPage} 页`;
  document.querySelector("#historyPrevPageButton").disabled = historyPageState.status === "loading" || historyPageState.page <= 1;
  document.querySelector("#historyNextPageButton").disabled = historyPageState.status === "loading" || !historyPageState.hasNext;
  document.querySelector("#historyPageQueryButton").disabled = historyPageState.status === "loading";

  const statusNode = document.querySelector("#historyPageStatus");
  statusNode.className = `history-page-status ${historyPageState.status === "error" ? "error" : ""}`;
  if (historyPageState.status === "loading") {
    statusNode.textContent = "正在查询历史数据...";
  } else if (historyPageState.status === "error") {
    statusNode.textContent = historyPageState.message;
  } else {
    statusNode.textContent = "";
  }

  document.querySelector("#historyTableHost").innerHTML = historyTableMarkup();
}

function initAlarmEventPage() {
  if (alarmEventState.initialized) return;
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  document.querySelector("#alarmStartField").innerHTML = historyTimeField("开始时间", "alarmStart", formatBeijingInputDateTime(start));
  document.querySelector("#alarmEndField").innerHTML = historyTimeField("结束时间", "alarmEnd", formatBeijingInputDateTime(end));
  document.querySelector("#eventStartField").innerHTML = historyTimeField("开始时间", "eventStart", formatBeijingInputDateTime(start));
  document.querySelector("#eventEndField").innerHTML = historyTimeField("结束时间", "eventEnd", formatBeijingInputDateTime(end));

  document.querySelectorAll("[data-alarm-event-tab]").forEach((button) => {
    button.addEventListener("click", () => switchAlarmEventTab(button.dataset.alarmEventTab));
  });
  document.querySelector("#alarmQueryButton").addEventListener("click", () => {
    alarmEventState.alarms.page = 1;
    loadAlarmData();
  });
  document.querySelector("#eventQueryButton").addEventListener("click", () => {
    alarmEventState.events.page = 1;
    resetEventPlaceholder();
  });
  document.querySelector("#alarmPageSizeSelect").addEventListener("change", (event) => {
    alarmEventState.alarms.pageSize = Number(event.target.value) || 20;
    alarmEventState.alarms.page = 1;
    if (alarmEventState.alarms.status === "success") loadAlarmData();
  });
  document.querySelector("#eventPageSizeSelect").addEventListener("change", (event) => {
    alarmEventState.events.pageSize = Number(event.target.value) || 20;
    alarmEventState.events.page = 1;
    resetEventPlaceholder();
  });
  document.querySelector("#alarmPrevPageButton").addEventListener("click", () => {
    if (alarmEventState.alarms.page <= 1 || alarmEventState.alarms.status === "loading") return;
    alarmEventState.alarms.page -= 1;
    loadAlarmData();
  });
  document.querySelector("#alarmNextPageButton").addEventListener("click", () => {
    if (!alarmEventState.alarms.hasNext || alarmEventState.alarms.status === "loading") return;
    alarmEventState.alarms.page += 1;
    loadAlarmData();
  });
  document.querySelector("#eventPrevPageButton").addEventListener("click", () => {
    resetEventPlaceholder();
  });
  document.querySelector("#eventNextPageButton").addEventListener("click", () => {
    resetEventPlaceholder();
  });
  document.querySelector("#alarmTableHost").addEventListener("click", (event) => {
    const button = event.target.closest("[data-alarm-action]");
    if (!button) return;
    openAlarmActionDialog(button.dataset.alarmAction, button.dataset.alarmId);
  });
  document.querySelector("#alarmActionForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitAlarmAction();
  });
  document.querySelector("[data-close-alarm-action]").addEventListener("click", () => {
    document.querySelector("#alarmActionDialog").close();
  });
  document.querySelector("#alarmToastHost").addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view-alarm-page]");
    const dismissButton = event.target.closest("[data-dismiss-alarm-toast]");
    if (viewButton) {
      setActivePage("alarms");
      const navButton = document.querySelector('[data-page="alarms"]');
      if (navButton) navButton.focus();
    }
    if (dismissButton) {
      dismissedAlarmToastIds.add(String(dismissButton.dataset.dismissAlarmToast));
      renderAlarmToasts([]);
    }
  });

  alarmEventState.initialized = true;
  renderAlarmEventState();
}

function activateAlarmEventPage() {
  if (!alarmEventState.initialized) initAlarmEventPage();
  if (alarmEventState.activeTab === "alarms" && alarmEventState.alarms.status === "idle") loadAlarmData();
}

function switchAlarmEventTab(tab) {
  alarmEventState.activeTab = tab === "events" ? "events" : "alarms";
  renderAlarmEventState();
  if (alarmEventState.activeTab === "alarms" && alarmEventState.alarms.status === "idle") loadAlarmData();
}

async function loadAlarmData() {
  if (!TOPOLOGY_API_BASE_URL) {
    alarmEventState.alarms.status = "error";
    alarmEventState.alarms.message = "未配置后台接口地址。";
    renderAlarmEventState();
    return;
  }

  alarmEventState.alarms.status = "loading";
  alarmEventState.alarms.message = "";
  renderAlarmEventState();

  try {
    const params = alarmQueryParams();
    const response = await fetch(topologyApiUrl(`/api/alarms?${params.toString()}`), { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || "alarm query failed");
    alarmEventState.alarms.status = "success";
    alarmEventState.alarms.rows = payload.alarms ?? [];
    alarmEventState.alarms.total = Number(payload.total ?? 0);
    alarmEventState.alarms.hasNext = Boolean(payload.hasNext);
    await loadAlarmSummary();
  } catch {
    alarmEventState.alarms.status = "error";
    alarmEventState.alarms.message = "告警查询失败，请检查后台服务和数据库连接。";
    alarmEventState.alarms.rows = [];
    alarmEventState.alarms.total = 0;
    alarmEventState.alarms.hasNext = false;
  }

  renderAlarmEventState();
}

async function loadAlarmSummary() {
  const statuses = ["active", "acknowledged", "recovered", "closed"];
  const results = await Promise.all(statuses.map(async (status) => {
    const params = alarmQueryParams();
    params.delete("status");
    params.set("status", status);
    params.set("page", "1");
    params.set("pageSize", "1");
    const response = await fetch(topologyApiUrl(`/api/alarms?${params.toString()}`), { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) return [status, "--"];
    return [status, Number(payload.total ?? 0)];
  }));
  alarmEventState.alarms.summary = Object.fromEntries(results);
}

async function loadEventData() {
  resetEventPlaceholder();
}

function resetEventPlaceholder() {
  alarmEventState.events.status = "success";
  alarmEventState.events.message = "";
  alarmEventState.events.rows = [];
  alarmEventState.events.total = 0;
  alarmEventState.events.hasNext = false;
  alarmEventState.events.page = 1;
  renderAlarmEventState();
}

function alarmQueryParams() {
  const params = new URLSearchParams({
    page: String(alarmEventState.alarms.page),
    pageSize: String(alarmEventState.alarms.pageSize),
  });
  addOptionalParam(params, "status", document.querySelector("#alarmStatusFilter").value);
  addOptionalParam(params, "level", document.querySelector("#alarmLevelFilter").value);
  addOptionalParam(params, "keyword", document.querySelector("#alarmKeywordFilter").value.trim());
  addTimeParams(params, "alarmStart", "alarmEnd");
  return params;
}

function eventQueryParams() {
  const params = new URLSearchParams({
    page: String(alarmEventState.events.page),
    pageSize: String(alarmEventState.events.pageSize),
  });
  addOptionalParam(params, "eventType", document.querySelector("#eventTypeFilter").value.trim());
  addOptionalParam(params, "level", document.querySelector("#eventLevelFilter").value);
  addOptionalParam(params, "keyword", document.querySelector("#eventKeywordFilter").value.trim());
  addTimeParams(params, "eventStart", "eventEnd");
  return params;
}

function addTimeParams(params, startPrefix, endPrefix) {
  const startTime = parseBeijingInputDateTime(readHistoryTimeValue(startPrefix));
  const endTime = parseBeijingInputDateTime(readHistoryTimeValue(endPrefix));
  if (startTime) params.set("startTime", startTime.toISOString());
  if (endTime) params.set("endTime", endTime.toISOString());
}

function addOptionalParam(params, key, value) {
  if (value) params.set(key, value);
}

function renderAlarmEventState() {
  document.querySelectorAll("[data-alarm-event-tab]").forEach((button) => {
    const active = button.dataset.alarmEventTab === alarmEventState.activeTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#alarmPanel").classList.toggle("active", alarmEventState.activeTab === "alarms");
  document.querySelector("#eventPanel").classList.toggle("active", alarmEventState.activeTab === "events");
  renderAlarmTableState();
  renderEventTableState();
}

function renderAlarmTableState() {
  const state = alarmEventState.alarms;
  const totalPage = state.total > 0 ? Math.ceil(state.total / state.pageSize) : 1;
  const startIndex = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const endIndex = Math.min(state.total, state.page * state.pageSize);
  document.querySelector("#activeAlarmCount").textContent = state.summary.active ?? "--";
  document.querySelector("#ackAlarmCount").textContent = state.summary.acknowledged ?? "--";
  document.querySelector("#recoveredAlarmCount").textContent = state.summary.recovered ?? "--";
  document.querySelector("#closedAlarmCount").textContent = state.summary.closed ?? "--";
  document.querySelector("#alarmResultMeta").textContent = state.total > 0 ? `共 ${state.total} 条，当前 ${startIndex}-${endIndex} 条` : "按开始时间倒序";
  document.querySelector("#alarmPageInfo").textContent = `第 ${state.page} / ${totalPage} 页`;
  document.querySelector("#alarmPrevPageButton").disabled = state.status === "loading" || state.page <= 1;
  document.querySelector("#alarmNextPageButton").disabled = state.status === "loading" || !state.hasNext;
  document.querySelector("#alarmQueryButton").disabled = state.status === "loading";
  const statusNode = document.querySelector("#alarmPageStatus");
  statusNode.className = `history-page-status ${state.status === "error" ? "error" : ""}`;
  statusNode.textContent = state.status === "loading" ? "正在查询告警..." : state.status === "error" ? state.message : "";
  document.querySelector("#alarmTableHost").innerHTML = alarmTableMarkup();
}

function renderEventTableState() {
  const state = alarmEventState.events;
  document.querySelector("#eventResultMeta").textContent = "ION7650电压事件待接入";
  document.querySelector("#eventPageInfo").textContent = "第 1 / 1 页";
  document.querySelector("#eventPrevPageButton").disabled = true;
  document.querySelector("#eventNextPageButton").disabled = true;
  document.querySelector("#eventQueryButton").disabled = true;
  const statusNode = document.querySelector("#eventPageStatus");
  statusNode.className = `history-page-status ${state.status === "error" ? "error" : ""}`;
  statusNode.textContent = "";
  document.querySelector("#eventTableHost").innerHTML = eventTableMarkup();
}

function alarmTableMarkup() {
  const state = alarmEventState.alarms;
  if (state.status === "idle") return `<div class="history-empty-state">设置筛选条件后点击查询。</div>`;
  if (state.status === "loading") return `<div class="history-empty-state">告警加载中...</div>`;
  if (state.status === "error") return "";
  if (state.rows.length === 0) return `<div class="empty-state">当前条件下暂无告警。</div>`;

  return `<table class="history-data-table alarm-data-table">
    <thead>
      <tr>
        <th>开始时间</th>
        <th>恢复时间</th>
        <th>回路编号 / 回路名称</th>
        <th>告警项目</th>
        <th>等级</th>
        <th>状态</th>
        <th>触发值</th>
        <th>阈值</th>
        <th>确认人</th>
        <th>关闭人</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      ${state.rows.map((alarm) => `<tr>
        <td class="history-time-cell">${escapeHtml(formatNullableTime(alarm.started_at))}</td>
        <td class="history-time-cell">${escapeHtml(formatNullableTime(alarm.recovered_at))}</td>
        <td>${escapeHtml(alarmCircuitText(alarm))}</td>
        <td>${escapeHtml(alarm.title ?? "--")}</td>
        <td>${levelBadge(alarm.level)}</td>
        <td>${statusBadge(alarm.status)}</td>
        <td>${escapeHtml(formatValueWithUnit(alarm.trigger_value, alarm.trigger_unit))}</td>
        <td class="basis-cell" title="${escapeHtml(alarmBasisText(alarm))}">${escapeHtml(limitText(alarm.min_value, alarm.max_value, alarm.trigger_unit))}</td>
        <td>${escapeHtml(alarm.acknowledged_by ?? "--")}</td>
        <td>${escapeHtml(alarm.closed_by ?? "--")}</td>
        <td>${alarmActionButtons(alarm)}</td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

function eventTableMarkup() {
  return `<div class="empty-state">${EVENT_PLACEHOLDER_MESSAGE}</div>`;
}

function alarmActionButtons(alarm) {
  const canAck = alarm.status === "active";
  const canClose = alarm.status === "acknowledged" || alarm.status === "recovered";
  return `<button class="row-action-button" type="button" data-alarm-action="ack" data-alarm-id="${alarm.id}" ${canAck ? "" : "disabled"}>确认</button>
    <button class="row-action-button" type="button" data-alarm-action="close" data-alarm-id="${alarm.id}" ${canClose ? "" : "disabled"}>关闭</button>`;
}

function openAlarmActionDialog(action, alarmId) {
  const alarm = alarmEventState.alarms.rows.find((item) => String(item.id) === String(alarmId));
  if (!alarm) return;
  alarmEventState.actionType = action === "close" ? "close" : "ack";
  alarmEventState.actionAlarm = alarm;
  document.querySelector("#alarmActionTitle").textContent = alarmEventState.actionType === "close" ? "关闭告警" : "确认告警";
  document.querySelector("#alarmActionMeta").textContent = `${alarm.title ?? "告警"} / ${alarmCircuitText(alarm)} / ${formatNullableTime(alarm.started_at)}`;
  document.querySelector("#alarmActionOperator").value = "值班员";
  document.querySelector("#alarmActionNote").value = "";
  document.querySelector("#alarmActionStatus").textContent = "";
  document.querySelector("#alarmActionSubmit").disabled = false;
  document.querySelector("#alarmActionDialog").showModal();
}

async function submitAlarmAction() {
  const alarm = alarmEventState.actionAlarm;
  if (!alarm) return;
  const action = alarmEventState.actionType;
  const submitButton = document.querySelector("#alarmActionSubmit");
  const statusNode = document.querySelector("#alarmActionStatus");
  submitButton.disabled = true;
  statusNode.className = "history-page-status";
  statusNode.textContent = "正在提交...";

  try {
    const response = await fetch(topologyApiUrl(`/api/alarms/${alarm.id}/${action}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operator: document.querySelector("#alarmActionOperator").value.trim() || "值班员",
        note: document.querySelector("#alarmActionNote").value.trim(),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || "alarm action failed");
    document.querySelector("#alarmActionDialog").close();
    await loadAlarmData();
    await refreshAlarmPopupState();
  } catch {
    statusNode.className = "history-page-status error";
    statusNode.textContent = "提交失败，请确认告警状态是否允许当前操作。";
    submitButton.disabled = false;
  }
}

function levelBadge(level) {
  const key = String(level || "info").toLowerCase();
  return `<span class="level-badge level-${escapeHtml(key)}">${escapeHtml(ALARM_LEVEL_LABELS[key] ?? key)}</span>`;
}

function statusBadge(status) {
  const key = String(status || "active").toLowerCase();
  return `<span class="status-badge status-${escapeHtml(key)}">${escapeHtml(ALARM_STATUS_LABELS[key] ?? key)}</span>`;
}

function alarmDeviceText(alarm) {
  return [alarm.cabinet_id, alarm.circuit_id, alarm.meter_id].filter(Boolean).join(" / ") || "--";
}

function alarmCircuitText(alarm) {
  const topologyCircuit = findAlarmTopologyCircuit(alarm);
  if (topologyCircuit) {
    return `${topologyCircuit.internalId} / ${displayCircuitName(topologyCircuit)}`;
  }

  const circuitId = alarm.display_circuit_id ?? alarm.circuit_id;
  const circuitName = alarm.display_circuit_name ?? alarm.circuit_name;
  if (circuitId || circuitName) {
    return `${circuitId || "--"} / ${circuitName || "--"}`;
  }

  const circuit = circuits.find((item) => item.meter && item.meter === alarm.meter_id);
  if (circuit) {
    return `${circuit.internalId} / ${displayCircuitName(circuit)}`;
  }

  return alarm.meter_id ?? "--";
}

function alarmBasisText(alarm) {
  return alarm.basis || alarm.description || "未记录告警依据";
}

function findAlarmTopologyCircuit(alarm) {
  const directCircuitId = alarm.circuit_id ?? alarm.display_circuit_id;
  if (directCircuitId) {
    const direct = circuits.find((circuit) => circuit.internalId === directCircuitId || circuit.dbCircuitId === directCircuitId);
    if (direct) return direct;
  }
  if (!alarm.meter_id) return null;
  return circuits.find((circuit) => circuit.meter === alarm.meter_id) ?? null;
}

function formatNullableTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : formatBeijingDateTime(date);
}

function formatValueWithUnit(value, unit) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  const text = Number.isFinite(number) ? number.toFixed(Math.abs(number) >= 100 ? 1 : 2) : String(value);
  return `${text}${unit ? ` ${unit}` : ""}`;
}

function limitText(minValue, maxValue, unit) {
  const hasMin = minValue !== null && minValue !== undefined;
  const hasMax = maxValue !== null && maxValue !== undefined;
  if (hasMin && hasMax) return `${formatValueWithUnit(minValue, unit)} ~ ${formatValueWithUnit(maxValue, unit)}`;
  if (hasMin) return `≥ ${formatValueWithUnit(minValue, unit)}`;
  if (hasMax) return `≤ ${formatValueWithUnit(maxValue, unit)}`;
  return "--";
}

function historyTableMarkup() {
  if (historyPageState.status === "idle") {
    return `<div class="history-empty-state">选择回路、时间范围和每页条数后点击查询。</div>`;
  }
  if (historyPageState.status === "loading") {
    return `<div class="history-empty-state">数据加载中...</div>`;
  }
  if (historyPageState.status === "error") {
    return "";
  }
  if (historyPageState.rows.length === 0) {
    return `<div class="empty-state">该回路在所选时间段内暂无历史数据。</div>`;
  }

  const columns = historyPageState.columns;
  return `<table class="history-data-table">
    <thead>
      <tr>
        <th>采样时间</th>
        ${columns.map((column) => `<th>${escapeHtml(historyColumnTitle(column))}</th>`).join("")}
      </tr>
    </thead>
    <tbody>
      ${historyPageState.rows.map((row) => `<tr>
        <td class="history-time-cell">${escapeHtml(formatBeijingDateTime(new Date(row.sampleTime)))}</td>
        ${columns.map((column) => `<td>${escapeHtml(formatHistoryTableValue(row.points?.[column.code], column.unit))}</td>`).join("")}
      </tr>`).join("")}
    </tbody>
  </table>`;
}

function historyColumnTitle(column) {
  const unit = column.unit ? ` (${column.unit})` : "";
  return `${column.symbol || column.code}${unit}`;
}

function formatHistoryTableValue(point, fallbackUnit = "") {
  if (!point || point.value === null || point.value === undefined) return "--";
  const value = Number(point.value);
  const text = Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 100 ? 1 : 2) : String(point.value);
  const unit = point.unit && point.unit !== fallbackUnit ? ` ${point.unit}` : "";
  return `${text}${unit}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadTopologySvg() {
  const response = await fetch(TOPOLOGY_CONFIG.svgAsset, { cache: "no-store" });
  const svgText = await response.text();
  const host = document.querySelector("#topologySvgHost");
  host.innerHTML = svgText;
  const svg = host.querySelector("svg");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  const viewBox = TOPOLOGY_CONFIG.canvas.viewBox;
  svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  svg.setAttribute("aria-hidden", "true");
  removeStaticCurrentSamples(svg);
  removeStaticCommunicationLabels(svg);
  renderSvgCommunicationLabels(svg);
  renderSvgCurrentTexts(svg);
  renderBreakerStates(svg);
}

function renderDynamicLayers() {
  renderHotspots();
}

function removeStaticCurrentSamples(svg) {
  svg.querySelectorAll("text").forEach((node) => {
    if (node.textContent.trim() === "10.00A") {
      node.remove();
    }
  });
}

function removeStaticCommunicationLabels(svg) {
  svg.querySelectorAll("text").forEach((node) => {
    const text = node.textContent.trim();
    if (text === "通讯正常" || text === "通讯异常") {
      node.remove();
    }
  });
}

function renderSvgCommunicationLabels(svg) {
  const switchCircuits = circuits.filter((circuit) => circuit.cabinetType === "开关");
  switchCircuits.forEach((circuit) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    const position = getCommunicationLabelPosition(circuit);
    text.setAttribute("x", position.x);
    text.setAttribute("y", position.y);
    text.setAttribute("font-family", "SimSun, Microsoft YaHei, sans-serif");
    text.setAttribute("font-size", "4.4");
    text.setAttribute("font-weight", "700");
    text.setAttribute("data-communication-id", circuit.internalId);
    text.setAttribute("class", "svg-communication-state");
    svg.appendChild(text);
  });
  refreshCommunicationLabels();
}

function renderSvgCurrentTexts(svg) {
  const switchCircuits = circuits.filter((circuit) => circuit.cabinetType === "开关");
  switchCircuits.forEach((circuit) => {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("data-current-id", circuit.internalId);
    group.setAttribute("class", `svg-live-current ${circuit.meter ? "real" : "pending"}`);
    const positions = getCurrentTextPositions(circuit);
    positions.forEach(({ x, y }) => {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", x);
      text.setAttribute("y", y);
      text.setAttribute("font-family", "Consolas, SimSun, sans-serif");
      text.setAttribute("font-size", "4.7");
      text.textContent = "--.--A";
      group.appendChild(text);
    });
    svg.appendChild(group);
  });
  refreshCurrentOverlays();
}

function renderBreakerStates(svg) {
  restoreOpenBreakerDiagonals(svg);
  svg.querySelectorAll("[data-breaker-closed-line]").forEach((node) => node.remove());
  circuits
    .filter((circuit) => circuit.cabinetType === "开关")
    .forEach((circuit) => {
      if (!isCircuitConnected(circuit)) return;
      hideOpenBreakerDiagonal(svg, circuit);
      drawClosedBreakerLine(svg, circuit);
    });
}

function isCircuitConnected(circuit) {
  return Boolean(circuit.meter && circuit.switchStatus === 1);
}

function restoreOpenBreakerDiagonals(svg) {
  svg.querySelectorAll("[data-breaker-open-line]").forEach((node) => {
    const originalStroke = node.getAttribute("data-original-stroke");
    if (originalStroke) {
      node.setAttribute("stroke", originalStroke);
    } else {
      node.removeAttribute("stroke");
    }
    node.removeAttribute("data-breaker-open-line");
    node.removeAttribute("data-original-stroke");
  });
}

function hideOpenBreakerDiagonal(svg, circuit) {
  const breaker = getBreakerGeometry(circuit);
  svg.querySelectorAll("polyline").forEach((node) => {
    const points = parsePolylinePoints(node.getAttribute("points"));
    if (
      points.length === 2 &&
      near(points[0].x, breaker.openX1) &&
      near(points[0].y, breaker.openY1) &&
      near(points[1].x, breaker.openX2) &&
      near(points[1].y, breaker.y)
    ) {
      node.setAttribute("data-original-stroke", node.getAttribute("stroke") ?? "");
      node.setAttribute("data-breaker-open-line", circuit.internalId);
      node.setAttribute("stroke", "transparent");
    }
  });
}

function drawClosedBreakerLine(svg, circuit) {
  const breaker = getBreakerGeometry(circuit);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", breaker.closedX1);
  line.setAttribute("y1", breaker.y);
  line.setAttribute("x2", breaker.closedX2);
  line.setAttribute("y2", breaker.y);
  line.setAttribute("stroke", "#00ff00");
  line.setAttribute("stroke-width", "1");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  line.setAttribute("data-breaker-closed-line", circuit.internalId);
  svg.appendChild(line);
}

function getBreakerGeometry(circuit) {
  const column = getCabinetColumn(circuit);
  const y = TOPOLOGY_CONFIG.layout.breakerRows?.[circuit.sequence - 1] ?? 319.699 + (circuit.sequence - 1) * 27.887;
  return {
    y,
    openX1: column.x + 25.0367,
    openY1: y - 2.394,
    openX2: column.x + 29.1832,
    closedX1: column.x + 25.0367,
    closedX2: column.x + 29.1832,
  };
}

function parsePolylinePoints(value) {
  return (value ?? "")
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function near(a, b) {
  return Math.abs(a - b) < 0.05;
}

function renderHotspots() {
  const layer = document.querySelector("#hotspotLayer");
  layer.innerHTML = circuits.map((circuit) => {
    const box = getHotspotBox(circuit);
    const title = `${circuit.internalId} ${circuit.cabinetCode} ${displayCircuitName(circuit)} ${displaySwitchState(circuit)}`;
    return `<button
      class="hotspot"
      data-circuit-id="${circuit.internalId}"
      onclick="selectCircuit('${circuit.internalId}')"
      ondblclick="openCircuitDialog('${circuit.internalId}')"
      title="${title}"
      aria-label="${title}"
      style="${boxStyle(box)}"
    ></button>`;
  }).join("");

  layer.querySelectorAll(".hotspot").forEach((hotspot) => {
    hotspot.addEventListener("click", () => selectCircuit(hotspot.dataset.circuitId));
    hotspot.addEventListener("dblclick", () => openCircuitDialog(hotspot.dataset.circuitId));
  });
}

function getCabinetColumn(circuit) {
  const { left, width } = TOPOLOGY_CONFIG.layout.columns;
  const explicitX = TOPOLOGY_CONFIG.layout.columnX?.[circuit.cabinetCode];
  return {
    x: explicitX ?? left + circuit.cabinetIndex * width,
    width,
  };
}

function getCircuitY(circuit) {
  const rows = TOPOLOGY_CONFIG.layout.switchRows[circuit.cabinetCode];
  return rows?.[circuit.sequence - 1] ?? 360;
}

function getHotspotBox(circuit) {
  const column = getCabinetColumn(circuit);
  if (circuit.cabinetType !== "开关") {
    return {
      x: column.x + 1,
      y: 265,
      width: column.width - 2,
      height: 260,
    };
  }

  const rowY = getBreakerGeometry(circuit).y;
  return {
    x: column.x + 1,
    y: rowY - 17,
    width: column.width - 2,
    height: 34,
  };
}

function getCurrentTextPositions(circuit) {
  const column = getCabinetColumn(circuit);
  const x = column.x + 63.2;
  const rowBaseY = 313.42 + (circuit.sequence - 1) * 27.89;
  return [0, 6.93, 13.87].map((offset) => ({ x, y: rowBaseY + offset }));
}

function getCommunicationLabelPosition(circuit) {
  const column = getCabinetColumn(circuit);
  const breaker = getBreakerGeometry(circuit);
  return {
    x: column.x + 19.5,
    y: breaker.y - 5.77,
  };
}

function boxStyle(box) {
  const viewBox = TOPOLOGY_CONFIG.canvas.viewBox ?? {
    x: 0,
    y: 0,
    width: TOPOLOGY_CONFIG.canvas.width,
    height: TOPOLOGY_CONFIG.canvas.height,
  };
  return `left:${((box.x - viewBox.x) / viewBox.width) * 100}%;top:${((box.y - viewBox.y) / viewBox.height) * 100}%;width:${(box.width / viewBox.width) * 100}%;height:${(box.height / viewBox.height) * 100}%`;
}

function normalizeApiBaseUrl(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function topologyApiUrl(path) {
  return `${TOPOLOGY_API_BASE_URL}${path}`;
}

async function refreshTopologyState() {
  if (!TOPOLOGY_API_BASE_URL) return;
  try {
    const response = await fetch(topologyApiUrl("/api/topology"), { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    applyTopologyState(payload);
  } catch {
    applyTopologyState({ switches: [] });
  }
}

async function refreshRealtimeState() {
  if (!TOPOLOGY_API_BASE_URL) return;
  try {
    const response = await fetch(topologyApiUrl("/api/realtime"), { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    realtimeByMeter.clear();
    (payload.meters ?? []).forEach((item) => {
      if (item.meterId) realtimeByMeter.set(item.meterId, item);
    });
    refreshCurrentOverlays();
    refreshCommunicationLabels();
    const dialog = document.querySelector("#circuitDialog");
    if (dialog.open && selectedCircuitId && activeDialogTab === "realtime") {
      refreshOpenRealtimeDialog(findCircuit(selectedCircuitId));
    }
    refreshSubstation3dHoverPopup();
  } catch {
    realtimeByMeter.clear();
    refreshCurrentOverlays();
    refreshCommunicationLabels();
    refreshSubstation3dHoverPopup();
  }
}

async function refreshAlarmPopupState() {
  if (!TOPOLOGY_API_BASE_URL) return;
  try {
    const params = new URLSearchParams({ status: "active", page: "1", pageSize: "20" });
    const response = await fetch(topologyApiUrl(`/api/alarms?${params.toString()}`), { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) return;
    const alarms = payload.alarms ?? [];
    updateActiveAlarmCircuitMarkers(alarms);
    refreshHotspotLabels();
    if (!alarmPopupPrimed) {
      alarms.forEach((alarm) => seenActiveAlarmIds.add(String(alarm.id)));
      alarmPopupPrimed = true;
      return;
    }
    const newAlarms = alarms.filter((alarm) => {
      const id = String(alarm.id);
      if (seenActiveAlarmIds.has(id)) return false;
      seenActiveAlarmIds.add(id);
      return !dismissedAlarmToastIds.has(id);
    });
    if (newAlarms.length > 0) renderAlarmToasts(newAlarms);
  } catch {
    activeAlarmCircuitIds.clear();
    refreshHotspotLabels();
  }
}

function updateActiveAlarmCircuitMarkers(alarms) {
  activeAlarmCircuitIds.clear();
  alarms.forEach((alarm) => {
    const circuitId = alarm.circuit_id ?? alarm.display_circuit_id;
    if (!circuitId) return;
    circuits
      .filter((circuit) => circuitId === circuit.dbCircuitId || circuitId === circuit.internalId)
      .forEach((circuit) => activeAlarmCircuitIds.add(circuit.internalId));
  });
}

function renderAlarmToasts(alarms) {
  const host = document.querySelector("#alarmToastHost");
  if (!host) return;
  if (!alarms || alarms.length === 0) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = alarms.slice(0, 3).map((alarm) => `<article class="alarm-toast">
    <div class="alarm-toast-header">
      ${levelBadge(alarm.level)}
      <button class="icon-button" type="button" title="不再提示此条" aria-label="不再提示此条" data-dismiss-alarm-toast="${escapeHtml(alarm.id)}">×</button>
    </div>
    <strong>${escapeHtml(alarm.title ?? "新告警")}</strong>
    <p>${escapeHtml(alarmCircuitText(alarm))}</p>
    <p>${escapeHtml(formatValueWithUnit(alarm.trigger_value, alarm.trigger_unit))} · ${escapeHtml(formatNullableTime(alarm.started_at))}</p>
    <div class="alarm-toast-actions">
      <button class="row-action-button" type="button" data-view-alarm-page>查看告警事件页</button>
      <button class="row-action-button" type="button" data-dismiss-alarm-toast="${escapeHtml(alarm.id)}">不再提示此条</button>
    </div>
  </article>`).join("");
}

function applyTopologyState(payload) {
  latestTopologyPayload = payload ?? { switches: [] };
  const byMeter = new Map();
  const byCircuit = new Map();
  (payload.switches ?? []).forEach((item) => {
    if (item.meterId) byMeter.set(item.meterId, item);
    if (item.circuitId) byCircuit.set(item.circuitId, item);
  });

  circuits.forEach((circuit) => {
    const state = (circuit.dbCircuitId && byCircuit.get(circuit.dbCircuitId)) || (circuit.meter && byMeter.get(circuit.meter));
    const hasRealSwitch = Boolean(circuit.meter && state && state.switchStatus !== null && state.switchStatus !== undefined);
    circuit.switchStatus = hasRealSwitch ? Number(state.switchStatus) : null;
    circuit.switchQuality = hasRealSwitch ? (state.quality ?? "good") : circuit.meter ? "unknown" : "not_connected";
    circuit.switchSampleTime = hasRealSwitch ? (state.sampleTime ?? null) : null;
    circuit.breakerClosed = isCircuitConnected(circuit);
  });

  const svg = document.querySelector("#topologySvgHost svg");
  if (svg) renderBreakerStates(svg);
  refreshHotspotLabels();
  applySubstation3dState();
  refreshSubstation3dHoverPopup();
}

async function activateSubstation3dPage() {
  if (substation3dController) {
    substation3dController.resize();
    applySubstation3dState();
    return;
  }
  if (substation3dLoadingPromise) return;

  const config = TOPOLOGY_CONFIG.visualization3d ?? DEFAULT_VISUALIZATION_3D_CONFIG;
  if (!config) {
    setSubstation3dStatus("未配置三维可视化参数。", true);
    return;
  }

  substation3dLoadingPromise = import("./substation-3d.js")
    .then((module) => {
      substation3dController = module.initSubstation3dPage({
        config,
        viewport: document.querySelector("#substation3dViewport"),
        statusNode: document.querySelector("#substation3dStatus"),
        circuitListNode: document.querySelector("#substation3dCircuitList"),
        resetButton: document.querySelector("#substation3dResetButton"),
        fitButton: document.querySelector("#substation3dFitButton"),
        viewButtons: document.querySelectorAll("[data-substation-view]"),
        onCircuitSelect: selectCircuit,
        onCircuitOpen: openCircuitDialog,
        onCircuitHover: scheduleSubstation3dHoverPopup,
        onCircuitLeave: hideSubstation3dHoverPopup,
      });
      applySubstation3dState();
    })
    .catch(() => {
      setSubstation3dStatus("三维模块加载失败，请检查本地 Three.js 资源。", true);
    })
    .finally(() => {
      substation3dLoadingPromise = null;
    });
}

function applySubstation3dState() {
  if (!substation3dController) return;
  substation3dController.applyTopologyState(latestTopologyPayload);
}

function setSubstation3dStatus(text, isError = false) {
  const status = document.querySelector("#substation3dStatus");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function refreshHotspotLabels() {
  document.querySelectorAll(".hotspot").forEach((hotspot) => {
    const circuit = findCircuit(hotspot.dataset.circuitId);
    if (!circuit) return;
    const title = `${circuit.internalId} ${circuit.cabinetCode} ${displayCircuitName(circuit)} ${displaySwitchState(circuit)}`;
    hotspot.setAttribute("title", title);
    hotspot.setAttribute("aria-label", title);
    hotspot.classList.remove("alarm");
  });
}

function initZoomControls() {
  document.querySelector("#zoomOutButton").addEventListener("click", () => {
    setTopologyZoom(topologyZoom - 0.25);
  });
  document.querySelector("#zoomInButton").addEventListener("click", () => {
    setTopologyZoom(topologyZoom + 0.25);
  });
  document.querySelector("#zoomFitButton").addEventListener("click", () => {
    setTopologyZoom(1);
    document.querySelector("#topologyStage").scrollLeft = 0;
  });
  setTopologyZoom(topologyZoom);
}

function setTopologyZoom(nextZoom) {
  topologyZoom = Math.min(3, Math.max(0.75, Number(nextZoom.toFixed(2))));
  const canvas = document.querySelector("#topologyCanvas");
  const stage = document.querySelector("#topologyStage");
  const previousScrollRatio =
    stage.scrollWidth > stage.clientWidth
      ? stage.scrollLeft / (stage.scrollWidth - stage.clientWidth)
      : 0;

  canvas.style.setProperty("--topology-width", `${topologyZoom * 100}%`);
  document.querySelector("#zoomValue").textContent = `${Math.round(topologyZoom * 100)}%`;
  document.querySelector("#zoomOutButton").disabled = topologyZoom <= 0.75;
  document.querySelector("#zoomInButton").disabled = topologyZoom >= 3;

  requestAnimationFrame(() => {
    const maxScroll = Math.max(0, stage.scrollWidth - stage.clientWidth);
    stage.scrollLeft = maxScroll * previousScrollRatio;
  });
}

function selectCircuit(circuitId) {
  selectedCircuitId = circuitId;
  document.querySelectorAll(".hotspot").forEach((hotspot) => {
    hotspot.classList.toggle("selected", hotspot.dataset.circuitId === circuitId);
  });
}

function formatBeijingDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function tickRealtime() {
  realtimeSeed += 1;
  const now = new Date();
  document.querySelector("#refreshTime").textContent = formatBeijingDateTime(now);

  const dialog = document.querySelector("#circuitDialog");
  if (dialog.open && selectedCircuitId && activeDialogTab === "realtime") {
    refreshOpenRealtimeDialog(findCircuit(selectedCircuitId));
  }
  refreshCurrentOverlays();
  refreshCommunicationLabels();
  refreshSubstation3dHoverPopup();
}

function findCircuit(circuitId) {
  return circuits.find((circuit) => circuit.internalId === circuitId);
}

function openCircuitDialog(circuitId) {
  const circuit = findCircuit(circuitId);
  if (!circuit) return;
  hideSubstation3dHoverPopup();
  activeDialogTab = "realtime";
  selectCircuit(circuitId);
  renderDialogContent(circuit);
  const dialog = document.querySelector("#circuitDialog");
  if (!dialog.open) dialog.showModal();
}

function scheduleSubstation3dHoverPopup(circuitId, pointer) {
  const circuit = findCircuit(circuitId);
  if (!circuit) return;
  const dialog = document.querySelector("#circuitDialog");
  if (dialog?.open) {
    hideSubstation3dHoverPopup();
    return;
  }
  lastSubstation3dPointer = pointer ?? lastSubstation3dPointer;
  if (hoveredSubstation3dCircuitId === circuitId) {
    renderSubstation3dHoverPopup(circuitId, lastSubstation3dPointer);
    return;
  }
  if (pendingSubstation3dHoverCircuitId === circuitId) return;

  clearSubstation3dHoverTimer();
  pendingSubstation3dHoverCircuitId = circuitId;
  const popup = document.querySelector("#substation3dHoverPopup");
  if (popup) popup.hidden = true;
  substation3dHoverTimer = setTimeout(() => {
    substation3dHoverTimer = null;
    if (pendingSubstation3dHoverCircuitId !== circuitId || activePage !== "substation3d") return;
    renderSubstation3dHoverPopup(circuitId, lastSubstation3dPointer);
  }, SUBSTATION_3D_HOVER_DELAY_MS);
}

function renderSubstation3dHoverPopup(circuitId, pointer) {
  const circuit = findCircuit(circuitId);
  if (!circuit) return;
  hoveredSubstation3dCircuitId = circuitId;
  pendingSubstation3dHoverCircuitId = null;
  const popup = ensureSubstation3dHoverPopup();
  const voltageText = buildPhaseVoltages(circuit).join(" / ");
  const currentText = buildPhaseCurrents(circuit).join(" / ");
  popup.innerHTML = `
    <div class="dialog-header">
      <h2>${circuit.cabinetCode} ${displayCircuitName(circuit)}</h2>
      <p>${circuit.internalId}</p>
    </div>
    <div class="dialog-body">
      <div class="substation-3d-hover-summary">
        ${substation3dHoverRow("电压", voltageText)}
        ${substation3dHoverRow("电流", currentText)}
        ${substation3dHoverRow("开关状态", displaySwitchState(circuit))}
      </div>
    </div>`;
  popup.hidden = false;
  positionSubstation3dHoverPopup(popup, pointer);
}

function refreshSubstation3dHoverPopup() {
  if (!hoveredSubstation3dCircuitId || activePage !== "substation3d") return;
  renderSubstation3dHoverPopup(hoveredSubstation3dCircuitId, lastSubstation3dPointer);
}

function hideSubstation3dHoverPopup() {
  clearSubstation3dHoverTimer();
  hoveredSubstation3dCircuitId = null;
  pendingSubstation3dHoverCircuitId = null;
  lastSubstation3dPointer = null;
  const popup = document.querySelector("#substation3dHoverPopup");
  if (popup) popup.hidden = true;
}

function clearSubstation3dHoverTimer() {
  if (!substation3dHoverTimer) return;
  clearTimeout(substation3dHoverTimer);
  substation3dHoverTimer = null;
}

function substation3dHoverRow(label, value) {
  return `<div class="substation-3d-hover-row">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
  </div>`;
}

function ensureSubstation3dHoverPopup() {
  let popup = document.querySelector("#substation3dHoverPopup");
  if (popup) return popup;
  popup = document.createElement("div");
  popup.id = "substation3dHoverPopup";
  popup.className = "substation-3d-hover-popup";
  popup.hidden = true;
  document.body.appendChild(popup);
  return popup;
}

function positionSubstation3dHoverPopup(popup, pointer) {
  const x = pointer?.clientX ?? window.innerWidth / 2;
  const y = pointer?.clientY ?? window.innerHeight / 2;
  const margin = 14;
  popup.style.left = `${x + margin}px`;
  popup.style.top = `${y + margin}px`;
  const rect = popup.getBoundingClientRect();
  const left = rect.right > window.innerWidth - margin ? x - rect.width - margin : x + margin;
  const top = rect.bottom > window.innerHeight - margin ? y - rect.height - margin : y + margin;
  popup.style.left = `${Math.max(margin, left)}px`;
  popup.style.top = `${Math.max(margin, top)}px`;
}

function renderDialogContent(circuit) {
  const content = document.querySelector("#dialogContent");
  const realtime = circuit.meter ? buildRealtime(circuit) : null;
  const quality = realtime ? aggregateRealtimeQuality(realtime) : "not_connected";
  content.innerHTML = `
    <div class="dialog-header">
      <h2>${circuit.cabinetCode} · ${displayCircuitName(circuit)}</h2>
      <p>${circuit.internalId} / ${circuit.cabinetName} / ${circuit.cabinetType}</p>
    </div>
    <div class="dialog-tabs" role="tablist" aria-label="回路数据视图">
      <button class="dialog-tab ${activeDialogTab === "realtime" ? "active" : ""}" type="button" role="tab" aria-selected="${activeDialogTab === "realtime"}" data-dialog-tab="realtime">实时数据</button>
      <button class="dialog-tab ${activeDialogTab === "history" ? "active" : ""}" type="button" role="tab" aria-selected="${activeDialogTab === "history"}" data-dialog-tab="history">历史数据</button>
    </div>
    <div class="dialog-body">
      ${dialogKvGrid(circuit, quality)}
      ${activeDialogTab === "history" ? historyPanel(circuit) : realtime ? measurementGrid(realtime) : emptyRealtime(circuit)}
    </div>`;
  bindDialogEvents(circuit);
}

function refreshOpenRealtimeDialog(circuit) {
  if (!circuit) return;
  const realtime = circuit.meter ? buildRealtime(circuit) : null;
  const quality = realtime ? aggregateRealtimeQuality(realtime) : "not_connected";
  const kvGrid = document.querySelector("#dialogContent .kv-grid");
  if (kvGrid) kvGrid.outerHTML = dialogKvGrid(circuit, quality);
  const measurementGridNode = document.querySelector("#dialogContent .measurement-grid");
  if (measurementGridNode && realtime) {
    measurementGridNode.outerHTML = measurementGrid(realtime);
  }
}

function dialogKvGrid(circuit, quality) {
  return `<div class="kv-grid">
    ${kv("内部回路编号", circuit.internalId)}
    ${kv("绑定仪表", circuit.meter ?? "未接入")}
    ${kv("数据来源", circuit.source)}
    ${kv("开关状态", displaySwitchState(circuit))}
    ${kv("质量码", quality)}
  </div>`;
}

function bindDialogEvents(circuit) {
  document.querySelectorAll("[data-dialog-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextTab = button.dataset.dialogTab;
      if (!nextTab || nextTab === activeDialogTab) return;
      activeDialogTab = nextTab;
      renderDialogContent(circuit);
      if (nextTab === "history" && circuit.meter) {
        const state = ensureHistoryState(circuit);
        if (state.status === "idle") loadHistoryData(circuit);
      }
    });
  });

  const queryButton = document.querySelector("#historyQueryButton");
  if (queryButton) {
    queryButton.addEventListener("click", () => {
      loadHistoryData(circuit);
    });
  }
}

function historyPanel(circuit) {
  if (!circuit.meter) {
    return `<div class="empty-state">该回路未绑定仪表，无法查询历史数据。</div>`;
  }

  const state = ensureHistoryState(circuit);
  return `
    <div class="history-panel">
      <div class="history-controls">
        ${historyTimeField("开始时间", "historyStart", state.startValue)}
        ${historyTimeField("结束时间", "historyEnd", state.endValue)}
        <button id="historyQueryButton" class="history-query-button" type="button">查询</button>
      </div>
      ${historyStatus(state)}
      ${historyCharts(state)}
    </div>`;
}

function ensureHistoryState(circuit) {
  const existing = historyStateByCircuit.get(circuit.internalId);
  if (existing) return existing;

  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  const state = {
    startValue: formatBeijingInputDateTime(start),
    endValue: formatBeijingInputDateTime(end),
    status: "idle",
    message: "",
    series: [],
  };
  historyStateByCircuit.set(circuit.internalId, state);
  return state;
}

function historyStatus(state) {
  if (state.status === "loading") {
    return `<div class="history-status">正在查询历史数据...</div>`;
  }
  if (state.status === "error") {
    return `<div class="history-status error">${state.message}</div>`;
  }
  return "";
}

function historyCharts(state) {
  if (state.status !== "success") return "";

  const hasSamples = state.series.some((series) => (series.samples ?? []).some((sample) => sample.value !== null && sample.value !== undefined));
  if (!hasSamples) {
    return `<div class="empty-state">该时间范围内暂无历史数据。</div>`;
  }

  const seriesByCode = new Map(state.series.map((series) => [series.pointCode, series]));
  return `<div class="history-chart-list">
    ${HISTORY_CHART_GROUPS.map((group) => historyChartCard(group, seriesByCode)).join("")}
  </div>`;
}

function historyChartCard(group, seriesByCode) {
  return `<article class="history-chart-card">
    ${lineChartSvg(group, seriesByCode)}
  </article>`;
}

function lineChartSvg(group, seriesByCode) {
  const width = 760;
  const height = 300;
  const margin = { top: 28, right: 18, bottom: 74, left: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const allSamples = [];
  const visibleSeries = group.series.map(([code, name, symbol, color]) => {
    const series = seriesByCode.get(code) ?? { samples: [] };
    const samples = (series.samples ?? [])
      .map((sample) => ({
        time: new Date(sample.sampleTime).getTime(),
        value: Number(sample.value),
      }))
      .filter((sample) => Number.isFinite(sample.time) && Number.isFinite(sample.value));
    allSamples.push(...samples);
    return { code, name, symbol, color, unit: series.unit ?? "", samples };
  });

  if (allSamples.length === 0) {
    return `<div class="chart-empty">${group.title}暂无数据</div>`;
  }

  const minTime = Math.min(...allSamples.map((sample) => sample.time));
  const maxTime = Math.max(...allSamples.map((sample) => sample.time));
  const minValue = Math.min(...allSamples.map((sample) => sample.value));
  const maxValue = Math.max(...allSamples.map((sample) => sample.value));
  const timeSpan = Math.max(1, maxTime - minTime);
  const valuePadding = Math.max((maxValue - minValue) * 0.12, Math.abs(maxValue || 1) * 0.04, 0.1);
  const yMin = minValue === maxValue ? minValue - valuePadding : minValue - valuePadding;
  const yMax = minValue === maxValue ? maxValue + valuePadding : maxValue + valuePadding;
  const valueSpan = Math.max(0.000001, yMax - yMin);
  const x = (time) => margin.left + ((time - minTime) / timeSpan) * plotWidth;
  const y = (value) => margin.top + plotHeight - ((value - yMin) / valueSpan) * plotHeight;
  const yTicks = Array.from({ length: 5 }, (_, index) => yMin + (valueSpan * index) / 4);
  const xTicks = [minTime, minTime + timeSpan / 2, maxTime];

  return `<svg class="history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${group.title}">
    <text class="chart-title" x="${margin.left}" y="18">${group.title}</text>
    <g class="chart-grid">
      ${yTicks.map((tick) => {
        const yy = y(tick);
        return `<line x1="${margin.left}" y1="${yy}" x2="${width - margin.right}" y2="${yy}"></line>
          <text x="${margin.left - 8}" y="${yy + 4}" text-anchor="end">${formatChartNumber(tick)}</text>`;
      }).join("")}
      ${xTicks.map((tick) => {
        const xx = x(tick);
        return `<line x1="${xx}" y1="${margin.top}" x2="${xx}" y2="${margin.top + plotHeight}"></line>
          <text x="${xx}" y="${height - 52}" text-anchor="middle">${formatChartTime(tick)}</text>`;
      }).join("")}
    </g>
    <rect class="chart-plot" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}"></rect>
    <g class="chart-lines">
      ${visibleSeries.map((series) => {
        if (series.samples.length === 0) return "";
        const points = series.samples.map((sample) => `${x(sample.time).toFixed(2)},${y(sample.value).toFixed(2)}`).join(" ");
        return `<polyline points="${points}" stroke="${series.color}"></polyline>`;
      }).join("")}
    </g>
    <g class="chart-legend">
      ${visibleSeries.map((series, index) => {
        const lx = margin.left + (index % 3) * 210;
        const ly = height - 28 + Math.floor(index / 3) * 14;
        return `<circle cx="${lx}" cy="${ly - 4}" r="4" fill="${series.color}"></circle>
          <text x="${lx + 8}" y="${ly}">${series.symbol} ${series.unit || "—"}</text>`;
      }).join("")}
    </g>
  </svg>`;
}

async function loadHistoryData(circuit) {
  const state = ensureHistoryState(circuit);
  state.startValue = readHistoryTimeValue("historyStart") ?? state.startValue;
  state.endValue = readHistoryTimeValue("historyEnd") ?? state.endValue;

  const startTime = parseBeijingInputDateTime(state.startValue);
  const endTime = parseBeijingInputDateTime(state.endValue);
  if (!startTime || !endTime || startTime >= endTime) {
    state.status = "error";
    state.message = "请输入有效的起止时刻，且开始时间必须早于结束时间。";
    state.series = [];
    renderDialogContent(circuit);
    return;
  }

  const requestId = ++historyRequestId;
  state.status = "loading";
  state.message = "";
  renderDialogContent(circuit);

  try {
    const params = new URLSearchParams({
      meterId: circuit.meter,
      pointCodes: HISTORY_POINT_CODES.join(","),
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      limitPerPoint: "1000",
    });
    const response = await fetch(topologyApiUrl(`/api/history?${params.toString()}`), { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "history query failed");
    }
    if (requestId !== historyRequestId) return;
    state.status = "success";
    state.series = payload.series ?? [];
  } catch {
    if (requestId !== historyRequestId) return;
    state.status = "error";
    state.message = "历史数据查询失败，请检查时间范围和后台服务。";
    state.series = [];
  }

  if (selectedCircuitId === circuit.internalId && activeDialogTab === "history") {
    renderDialogContent(circuit);
  }
}

function formatBeijingInputDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function historyTimeField(label, prefix, value) {
  const date = historyDatePart(value);
  const hour = historyHourPart(value);
  const minute = historyMinutePart(value);
  return `<label class="history-time-field">
    <span>${label}</span>
    <div class="history-time-control">
      <input id="${prefix}Date" type="date" value="${date}" />
      <select id="${prefix}Hour" aria-label="${label}小时">${timeOptions(24, hour)}</select>
      <span class="history-time-separator">:</span>
      <select id="${prefix}Minute" aria-label="${label}分钟">${timeOptions(60, minute)}</select>
    </div>
  </label>`;
}

function timeOptions(count, selectedValue) {
  return Array.from({ length: count }, (_, index) => {
    const value = String(index).padStart(2, "0");
    return `<option value="${value}" ${value === selectedValue ? "selected" : ""}>${value}</option>`;
  }).join("");
}

function historyDatePart(value) {
  return String(value || "").slice(0, 10);
}

function historyHourPart(value) {
  return String(value || "").slice(11, 13) || "00";
}

function historyMinutePart(value) {
  return String(value || "").slice(14, 16) || "00";
}

function readHistoryTimeValue(prefix) {
  const date = document.querySelector(`#${prefix}Date`)?.value;
  const hour = document.querySelector(`#${prefix}Hour`)?.value;
  const minute = document.querySelector(`#${prefix}Minute`)?.value;
  if (!date || !hour || !minute) return null;
  return `${date}T${hour}:${minute}`;
}

function parseBeijingInputDateTime(value) {
  if (!value) return null;
  const text = String(value).length === 16 ? `${value}:00+08:00` : `${value}+08:00`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatChartNumber(value) {
  const absolute = Math.abs(value);
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatChartTime(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "--";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "--";
  return `${hour}:${minute}`;
}

function displayCircuitName(circuit) {
  if (circuit.displayName !== "/") return circuit.displayName;
  if (circuit.cabinetType === "主进线") return "主进线";
  if (circuit.cabinetType === "母联") return "母联";
  if (circuit.cabinetType === "补偿") return "补偿回路";
  return "单回路";
}

function displaySwitchState(circuit) {
  if (!circuit.meter) return "断路（未接入）";
  if (circuit.switchStatus === 1) return "通路";
  if (circuit.switchStatus === 0) return "断路";
  return "断路（未收到开关量）";
}

function kv(label, value) {
  return `<div class="kv"><span>${label}</span><strong>${value}</strong></div>`;
}

function buildRealtime(circuit) {
  const meterRealtime = circuit.meter ? realtimeByMeter.get(circuit.meter) : null;
  if (!meterRealtime) return null;
  const points = meterRealtime.points ?? {};
  return [
    measurement("A相电压", "Ua", points.ua, "V"),
    measurement("AB线电压", "Uab", points.uab, "V"),
    measurement("A相电流", "Ia", points.ia, "A"),
    measurement("有功功率", "P", points.p_total, "W"),
    measurement("功率因数", "PF", points.pf_total, "—"),
    measurement("B相电压", "Ub", points.ub, "V"),
    measurement("CB线电压", "Ucb", points.ubc, "V"),
    measurement("B相电流", "Ib", points.ib, "A"),
    measurement("无功功率", "Q", points.q_total, "var"),
    measurement("频率", "f", points.frequency, "Hz"),
    measurement("C相电压", "Uc", points.uc, "V"),
    measurement("AC线电压", "Uac", points.uac, "V"),
    measurement("C相电流", "Ic", points.ic, "A"),
    measurement("视在功率", "S", points.s_total, "VA"),
    measurement("电度", "Ep", points.ep_import, "kWh"),
    measurement("电压不平衡度", "Uunb", points.voltage_unbalance, "%"),
    measurement("电流不平衡度", "Iunb", points.current_unbalance, "%"),
  ];
}

function buildPhaseCurrents(circuit) {
  const meterRealtime = circuit.meter ? realtimeByMeter.get(circuit.meter) : null;
  if (!meterRealtime) {
    return ["--.--A", "--.--A", "--.--A"];
  }
  const points = meterRealtime.points ?? {};
  return [
    formatPoint(points.ia, "A"),
    formatPoint(points.ib, "A"),
    formatPoint(points.ic, "A"),
  ];
}

function buildPhaseVoltages(circuit) {
  const meterRealtime = circuit.meter ? realtimeByMeter.get(circuit.meter) : null;
  if (!meterRealtime) {
    return ["--.--V", "--.--V", "--.--V"];
  }
  const points = meterRealtime.points ?? {};
  return [
    formatPoint(points.ua, "V"),
    formatPoint(points.ub, "V"),
    formatPoint(points.uc, "V"),
  ];
}

function refreshCurrentOverlays() {
  document.querySelectorAll("[data-current-id]").forEach((node) => {
    const circuit = findCircuit(node.dataset.currentId);
    if (!circuit) return;
    const [ia, ib, ic] = buildPhaseCurrents(circuit);
    const values = [ia, ib, ic];
    node.querySelectorAll("text").forEach((text, index) => {
      text.textContent = values[index] ?? "--.--A";
    });
  });
}

function refreshCommunicationLabels() {
  document.querySelectorAll("[data-communication-id]").forEach((node) => {
    const circuit = findCircuit(node.dataset.communicationId);
    if (!circuit) return;
    const isNormal = hasRealtimeData(circuit);
    node.textContent = isNormal ? "通讯正常" : "通讯异常";
    node.classList.toggle("normal", isNormal);
    node.classList.toggle("abnormal", !isNormal);
  });
}

function hasRealtimeData(circuit) {
  if (!circuit.meter) return false;
  const meterRealtime = realtimeByMeter.get(circuit.meter);
  if (!meterRealtime) return false;
  const points = Object.values(meterRealtime.points ?? {});
  return points.some((point) => point?.value !== null && point?.value !== undefined);
}

function measurementGrid(items) {
  return `<div class="measurement-grid">
    ${items.map((item) => `<div class="measurement">
      <span class="measurement-name">${item.name}</span>
      <em class="measurement-symbol">${item.symbol}</em>
      <strong class="measurement-reading">
        <span class="measurement-value">${item.value}</span>
        <small class="measurement-unit">${item.unit}</small>
      </strong>
    </div>`).join("")}
  </div>`;
}

function measurement(name, symbol, point, fallbackUnit) {
  return {
    name,
    symbol,
    ...formatMeasurement(point, fallbackUnit),
  };
}

function formatMeasurement(point, fallbackUnit = "") {
  const unit = point?.unit ?? fallbackUnit;
  if (!point || point.value === null || point.value === undefined) {
    return {
      value: "--",
      unit: unit || "—",
    };
  }

  const value = Number(point.value);
  return {
    value: Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 100 ? 1 : 2) : String(point.value),
    unit: unit || "—",
  };
}

function formatPoint(point, fallbackUnit = "") {
  if (!point || point.value === null || point.value === undefined) return "--";
  const value = Number(point.value);
  const text = Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 100 ? 1 : 2) : String(point.value);
  const unit = point.unit ?? fallbackUnit;
  return `${text}${unit ? ` ${unit}` : ""}`;
}

function aggregateRealtimeQuality(items) {
  if (items.every((item) => item.value === "--")) return "unknown";
  return "from_database";
}

function emptyRealtime(circuit) {
  return `<div class="empty-state">
    ${circuit.cabinetCode} ${displayCircuitName(circuit)} 当前未绑定仪表，系统保留回路编号和交互入口，但不显示伪造实时采集值。
  </div>`;
}

if (typeof document !== "undefined") {
  globalThis.selectCircuit = selectCircuit;
  globalThis.openCircuitDialog = openCircuitDialog;
  init();
}
