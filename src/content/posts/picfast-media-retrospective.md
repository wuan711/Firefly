---
title: 给图床加视频音频：从摸底到上线的实战复盘
published: 2026-11-24
description: 七天时间把视频与音频能力加进自建图床，记录最终架构、六个后端流式存储、弱网构建、致命的 HTTP 超时、Chromium 媒体文档陷阱、HEVC 兼容与线上验证数据。
tags: [PicFast, Go, 媒体, 运维, 复盘]
category: 技术复盘
image: ''
draft: false
lang: ''
pinned: false
slug: picfast-media-retrospective
---

上一篇写的是「动手之前」：为什么不能直接复用图片的 `[]byte` 链路、为什么媒体必须独立成模块。这一篇写「动手之后」：七天里架构最终长成什么样、哪些坑真的把人拦住了、以及拿什么证据确认它跑通了。

项目从摸底到上线历时约一周，功能已经部署到线上并验收通过，但仍有几处明确的限制留在待办里——这篇会把它们一并写清楚，不粉饰成「完美收工」。

> [!NOTE] 系列衔接
> 本文是《给自建图床加视频和音频：PicFast 媒体扩展前期摸底》的续篇。前篇讲设计判断，本篇讲落地结果。所有结论都来自实际日志、测试输出与线上验证，不是推测。

## 一、最终架构

分层仍然是摸底时定下的那条线：**原图片模块一行不改，媒体模块独立一套**，只在认证、用户组、容量和存储策略上共享现有能力。

```text
┌────────────────────────────────────────────────────────┐
│ 现有公共能力：认证(JWT/API Token) · 用户组 · 容量 · 策略 │
├──────────────────────┬─────────────────────────────────┤
│ 原图片模块（不改动） │ 新增媒体模块                    │
│ handler/service/sqlc │ MediaHandler / MediaService     │
│ images 表            │ media_files 表                  │
│ Storage([]byte)      │ StreamingStorage(io.Reader)     │
└──────────────────────┴─────────────────────────────────┘
```

### 数据表

迁移 `037` 新增独立的 `media_files` 表，迁移文件随应用启动自动执行（`PICFAST_DATABASE_AUTO_MIGRATE` 默认开启）：

```sql
CREATE TABLE media_files (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT REFERENCES users(id) ON DELETE SET NULL,
    group_id          BIGINT REFERENCES groups(id) ON DELETE SET NULL,
    strategy_id       BIGINT REFERENCES strategies(id) ON DELETE SET NULL,
    key               VARCHAR(32) NOT NULL UNIQUE,
    path              TEXT NOT NULL DEFAULT '',
    name              VARCHAR(255) NOT NULL,
    origin_name       VARCHAR(255) NOT NULL DEFAULT '',
    size_bytes        BIGINT NOT NULL DEFAULT 0,
    mimetype          VARCHAR(64) NOT NULL,
    extension         VARCHAR(16) NOT NULL,
    media_type        VARCHAR(16) NOT NULL CHECK (media_type IN ('video','audio')),
    duration_seconds  DOUBLE PRECISION,
    permission        SMALLINT NOT NULL DEFAULT 0,
    uploaded_ip       VARCHAR(45) NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`user_id` 允许为空，是为了兼容游客上传；索引建在 `(user_id, created_at DESC)`、`group_id`、`strategy_id` 上。

### 流式存储接口

原 `Storage` 以 `[]byte` 收发，1GB 文件必然撑爆内存。新增的独立接口只有两个方法，六个存储后端全部实现：

```go
type StreamingStorage interface {
    WriteStream(ctx context.Context, path string, body io.Reader, size int64, contentType string) error
    OpenStream(ctx context.Context, path string) (io.ReadCloser, error)
}
```

| 后端 | 流式写 | 流式读 |
| --- | --- | --- |
| local | `os.Create` + `io.Copy` | `os.Open` |
| s3 / tos / obs | `PutObject(Body=io.Reader)` | `GetObject().Body` |
| cos | `Object.Put(io.Reader)` | `Object.Get().Body` |
| oss | `PutObject(io.Reader)` | `GetObject()` |
| kodo | `uploader.Put(io.Reader, size)` | `manager.Get()` |
| webdav | `PUT` + `Content-Length` | `GET` + `resp.Body` |

指标包装 `WithMetrics` 也同步扩展，底层支持流式时返回带指标的包装，指标名沿用 `put` / `get`。

### 接口与前端

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/media` | DualAuth + `write` | 登录用户上传 |
| POST | `/api/v1/media/upload` | OptionalDualAuth + `write` | 游客上传，受开关 / 容量 / 限流约束 |
| GET | `/api/v1/media` | DualAuth | 分页列出本人媒体 |
| DELETE | `/api/v1/media/{key}` | DualAuth + `write` | 所有者或管理员删除，同时清理存储对象 |
| GET/HEAD | `/v/{key}` | OptionalAuth | 视频读取，支持 Range / 206 / 416 |
| GET/HEAD | `/a/{key}` | OptionalAuth | 音频读取，同上 |

