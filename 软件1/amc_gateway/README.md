# AMC采集处理与数据打包软件

该项目是软件1的 Python 演示网关，支持通过 Modbus RTU 读取 AMC(II)-E4KC 电表，并按点表解码、显示和打包数据。

## 工控机主界面

当前现场电表参数已写入 `meter_config.example.json`：

- 端口：`COM3`
- 从站地址：`8`
- 波特率：`9600`
- 校验方式：无校验，配置值为 `N`
- 数据位：`8`
- 停止位：`1`

启动桌面主界面：

```powershell
cd "G:\#.Project\电能质量监测系统轻量版\软件1\amc_gateway"
$env:PYTHONPATH=".\src"
python -m amc_gateway gui --config meter_config.example.json
```

界面会自动通过真实串口采集电表数据，并完成处理、告警判断、数据打包、HTTP 上报和本地缓存补传。顶部显示站点编号、站点名称、当前时间、在线设备数量、异常设备数量、缓存数量和发送状态；中部按仪表分选项卡显示实时点位，并在“告警信息”选项卡中显示本次运行内的活动告警和恢复记录。

如果只需要无界面常驻运行，仍可使用 `run` 命令。

## 命令行验证

列出串口：

```powershell
python -m amc_gateway list-ports --config meter_config.example.json
```

读取一次真实电表：

```powershell
python -m amc_gateway read-once --config meter_config.example.json --mode serial
```

无电表时使用模拟数据：

```powershell
python -m amc_gateway read-once --config meter_config.example.json --mode mock
```

常驻采集并向软件2上报：

```powershell
python -m amc_gateway run --config meter_config.example.json --mode serial
```

## 打包为可执行文件

生成工控机 GUI 可执行文件：

```powershell
cd "G:\#.Project\电能质量监测系统轻量版\软件1\amc_gateway"
.\build_gui_exe.ps1
```

输出文件位于 `dist`：

- `AMC_Gateway_GUI.exe`：可双击运行的主界面程序。
- `meter_config.json`：现场可编辑配置，默认使用真实串口。
- `point_table.json`：运行所需点表。

## 多电表配置

`meter_config.example.json` 使用可扩展结构：

- `buses[]`：串口/RS485 总线参数，例如 `COM3`、波特率、校验方式。
- `meters[]`：电表清单，例如系统内编号、名称、型号、总线编号、从站地址。

后续同一条 RS485 总线上接入多块表时，只需在 `meters[]` 中继续添加不同 `slaveId` 的电表；如果使用多个 USB-RS485 转换器，则在 `buses[]` 中增加新的端口配置，并让电表通过 `busId` 绑定。

## 开关量输出

软件1读取 AMC 的 `0022H` 开关量寄存器。系统内所有 AMC 仪表当前只接 DI1，因此数据包输出：

- `switch_status`：DI1 业务状态，`value` 为 `1` 表示通路，`0` 表示断路；`rawValue` 为 `0022H` 直接读到的原始寄存器值。

AMC 当前不采集谐波相关数据，输出包中不包含 `thd_*` 点位。

## 目录结构

- `src/amc_gateway/core`：Modbus CRC、组帧、响应解析、点表模型、寄存器解码、质量码和数据包模型。
- `src/amc_gateway/platform`：串口 RTU、模拟源、HTTP 发送和 SQLite 缓存。
- `src/amc_gateway/acquisition.py`：单次采集逻辑，供 CLI 和 GUI 复用。
- `src/amc_gateway/gui.py`：Tkinter 工控机主界面，固定使用真实串口模式。
- `tests`：离线单元测试，不依赖真实串口。
- `samples/sample_modscan_40257.json`：按 Modscan 截图整理的寄存器样例。

## 质量码

- `good`：正常采集并解码成功
- `simulated`：模拟数据
- `timeout`：仪表无响应或串口读取超时
- `crc_error`：Modbus 响应 CRC 错误
- `parse_error`：响应格式或点位解码错误
- `out_of_range`：工程值超出合理范围
- `unsupported`：当前版本不采集或仪表能力未确认
