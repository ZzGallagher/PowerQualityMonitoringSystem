from __future__ import annotations

import queue
import threading
import time
import tkinter as tk
from collections import deque
from dataclasses import dataclass, field, replace
from datetime import datetime
from tkinter import ttk

from .config import AppConfig, BusConfig, MeterConfig, load_config, serial_for_bus_meter
from .core import quality
from .core.decoder import PointValue, decode_points
from .core.modbus import ModbusCrcError, ModbusError, ModbusParseError
from .core.packet import PacketFactory
from .core.point_table import PointTable, load_point_table
from .core.processing import DataProcessor
from .platform.cache import PacketCache
from .platform.mock_source import MockSource
from .platform.sender import HttpPacketSender
from .platform.serial_rtu import SerialRtuClient, SerialTimeoutError
from .service import StatsWindow


GOOD_DEVICE_STATUSES = {quality.GOOD, quality.SIMULATED}
BAD_DEVICE_STATUSES = {quality.TIMEOUT, quality.CRC_ERROR, quality.PARSE_ERROR, "offline"}


@dataclass
class MeterRuntime:
    meter: MeterConfig
    bus: BusConfig
    table: PointTable
    packet_factory: PacketFactory
    processor: DataProcessor
    stats: StatsWindow = field(default_factory=StatsWindow)
    mock_source: MockSource | None = None
    last_points: list[PointValue] = field(default_factory=list)
    last_status: str = "not_sampled"
    last_error: str = ""
    last_timestamp: datetime | None = None
    communication_online: bool = True


@dataclass(frozen=True)
class MeterDisplayUpdate:
    meter: MeterConfig
    bus: BusConfig
    status: str
    error: str
    timestamp: datetime | None
    points: list[PointValue]


@dataclass(frozen=True)
class GuiRuntimeSnapshot:
    meters: list[MeterDisplayUpdate]
    alarms: list[dict[str, object]]
    online_count: int
    abnormal_count: int
    cache_count: int
    send_status: str
    updated_at: datetime


