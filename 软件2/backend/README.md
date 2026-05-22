# 软件2后台服务

软件2后台是三机部署中的唯一数据库访问层：

```text
软件1采集机 -> 软件2后台 HTTP API -> PostgreSQL 数据库机
软件2前端机 -> 软件2后台 HTTP API -> PostgreSQL 数据库机
```

## 初始化

安装依赖：

```powershell
cd "G:\#.Project\电能质量监测系统轻量版\软件2\backend"
npm install
```

复制配置：

```powershell
Copy-Item .env.example .env
```

修改 `.env`：

```text
HOST=0.0.0.0
PORT=8000
DATABASE_URL=postgres://pq_app:change_me@数据库服务器IP:5432/pq_monitor
INGEST_TOKEN=
CORS_ORIGIN=*
```

初始化 PostgreSQL 表结构和种子数据：

```powershell
npm run init-db
```

启动后台：

```powershell
npm start
```

## 软件1配置

软件1配置文件中的接收端地址指向软件2后台：

```json
{
  "receiver": {
    "baseUrl": "http://软件2后台IP:8000",
    "ingestPath": "/api/ingest/packets",
    "token": ""
  }
}
```

## 软件2前端配置

`软件2/web/topology-config.js` 中：

```js
apiBaseUrl: "http://软件2后台IP:8000"
```

## 接口

- `GET /api/ingest/health`
- `POST /api/ingest/packets`
- `POST /api/ingest/test`
- `GET /api/topology`
- `GET /api/realtime`
- `GET /api/history?meterId=amc-001&pointCode=ua`
- `GET /api/alarms`
- `GET /api/events`
- `GET /api/interfaces/status`