> [!TIP] 直链为什么要返回播放页
> 当请求带 `Accept: text/html` 且没有 `Range` 时，读取端点返回的是一个内嵌 `<video>` / `<audio>` 的 HTML 页面（约 1.2KB），页面元素再带 `?raw=1` 复用同一处理器拿原始字节；`curl`、播放器和 API 客户端仍然直接拿到文件流。这个设计不是多此一举，后面第三节会讲它解决的具体问题。

前端新增 `/console/media` 懒加载路由，控制台侧边栏与移动端抽屉都加了入口，支持上传进度、公开/私有、分页列表、内嵌播放、复制直链和删除二次确认，中英双语 16 个文案 key 同步补齐。还有个细节：在 `loadedmetadata` 后检查 `videoWidth === 0`，用来判定视频轨道无法解码，提示「可能是 H.265/HEVC」并给下载入口。

## 二、实施顺序

实际走下来是十二步，前六步是代码，后六步是验证与上线：

1. 建功能分支、写迁移 037、补 SQLC 查询并生成代码
2. 实现 `StreamingStorage` 与六个后端
3. 实现 `MediaService`：流式写、签名校验、配额、限流、失败清理
4. 实现 `MediaHandler`、路由注册、列表与删除
5. 前端媒体页、导航、i18n
6. 集成测试（真实 PostgreSQL + 真实 chi 路由）
7. 本地验证：build / vet / test / lint / 前端 build，全绿
8. 服务器构建镜像（弱网中断，多次重试）
9. Nginx 放开上传与超时、调整用户组配置
10. 线上验收：上传、播放、Range、直链
11. 修复大文件超时、直链播放页、编码提示
12. 代码提交，工作区干净

## 三、踩过的坑（这篇的重点）

### 3.1 弱网服务器上，构建本身就是一场战斗

`deb.debian.org` 在国内约 200KB/s，而 `libvips-dev` 依赖上百个包，构建跑了 30 分钟卡在 `apt`。更麻烦的是前台运行加 `| tee | tail` 会缓冲，SSH 一掉线 SIGHUP 直接把进程杀掉，每次断网都要从头再来。

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 反复从头构建 | 前台运行，SSH 掉线被 SIGHUP 杀掉 | `nohup … > /tmp/build.log 2>&1 &` 后台运行 |
| 看不到实时进度 | `\| tail` 缓冲到结束才输出 | 另开窗口 `tail -f` 日志 |
| `sed` 删不掉某一行 | 该行空白字符不是普通空格，模式没匹配上但 `grep -c` 返回 0 造成假象 | 改用行号删除 `sed -i '50d'` |
| 构建产物路径不对 | `docker build .` 默认找根目录 `Dockerfile`，实际在 `docker/` 下 | 始终显式 `-f docker/Dockerfile` |

最后删掉了可选的 `apt-get upgrade` 层，全部命中缓存才跑完。**弱网构建的通用原则：后台运行、独立日志、断点重试、显式指定 Dockerfile。**

### 3.2 致命问题：写死的 HTTP 超时

这是整个项目最隐蔽也最致命的一处。入口文件里原本写着：

```go
srv := &http.Server{
    ReadTimeout:  30 * time.Second,   // 读取整个请求（含 body）
    WriteTimeout: 60 * time.Second,   // 写整个响应
}
```

在图片场景完全无感，一上大文件立刻现形：182MB 上传在 **30.018 秒**被判 400 `failed to parse multipart form`；1GB 视频在 5Mbps 下需要约 27 分钟下载，60 秒必然被切断。

修复是把两处都交给前置 Nginx 控制，并关掉 chi 的 60 秒上下文超时：

```go
ReadTimeout:  0,
WriteTimeout: 0,
```