class GuiRuntimeController:
    def __init__(self, config: AppConfig, mode: str | None = None) -> None:
        self.config = config
        self.mode = (mode or config.mode).lower()
        self.cache = PacketCache(config.cache.sqlite_path, config.cache.max_packets)
        self.sender = HttpPacketSender(config.receiver)
        self.alarm_history: deque[dict[str, object]] = deque(maxlen=500)
        self.last_send_status = "尚未发送"
        self._lock = threading.Lock()
        self._meters = [self._build_runtime(meter) for meter in config.enabled_meters]

    @property
    def meter_runtimes(self) -> list[MeterRuntime]:
        return list(self._meters)

    def poll_once(self) -> GuiRuntimeSnapshot:
        with self._lock:
            updates = [self._poll_meter(runtime) for runtime in self._meters]
            self._drain_cache()
            return self._snapshot(updates)

    def _build_runtime(self, meter: MeterConfig) -> MeterRuntime:
        bus = self.config.bus_for_meter(meter)
        table = load_point_table(meter.point_table_path or self.config.point_table_path)
        runtime = MeterRuntime(
            meter=meter,
            bus=bus,
            table=table,
            packet_factory=PacketFactory(self.config.station, self.config.gateway, meter.as_packet_meter()),
            processor=DataProcessor(self.config.thresholds),
        )
        runtime.mock_source = MockSource(table)
        return runtime

    def _poll_meter(self, runtime: MeterRuntime) -> MeterDisplayUpdate:
        timestamp = datetime.now().astimezone()
        try:
            blocks, read_errors = self._read_blocks(runtime)
            default_quality = quality.SIMULATED if self.mode == "mock" else quality.GOOD
            decoded = decode_points(runtime.table, blocks, timestamp, default_quality=default_quality)
            processed = runtime.processor.process(decoded, timestamp)
            status = quality.SIMULATED if self.mode == "mock" else quality.GOOD
            error = ""
            if read_errors:
                status = read_errors[0][1]
                error = "; ".join(f"{block_id}: {message}" for block_id, _, message in read_errors)

            runtime.last_points = processed.points
            runtime.last_status = status
            runtime.last_error = error
            runtime.last_timestamp = timestamp
            self._handle_comm_status(runtime, timestamp, status, error)
            self._send_or_cache(runtime.packet_factory.realtime(processed.points, timestamp))
            runtime.stats.add(processed.points)
            if processed.alarms:
                self._record_alarms(runtime, processed.alarms)
                self._send_or_cache(runtime.packet_factory.alarm(processed.alarms, timestamp))
            if runtime.stats.due(self.config.collection.statistics_window_seconds):
                stats = runtime.stats.flush()
                if stats:
                    self._send_or_cache(runtime.packet_factory.statistics(stats, timestamp))
        except Exception as exc:
            status = _status_from_exception(exc)
            error = str(exc)
            runtime.last_status = status
            runtime.last_error = error
            runtime.last_timestamp = timestamp
            self._handle_comm_status(runtime, timestamp, status, error)

        return MeterDisplayUpdate(
            meter=runtime.meter,
            bus=runtime.bus,
            status=runtime.last_status,
            error=runtime.last_error,
            timestamp=runtime.last_timestamp,
            points=list(runtime.last_points),
        )

    def _read_blocks(self, runtime: MeterRuntime) -> tuple[dict[str, list[int]], list[tuple[str, str, str]]]:
        if self.mode == "mock":
            if runtime.mock_source is None:
                runtime.mock_source = MockSource(runtime.table)
            return runtime.mock_source.read_all_blocks(), []
        return self._read_serial_blocks(runtime)

    def _read_serial_blocks(self, runtime: MeterRuntime) -> tuple[dict[str, list[int]], list[tuple[str, str, str]]]:
        client = SerialRtuClient(serial_for_bus_meter(runtime.bus, runtime.meter))
        try:
            blocks: dict[str, list[int]] = {}
            errors: list[tuple[str, str, str]] = []
            for block in runtime.table.enabled_read_blocks:
                try:
                    blocks[block.id] = client.read_holding_registers(block.start_address, block.quantity)
                except Exception as exc:
                    errors.append((block.id, _status_from_exception(exc), str(exc)))
            return blocks, errors
        finally:
            client.close()

    def _send_or_cache(self, packet: dict[str, object]) -> None:
        result = self.sender.send_packet(packet)
        packet_type = str(packet.get("packetType", ""))
        if result.ok:
            self.last_send_status = f"{packet_type} 发送成功"
            return
        self.cache.enqueue(packet)
        self.last_send_status = f"{packet_type} 发送失败，已缓存：{result.error or result.status_code}"

    def _drain_cache(self) -> None:
        for packet_id, packet in self.cache.peek(limit=20):
            result = self.sender.send_packet(packet)
            if result.ok:
                self.cache.delete(packet_id)
                self.last_send_status = "缓存补传成功"
            else:
                self.cache.mark_failed(packet_id, result.error)
                break

    def _handle_comm_status(self, runtime: MeterRuntime, timestamp: datetime, status: str, error: str) -> None:
        online = status in GOOD_DEVICE_STATUSES
        if online and not runtime.communication_online:
            runtime.communication_online = True
            self._send_or_cache(runtime.packet_factory.comm_status(timestamp, "online", "communication recovered"))
            return
        if not online and runtime.communication_online:
            runtime.communication_online = False
            self._send_or_cache(runtime.packet_factory.comm_status(timestamp, status, error or status))

    def _record_alarms(self, runtime: MeterRuntime, alarms: list[dict[str, object]]) -> None:
        for alarm in alarms:
            display = dict(alarm)
            display["meterId"] = runtime.meter.id
            display["meterName"] = runtime.meter.name
            display["reason"] = _alarm_reason(alarm)
            self.alarm_history.appendleft(display)

    def _snapshot(self, updates: list[MeterDisplayUpdate]) -> GuiRuntimeSnapshot:
        online_count = sum(1 for update in updates if update.status in GOOD_DEVICE_STATUSES)
        abnormal_count = sum(1 for update in updates if update.status in BAD_DEVICE_STATUSES)
        return GuiRuntimeSnapshot(
            meters=updates,
            alarms=list(self.alarm_history),
            online_count=online_count,
            abnormal_count=abnormal_count,
            cache_count=self.cache.count(),
            send_status=self.last_send_status,
            updated_at=datetime.now().astimezone(),
        )


