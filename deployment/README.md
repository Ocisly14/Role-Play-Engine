# CoC AI Agent - AWS EC2 部署指南

本目录包含将 CoC AI Agent 应用部署到 AWS EC2 所需的所有配置文件和脚本。

## 📁 文件说明

| 文件 | 用途 | 位置 |
|------|------|------|
| `ecosystem.config.cjs` | PM2 进程管理器配置 | 服务器: `/home/ubuntu/app/` |
| `nginx.conf` | Nginx 反向代理配置 | 服务器: `/etc/nginx/sites-available/coc-agent` |
| `backup-db.sh` | 数据库自动备份脚本 | 服务器: `/home/ubuntu/app/deployment/` |
| `deploy.sh` | 本地构建和部署脚本 | 本地运行 |
| `.env.production.example` | 生产环境变量模板 | 服务器: `/home/ubuntu/app/.env` |
| `README.md` | 本文档 | 参考文档 |

## 🚀 快速开始

### 前置条件

**本地开发机器：**
- Node.js 20+
- pnpm 9+
- SSH 客户端

**AWS 准备：**
- AWS 账户
- 已注册的域名
- EC2 密钥对（.pem 文件）

**API 密钥：**
- OpenAI API Key 或 Google Gemini API Key

### 部署流程概览

```
1. AWS 设置 (30-45 分钟)
   ├── 创建 EC2 实例
   ├── 配置安全组
   ├── 分配弹性 IP
   └── 配置 DNS

2. 服务器配置 (30-45 分钟)
   ├── 安装 Node.js/pnpm/Nginx
   ├── 配置防火墙
   └── 设置 SSH 安全

3. 应用部署 (20-30 分钟)
   ├── 上传代码
   ├── 配置环境变量
   ├── 启动应用
   └── 配置 SSL

4. 验证和监控 (10-15 分钟)
   ├── 功能测试
   ├── 设置备份
   └── 配置监控
```

## 📋 详细部署步骤

### 步骤 1: AWS EC2 实例设置

#### 1.1 启动 EC2 实例

