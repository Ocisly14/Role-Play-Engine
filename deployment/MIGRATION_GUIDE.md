# EC2 SQLite → PostgreSQL 迁移指南

本指南帮助你将已部署在 AWS EC2 上的 CoC AI Agent 应用从 SQLite 迁移到 PostgreSQL。

## 📋 迁移概览

```
当前状态: EC2 运行 SQLite 版本
目标状态: EC2 运行 PostgreSQL 版本 + 完整数据迁移

预计时间: 1-2 小时
停机时间: ~30 分钟
```

---

## 🎯 前置准备

### 1. 确认当前状态

SSH 到 EC2 服务器：
```bash
ssh -i your-key.pem ubuntu@<EC2-IP>
cd /home/ubuntu/app

# 检查当前 SQLite 数据库
ls -lh data/*.db

# 检查应用状态
pm2 status
```

### 2. 创建完整备份

```bash
# 停止应用
pm2 stop all

# 备份整个应用目录
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
cd /home/ubuntu
tar -czf app-backup-${BACKUP_DATE}.tar.gz app/

# 验证备份
ls -lh app-backup-*.tar.gz

# 重启应用
pm2 start app/deployment/ecosystem.config.cjs
```

**重要:** 将备份下载到本地（可选但推荐）：
```bash
# 在本地机器运行：
scp -i your-key.pem ubuntu@<EC2-IP>:/home/ubuntu/app-backup-*.tar.gz ./
```

---

## 🗄️ 方案选择

### 方案 A: EC2 本地 PostgreSQL（推荐，成本低）

**优点:**
- ✅ 无额外成本
- ✅ 配置简单
- ✅ 低延迟

**缺点:**
- ⚠️ 需要手动备份
- ⚠️ 单点故障

**适合:** 中小流量，单服务器部署

---

### 方案 B: AWS RDS PostgreSQL（推荐，生产环境）

**优点:**
- ✅ 自动备份
- ✅ 高可用
- ✅ 易于扩展

**缺点:**
- ❌ 额外成本（$15-30/月）

**适合:** 生产环境，需要高可用

---

## 📦 方案 A: EC2 本地 PostgreSQL 部署

### 步骤 1: 安装 PostgreSQL

```bash
# SSH 到 EC2
ssh -i your-key.pem ubuntu@<EC2-IP>

# 更新包管理器
sudo apt update

# 安装 PostgreSQL 14
sudo apt install -y postgresql postgresql-contrib

# 启动并设置开机自启
sudo systemctl start postgresql
sudo systemctl enable postgresql

# 验证安装
psql --version
```

### 步骤 2: 配置 PostgreSQL

```bash
# 创建数据库用户和数据库
sudo -u postgres psql << 'EOF'
CREATE USER cocuser WITH PASSWORD 'YourSecurePassword123';
CREATE DATABASE coc_game_db OWNER cocuser;
GRANT ALL PRIVILEGES ON DATABASE coc_game_db TO cocuser;
\q
EOF

# 配置密码认证
sudo nano /etc/postgresql/14/main/pg_hba.conf

# 在文件中找到：
#   local   all   all   peer
# 在其上方添加：
local   all   cocuser   md5

# 保存并退出 (Ctrl+X, Y, Enter)

# 重启 PostgreSQL
sudo systemctl restart postgresql

# 测试连接
psql -U cocuser -d coc_game_db -h localhost
# 输入密码: YourSecurePassword123
# 成功连接后输入 \q 退出
```

### 步骤 3: 优化 PostgreSQL 配置（可选）

```bash
sudo nano /etc/postgresql/14/main/postgresql.conf

# 修改以下参数（根据 EC2 实例类型调整）:
max_connections = 100
shared_buffers = 256MB
effective_cache_size = 1GB
maintenance_work_mem = 64MB

# 保存并重启
sudo systemctl restart postgresql
```

### 步骤 4: 更新应用代码

在**本地机器**上：

```bash
cd /path/to/CoC-AI-agent

# 确保在正确的分支
git status
git pull

# 安装依赖
pnpm install

# 构建后端
pnpm build

# 构建前端
cd client
npm install
npm run build
cd ..

# 打包部署
tar czf coc-postgres-deploy.tar.gz \
  dist/ \
  client/dist/ \
  client/dist-server/ \
  data/Mods/ \
  package.json \
  pnpm-lock.yaml \
  prisma/ \
  scripts/migrate-sqlite-to-postgres.ts \
  scripts/verify-migration.ts \
  deployment/ecosystem.config.cjs

# 上传到 EC2
scp -i your-key.pem coc-postgres-deploy.tar.gz ubuntu@<EC2-IP>:/home/ubuntu/app/
```

在 **EC2 服务器**上：

```bash
cd /home/ubuntu/app

# 停止应用
pm2 stop all

# 解压新代码
tar xzf coc-postgres-deploy.tar.gz

# 安装依赖
NODE_ENV=production pnpm install --prod

# 生成 Prisma Client
pnpm prisma:generate
```

### 步骤 5: 配置环境变量