class MeterMonitorApp:
    def __init__(self, config: AppConfig, mode: str | None = None) -> None:
        self.config = config
        self.mode = "serial"
        self.controller = GuiRuntimeController(config, self.mode)
        self.root = tk.Tk()
        self.root.title("软件1 AMC采集处理与数据打包主界面")
        self.root.geometry("1280x760")
        self._running = False
        self._worker: threading.Thread | None = None
        self._queue: queue.Queue[tuple[str, object]] = queue.Queue()
        self._meter_views: dict[str, dict[str, object]] = {}
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(200, self._drain_queue)
        self.root.after(1000, self._tick_clock)
        self.root.after(300, self._start)

    def run(self) -> None:
        self.root.mainloop()

    def _build_ui(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(2, weight=1)
        self._build_overview()
        self._build_controls()
        self.notebook = ttk.Notebook(self.root)
        self.notebook.grid(row=2, column=0, sticky="nsew", padx=10, pady=(4, 10))
        self._build_tabs()

    def _build_overview(self) -> None:
        overview = ttk.Frame(self.root, padding=(10, 10, 10, 4))
        overview.grid(row=0, column=0, sticky="ew")
        for column in range(8):
            overview.columnconfigure(column, weight=1 if column % 2 else 0)

        self.station_id_var = tk.StringVar(value=str(self.config.station.get("id", "-")))
        self.station_name_var = tk.StringVar(value=str(self.config.station.get("name", "-")))
        self.current_time_var = tk.StringVar(value="-")
        self.mode_var = tk.StringVar(value=_mode_text(self.mode))
        self.running_status_var = tk.StringVar(value="未启动")
        self.online_count_var = tk.StringVar(value="0")
        self.abnormal_count_var = tk.StringVar(value="0")
        self.cache_count_var = tk.StringVar(value="0")
        self.send_status_var = tk.StringVar(value=_initial_send_status(self.mode))
        self.updated_var = tk.StringVar(value="-")

        items = [
            ("站点编号", self.station_id_var),
            ("站点名称", self.station_name_var),
            ("当前时间", self.current_time_var),
            ("运行模式", self.mode_var),
            ("运行状态", self.running_status_var),
            ("在线设备", self.online_count_var),
            ("异常设备", self.abnormal_count_var),
            ("缓存数量", self.cache_count_var),
            ("发送状态", self.send_status_var),
        ]
        for index, (label, variable) in enumerate(items):
            row = index // 4
            column = (index % 4) * 2
            ttk.Label(overview, text=label).grid(row=row, column=column, sticky="w", padx=(0, 6), pady=2)
            ttk.Label(overview, textvariable=variable).grid(row=row, column=column + 1, sticky="w", padx=(0, 18), pady=2)

    def _build_controls(self) -> None:
        controls = ttk.Frame(self.root, padding=(10, 4, 10, 4))
        controls.grid(row=1, column=0, sticky="ew")
        controls.columnconfigure(8, weight=1)
        self.start_button = ttk.Button(controls, text="启动", command=self._start)
        self.start_button.grid(row=0, column=0, sticky="w")
        self.stop_button = ttk.Button(controls, text="停止", command=self._stop, state="disabled")
        self.stop_button.grid(row=0, column=1, sticky="w", padx=(8, 0))
        ttk.Button(controls, text="单次读取", command=self._read_once).grid(row=0, column=2, sticky="w", padx=(8, 0))
        ttk.Button(controls, text="重新加载配置", command=self._reload_config).grid(row=0, column=3, sticky="w", padx=(8, 0))
        ttk.Label(controls, text="刷新周期(s)").grid(row=0, column=4, sticky="w", padx=(18, 6))
        self.interval_var = tk.StringVar(value=f"{self.config.collection.poll_interval_seconds:g}")
        ttk.Entry(controls, textvariable=self.interval_var, width=8).grid(row=0, column=5, sticky="w")
        ttk.Label(controls, text="最近刷新").grid(row=0, column=6, sticky="w", padx=(18, 6))
        ttk.Label(controls, textvariable=self.updated_var).grid(row=0, column=7, sticky="w")

    def _build_tabs(self) -> None:
        for tab in self.notebook.tabs():
            self.notebook.forget(tab)
        self._meter_views.clear()
        for runtime in self.controller.meter_runtimes:
            self._build_meter_tab(runtime)
        self._build_alarm_tab()

    def _build_meter_tab(self, runtime: MeterRuntime) -> None:
        frame = ttk.Frame(self.notebook, padding=(8, 8, 8, 8))
        frame.rowconfigure(1, weight=1)
        frame.columnconfigure(0, weight=1)
        self.notebook.add(frame, text=f"{runtime.meter.name}/{runtime.meter.id}")

        status = ttk.Frame(frame)
        status.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        for column in range(12):
            status.columnconfigure(column, weight=1 if column % 2 else 0)

        vars_for_meter = {
            "status": tk.StringVar(value="未采样"),
            "time": tk.StringVar(value="-"),
            "error": tk.StringVar(value="-"),
        }
        info = [
            ("仪表编号", runtime.meter.id),
            ("仪表名称", runtime.meter.name),
            ("型号", runtime.meter.model),
            ("串口", runtime.bus.port),
            ("从站地址", str(runtime.meter.slave_id)),
            ("通信状态", vars_for_meter["status"]),
            ("最近采样", vars_for_meter["time"]),
            ("失败原因", vars_for_meter["error"]),
        ]
        for index, (label, value) in enumerate(info):
            row = index // 4
            column = (index % 4) * 2
            ttk.Label(status, text=label).grid(row=row, column=column, sticky="w", padx=(0, 6), pady=2)
            if isinstance(value, tk.StringVar):
                ttk.Label(status, textvariable=value).grid(row=row, column=column + 1, sticky="w", padx=(0, 16), pady=2)
            else:
                ttk.Label(status, text=value).grid(row=row, column=column + 1, sticky="w", padx=(0, 16), pady=2)

        tree = self._make_tree(
            frame,
            ("code", "name", "value", "unit", "quality", "raw", "timestamp"),
            {
                "code": "点位编码",
                "name": "名称",
                "value": "值",
                "unit": "单位",
                "quality": "质量码",
                "raw": "原始值",
                "timestamp": "时间戳",
            },
            {
                "code": 130,
                "name": 220,
                "value": 120,
                "unit": 70,
                "quality": 110,
                "raw": 100,
                "timestamp": 220,
            },
            row=1,
        )
        self._meter_views[runtime.meter.id] = {"tree": tree, **vars_for_meter}

    def _build_alarm_tab(self) -> None:
        frame = ttk.Frame(self.notebook, padding=(8, 8, 8, 8))
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)
        self.notebook.add(frame, text="告警信息")
        self.alarm_tree = self._make_tree(
            frame,
            ("type", "state", "meter", "point", "reason", "value", "limit", "timestamp"),
            {
                "type": "告警类型",
                "state": "状态",
                "meter": "仪表",
                "point": "点位",
                "reason": "原因",
                "value": "当前值",
                "limit": "阈值",
                "timestamp": "时间",
            },
            {
                "type": 100,
                "state": 90,
                "meter": 160,
                "point": 160,
                "reason": 360,
                "value": 120,
                "limit": 160,
                "timestamp": 220,
            },
            row=0,
        )

    def _make_tree(
        self,
        parent: ttk.Frame,
        columns: tuple[str, ...],
        headings: dict[str, str],
        widths: dict[str, int],
        row: int,
    ) -> ttk.Treeview:
        tree = ttk.Treeview(parent, columns=columns, show="headings")
        for column in columns:
            tree.heading(column, text=headings[column])
            tree.column(column, width=widths[column], anchor="w")
        tree.grid(row=row, column=0, sticky="nsew")
        y_scroll = ttk.Scrollbar(parent, orient="vertical", command=tree.yview)
        y_scroll.grid(row=row, column=1, sticky="ns")
        x_scroll = ttk.Scrollbar(parent, orient="horizontal", command=tree.xview)
        x_scroll.grid(row=row + 1, column=0, sticky="ew")
        tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)
        return tree

    def _start(self) -> None:
        if self._running:
            return
        self._running = True
        self.running_status_var.set("运行中")
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self._worker = threading.Thread(target=self._poll_loop, daemon=True)
        self._worker.start()

    def _stop(self) -> None:
        self._running = False
        self.running_status_var.set("已停止")
        self.start_button.configure(state="normal")
        self.stop_button.configure(state="disabled")

    def _read_once(self) -> None:
        threading.Thread(target=self._sample_once, daemon=True).start()

    def _reload_config(self) -> None:
        was_running = self._running
        self._stop()
        try:
            loaded = load_config(self.config.source_path)
            self.config = _with_runtime_mode(loaded, self.mode)
            self.controller = GuiRuntimeController(self.config, self.mode)
            self.station_id_var.set(str(self.config.station.get("id", "-")))
            self.station_name_var.set(str(self.config.station.get("name", "-")))
            self.mode_var.set(_mode_text(self.mode))
            self.interval_var.set(f"{self.config.collection.poll_interval_seconds:g}")
            self._build_tabs()
            self.send_status_var.set(_initial_send_status(self.mode))
            self.cache_count_var.set("0")
            self.online_count_var.set("0")
            self.abnormal_count_var.set("0")
        except Exception as exc:
            self.running_status_var.set(f"配置加载失败：{exc}")
        if was_running:
            self._start()

    def _poll_loop(self) -> None:
        while self._running:
            started = time.monotonic()
            self._sample_once()
            elapsed = time.monotonic() - started
            time.sleep(max(0.1, self._interval_seconds() - elapsed))

    def _sample_once(self) -> None:
        try:
            self._queue.put(("snapshot", self.controller.poll_once()))
        except Exception as exc:
            self._queue.put(("error", str(exc)))

    def _drain_queue(self) -> None:
        try:
            while True:
                kind, payload = self._queue.get_nowait()
                if kind == "snapshot":
                    self._show_snapshot(payload)  # type: ignore[arg-type]
                elif kind == "error":
                    self.running_status_var.set("异常")
                    self.send_status_var.set(str(payload))
        except queue.Empty:
            pass
        self.root.after(200, self._drain_queue)

    def _show_snapshot(self, snapshot: GuiRuntimeSnapshot) -> None:
        self.online_count_var.set(str(snapshot.online_count))
        self.abnormal_count_var.set(str(snapshot.abnormal_count))
        self.cache_count_var.set(str(snapshot.cache_count))
        self.send_status_var.set(snapshot.send_status)
        self.updated_var.set(snapshot.updated_at.strftime("%Y-%m-%d %H:%M:%S"))
        self.running_status_var.set("运行中" if self._running else "已停止")

        for update in snapshot.meters:
            view = self._meter_views.get(update.meter.id)
            if view is None:
                continue
            view["status"].set(update.status)  # type: ignore[index,union-attr]
            view["time"].set(_format_time(update.timestamp))  # type: ignore[index,union-attr]
            view["error"].set(update.error or "-")  # type: ignore[index,union-attr]
            tree = view["tree"]  # type: ignore[index]
            self._replace_meter_rows(tree, update.points)  # type: ignore[arg-type]
        self._replace_alarm_rows(snapshot.alarms)

    def _replace_meter_rows(self, tree: ttk.Treeview, points: list[PointValue]) -> None:
        for item in tree.get_children():
            tree.delete(item)
        for point in points:
            tree.insert(
                "",
                "end",
                values=(
                    point.code,
                    point.name,
                    "" if point.value is None else point.value,
                    point.unit,
                    point.quality,
                    "" if point.raw_value is None else point.raw_value,
                    point.timestamp,
                ),
            )

    def _replace_alarm_rows(self, alarms: list[dict[str, object]]) -> None:
        for item in self.alarm_tree.get_children():
            self.alarm_tree.delete(item)
        for alarm in alarms:
            self.alarm_tree.insert(
                "",
                "end",
                values=(
                    str(alarm.get("severity", "warning")),
                    _alarm_state_text(str(alarm.get("state", ""))),
                    f"{alarm.get('meterName', '')}/{alarm.get('meterId', '')}",
                    f"{alarm.get('name', '')}({alarm.get('code', '')})",
                    str(alarm.get("reason", alarm.get("basis", ""))),
                    _value_with_unit(alarm.get("value"), alarm.get("unit")),
                    _limit_text(alarm.get("min"), alarm.get("max"), alarm.get("unit")),
                    str(alarm.get("timestamp", "")),
                ),
            )

    def _tick_clock(self) -> None:
        self.current_time_var.set(time.strftime("%Y-%m-%d %H:%M:%S"))
        self.root.after(1000, self._tick_clock)

    def _interval_seconds(self) -> float:
        try:
            return max(0.5, float(self.interval_var.get()))
        except ValueError:
            return max(0.5, self.config.collection.poll_interval_seconds)

    def _on_close(self) -> None:
        self._running = False
        self.root.destroy()


