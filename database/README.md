# database

服务器端轻量化数据库目录，用于承接软件1发送到数据库侧入库服务的 JSON 数据包。

正式演示链路采用 PostgreSQL：软件1把采集/模拟数据处理打包后发送到数据库侧入库服务入库，软件2后台只从数据库拉取数据。SQLite 脚本保留为本机轻量验证参考。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `服务器端轻量化数据库设计.md` | 数据库设计说明 |
| `schema.sql` | SQLite 建表脚本 |
| `init_database.py` | 初始化数据库、导入软件1点表、生成默认站点/网关/仪表/点位映射 |
| `packet_ingest.py` | 将软件1的 `realtime`、`statistics`、`alarm`、`event`、`heartbeat`、`comm_status` 包写入数据库 |
| `ingest_server.py` | 本机/局域网 HTTP 接收服务，提供软件1入库接口 |
| `server_config.json` | 接收服务配置，后续修改服务器 IP、端口、数据库路径和 token |
| `smoke_send_software1.py` | 使用软件1打包逻辑生成 `realtime` 包并通过 HTTP 发送到接收服务 |
| `verify_database.py` | 使用软件1 mock 数据包验证建库和入库链路 |
| `data/pq_monitor.sqlite3` | 默认生成的 SQLite 数据库文件 |

## 初始化

在项目根目录执行：

```powershell
python database\init_database.py
```

默认会生成：

```text
database/data/pq_monitor.sqlite3
```

并导入：

- 软件1 `AMC-E4KC点表-v1.json` 中的点位字典。
- 软件1 `meter_config.example.json` 中的站点、网关、仪表。
- 默认高压 `AA1-AA7`、低压 `AA0-AA11` 柜体。
- `amc-001` 到默认低压主进线回路的点位映射。

## 验证

在项目根目录执行：

```powershell
python database\verify_database.py
```

验证脚本会调用软件1 mock 采样逻辑生成一个 `realtime` 包，再通过 `packet_ingest.py` 写入数据库。

## HTTP 接收入库测试

服务配置文件：

```text
database/server_config.json
```

本机测试默认配置：

```json
{
  "host": "127.0.0.1",
  "port": 9000,
  "databasePath": "data/pq_monitor.sqlite3",
  "token": "",
  "maxBodyBytes": 1048576
}
```

启动接收服务：

```powershell
python database\ingest_server.py
```

健康检查：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9000/api/ingest/health" -Method Get
```

使用软件1打包逻辑发送一包测试数据：

```powershell
python database\smoke_send_software1.py
```

软件1正式运行时，只要 `软件1/amc_gateway/meter_config.example.json` 中的接收端配置指向同一地址即可：

```json
{
  "receiver": {
    "baseUrl": "http://127.0.0.1:9000",
    "ingestPath": "/api/ingest/packets",
    "token": ""
  }
}
```

## 软件1数据包匹配

当前入库代码匹配软件1 `PacketFactory` 的六类包：

| packetType | 入库目标 |
| --- | --- |
| `realtime` | `ingest_packet`、`history_sample`、`realtime_value`、`meter_reading_record` |
| `statistics` | `ingest_packet`、`statistic_record` |
| `alarm` | `ingest_packet`、`alarm`、`event` |
| `event` | `ingest_packet`、`event` |
| `heartbeat` | `ingest_packet`、`interface_status`、`event` |
| `comm_status` | `ingest_packet`、`interface_status`、`event`、通信告警 |

数据库侧入库服务接收 `POST /api/ingest/packets` 时，可以直接调用：

```python
from database.init_database import connect
from database.packet_ingest import ingest_packet

with connect(db_path) as conn:
    with conn:
        packet_id = ingest_packet(conn, packet)
```