```bash
cd /home/ubuntu/app
nano .env
```

**修改数据库配置** (找到并修改这些行)：

```bash
# 注释或删除 SQLite 配置
# DATABASE_PATH=./data/db.sqlite
# DATABASE_PATH=./data/coc_game.db

# 添加 PostgreSQL 配置
DATABASE_URL="postgresql://cocuser:YourSecurePassword123@localhost:5432/coc_game_db?schema=public&connection_limit=50&pool_timeout=20"
```

**保存文件** (Ctrl+X, Y, Enter)

**设置权限：**
```bash
chmod 600 .env
```

### 步骤 6: 运行 Prisma 迁移（创建表结构）

```bash
cd /home/ubuntu/app

# 运行迁移
pnpm prisma:migrate:deploy

# 验证表已创建
psql -U cocuser -d coc_game_db -h localhost -c "\dt"
# 应该看到 35+ 张表
```

### 步骤 7: 迁移数据（关键步骤）

```bash
cd /home/ubuntu/app

# 安装 better-sqlite3（临时用于读取 SQLite）
npm install better-sqlite3

# 运行迁移脚本
tsx scripts/migrate-sqlite-to-postgres.ts ./data/coc_game.db
# 或者如果是 db.sqlite:
# tsx scripts/migrate-sqlite-to-postgres.ts ./data/db.sqlite
```

**预期输出:**
```
========================================
  SQLite → PostgreSQL Migration
========================================

SQLite database path: /home/ubuntu/app/data/coc_game.db
SQLite file size: 3.45 MB

Connecting to databases...
✅ Connected to PostgreSQL ✓
✅ Connected to SQLite ✓

📦 Migrating users...
  ✅ 25 users migrated

📦 Migrating sessions...
  ✅ 48 sessions migrated

📦 Migrating characters...
  ✅ 120 characters migrated

📦 Migrating game turns (this may take a while)...
  Progress: 100/1534 turns migrated
  Progress: 200/1534 turns migrated
  ...
  ✅ 1534 game turns migrated

========================================
  Migration Summary
========================================

Migrated records:
  users                         25
  sessions                      48
  characters                   120
  gameTurns                   1534
  gameCheckpoints               12
  ...

✅ Total records migrated: 1739

✨ Migration completed successfully! ✨
```

### 步骤 8: 验证数据迁移

```bash
# 运行验证脚本
tsx scripts/verify-migration.ts ./data/coc_game.db
```

**预期输出:**
```
========================================
  Migration Verification
========================================

Comparing record counts:

Table                     SQLite     PostgreSQL  Status
------------------------------------------------------------
users                         25             25  ✓ Match
characters                   120            120  ✓ Match
sessions                      48             48  ✓ Match
game_turns                  1534           1534  ✓ Match
game_checkpoints              12             12  ✓ Match
...
------------------------------------------------------------

✨ All table counts match! Migration appears successful.
```

**手动检查（可选）:**
```bash
# 连接到 PostgreSQL
psql -U cocuser -d coc_game_db -h localhost

-- 检查数据
SELECT 'users', COUNT(*) FROM users
UNION ALL
SELECT 'sessions', COUNT(*) FROM sessions
UNION ALL
SELECT 'game_turns', COUNT(*) FROM game_turns;

-- 查看最近的 turn
SELECT turn_id, session_id, character_input, status, created_at
FROM game_turns
ORDER BY created_at DESC
LIMIT 5;

\q
```

### 步骤 9: 重启应用

```bash
cd /home/ubuntu/app

# 重启应用
pm2 reload ecosystem.config.cjs --update-env

# 查看日志
pm2 logs --lines 100

# 检查状态
pm2 status
```

**预期日志中应看到:**
```
✅ Prisma Client initialized
✅ DynamicWorld system initialized
Server listening on port 3000
```

### 步骤 10: 测试验证

```bash
# 测试健康检查
curl http://localhost:3000/api/health

# 如果配置了域名和 Nginx
curl https://your-domain.com/api/health
```

**在浏览器中测试:**
1. 访问你的应用 URL
2. 登录测试账号
3. 检查游戏历史是否正常显示
4. 创建一个新 turn 测试

### 步骤 11: 清理和备份设置

**归档 SQLite 数据库:**
```bash
cd /home/ubuntu/app
mkdir -p backups/sqlite-archive
mv data/*.db* backups/sqlite-archive/
ls -lh backups/sqlite-archive/
```

**设置 PostgreSQL 自动备份:**
```bash
# 创建备份脚本
nano /home/ubuntu/app/scripts/backup-postgres.sh
```

粘贴以下内容：
```bash
#!/bin/bash
BACKUP_DIR="/home/ubuntu/app/backups/postgres"
BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# 使用 pg_dump 备份
pg_dump -U cocuser -h localhost coc_game_db | gzip > $BACKUP_DIR/coc_db_${BACKUP_DATE}.sql.gz

# 保留最近 7 天的备份
find $BACKUP_DIR -name "coc_db_*.sql.gz" -mtime +7 -delete

echo "Backup completed: coc_db_${BACKUP_DATE}.sql.gz"
```