def run_gui(config: AppConfig, mode: str | None = None) -> None:
    app = MeterMonitorApp(_with_runtime_mode(config, "serial"), "serial")
    app.run()


def _with_runtime_mode(config: AppConfig, mode: str | None) -> AppConfig:
    if not mode or mode == config.mode:
        return config
    return replace(
        config,
        mode=mode,
        serial=serial_for_bus_meter(config.buses[0], config.meters[0]) if config.buses and config.meters else config.serial,
    )


def _status_from_exception(exc: Exception) -> str:
    if isinstance(exc, SerialTimeoutError):
        return quality.TIMEOUT
    if isinstance(exc, ModbusCrcError):
        return quality.CRC_ERROR
    if isinstance(exc, (ModbusParseError, ModbusError)):
        return quality.PARSE_ERROR
    return "offline"


def _alarm_reason(alarm: dict[str, object]) -> str:
    value = alarm.get("value")
    unit = str(alarm.get("unit", ""))
    low = alarm.get("min")
    high = alarm.get("max")
    name = str(alarm.get("name", alarm.get("code", "")))
    basis = str(alarm.get("basis", ""))
    if isinstance(value, (int, float)) and isinstance(high, (int, float)) and value > high:
        return f"{name} {_value_with_unit(value, unit)} > {_value_with_unit(high, unit)}；{basis}"
    if isinstance(value, (int, float)) and isinstance(low, (int, float)) and value < low:
        return f"{name} {_value_with_unit(value, unit)} < {_value_with_unit(low, unit)}；{basis}"
    return basis