1. 登录 [AWS Console](https://console.aws.amazon.com) → EC2
2. 点击 **Launch Instance**
3. 配置实例：

```yaml
Name: coc-ai-agent
AMI: Ubuntu Server 22.04 LTS (64-bit x86)
Instance Type: t3.micro
Key Pair: 创建新密钥对并下载 .pem 文件
Storage: 20 GiB gp3
```

4. 点击 **Launch Instance**

#### 1.2 配置安全组

编辑实例的安全组，添加入站规则：

| 类型 | 协议 | 端口 | 源 |
|------|------|------|-----|
| SSH | TCP | 22 | 你的IP/32 |
| HTTP | TCP | 80 | 0.0.0.0/0 |
| HTTPS | TCP | 443 | 0.0.0.0/0 |

#### 1.3 分配弹性 IP

```bash
EC2 Console → Elastic IPs → Allocate Elastic IP
→ 关联到 coc-ai-agent 实例
```

记录此 IP 地址，例如：`54.123.45.67`

#### 1.4 配置域名 DNS

在你的域名提供商添加 A 记录：

```
类型: A
名称: coc-agent (或你喜欢的子域名)
值: <弹性IP地址>
TTL: 300
```

验证 DNS 生效：
```bash
nslookup coc-agent.yourdomain.com
```

---

### 步骤 2: 服务器环境配置

#### 2.1 SSH 连接到服务器

```bash
chmod 400 your-key.pem
ssh -i your-key.pem ubuntu@<弹性IP>
```

#### 2.2 安装系统依赖

在服务器上运行以下命令：

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证安装
node --version  # 应显示 v20.x
npm --version

# 安装 pnpm（必需）
npm install -g pnpm
pnpm --version  # 应显示 9.x

# 安装编译工具（better-sqlite3 需要）
sudo apt install -y build-essential python3

# 安装 Nginx
sudo apt install -y nginx
nginx -v

# 安装 Certbot (Let's Encrypt SSL)
sudo apt install -y certbot python3-certbot-nginx

# 安装 PM2 进程管理器
npm install -g pm2

# 配置 PM2 开机自启
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# 运行输出的命令（类似 sudo env PATH=...）

# 安装 SQLite3（用于备份）
sudo apt install -y sqlite3
```

#### 2.3 配置防火墙

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
sudo ufw enable
sudo ufw status
```

#### 2.4 创建应用目录

```bash
mkdir -p /home/ubuntu/app
cd /home/ubuntu/app
```

---

### 步骤 3: 应用部署

#### 方式 A: 使用自动部署脚本（推荐）

**在本地开发机器上运行：**

```bash
cd /path/to/CoC-AI-agent

# 设置环境变量
export DEPLOY_HOST=<弹性IP或域名>
export DEPLOY_KEY=/path/to/your-key.pem
export DEPLOY_USER=ubuntu

# 运行部署脚本
chmod +x deployment/deploy.sh
./deployment/deploy.sh
```

脚本会自动：
1. 构建后端和前端
2. 创建部署包
3. 上传到服务器
4. 安装依赖
5. 启动应用

**然后跳转到步骤 3.3 配置环境变量**

#### 方式 B: 手动部署

<details>
<summary>点击展开手动部署步骤</summary>

**在本地构建：**

```bash
cd /path/to/CoC-AI-agent

# 安装依赖并构建
pnpm install
pnpm build

# 构建前端
cd client
npm install
npm run build
cd ..

# 创建部署包
tar czf coc-deploy.tar.gz \
  dist/ \
  client/dist/ \
  data/Mods/ \
  package.json \
  pnpm-lock.yaml \
  deployment/

# 上传到服务器
scp -i your-key.pem coc-deploy.tar.gz ubuntu@<IP>:/home/ubuntu/app/
```

**在服务器上解压和安装：**

```bash
cd /home/ubuntu/app
tar xzf coc-deploy.tar.gz
rm coc-deploy.tar.gz

# 安装生产依赖
NODE_ENV=production pnpm install --prod

# 重新编译 better-sqlite3
pnpm rebuild better-sqlite3
```

</details>

#### 3.3 配置环境变量

**在服务器上：**

```bash
cd /home/ubuntu/app
cp deployment/.env.production.example .env
nano .env
```

**必须修改以下配置：**

```env
# 1. AI 提供商（必需）
MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-your-actual-key-here

# 2. JWT Secret（必需，生成安全随机字符串）
JWT_SECRET=<运行 openssl rand -base64 48 生成>

# 3. 数据库路径
DATABASE_PATH=/home/ubuntu/app/data/coc_game.db

# 4. 其他配置保持默认即可
```

**生成安全的 JWT_SECRET：**
```bash
openssl rand -base64 48
```

**设置文件权限：**
```bash
chmod 600 /home/ubuntu/app/.env
```

#### 3.4 初始化数据库

```bash
mkdir -p /home/ubuntu/app/data
cd /home/ubuntu/app

# 首次运行会自动创建数据库表
NODE_ENV=production node dist/src/index.js --prompt "init" || true
```

#### 3.5 启动应用

```bash
# 创建日志目录
mkdir -p /home/ubuntu/app/logs

# 启动应用
cd /home/ubuntu/app
pm2 start deployment/ecosystem.config.cjs

# 保存 PM2 进程列表
pm2 save

# 查看状态
pm2 status
pm2 logs coc-agent --lines 50
```

**验证应用运行：**
```bash
curl http://localhost:3000/api/health
# 应返回 JSON 响应
```

---

### 步骤 4: 配置 Nginx 和 HTTPS

#### 4.1 安装 Nginx 配置

```bash
# 复制配置文件
sudo cp /home/ubuntu/app/deployment/nginx.conf /etc/nginx/sites-available/coc-agent

# 替换域名（重要！）
sudo sed -i 's/coc-agent.example.com/YOUR-ACTUAL-DOMAIN/g' /etc/nginx/sites-available/coc-agent

# 创建符号链接
sudo ln -s /etc/nginx/sites-available/coc-agent /etc/nginx/sites-enabled/

# 删除默认站点
sudo rm /etc/nginx/sites-enabled/default

# 测试配置
sudo nginx -t

# 重载 Nginx
sudo systemctl reload nginx
```

#### 4.2 获取 SSL 证书

```bash
# 确保 DNS 已生效
nslookup your-domain.com

# 使用 Certbot 自动配置 SSL
sudo certbot --nginx -d your-domain.com

# 按提示操作：
# 1. 输入邮箱地址
# 2. 同意服务条款 (Y)
# 3. 选择是否分享邮箱 (N)
# 4. Certbot 会自动配置 SSL

# 测试自动续期
sudo certbot renew --dry-run
```

#### 4.3 验证 HTTPS 访问

在浏览器打开：`https://your-domain.com`

应该看到：
- ✅ 绿色安全锁图标
- ✅ 应用正常加载
- ✅ WebSocket 连接成功

---

### 步骤 5: 设置备份和监控

#### 5.1 配置数据库自动备份

```bash
# 设置脚本权限
chmod +x /home/ubuntu/app/deployment/backup-db.sh

# 测试备份
/home/ubuntu/app/deployment/backup-db.sh

# 配置定时任务（每天凌晨 3 点备份）
crontab -e

# 添加以下行：
0 3 * * * /home/ubuntu/app/deployment/backup-db.sh >> /home/ubuntu/app/logs/backup.log 2>&1
```

#### 5.2 设置外部监控（推荐）

使用 [UptimeRobot](https://uptimerobot.com/)（免费）监控网站可用性：

1. 注册账号
2. 添加新监控：
   - 类型：HTTPS
   - URL：`https://your-domain.com/api/health`
   - 间隔：5 分钟
3. 设置告警通知（邮件/短信）

---

## 🔧 日常运维

### 查看应用状态

```bash
ssh -i your-key.pem ubuntu@<IP>

# PM2 状态
pm2 status
pm2 logs coc-agent
pm2 monit

# 系统资源
df -h      # 磁盘使用
free -h    # 内存使用
top        # CPU 使用

# Nginx 日志
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### 应用更新

**小更新（代码修复）：**

```bash
# 本地
cd /path/to/CoC-AI-agent
./deployment/deploy.sh
```

**完整更新（依赖变更）：**

```bash
# 服务器
cd /home/ubuntu/app
./deployment/backup-db.sh  # 先备份
# 然后运行部署脚本上传新版本
pm2 restart coc-agent
```

### 数据库备份与恢复

**手动备份：**
```bash
/home/ubuntu/app/deployment/backup-db.sh
```

**恢复备份：**
```bash
pm2 stop coc-agent
gunzip -c /home/ubuntu/app/backups/coc_game_YYYYMMDD_HHMMSS.db.gz > /home/ubuntu/app/data/coc_game.db
pm2 start coc-agent
```

**下载备份到本地：**
```bash
scp -i your-key.pem ubuntu@<IP>:/home/ubuntu/app/backups/*.db.gz ./
```

### SSL 证书续期

Let's Encrypt 证书每 90 天过期，Certbot 会自动续期。

**手动续期：**
```bash
sudo certbot renew
sudo systemctl reload nginx
```

---

## 🐛 故障排查

### 应用无法启动

```bash
# 查看详细日志
pm2 logs coc-agent --lines 200

# 检查端口占用
sudo lsof -i :3000

# 检查环境变量
cat /home/ubuntu/app/.env

# 测试数据库连接
sqlite3 /home/ubuntu/app/data/coc_game.db ".tables"

# 重启应用
pm2 restart coc-agent
```

### WebSocket 连接失败

```bash
# 检查 Nginx WebSocket 配置
sudo nginx -T | grep -A 10 "location /ws"

# 确保包含这两行：
# proxy_set_header Upgrade $http_upgrade;
# proxy_set_header Connection "upgrade";

# 重载 Nginx
sudo nginx -t && sudo systemctl reload nginx
```

### HTTPS 不工作

```bash
# 检查证书状态
sudo certbot certificates

# 检查 Nginx 配置
sudo nginx -t

# 查看 Nginx 错误日志
sudo tail -100 /var/log/nginx/error.log

# 重新获取证书
sudo certbot --nginx -d your-domain.com --force-renewal
```

### 内存不足

```bash
# 查看内存使用
free -h
pm2 monit

# 重启释放内存
pm2 restart coc-agent

# 如果持续问题，考虑升级到 t3.small (2GB)
```

---

## 💰 成本预估

| 服务 | 配置 | 月费用 |
|------|------|--------|
| EC2 实例 | t3.micro | $7.50 |
| EBS 存储 | 20 GB gp3 | $1.60 |
| 弹性 IP | 已绑定 | $0.00 |
| Route 53 | 可选 | $0.50 |
| SSL 证书 | Let's Encrypt | $0.00 |
| **AWS 总计** | | **$9.60** |
| OpenAI API | 预估 | $10-30 |
| **月度总计** | | **$20-40** |

---

## 📚 参考资源

- [完整部署计划](/Users/sunyining/.claude/plans/mighty-snacking-fiddle.md)
- [PM2 文档](https://pm2.keymetrics.io/)
- [Nginx 文档](https://nginx.org/en/docs/)
- [Let's Encrypt 文档](https://letsencrypt.org/docs/)
- [AWS EC2 文档](https://docs.aws.amazon.com/ec2/)

---

## ✅ 部署检查清单

### 部署前
- [ ] 准备域名或子域名
- [ ] 生成 EC2 SSH 密钥对
- [ ] 获取 OpenAI/Google API 密钥

### AWS 配置
- [ ] 启动 t3.micro Ubuntu 实例
- [ ] 配置安全组（22, 80, 443）
- [ ] 分配弹性 IP
- [ ] 配置 DNS A 记录

### 服务器配置
- [ ] 安装 Node.js 20、pnpm、Nginx、Certbot、PM2
- [ ] 配置 UFW 防火墙
- [ ] 配置 SSH 安全

### 应用部署
- [ ] 上传代码
- [ ] 配置 .env 文件
- [ ] 启动 PM2 应用
- [ ] 配置 Nginx
- [ ] 获取 SSL 证书

### 验证和监控
- [ ] 测试 HTTPS 访问
- [ ] 测试用户注册/登录
- [ ] 测试游戏功能
- [ ] 配置数据库备份
- [ ] 设置外部监控

---

## 🆘 获取帮助

如果遇到问题：

1. 查看本文档的故障排查部分
2. 检查应用日志：`pm2 logs coc-agent`
3. 查看系统日志：`journalctl -u pm2-ubuntu`
4. 参考完整部署计划文档

---

**祝部署顺利！** 🚀