```env
PICFAST_SERVER_READ_TIMEOUT=0s
```

验证用的是 `curl --limit-rate 60k` 拉一个 6.5MB 音频：耗时 **106.5 秒**仍完整返回 6,584,592 字节，旧版会在 60 秒处截断。

> [!CAUTION] 大文件需求先审计超时
> 「能上传」和「能传完」是两回事。任何涉及大文件的功能，动手前应该先把 HTTP 服务器、反向代理、框架上下文三层的超时全部翻一遍。

### 3.3 Chromium 的顶层媒体文档会中途改主意

现象很诡异：同一个视频，**页面内 `<video>` 能播，直接打开链接永远停在 0:00**。日志给出了答案：

```text
16:13:57  GET /a/<key>  200 1300160  referer "-"   ← 普通请求只送 1.3MB / 2.8MB 就中断
16:14:01  GET /a/<key>  206 2823665  referer "-"   ← 浏览器改用 Range 重试，完整拿到
16:14:12  GET /v/<key>  200  294199  referer "-"   ← 视频：中断后不再重试，永远 0:00
```

Chromium 把媒体文件当顶层文档打开时，会先发普通 GET、收一部分后中断再改用 Range 重发；但部分文件（尤其 HEVC）不会重试，于是画面永远不动。

解决方案就是第一节提到的**直链返回 HTML 播放页**：让浏览器进入一个正常网页，由页面里的 `<video>` 元素去请求带 `?raw=1` 的原始流，彻底绕开「媒体文档」这条路径。另外还有个伴随现象：浏览器会缓存那个被中断的 200 响应，导致复现时服务器连日志都没有——用无痕窗口或加 `?v=` 绕过即可。

### 3.4 H.265 只能听见声音

用户上传的 mp4 检查出来是 `hvc1`（HEVC）+ `mp4a`：

```bash
grep -a -o -E 'hvc1|hev1|avc1|av01|vp09' file.mp4 | sort -u
# hvc1
```

Windows 上的 Edge / Chrome 默认没有 HEVC 解码器，结果是**音轨能放、视频轨解不出（画面全黑）**，而且不触发 `error` 事件，排查时极具迷惑性。

处理方式有三层：前端用 `videoWidth === 0` 明确提示并提供下载入口；推荐用户本地转码：

```bash
ffmpeg -i in.mp4 -c:v libx264 -crf 23 -c:a copy out.mp4
```

服务器自动转码只列为后续可选项——4 核 4GB 加 5Mbps 上行，代价太高。

### 3.5 配置不改，代码等于没写

默认用户组配置是这样的：

```json
{ "maximum_file_size": 5242880,
  "accepted_extensions": ["jpeg","jpg","png","gif","webp","bmp","svg","ico"] }
```

媒体上传必然 400，因为扩展名全在图片白名单里、上限也只有 5MB。部署时必须把组配置改成 1GB 并加入 `mp4/webm/mkv/mov/mp3/wav/m4a/flac/ogg/aac/opus` 等扩展名。

> [!NOTE] 别担心图片被放大到 1GB
> 图片上传在 handler 层还有 50MiB 的硬上限（`defaultMaxUploadBytes`）保护，提高用户组上限只影响新的媒体链路。

### 3.6 其他零碎但真实的问题

| 问题 | 处理 |
| --- | --- |
| 直接打开链接 0:00 且无服务器日志 | 浏览器缓存了被中断的 200 响应，无痕窗口 / 加 `?v=` 绕过 |
| 上传报 `Network Error` | 其实是登录态过期导致 401 连续刷新失败，重新登录即可 |
| 测试在只读检出 / 沙箱里失败 | 原本要在包目录建临时目录，改成纯路径计算 |
| Windows 盘符被当成 URL host | 迁移源改用 opaque file URL |
| npm bin 权限位被改成 100644 | 提交前 `git add --chmod=+x` 还原 |

## 四、验证记录

本地自动化验证全绿：

```text
go build -tags novips ./...                     exit 0
go vet   -tags novips ./...                     exit 0
go test  -tags novips -count=1 ./...            exit 0（19 个包）
pnpm lint                                       exit 0
pnpm build（含 tsc -b）                         exit 0
```

媒体相关测试跑的是真实 PostgreSQL 加真实路由，覆盖上传落库、Range / HEAD / 416、私有权限的匿名·他人·本人 Bearer·本人 `?token=`·管理员、游客上传的 `user_id IS NULL`、列表分页与越权删除 403、删除后记录与磁盘对象一起消失、播放页与原始流的分流、伪装扩展名被拒、未配置组媒体限制时明确 400 等场景。

