---
title: 在 Ubuntu 上自建图床：PicFast + Docker + Nginx 部署笔记
published: 2026-11-13
description: 从安装 Docker、配置环境变量、启动容器，到 Nginx 反代、HTTPS 证书、上传工具对接与备份排错，记录在一台 Ubuntu 服务器上把 PicFast 图床跑起来的完整流程。
tags: [Ubuntu, Docker, Nginx, 图床, 运维]
category: 运维笔记
image: ''
draft: false
lang: ''
pinned: false
slug: picfast-image-hosting
---

把图片寄存在别人的图床里，最让人不放心的往往不是容量，而是某一天整片外链突然失效。自建一套其实没那么重：一台 Ubuntu 小机器、一个子域名、Docker 加 Nginx，再配一张证书，就能把上传、外链和备份都握在自己手里。

这篇记录的是用 [PicFast](https://github.com/atbeta/picfast) 搭图床的完整流程，适用 Ubuntu 22.04 / 24.04、仅 SSH 管理、域名已解析到服务器、目标是图片上传与公开外链。

> [!WARNING] 动手之前先核对官方资料
> 本文的命令、变量名与端口按 **2026-11-13** 核对的官方仓库（`atbeta/picfast`，`main` 分支，当时仍在维护）整理。但 Compose 文件、环境变量、数据卷和客户端集成方式随时会变，执行前请打开[官方部署文档](https://picfast.dev/docs/deployment)与仓库 `docker/` 目录复核；若与本文不一致，一律以官方为准。特别注意 `https://picfast.dev/docs/` 这个根路径目前返回 404，部署文档实际在 `/docs/deployment`。如果项目维护状态已不适合新部署，换一个仍在维护的图床即可，本文的 Docker、Nginx、HTTPS 和安全原则仍然通用。

## 一、架构与准备

访问链路大致是这样：

```text
浏览器 / PicGo
   │ HTTPS
   ▼
Nginx :443（img.example.com）
   │ 反向代理 127.0.0.1:18080
   ▼
PicFast 容器 :8080
   ├── ./data/uploads、./data/thumbnails（图片与缩略图）
   └── PostgreSQL 容器（./data/postgres）
```

开工前需要备好：

- Ubuntu 22.04 或 24.04，一个有 `sudo` 权限的 SSH 账号。
- 一个已解析的图床子域名，例如 `img.example.com`，A 记录指向服务器公网 IP；启用 IPv6 时也要确认 AAAA 正确。
- 云厂商安全组与主机防火墙放行 TCP 22（SSH）、80、443。**不要把应用端口或数据库端口暴露到公网**。
- 磁盘能装下预期的图片增长；1 核 / 2 GB 内存可作为起步参考，实际按官方当前要求和使用量来定。
- 确认 80/443 上是否已有站点或 Nginx。若已有，复用现有配置，别覆盖默认配置。

> [!NOTE] 示例值都要替换
> 下文的 `img.example.com`、邮箱、密码、域名和路径都是占位符，请换成自己的值。

## 二、安装 Docker、Nginx 与证书工具

SSH 登录后：

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx curl openssl
sudo systemctl enable --now docker
sudo systemctl enable --now nginx
```

确认版本：

```bash
docker --version
docker compose version
nginx -v
```

Ubuntu 软件源里的 Docker 版本可能落后于官方仓库。轻量部署可以先用系统包；若 PicFast 当前文档要求较新版本，按 [Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 安装，注意不要混装不同来源。

### 防火墙

用 UFW 时，先把 SSH 规则加好，避免把自己锁在外面：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

确认 SSH 入口仍可用后，才在**确实尚未启用** UFW 的机器上执行：

```bash
sudo ufw enable
```

云服务商控制台的安全组也要放行 80/443。不要放行 18080，更不要放行数据库端口。

## 三、下载并配置 PicFast

官方仓库的 `docker/` 目录里放着 `docker-compose.yml` 和 `.env.example`。这里把它们放到 `/opt/picfast` 作为工作目录：

```bash
sudo mkdir -p /opt/picfast
sudo chown "$USER":"$USER" /opt/picfast
cd /opt/picfast

curl -fL https://raw.githubusercontent.com/atbeta/picfast/main/docker/docker-compose.yml -o docker-compose.yml
curl -fL https://raw.githubusercontent.com/atbeta/picfast/main/docker/.env.example -o .env
```

> [!TIP] raw 域名连不上怎么办
> 如果 `raw.githubusercontent.com` 在你的网络环境里访问受限，直接从仓库 `docker/` 目录把这两个文件内容复制下来即可，效果一样。也别默认 `main` 就等同于验证过的稳定版本，先看一眼内容：

```bash
sed -n '1,240p' docker-compose.yml
sed -n '1,240p' .env
```

编辑环境配置：

```bash
nano .env
```

按当前官方 `.env.example` 核对后，一份最小可用的配置大致是：

```env
TZ=Asia/Shanghai
PICFAST_IMAGE=xbeta/picfast:latest

# 容器内服务监听 8080，这里只控制宿主机映射
PICFAST_HTTP_BIND=127.0.0.1
PICFAST_HTTP_PORT=18080

# PicFast 认为的「对外站点地址」，必须是真实访问地址
PICFAST_SERVER_BASE_URL=https://img.example.com

# 数据库三项在官方 Compose 里没有默认值，必须填写
POSTGRES_DB=picfast
POSTGRES_USER=picfast
POSTGRES_PASSWORD=换成独立强密码

PICFAST_JWT_SECRET=换成随机长密钥

# 留空 = 首次访问走浏览器初始化向导；两项都填 = 无人值守创建管理员并跳过向导
PICFAST_APP_ADMIN_EMAIL=
PICFAST_APP_ADMIN_PASSWORD=

PICFAST_APP_ALLOW_GUEST_UPLOAD=false
PICFAST_APP_ALLOW_REGISTRATION=false
```

几个容易踩的点：

- **数据库变量别漏。** `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` 在 Compose 里被直接引用且无默认值，漏填会让 `docker compose up` 报错。
- **端口默认已经只绑本机。** `127.0.0.1:18080 → 容器 8080` 正是给 Nginx 反代用的，没有特殊需求不要改成 `0.0.0.0`。
- **管理员账号二选一。** 留空就打开页面用初始化向导创建；两项都填则自动创建管理员、跳过向导。
- **访客上传和公开注册保持关闭**，这两个开关默认就是 `false`。
- 密钥用 `openssl rand -hex 32` 生成后填进去。
- `nano` 保存是 `Ctrl+O`、回车、`Ctrl+X`。

```bash
openssl rand -hex 32
chmod 600 .env
```

> [!CAUTION] `.env` 里有密码和密钥
> 不要提交到 Git、不要发给别人、不要放在公开可访问的目录。

顺便记一下数据落在哪：官方 Compose 把卷挂到 `./data/postgres`、`./data/uploads`、`./data/thumbnails`、`./data/backups`，路径相对 Compose 文件所在目录。按本文的布局，它们就在 `/opt/picfast/data/` 下；如果你是在仓库自带的 `docker/` 目录里运行，则会变成 `docker/data/`。后面做备份时按实际位置来。

## 四、启动与自检

```bash
cd /opt/picfast
docker compose config
docker compose up -d
docker compose ps
docker compose logs --tail=100
```

`docker compose config` 能提前发现配置错误。官方 Compose 给数据库和应用都配了健康检查（数据库用 `pg_isready`，应用请求 `/health`），`docker compose ps` 里可以直接看状态。若启动失败，按日志检查必填变量、数据库健康状态、端口冲突和目录权限。

## 五、配置 Nginx 反向代理

新建站点配置：

```bash
sudo nano /etc/nginx/sites-available/picfast
```

写入（域名和上游端口按实际值替换）：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name img.example.com;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

`client_max_body_size` 要和应用自身的上传上限匹配；服务器没有 IPv6 就删掉 `listen [::]:80;`。若这台机器还跑着别的站点，确认 `server_name` 唯一，也别覆盖已有配置。

```bash
sudo ln -s /etc/nginx/sites-available/picfast /etc/nginx/sites-enabled/picfast
sudo nginx -t
sudo systemctl reload nginx
```

如果软链接已经存在，先查看现有配置，不要重复创建或覆盖。此时 DNS 生效的话，`http://img.example.com` 应该能打开。

## 六、申请 HTTPS 证书

先确认 A/AAAA 记录正确、安全组和 UFW 都放行了 80/443，然后：

```bash
sudo certbot --nginx -d img.example.com
```

按提示填邮箱并选择启用 HTTP → HTTPS 跳转。再验证自动续期：

```bash
sudo certbot renew --dry-run
```

之后统一走 `https://img.example.com`。证书签发失败时，依次检查 DNS、IPv6 是否误指向、80 端口能否从公网访问，以及是否有 CDN 代理干扰了验证。Certbot 的当前用法可对照 [官方说明](https://certbot.eff.org/instructions)。

## 七、初始化与上传测试

1. 浏览器打开 `https://img.example.com`。
2. 按当前版本的初始化流程创建或登录管理员：`.env` 里两项管理员变量留空就走向导，都填则已经自动创建好了。不要假设一定存在「首次注册页面」。
3. 在管理设置里关闭不需要的公开注册 / 匿名上传，设置上传大小上限，确认存储用的是持久化卷。
4. 上传一张**不敏感**的测试图，复制程序生成的公开 URL，换一个未登录的浏览器窗口验证能否访问。
5. 检查 HTTPS、外链路径、删除行为，以及重启服务后图片是否还在。

> [!NOTE] 外链路径不要照抄
> 图片 URL 的格式由应用版本决定，以界面实际生成的为准，别沿用旧教程里的 `/i/...` 之类路径。

## 八、对接 PicGo 等上传工具

PicFast 提供管理后台和开放 API，可与 PicGo、PicList、ShareX 一类工具集成；具体插件名、API 路径和字段属于易变细节，请以官方当前客户端文档为准，不要靠猜。

通常流程：

1. 在管理界面创建**专用**上传令牌 / API Token（若当前版本支持），别拿管理员密码当长期客户端凭据。
2. 在 PicGo 里选择官方支持的适配器，填写 `https://img.example.com`、令牌以及文档要求的字段。
3. 上传一张测试图，确认返回的 URL 是 HTTPS 且可公开访问。
4. 令牌保存在本机安全位置，一旦泄露立即撤销并重建。

## 九、日常维护与升级

在 `/opt/picfast` 下：

```bash
# 查看容器状态
docker compose ps

# 查看近期日志
docker compose logs --tail=200

# 跟踪日志
docker compose logs -f

# 重启服务
docker compose restart
```

升级前先读官方 CHANGELOG、做好备份，按官方升级步骤拉取**明确版本**再更新：

```bash
docker compose pull
docker compose up -d
```

> [!CAUTION] 两个升级禁区
> 想要可复现的部署，就固定官方发布的版本标签，别无条件跟 `latest`；数据库结构升级通常不能直接回滚，升级前必须有可恢复的备份。另外 `docker compose down` 会停止容器但一般保留命名卷，**不要加 `-v`**，除非你确实要连数据一起删掉。

## 十、备份与安全

- 一致性备份要同时覆盖图片 / 缩略图目录、数据库和必要配置（`docker-compose.yml` 与 `.env`）。本文布局下图片在 `/opt/picfast/data/uploads`，数据库在 `./data/postgres`，但实际位置以你核对过的 Compose 卷映射为准。
- 数据库用应用支持的导出 / 备份方式，**不要只在数据库运行时复制它的数据目录**。
- 备份要复制到另一台机器或对象存储，并定期做恢复演练。同盘副本挡不住磁盘故障。
- `.env`、数据库备份和上传目录设最小权限；管理端口、数据库端口一律不对外。
- 管理员密码使用独立强密码，关闭公开注册 / 匿名上传，及时撤销泄露的令牌。
- 定期装 Ubuntu 安全更新，关注 PicFast、Docker 镜像、Nginx 和证书状态；限制上传类型与大小，盯着磁盘空间。
- 外链是公开可访问资源，别上传私人或敏感图片。一旦被滥用，先关匿名上传、撤销令牌，再查访问日志。

## 十一、常见问题速查

| 现象 | 优先检查 |
| --- | --- |
| 域名打不开 | DNS、云安全组、UFW、Nginx 是否运行、`sudo nginx -t` |
| 502 Bad Gateway | `docker compose ps`、应用日志、Nginx `proxy_pass` 端口、容器监听地址 |
| 上传大图失败 | 同时检查 Nginx `client_max_body_size` 与 PicFast 上传上限 |
| 重启后图片消失 | Compose 卷是否持久化、宿主机目录权限、实际数据目录位置 |
| HTTPS 签发失败 | A/AAAA 记录、80/443 连通性、证书状态、系统时间、CDN 代理 |
| PicGo 上传失败 | 官方支持的插件版本、API Token 权限、服务端 URL、当前 API 配置 |

## 部署当天核对清单

- [官方部署文档](https://picfast.dev/docs/deployment)与 [GitHub 仓库](https://github.com/atbeta/picfast)：维护状态、稳定版本、`docker/` 目录里的 Compose 与 `.env.example`、必填变量、端口、数据卷、升级与备份步骤。
- [Docker Engine 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)：Ubuntu 版本支持与安装来源。
- [Certbot 官方说明](https://certbot.eff.org/instructions)：当前 Ubuntu / Nginx 的证书申请方式。
- PicGo 官方发行版与 PicFast 当前客户端集成文档：插件名称、配置字段、令牌方式。

自建图床真正费心的不是第一次跑通，而是之后一直跑得稳：证书会自动续、数据有异地备份、令牌没到处乱放、磁盘还有余量。把这几件小事维持住，那些图片链接才真的算是自己的。
