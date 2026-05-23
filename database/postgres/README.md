# PostgreSQL 数据库部署

正式三机部署使用 PostgreSQL 作为数据库服务。软件1不再把数据包发送给软件2后台，而是发送给数据库侧入库服务；软件2后台只从 PostgreSQL 拉取数据供前端展示。

```text
软件1采集/打包 -> 数据库侧入库服务 -> PostgreSQL
软件2后台查询 API -> PostgreSQL -> 软件2前端展示
```

## 建议数据库

```text
database: pq_monitor
user: pq_app
```

## 初始化方式

1. 在数据库服务器创建数据库和用户。
2. 在可访问 PostgreSQL 的机器上配置 `软件2/backend/.env`：

```text
DATABASE_URL=postgres://pq_app:change_me@数据库服务器IP:5432/pq_monitor
DATABASE_INGEST_HOST=0.0.0.0
DATABASE_INGEST_PORT=9000
```

3. 执行数据库初始化：

```powershell
cd "G:\#.Project\电能质量监测系统轻量版\软件2\backend"
npm run init-db
```

该命令会执行 `database/postgres/schema.sql`，并从软件1点表和配置文件导入默认站点、网关、仪表、柜体、回路和点位映射。

4. 启动数据库侧入库服务：

```powershell
cd "G:\#.Project\电能质量监测系统轻量版\软件2\backend"
npm run start:ingest
```

软件1配置指向：

```json
{
  "receiver": {
    "baseUrl": "http://数据库入库服务IP:9000",
    "ingestPath": "/api/ingest/packets",
    "healthPath": "/api/ingest/health",
    "testPath": "/api/ingest/test"
  }
}
```
