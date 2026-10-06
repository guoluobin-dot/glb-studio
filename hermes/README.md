# Hermes AI — GLB 智能记忆与带货话术引擎

> 为 GLB 直播切片工具打造的 AI 伴随服务：学习你的节奏、爆点、留存模式，形成永久记忆，自动生成并嵌入带货话术，让你每次混剪都越来越贴合自己的爆款逻辑。完全本地化，Ollama 驱动，零云端依赖。

---

## 目录

- [一、Hermes 是什么](#一hermes-是什么)
- [二、系统架构](#二系统架构)
- [三、快速开始](#三快速开始)
- [四、配置说明](#四配置说明)
- [五、与 GLB 联动](#五与-glb-联动)
- [六、话术库格式](#六话术库格式)
- [七、API 接口文档](#七api-接口文档)
- [八、工作流程详解](#八工作流程详解)
- [九、故障排查](#九故障排查)

---

## 一、Hermes 是什么

Hermes 是一个独立运行的本地服务，与 GLB 全家桶配合使用，提供三项核心能力：

| 能力 | 说明 |
|------|------|
| **永久记忆** | 每处理一个视频，自动学习其节奏、爆点位置、留存信号、话术模式，存入 SQLite，形成你的专属"内容 DNA" |
| **爆点进化** | 积累足够样本后，Hermes 反向调整 GLB 的爆点检测参数（最佳切片时长、间隔、节奏曲线），让检测越来越准 |
| **带货话术** | 从你的历史视频中提取话术模式（钩子/紧迫感/CTA/社会认同），在新视频中自动生成匹配的话术并嵌入字幕 |
| **记忆调用** | 粗剪/标题/封面生成时自动检索记忆库：标题往验证过的爆款主题上靠，话术复用你的高频句式，教学类内容默认织入软CTA（`soft_cta`：追更/关注/直播预告，藏在内容流里不显广告味） |

**设计原则：**
- 不改动 GLB 本体（app.asar 及内部代码零修改）
- 完全本地运行，使用全家桶内置的 Ollama + Qwen3 8B
- 数据全部存在本地 `data/hermes.db`
- 从零开始积累，处理越多视频越聪明

---

## 二、系统架构

```
┌──────────────────────────────────────────────────────────┐
│                    你的电脑 (Win10/11)                     │
│                                                          │
│  ┌─────────────┐        Webhook          ┌────────────┐ │
│  │             │ ──────────────────────► │            │ │
│  │   GLB   │  事件: 转写完成/        │   Hermes   │ │
│  │  (v0.14.1)  │  爆点检测/导出完成       │   服务     │ │
│  │             │ ◄────────────────────── │  (:17841)  │ │
│  │             │  爆点配置覆盖/话术       │            │ │
│  └──────┬──────┘                        └─────┬──────┘ │
│         │                                     │        │
│         │ 文件监听 (chokidar)                 │        │
│         └─────────── 输出目录 ◄───────────────┘        │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │                  Hermes 内部模块                     ││
│  │                                                     ││
│  │  ┌───────────┐  ┌───────────┐  ┌────────────────┐  ││
│  │  │  爆点学习  │  │  话术引擎  │  │  记忆存储层     │  ││
│  │  │  Learner   │  │  Copy En. │  │  SQLite+Vector │  ││
│  │  └─────┬─────┘  └─────┬─────┘  └───────┬────────┘  ││
│  │        │               │                │           ││
│  │        └───────────────┴────────────────┘           ││
│  │                        │                             ││
│  │                   Ollama API                         ││
│  │              (localhost:11434)                       ││
│  │               Qwen3 8B Chat                          ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 文件结构

```
Hermes/
├── src/
│   ├── hermes.js              # 主入口（启动服务 / 状态查询）
│   ├── llm/
│   │   └── ollama.js          # Ollama API 客户端（chat + embedding）
│   ├── memory/
│   │   └── store.js           # SQLite 记忆存储（6张表 + 向量检索）
│   ├── highlight/
│   │   └── learner.js         # 爆点学习模块（节奏/情绪/留存信号提取）
│   ├── copywriting/
│   │   └── engine.js          # 带货话术引擎（提取/生成/字幕转换）
│   └── orchestrator/
│       └── index.js           # GLB 联动编排器（Webhook + 文件监听）
├── config/
│   └── default.json           # 全部配置项
├── data/
│   ├── hermes.db              # SQLite 记忆数据库（自动创建）
│   ├── hermes.log             # 运行日志
│   └── copywriting-presets.json  # 话术预设模板
├── package.json
└── README.md
```
（启动统一走全家桶根目录的 `启动GLB.cmd`，内含启动/停止菜单）

---

## 三、快速开始

### 前置条件

| 依赖 | 版本要求 | 检查命令 |
|------|---------|---------|
| Node.js | >= 18.0.0 | `node --version` |
| Ollama | 已运行 | 浏览器打开 `http://localhost:11434` 看到 `Olympus` 或 `OK` |
| Qwen3 模型 | 已下载 | `ollama list` 包含 `qwen3:8b-chat` |
| GLB | 已安装 | 全家桶目录下有 `GLB.exe` |

> 以上依赖在 GLB 全家桶安装后均已就绪，无需额外安装。

### 安装步骤

1. **把 Hermes 目录放到 GLB 全家桶同级或任意位置**

   推荐结构：
   ```
   D:\
   ├── GLB\
   │   ├── GLB\
   │   ├── Ollama\
   │   └── ...
    └── Hermes\
        ├── src\
        ├── config\
        └── （无启动脚本，统一用全家桶根目录启动GLB.cmd）
    ```

2. **安装依赖**（首次运行，任选其一）

   方法一：全家桶根目录双击 `启动GLB.cmd` 选 [1]，脚本会自动处理依赖并启动服务。

   方法二：手动执行：
   ```bash
   cd Hermes
   npm install
   node src/memory/store.js --init
   ```

3. **启动 Ollama**（如果未设为开机自启）

   全家桶根目录双击 `启动GLB.cmd` 选 [1] 即可（自动处理 Ollama + Hermes）。

4. **启动 Hermes**

   同上，一键启动菜单选 [1]（会新开 "Hermes AI" 黑窗口，不要关）。

   成功启动会显示：
   ```
   [Orchestrator] Ollama connected (v0.32.9)
   [Orchestrator] Available models: qwen3:8b, qwen3:8b-chat
   [Orchestrator] Hermes server running at http://127.0.0.1:17841
   [Orchestrator] Ready. Process videos in GLB - Hermes will learn automatically.
   ```

5. **验证服务**

   浏览器打开 `http://127.0.0.1:17841/health`，看到 `{"ok":true}` 即正常。

### 爆款粗剪看板（推荐入口）

浏览器打开 **`http://127.0.0.1:17841`**（自动跳到 `/dashboard`），或双击全家桶根目录的 **`启动GLB.cmd`**（会自动起服务并打开看板）：

1. **🔥 历史爆款**页：把以前数据最好的 3~10 条短视频拖进来，空闲时自动拆解结构/主题/话术
2. **📡 整场直播**页：把几小时的直播拖进来，转写双通道自动兜底（GLB 转写复用 → Sherpa 本地模型），再按爆款逻辑分段粗剪
3. **❓ 待确认**页：拿不准时 Hermes 会 @你，点一下选项即继续（30 分钟不回自动按默认走）
4. **✅ 成片**页：拿烧好字幕+顶部标题的 `*_final.mp4`、`*.srt`、`*_cover.jpg`，直接发

> 无需改动 GLB 本体。调度器每 30 秒扫一遍 `upload/`，有活就干，没活就歇。

---

## 四、配置说明

所有配置在 `config/default.json` 中：

```json
{
  "server": {
    "port": 17841,          // Hermes 服务端口
    "host": "127.0.0.1"     // 仅本机访问
  },
  "ollama": {
    "baseUrl": "http://localhost:11434/v1",
    "chatModel": "qwen3:8b-chat",    // 对话模型（必须带 -chat）
    "embeddingModel": "qwen3:8b",     // 向量嵌入模型
    "temperature": 0.7,               // 生成温度
    "maxTokens": 4096
  },
  "glb": {
    "webhookSecret": "hermes-local-secret",  // Webhook 密钥
    "outputWatchDir": "<GLB_OUTPUT>",        // GLB 输出目录
    "transcriptDir": "<GLB_OUTPUT>/transcripts",
    "highlightDir": "<GLB_OUTPUT>/highlights",
    "clipDir": "<GLB_OUTPUT>/clips"
  },
  "highlight": {
    "minConfidence": 0.5,     // 爆点最低置信度
    "learningRate": 0.15,     // 学习率（0-1，越大适应越快）
    "minSamplesForPattern": 3 // 形成模式最少样本数
  },
  "copywriting": {
    "presetPath": "data/copywriting-presets.json",
    "maxHooksPerVideo": 5,    // 每个视频最多生成钩子数
    "maxCTAsPerVideo": 3      // 每个视频最多生成CTA数
  }
}
```

### 关键配置项说明

- **outputWatchDir 等 4 个目录**：必须指向 GLB 实际输出路径。在 GLB 设置页里确认导出位置，然后把路径填到这里。
- **webhookSecret**：与 GLB Webhook 配置中的密钥保持一致。
- **learningRate**：0.15 表示新样本占 15% 权重，值越大适应越快但越不稳定，推荐 0.1-0.2。

---

## 五、与 GLB 联动

### 方式一：Webhook 联动（推荐）

GLB 内置 Webhook 自动化接口。配置方法：

1. 启动 Hermes 服务
2. 在 GLB 中打开设置 → Webhook 自动化
3. 填入 Webhook URL：`http://127.0.0.1:17841/webhook`
4. 填入密钥：`hermes-local-secret`（与 config/default.json 一致）
5. 勾选要发送的事件：
   - 转写完成
   - 爆点检测完成
   - 切片导出完成
   - Pipeline 完整结束

配置完成后，GLB 每处理完一个阶段就会通知 Hermes，Hermes 自动学习。

### 方式二：文件监听（自动）

Hermes 会监听 `config/default.json` 中配置的 4 个输出目录：

| 目录 | 监听内容 | 触发动作 |
|------|---------|---------|
| outputWatchDir | 任何新文件 | 判断文件类型 |
| transcriptDir | `*transcript*.json` | 解析转写结果，学习话术 |
| highlightDir | `*highlight*.json` | 解析爆点结果，学习模式 |
| clipDir | `*.mp4/.mov/.mkv` | 生成带货话术并写入覆盖文件 |

**无需任何 GLB 配置**，只要 GLB 的输出文件落到这些目录，Hermes 就会自动处理。

### 方式三：手动 API 调用

直接调用 Hermes API 提交视频：

```bash
curl -X POST http://127.0.0.1:17841/process \
  -H "Content-Type: application/json" \
  -d '{"videoPath":"D:/videos/my-stream.mp4","genre":"gaming","productInfo":"游戏耳机"}'
```

### 记忆桥（Hermes ⇄ GLB 桌面端/CLI，全链路打通）

GLB 每次"AI 找爆点"都会读本机 `review-memory.json`。Hermes 每小时把记忆编成这份原生文件写进去（历史爆款主题 + 你在看板上的确认/打回），桌面端、CLI、录播监听三边下次找爆点自动吃到；你在桌面端新的采用/否决也会读回来变成 Hermes 经验。手动触发：`POST /pipeline/bridge-sync`。`performance-memory.json`（真实播放量）绝不伪造写入。

### GLB 爆点配置覆盖

Hermes 学习 3 个以上视频后，会形成用户专属爆点模型。GLB 可以读取这个覆盖配置：

```bash
curl http://127.0.0.1:17841/highlight-config?genre=gaming
```

返回示例：
```json
{
  "override": {
    "optimalClipDuration": 18.5,
    "optimalHighlightInterval": 45.0,
    "energyCurveShape": "wave",
    "pacingStyle": "fast",
    "hookPatterns": ["3秒告诉你为什么...", "停下来！这个..."],
    "retentionOptimalPoints": [0.05, 0.3, 0.65],
    "recommendedBpm": 128,
    "samplesLearned": 5
  },
  "learned": true
}
```

在 GLB 设置中把这个 URL 填入"外部爆点配置"即可（如果 GLB 支持该功能）。

---

## 六、话术库格式

### 预设话术模板

文件位置：`data/copywriting-presets.json`

```json
[
  {
    "pattern_type": "hook",
    "text_content": "停下来！这个改变了一切",
    "effectiveness": 0.8,
    "context_tags": ["开头", "吸引注意力"]
  },
  {
    "pattern_type": "urgency",
    "text_content": "限时只有今天，手慢无",
    "effectiveness": 0.85,
    "context_tags": ["紧迫感", "稀缺性"]
  },
  {
    "pattern_type": "cta",
    "text_content": "点击下方链接，马上带回家",
    "effectiveness": 0.7,
    "context_tags": ["行动号召", "购买引导"]
  }
]
```

### 话术类型（pattern_type）

| 类型 | 说明 | 使用场景 |
|------|------|---------|
| `hook` | 开头钩子 | 视频前 3 秒抓住注意力 |
| `transition` | 过渡话术 | 片段之间的平滑衔接 |
| `urgency` | 紧迫感/稀缺性 | 制造时间/数量压力 |
| `cta` | 行动号召（硬广） | 引导购买/点击 |
| `soft_cta` | 软CTA（藏CTA） | 内容流里自然带出关注/追更/直播预告，教学类视频默认用它，不显广告味 |
| `objection` | 异议处理 | 预防性打消顾虑 |
| `social_proof` | 社会认同 | 销量/好评/口碑背书 |
| `value_prop` | 价值主张 | 核心卖点阐述 |
| `trust` | 信任建立 | 权威/保障/承诺 |

### 导入自定义话术库

方法一：编辑 `data/copywriting-presets.json` 后重启 Hermes

方法二：通过 API 导入

```bash
curl -X POST http://127.0.0.1:17841/import-copy \
  -H "Content-Type: application/json" \
  -d '{"presets": [
    {"pattern_type":"hook","text_content":"你的话术","effectiveness":0.9,"context_tags":["标签"]}
  ]}'
```

方法三：命令行导入

```bash
node src/copywriting/engine.js --import your-presets.json
```

### 自动学习话术

Hermes 会自动从每个处理过的视频转录文本中提取话术模式：
1. 用 Qwen3:8b-chat 分析转录文本
2. 识别其中的销售技巧（钩子/CTA/紧迫感等）
3. 评估话术有效性
4. 生成向量嵌入
5. 存入记忆库，作为后续生成的风格参考

随着处理的视频增多，Hermes 会越来越贴合你的个人话术风格。

---

## 七、API 接口文档

### GET /health
健康检查。

**响应：** `{"ok": true, "service": "hermes", "uptime": <秒>}`

### GET /stats
查看记忆库统计。

**响应：**
```json
{
  "videos": 5,
  "highlights": 127,
  "retentionSignals": 340,
  "copywritingPatterns": 89,
  "speakers": 2,
  "genreDistribution": [{"genre":"gaming","count":80}],
  "peakTypeStats": [{"peak_type":"audio_peak","avg_intensity":0.72,"count":45}],
  "copywritingTypeDistribution": [{"pattern_type":"hook","avg_effect":0.78,"count":20}]
}
```

### GET /style
查看用户风格画像（聚合后的"内容 DNA"）。

### GET /highlight-config?genre=`<genre>`
获取爆点检测配置覆盖（学习 3+ 视频后生效）。

### POST /webhook
接收 GLB 事件。

**Headers：** `x-hermes-secret: hermes-local-secret`
**Body：**
```json
{
  "type": "transcription_complete",
  "data": {
    "videoPath": "D:/videos/stream.mp4",
    "transcriptPath": "D:/output/transcripts/stream-transcript.json",
    "transcript": { "segments": [...] },
    "genre": "gaming"
  }
}
```

**事件类型：**
| type | 触发动作 |
|------|---------|
| `transcription_complete` | 注册视频 → 提取话术模式 |
| `highlights_detected` | 学习爆点模式 → 更新风格画像 |
| `clips_exported` | 生成带货话术 → 写入覆盖文件 |
| `pipeline_complete` | 完成学习循环 → 更新视频记录 |

### POST /process
手动提交视频处理。

**Body：** `{"videoPath": "...", "genre": "...", "productInfo": "..."}`

### POST /generate-copy
直接生成带货话术。

**Body：** `{"transcript": {...}, "highlights": {...}, "genre": "...", "productInfo": "...", "brandColor": "#ff6e0d"}`

**响应：**
```json
{
  "hooks": [{"text":"...", "place_at_ms": 0, "type":"hook", "reason":"..."}],
  "mid_copy": [{"text":"...", "place_at_ms": 15000, "type":"urgency", "reason":"..."}],
  "ctas": [{"text":"...", "place_at_ms": 30000, "type":"cta", "reason":"..."}],
  "full_script": "[0s] 钩子文本... [15s] 紧迫感... [30s] CTA..."
}
```

### POST /import-copy
导入话术预设库。

---

## 八、工作流程详解

### 完整学习循环

```
用户在 GLB 中导入视频
        │
        ▼
GLB 执行 ASR 转写
        │
        ├─(Webhook)─→ Hermes 接收 transcription_complete
        │                   │
        │                   ├─ 注册视频到 SQLite
        │                   ├─ Qwen3 分析转录文本
        │                   └─ 提取话术模式 → 存入记忆
        │
        ▼
GLB 检测爆点 (AI 找爆点)
        │
        ├─(Webhook)─→ Hermes 接收 highlights_detected
        │                   │
        │                   ├─ 存储每个爆点 (时间/类型/强度/上下文)
        │                   ├─ 计算 30s 窗口的留存信号
        │                   │   (节奏/能量/镜头密度/钩子强度)
        │                   ├─ Qwen3 提取高层节奏模式
        │                   │   (最佳间隔/能量曲线/情绪弧)
        │                   └─ 更新用户风格画像 (EMA 加权)
        │
        ▼
GLB 导出切片
        │
        ├─(Webhook)─→ Hermes 接收 clips_exported
        │                   │
        │                   ├─ 从记忆库检索匹配话术
        │                   ├─ Qwen3 生成话术 (钩子/中间/CTA)
        │                   ├─ 转换为字幕时段格式
        │                   └─ 写入 hermes-copywriting.json
        │
        ▼
GLB Pipeline 完成
        │
        └─(Webhook)─→ Hermes 接收 pipeline_complete
                            │
                            └─ 更新视频记录 → 清理状态
```

### 从零到聪明的进化曲线

| 阶段 | 处理视频数 | Hermes 能力 |
|------|-----------|------------|
| 冷启动 | 1-2 | 记录数据，开始学习，暂无模式输出 |
| 初步 | 3-5 | 形成首个风格画像，爆点配置覆盖生效 |
| 成长 | 6-20 | 话术库丰富，节奏模式稳定，生成质量提升 |
| 成熟 | 20+ | 完整内容 DNA，生成的话术高度贴合个人风格 |

---

## 九、故障排查

### Hermes 无法启动

| 症状 | 原因 | 解决方法 |
|------|------|---------|
| `EADDRINUSE: port 17841` | 端口被占用 | 修改 `config/default.json` 中的 `server.port`，或关闭占用进程 |
| `Cannot find module` | 依赖未安装 | 运行 `npm install` |
| `Error: better-sqlite3` | 原生模块编译失败 | 确认 Node.js 版本 >= 18，运行 `npm rebuild better-sqlite3` |

### Ollama 相关

| 症状 | 原因 | 解决方法 |
|------|------|---------|
| `Ollama is not running` | Ollama 未启动 | 全家桶根目录双击 `启动GLB.cmd` 选 [1] |
| `LLM 未返回内容` | 模型选错 | 确保 GLB 中选 `qwen3:8b-chat`（带 -chat 的非思考版） |
| 生成很慢 | 首次推理加载模型 | 正常现象，首次约 30-60 秒，后续秒级 |

### Webhook 不触发学习

1. 确认 Hermes 服务在运行：`http://127.0.0.1:17841/health`
2. 确认 GLB Webhook URL 填写正确
3. 确认密钥一致（`hermes-local-secret`）
4. 查看 Hermes 控制台输出是否有事件接收日志
5. 如果 GLB 不支持 Webhook，依赖文件监听方式即可

### 文件监听不触发

1. 确认 `config/default.json` 中的目录路径正确
2. 确认目录存在且有写入权限
3. 确认 GLB 的输出文件名包含 `transcript` 或 `highlight`（JSON 文件）
4. 视频文件扩展名在 `.mp4/.mov/.mkv/.webm` 范围内

### 数据库重置

```bash
# 备份
copy data\hermes.db data\hermes.db.bak

# 重置（删除后重启会自动重建）
del data\hermes.db
node src\memory\store.js --init
```

### 查看当前状态

```bash
node src\hermes.js --status
```

输出 Ollama 连接状态、模型列表、数据库统计、端口信息。

---

## 许可证

AGPL-3.0-only — 与 GLB 保持一致，自由使用、修改、分发。

---

## 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| 运行时 | Node.js | >= 18 |
| Web 服务 | Express | 4.21 |
| 数据库 | better-sqlite3 (SQLite) | 11.x |
| 文件监听 | chokidar | 3.6 |
| AI 推理 | Ollama + Qwen3 8B | 0.32.9 |
| 向量检索 | 余弦相似度 (Float32Array) | — |
