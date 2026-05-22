const NAV_ITEMS = [
  ["overview", "低压组态监测", "P0"],
  ["history", "历史曲线", "P0"],
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
  renderNavigation();
  renderSummary();
  await loadTopologySvg();
  renderDynamicLayers();
  refreshTopologyState();
  refreshRealtimeState();
  initZoomControls();
  tickRealtime();
  setInterval(tickRealtime, 2000);
  setInterval(refreshTopologyState, 2000);
  setInterval(refreshRealtimeState, 2000);
}

function initCollectorStatusIndicator() {
  const status = document.querySelector("#collectorStatus");
  if (!status) return;

  const syncStatusClass = () => {
    const isOffline = status.textContent.includes("离线");
    status.classList.toggle("offline", isOffline);
    status.classList.toggle("online", !isOffline);
  };

  syncStatusClass();
  new MutationObserver(syncStatusClass).observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
  });
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
  document.querySelector("#overviewPage").classList.toggle("page-active", isOverview);
  document.querySelector("#placeholderPage").classList.toggle("page-active", !isOverview);
  const label = NAV_ITEMS.find(([key]) => key === page)?.[1] ?? "低压组态监测";
  document.querySelector("#pageTitle").textContent = label;

  if (!isOverview) {
    document.querySelector("#placeholderTitle").textContent = label;
    document.querySelector("#placeholderBody").textContent = PLACEHOLDER_COPY[page] ?? "";
  }
}

function renderSummary() {
  const boundCount = circuits.filter((circuit) => circuit.meter).length;
  document.querySelector("#circuitCount").textContent = circuits.length;
  document.querySelector("#boundCount").textContent = boundCount;
  document.querySelector("#unboundCount").textContent = circuits.length - boundCount;
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
    if (dialog.open && selectedCircuitId) {
      renderDialogContent(findCircuit(selectedCircuitId));
    }
  } catch {
    realtimeByMeter.clear();
    refreshCurrentOverlays();
    refreshCommunicationLabels();
  }
}

function applyTopologyState(payload) {
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
}

function refreshHotspotLabels() {
  document.querySelectorAll(".hotspot").forEach((hotspot) => {
    const circuit = findCircuit(hotspot.dataset.circuitId);
    if (!circuit) return;
    const title = `${circuit.internalId} ${circuit.cabinetCode} ${displayCircuitName(circuit)} ${displaySwitchState(circuit)}`;
    hotspot.setAttribute("title", title);
    hotspot.setAttribute("aria-label", title);
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
  if (dialog.open && selectedCircuitId) {
    renderDialogContent(findCircuit(selectedCircuitId));
  }
  refreshCurrentOverlays();
  refreshCommunicationLabels();
}

function findCircuit(circuitId) {
  return circuits.find((circuit) => circuit.internalId === circuitId);
}

function openCircuitDialog(circuitId) {
  const circuit = findCircuit(circuitId);
  if (!circuit) return;
  selectCircuit(circuitId);
  renderDialogContent(circuit);
  document.querySelector("#circuitDialog").showModal();
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
    <div class="dialog-body">
      <div class="kv-grid">
        ${kv("内部回路编号", circuit.internalId)}
        ${kv("绑定仪表", circuit.meter ?? "未接入")}
        ${kv("数据来源", circuit.source)}
        ${kv("开关状态", displaySwitchState(circuit))}
        ${kv("质量码", quality)}
      </div>
      ${realtime ? measurementGrid(realtime) : emptyRealtime(circuit)}
    </div>`;
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
    ["Uab", formatPoint(points.uab)],
    ["Ia", formatPoint(points.ia)],
    ["Ib", formatPoint(points.ib)],
    ["Ic", formatPoint(points.ic)],
    ["P", formatPoint(points.p_total)],
    ["PF", formatPoint(points.pf_total)],
    ["f", formatPoint(points.frequency)],
    ["不平衡", formatPoint(points.current_unbalance)],
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
    ${items.map(([label, value]) => `<div class="measurement"><span>${label}</span><strong>${value}</strong></div>`).join("")}
  </div>`;
}

function formatPoint(point, fallbackUnit = "") {
  if (!point || point.value === null || point.value === undefined) return "--";
  const value = Number(point.value);
  const text = Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 100 ? 1 : 2) : String(point.value);
  const unit = point.unit ?? fallbackUnit;
  return `${text}${unit ? ` ${unit}` : ""}`;
}

function aggregateRealtimeQuality(items) {
  const values = items.map(([, value]) => value);
  if (values.every((value) => value === "--")) return "unknown";
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
