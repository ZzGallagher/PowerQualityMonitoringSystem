# PostgreSQL 数据库部署

正式三机部署使用 PostgreSQL 作为数据库服务。软件1和软件2前端都不直接连接 PostgreSQL，只有软件2后台连接数据库。

## 建议数据库

```text
database: pq_monitor
user: pq_app
```

## 初始化方式

1. 在数据库服务器创建数据库和用户。
2. 在软件2后台 `.env` 中配置：

```text
DATABASE_URL=postgres://pq_app:change_me@数据库服务器IP:5432/pq_monitor
```

3. 在软件2后台机器执行：

```powershell
cd "G:\#.Project\电能质量监测系统轻量版\软件2\backend"
npm run init-db
```

该命令会执行 `database/postgres/schema.sql`，并从软件1点表和配置文件导入默认站点、网关、仪表、柜体、回路和点位映射。