def _alarm_state_text(state: str) -> str:
    if state == "active":
        return "当前告警"
    if state == "cleared":
        return "已恢复"
    return state or "-"


def _limit_text(low: object, high: object, unit: object) -> str:
    unit_text = str(unit or "")
    if isinstance(low, (int, float)) and isinstance(high, (int, float)):
        return f"{low:g}~{high:g}{unit_text}"
    if isinstance(low, (int, float)):
        return f">= {low:g}{unit_text}"
    if isinstance(high, (int, float)):
        return f"<= {high:g}{unit_text}"
    return "-"


def _value_with_unit(value: object, unit: object) -> str:
    if isinstance(value, float):
        text = f"{value:g}"
    else:
        text = "" if value is None else str(value)
    return f"{text}{unit or ''}" if text else "-"


def _format_time(value: datetime | None) -> str:
    if value is None:
        return "-"
    return value.strftime("%Y-%m-%d %H:%M:%S")


def _mode_text(mode: str) -> str:
    if mode.lower() == "mock":
        return "模拟数据(mock，未读取真实电表)"
    if mode.lower() == "serial":
        return "真实串口(serial)"
    return mode


def _initial_send_status(mode: str) -> str:
    if mode.lower() == "mock":
        return "模拟模式：当前数据来自软件生成"
    return "尚未发送"
