# 启动流程-cmd窗口版

本文档用于 Windows `cmd.exe` 窗口启动本项目演示系统。不要在 `cmd.exe` 中使用 PowerShell 的 `$env:PYTHONPATH=...` 语法。

## 1. 本机启动结构

本机测试时，一台电脑同时运行三部分：

```text
软件1采集打包端 -> 软件2后台服务 -> PostgreSQL数据库
软件2前端页面   -> 软件2后台服务 -> PostgreSQL数据库
```

默认本机地址：

| 部分 | 地址/配置 |
| --- | --- |
| PostgreSQL | `127.0.0.1:5432` |
| 软件2后台 | `http://127.0.0.1:8000` |
| 软件2前端 | `http://127.0.0.1:8080` |
| 软件1接收端配置 | `receiver.baseUrl = http://127.0.0.1:8000` |

## 2. 启动前检查

确认 PostgreSQL 服务正在运行。当前本机服务名通常为：

```cmd
sc query postgresql-x64-18
```

确认软件2后台依赖已经安装：

```cmd
cd /d "G:\#.Project\电能质量监测系统轻量版\软件2\backend"
npm install
```

确认软件2后台 `.env` 存在：

```cmd
cd /d "G:\#.Project\电能质量监测系统轻量版\软件2\backend"
dir .env
```

本机 `.env` 示例：

```text
HOST=127.0.0.1
PORT=8000
DATABASE_URL=postgres://pq_app:change_me@127.0.0.1:5432/pq_monitor
INGEST_TOKEN=
CORS_ORIGIN=*
POINT_TABLE_PATH="G:/#.Project/电能质量监测系统轻量版/软件1/AMC-E4KC点表-v1.json"
SOFTWARE1_CONFIG_PATH="G:/#.Project/电能质量监测系统轻量版/软件1/amc_gateway/meter_config.example.json"
```

路径里有 `#` 时，`.env` 里建议给路径加双引号，否则 `dotenv` 会把 `#` 后面的内容当注释。

## 3. 手动启动步骤

### 窗口1：启动软件2后台

```cmd
cd /d "G:\#.Project\电能质量监测系统轻量版\软件2\backend"
npm run init-db
npm start
```

健康检查：

```cmd
curl http://127.0.0.1:8000/api/ingest/health
```

### 窗口2：启动软件2前端

```cmd
cd /d "G:\#.Project\电能质量监测系统轻量版\软件2\web"
python -m http.server 8080
```

浏览器打开：

```text
http://127.0.0.1:8080
```

### 窗口3：启动软件1真实仪表采集

`cmd.exe` 里使用：

```cmd
cd /d "G:\#.Project\电能质量监测系统轻量版\软件1\amc_gateway"
set PYTHONPATH=.\src
python -m amc_gateway run --config meter_config.example.json --mode serial
```

无仪表时 mock 测试：

```cmd
cd /d "G:\#.Project\电能质量监测系统轻量版\软件1\amc_gateway"
set PYTHONPATH=.\src
python -m amc_gateway run --config meter_config.example.json --mode mock
```

## 4. 一键启动脚本

根目录提供：

```text
本机一键启动.cmd
```

默认启动真实仪表模式：

```cmd
本机一键启动.cmd
```

启动 mock 模式：

```cmd
本机一键启动.cmd mock
```

启动 serial 模式：

```cmd
本机一键启动.cmd serial
```

该脚本会打开三个新 cmd 窗口：

- `软件2后台`
- `软件2前端`
- `软件1采集`

## 5. 分机器部署时需要修改的位置

### 数据库服务器

PostgreSQL 部署在数据库机器上。软件1和软件2前端不直接连接数据库。

需要在数据库机器上创建：

```text
database: pq_monitor
user: pq_app
```

### 软件2后台机器

修改：

```text
软件2/backend/.env
```

把数据库连接改成数据库服务器地址：

```text
DATABASE_URL=postgres://pq_app:数据库密码@数据库服务器IP:5432/pq_monitor
```

如需让其他机器访问软件2后台，建议：

```text
HOST=0.0.0.0
PORT=8000
```

### 软件2前端机器

修改：

```text
软件2/web/topology-config.js
```

把：

```js
apiBaseUrl: "http://127.0.0.1:8000"
```

改成：

```js
apiBaseUrl: "http://软件2后台IP:8000"
```

### 软件1采集机器

修改：

```text
软件1/amc_gateway/meter_config.example.json
```

把：

```json
"receiver": {
  "baseUrl": "http://127.0.0.1:8000",
  "ingestPath": "/api/ingest/packets"
}
```

改成：

```json
"receiver": {
  "baseUrl": "http://软件2后台IP:8000",
  "ingestPath": "/api/ingest/packets"
}
```

如果软件2后台 `.env` 配置了 `INGEST_TOKEN`，这里的 `receiver.token` 也要填同一个值。

## 6. 常用验证接口

后台健康：

```cmd
curl http://127.0.0.1:8000/api/ingest/health
```

实时数据：

```cmd
curl http://127.0.0.1:8000/api/realtime
```

拓扑开关状态：

```cmd
curl http://127.0.0.1:8000/api/topology
```

接口状态：

```cmd
curl http://127.0.0.1:8000/api/interfaces/status
```

## 7. 采集频率

当前软件1配置：

```json
"pollIntervalSeconds": 2
```

即实时采集周期为 2 秒，频率约为 0.5 Hz。