线上实测：

| 项目 | 结果 |
| --- | --- |
| 音频（6.3MB mp3）上传 | 201，`media_files` 有记录 |
| 音频页内播放 | `0:08 / 4:20`，正常 |
| Range 请求 | `206`，`Content-Range: bytes 0-99/6584592` |
| 直链（浏览器） | `200 text/html`，返回播放页 |
| 直链（API） | `200 audio/mpeg`，完整 2,823,665 字节 |
| 限速下载（60KB/s，6.5MB） | 106.6 秒完整返回，验证超时修复 |
| 182MB 上传 | 修复前 30 秒失败；修复后待复测 |

## 五、部署与运维要点

Nginx 侧的关键改动（原值分别是 `100m` 和 `300s`）：

```nginx
client_max_body_size 1024m;
client_body_timeout 600s;
proxy_request_buffering off;     # 上传不落 Nginx 临时盘
proxy_buffering off;             # 播放不落临时盘
proxy_read_timeout 600s;
```

环境变量里三项要注意：镜像标签固定到自建版本、`PICFAST_SERVER_READ_TIMEOUT=0s` 关闭框架超时、`PICFAST_JWT_SECRET` 必须固定，否则每次重启都会掉登录。

发布流程的骨架是：打包源码树（排除 `node_modules`、`web/dist`、`.git`、`bin`、`data`）传到服务器 → 后台构建镜像并显式指定 `-f docker/Dockerfile` → 备份 `.env` 后替换镜像标签 → `docker compose up -d` → 用 `/health` 确认。回滚就是把镜像标签改回官方版本再 `up -d`。

> [!CAUTION] 两件上线前必须做的事
> 数据库 dump 要写到有权限的目录，别直接写进容器挂载、属主为应用用户的 `data/backups`；另外迁移的 down 脚本会删表，回滚迁移前先确认备份可用。本次上线前留了改造前的完整备份和上线前的数据库 dump，但**媒体文件尚未纳入备份脚本**。

## 六、已知限制与后续

| 项 | 说明 |
| --- | --- |
| 无转码 | HEVC / MKV 等浏览器不能播，只能提示 + 下载 |
| `duration_seconds` 恒为空 | 未解析媒体时长 |
| 无游客媒体上传入口 | 后端接口已可用且有测试，前端游客页未接入 |
| 媒体无搜索 / 筛选 | 列表仅按时间倒序分页 |
| 远端存储 Range 低效 | 请求某段时从文件头读到起点，云存储会多耗流量 |
| 备份未覆盖媒体文件 | `data/uploads` 中的媒体未纳入备份 |
| 构建目录与仓库 Dockerfile 不一致 | 服务器为适配弱网删掉了 `apt-get upgrade` 层 |

后续顺序：先用 **H.264** 视频做一次 1GB 全链路实测 → 把媒体文件纳入备份并评估 60GB 磁盘容量策略 → 解析 `duration_seconds` → 优化对象存储 Range → 再视需求考虑服务器转码和列表增强。

## 七、六条经验

1. **写死的超时是隐藏的定时炸弹**：`ReadTimeout 30s` / `WriteTimeout 60s` 在图片场景完全无感，一上大文件立刻致命。
2. **弱网构建要按「会断」来设计**：后台运行、独立日志、断点重试、国内镜像源。
3. **浏览器不是「能播所有文件」**：H.265、MKV 在 Chrome / Edge 上默认不可用，图床类产品必须在上传端或展示端明确告知编码兼容性。
4. **直链不要依赖浏览器的媒体文档**：返回带 `<video>` 的 HTML 页，兼容性和可维护性都更好。
5. **配置与代码同等重要**：用户组的 `maximum_file_size` / `accepted_extensions` 不改，媒体功能等于不可用。
6. **验证要拿证据**：30.018 秒失败、106.5 秒完整下载、`hvc1` 编码、206 分段——所有结论都来自日志与实测，而不是推测。

从一个「加个上传按钮」的念头，到最后要同时改 HTTP 超时、Nginx 缓冲、组配置、浏览器播放策略和编码提示，中间隔着的正是这类功能真正的复杂度。摸底时圈出「不能动的东西」，上线后补上「必须一起改的东西」，这个项目才算真的跑通。