```bash
chmod +x /home/ubuntu/app/scripts/backup-postgres.sh

# 设置定时任务（每天凌晨 2 点备份）
crontab -e

# 添加：
0 2 * * * /home/ubuntu/app/scripts/backup-postgres.sh >> /home/ubuntu/app/logs/backup.log 2>&1
```

---

## 🚀 方案 B: AWS RDS PostgreSQL 部署

### 步骤 1: 创建 RDS 实例

1. 登录 AWS Console → RDS → Create database
2. 配置：
   - 引擎: PostgreSQL 14
   - 模板: 生产（或免费套餐）
   - 数据库实例标识符: `coc-db`
   - 主用户名: `admin`
   - 主密码: <设置强密码>
   - 实例类: `db.t3.micro` (免费) 或 `db.t3.small`
   - 存储: 20 GB gp3
   - VPC: 与 EC2 相同
   - 公开访问: 否
   - VPC 安全组: 创建新的

### 步骤 2: 配置安全组

编辑 RDS 安全组，添加入站规则：
```
类型: PostgreSQL
端口: 5432
源: <EC2 安全组 ID>
```

### 步骤 3: 获取 RDS Endpoint

AWS Console → RDS → 数据库 → coc-db → 连接性和安全性

记录：
- 端点: `coc-db.xxxxx.us-east-1.rds.amazonaws.com`
- 端口: `5432`

### 步骤 4: 配置 .env（RDS 版本）

```bash
# 在 EC2 上
nano /home/ubuntu/app/.env

# 修改数据库配置：
DATABASE_URL="postgresql://admin:YourRDSPassword@coc-db.xxxxx.us-east-1.rds.amazonaws.com:5432/coc_game_db?schema=public&connection_limit=50&pool_timeout=20&sslmode=require"
```

**注意 RDS 的区别:**
- 主机名是 RDS endpoint（不是 localhost）
- 必须添加 `sslmode=require`

### 步骤 5: 测试 RDS 连接

```bash
# 安装 PostgreSQL 客户端（如果还没安装）
sudo apt install -y postgresql-client

# 测试连接
psql -h coc-db.xxxxx.us-east-1.rds.amazonaws.com -U admin -d postgres

# 创建数据库
CREATE DATABASE coc_game_db;
\q
```

### 步骤 6-11: 与方案 A 相同

从步骤 6 开始，与方案 A 的步骤相同。

---

## 🔧 常见问题处理

### Q1: 迁移脚本报错 "better-sqlite3 not found"

```bash
cd /home/ubuntu/app
npm install better-sqlite3
npm install @types/better-sqlite3 --save-dev
```

### Q2: Prisma 迁移失败 "relation already exists"

```bash
# 清空数据库重新迁移
psql -U cocuser -d coc_game_db -h localhost
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
\q

# 重新运行
pnpm prisma:migrate:deploy
```

### Q3: 连接 PostgreSQL 超时

```bash
# 检查 PostgreSQL 状态
sudo systemctl status postgresql

# 检查端口
sudo netstat -tuln | grep 5432

# 检查防火墙
sudo ufw status
```

### Q4: 数据迁移后数量不匹配

```bash
# 对比数据量
sqlite3 data/coc_game.db "SELECT COUNT(*) FROM users;"
psql -U cocuser -d coc_game_db -h localhost -c "SELECT COUNT(*) FROM users;"

# 重新运行迁移脚本
tsx scripts/migrate-sqlite-to-postgres.ts ./data/coc_game.db
```

### Q5: 应用启动失败

```bash
# 查看日志
pm2 logs --lines 200

# 检查 .env 配置
cat .env | grep DATABASE_URL

# 测试 Prisma 连接
cd /home/ubuntu/app
npx prisma db pull
```

---

## 🔄 回滚方案

如果迁移失败，需要回滚到 SQLite：

```bash
# 停止应用
pm2 stop all

# 恢复备份
cd /home/ubuntu
tar -xzf app-backup-*.tar.gz

# 修改 .env 恢复 SQLite
cd app
nano .env
# 改回: DATABASE_PATH=./data/coc_game.db

# 重启应用
pm2 start deployment/ecosystem.config.cjs
```

---

## ✅ 迁移检查清单

- [ ] 创建完整应用备份
- [ ] 安装 PostgreSQL
- [ ] 创建数据库和用户
- [ ] 更新应用代码
- [ ] 配置 .env 使用 PostgreSQL
- [ ] 运行 Prisma 迁移（创建表结构）
- [ ] 运行数据迁移脚本
- [ ] 验证数据完整性
- [ ] 重启应用
- [ ] 测试功能正常
- [ ] 归档 SQLite 数据库
- [ ] 设置 PostgreSQL 自动备份

---

## 📞 支持

如遇问题，请检查：
1. 应用日志: `pm2 logs`
2. PostgreSQL 日志: `sudo tail -f /var/log/postgresql/postgresql-14-main.log`
3. 系统日志: `sudo journalctl -xe`

---

**祝迁移顺利！** 🎉
