# 三部分分机部署改造计划

## Summary
将项目明确拆成三部分：软件1采集打包端、数据库侧 PostgreSQL 入库服务、软件2前端+Node.js Express查询后台。最终数据流为：软件1通过 HTTP POST 发送数据包到数据库侧入库服务，入库服务校验并写入 PostgreSQL；软件2后台只从 PostgreSQL 读取实时值、拓扑状态、历史、告警和接口状态并提供给前端。

当前评审结论：现有 SQLite + `database/ingest_server.py` 适合本机演示，但不适合“数据库独立机器部署”；现有软件2前端仍有部分模拟实时值，且 `/api/topology` 查询 `switch_status` 与软件1实际 `dido_status` 不匹配，需要改造。

## Key Changes
- 数据库服务改为 PostgreSQL：
  - 新增 PostgreSQL 建表脚本，覆盖现有 `station/gateway/meter/point_dictionary/point_mapping/ingest_packet/realtime_value/history_sample/statistic_record/alarm/event/interface_status` 等表。
  - 新增种子数据脚本，导入软件1点表、默认站点、网关、仪表、低压柜体和点位映射。
  - 保留现有 SQLite 文档和脚本作为本机轻量演示参考，但正式三机部署以 PostgreSQL 为准。

- 数据库侧新增 Node.js Express 入库服务：
  - 目录建议为 `软件2/backend`。
  - 使用 `express` + `pg` 连接 PostgreSQL。
  - 入库服务配置通过 `.env` 管理：`DATABASE_INGEST_HOST`、`DATABASE_INGEST_PORT`、`DATABASE_URL`、`INGEST_TOKEN`。
  - 提供软件1入库接口：
    - `GET /api/ingest/health`
    - `POST /api/ingest/packets`
    - `POST /api/ingest/test`

- 软件2新增 Node.js Express 查询后台：
  - 后台配置通过 `.env` 管理：`HOST`、`PORT`、`DATABASE_URL`、`CORS_ORIGIN`。
  - 提供软件2前端查询接口：
    - `GET /api/health`
    - `GET /api/topology`
    - `GET /api/realtime`
    - `GET /api/history`
    - `GET /api/alarms`
    - `GET /api/events`
    - `GET /api/interfaces/status`

- 软件1对接方式：
  - 软件1只需修改 `receiver.baseUrl` 为数据库侧入库服务地址，例如 `http://数据库入库服务IP:9000`。
  - `receiver.ingestPath` 保持 `/api/ingest/packets`。
  - token 暂时允许为空；若配置 `INGEST_TOKEN`，软件1同步配置 `receiver.token`，入库服务校验 `Authorization: Bearer <token>`。

- 软件2前端改造：
  - `topology-config.js` 的 `apiBaseUrl` 指向软件2后台地址，不直接访问数据库机器。
  - 将弹窗和图上实时电参改为读取 `/api/realtime`，不再使用前端模拟值作为真实采集数据。
  - `/api/topology` 使用软件1实际点位 `dido_status` 派生开关状态；如果点位无法判断分合闸，则显示“未收到开关量/未知”，不伪造状态。

## Implementation Details
- 软件1数据包入库规则：
  - `realtime.points[]` 写入 `history_sample`，并 upsert 到 `realtime_value`。
  - `statistics.statistics[]` 写入 `statistic_record`。
  - `alarm.alarms[]` 写入或恢复 `alarm`，同时写入 `event`。
  - `event.events[]` 写入 `event`。
  - `heartbeat`、`comm_status` 更新 `interface_status`，通信异常生成事件/告警。
  - 原始包完整保存到 `ingest_packet.raw_json`，并用 `gateway_id + meter_id + packet_type + sequence + packet_timestamp` 做重复包识别。

- PostgreSQL 部署形态：
  - 数据库机器开放 PostgreSQL 端口给数据库侧入库服务和软件2后台。
  - 软件1不发包给软件2后台，软件2前端不直连数据库。
  - 默认数据库名建议：`pq_monitor`。
  - 默认用户建议：`pq_app`。
  - 正式部署用 `.env` 保存连接串，不把真实密码写进代码。

- 三机启动关系：
  - 数据库机器：启动 PostgreSQL，执行建表和种子脚本，启动数据库侧入库服务。
  - 软件2机器：启动 Express 查询后台，再托管/打开软件2前端。
  - 软件1机器：配置数据库侧入库服务地址，运行采集打包程序。

## Test Plan
- 本机联调：
  - 启动本机 PostgreSQL。
  - 启动数据库侧入库服务和软件2查询后台。
  - 用软件1 mock 模式发送 `realtime` 包，确认 HTTP 返回 200。
  - 查询 PostgreSQL，确认 `ingest_packet/history_sample/realtime_value/interface_status` 有记录。
  - 打开软件2前端，确认实时电参来自数据库而不是前端模拟。

- 分机联调：
  - 数据库机器执行健康检查：数据库侧入库服务能连接 PostgreSQL。
  - 软件1机器访问 `http://数据库入库服务IP:9000/api/ingest/health` 成功。
  - 软件1连续发送数据，软件2前端 2 秒内刷新最新值。
  - 断开软件1或模拟 `comm_status` 异常，软件2接口状态页可见离线/异常。

- 回归场景：
  - 重复包不会重复污染实时值。
  - `timeout/crc_error/parse_error/unsupported/simulated/good` 质量码均能入库并显示。
  - `dido_status` 不可解析时，拓扑显示未知，不展示伪造分合闸。
  - 告警 active/cleared 能正确创建和恢复。

## Assumptions
- 正式三部分架构采用 PostgreSQL + Node.js Express，这是本轮已选定方案。
- 数据库侧入库服务负责写入数据库；软件2后台负责读取数据库；软件1不直接连接 PostgreSQL。
- token 鉴权保留但默认关闭，便于本机和演示环境快速联调。
- 软件1现有包格式保持不变，后台必须兼容 `PacketFactory` 当前六类包。
