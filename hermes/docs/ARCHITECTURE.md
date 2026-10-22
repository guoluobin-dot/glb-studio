# Hermes AI - 爆款学习与粗剪系统架构

## 1. 目录结构

```
Hermes/
  src/
    orchestrator/       # 已有 - 主编排器（扩展auto-pipeline）
    memory/             # 已有 - 数据存储层（扩展新表）
    llm/                # 已有 - Ollama客户端
    highlight/          # 已有 - 爆点学习
    copywriting/        # 已有 - 话术引擎
    analyzer/           # [NEW] 视频分析器
      hit-analyzer.js     # 爆款视频结构拆解
      live-analyzer.js    # 直播视频主题分段
      asr-helper.js       # ASR转写辅助（复用GLB/ffmpeg）
      frame-extractor.js  # 关键帧提取（ffmpeg）
    clipper/            # [NEW] 粗剪引擎
      segmenter.js        # 主题分段（基于学习模型）
      matcher.js          # 爆点匹配
      hook-finder.js      # 黄金3秒钩子提取
    generator/          # [NEW] 内容生成器
      subtitle-gen.js     # 字幕生成（ASR+时间对齐）
      title-gen.js        # 视频上方标题生成
      cover-gen.js        # 第一帧封面生成（ffmpeg关键帧+标题叠加）
    query/              # [NEW] 用户交互确认
      user-query.js       # 向用户提问并等待回答
    scheduler/          # [NEW] 任务调度
      idle-scheduler.js   # 空闲时自动触发分析/剪辑
  upload/
    hits/               # 历史爆款视频上传目录
    live/               # 整场直播视频上传目录
    temp/               # 临时工作目录（ASR结果、关键帧、中间文件）
  output/
    finished/           # 最终成片输出目录
    draft/              # 粗剪草稿目录
  docs/
    ARCHITECTURE.md     # 本文档
```

## 2. 数据库表设计

### 2.1 爆款视频记录
```sql
CREATE TABLE hit_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_path TEXT NOT NULL UNIQUE,
  video_name TEXT,
  duration_ms INTEGER,
  file_size INTEGER,
  resolution TEXT,        -- e.g. "1080x1920"
  fps REAL,
  genre TEXT,             -- 直播带货 / 知识分享 / 情感共鸣 / 剧情演绎 / 种草测评
  analysis_status TEXT DEFAULT 'pending',  -- pending / analyzing / completed / failed
  analysis_result TEXT,   -- JSON: 结构拆解结果
  asr_path TEXT,          -- ASR转写文件路径
  created_at TEXT DEFAULT (datetime('now')),
  analyzed_at TEXT
);
```

### 2.2 爆款结构拆解
```sql
CREATE TABLE hit_structure (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hit_video_id INTEGER REFERENCES hit_videos(id),
  segment_type TEXT NOT NULL,   -- hook_opening / tension_build / peak_moment / resolution_cta / outro
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  duration_ms INTEGER,
  description TEXT,             -- AI分析描述
  key_text TEXT,                -- 该段落关键话术
  emotion_tag TEXT,             -- 情绪标签: excitement / curiosity / urgency / trust / humor
  intensity REAL,               -- 强度 0-1
  keyframe_path TEXT,           -- 关键帧图片路径
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 2.3 爆款主题/话题
```sql
CREATE TABLE hit_themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hit_video_id INTEGER REFERENCES hit_videos(id),
  theme_name TEXT NOT NULL,     -- e.g. "产品功效揭秘", "限时福利", "用户见证"
  confidence REAL,              -- AI判定置信度
  keywords TEXT,                -- JSON array of keywords
  related_segments TEXT,        -- JSON array of hit_structure IDs
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 2.4 直播视频记录
```sql
CREATE TABLE live_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_path TEXT NOT NULL UNIQUE,
  video_name TEXT,
  duration_ms INTEGER,
  file_size INTEGER,
  analysis_status TEXT DEFAULT 'pending',
  asr_path TEXT,
  segment_count INTEGER DEFAULT 0,
  clip_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  analyzed_at TEXT
);
```

### 2.5 直播主题分段
```sql
CREATE TABLE live_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  live_video_id INTEGER REFERENCES live_videos(id),
  segment_index INTEGER,        -- 第几段
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  duration_ms INTEGER,
  theme_name TEXT,                -- AI识别的主题名
  theme_confidence REAL,
  matched_hit_themes TEXT,        -- JSON: 匹配到的历史爆款主题 [{theme_id, similarity}]
  hook_quality REAL,              -- 开头3秒钩子质量 0-1
  peak_count INTEGER DEFAULT 0,   -- 该段落内爆点数量
  transcript_summary TEXT,        -- 该段落内容摘要
  status TEXT DEFAULT 'draft',    -- draft / selected / rejected / clipped
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 2.6 粗剪项目
```sql
CREATE TABLE clip_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  live_video_id INTEGER REFERENCES live_videos(id),
  project_name TEXT,
  status TEXT DEFAULT 'pending',  -- pending / clipping / reviewing / generating / finished / failed
  selected_segments TEXT,       -- JSON array of live_segment IDs
  total_duration_ms INTEGER,
  output_path TEXT,             -- 最终成片路径
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);
```

### 2.7 成片输出记录
```sql
CREATE TABLE clip_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clip_project_id INTEGER REFERENCES clip_projects(id),
  output_type TEXT NOT NULL,    -- video / subtitle / title_overlay / cover
  file_path TEXT,
  duration_ms INTEGER,
  file_size INTEGER,
  metadata TEXT,                -- JSON: 标题文字、字幕条数、封面参数等
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 2.8 用户待确认问题
```sql
CREATE TABLE user_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,           -- 关联的clip_project或hit_video
  query_type TEXT,              -- theme_confirm / hook_select / title_choose / genre_unknown
  question TEXT NOT NULL,
  context TEXT,                 -- JSON: 相关上下文数据
  options TEXT,                 -- JSON array: 可选项
  answer TEXT,                  -- 用户回答
  status TEXT DEFAULT 'pending', -- pending / answered / timeout / auto
  created_at TEXT DEFAULT (datetime('now')),
  answered_at TEXT
);
```

## 3. 模块接口设计

### 3.1 HitAnalyzer (爆款分析器)
```javascript
class HitAnalyzer {
  async analyze(videoPath) {
    // 1. ffprobe获取元数据
    // 2. ASR转写（调用GLB IPC 或 ffmpeg+本地whisper）
    // 3. 关键帧提取（ffmpeg -vf select='gt(scene,0.3)')
    // 4. Ollama分析：输入转写文本+关键帧描述，输出结构拆解JSON
    // 5. 写入 hit_videos + hit_structure + hit_themes
    return { hitVideoId, segments, themes };
  }
}
```

### 3.2 LiveAnalyzer (直播分析器)
```javascript
class LiveAnalyzer {
  async analyze(videoPath) {
    // 1. ffprobe获取元数据
    // 2. ASR转写
    // 3. Ollama主题分段：输入完整转写文本，输出 [{theme, start, end, confidence}]
    // 4. 对每个段落匹配历史爆款主题（向量相似度）
    // 5. 写入 live_videos + live_segments
    return { liveVideoId, segments };
  }
}
```

### 3.3 Clipper (粗剪引擎)
```javascript
class Clipper {
  async createProject(liveVideoId) {
    // 1. 读取 live_segments
    // 2. 按匹配度排序，选择最佳段落组合
    // 3. 对每个选中段落：提取黄金3秒钩子（调用hook-finder）
    // 4. 创建 clip_project，写入 selected_segments
    // 5. 如有不确定，创建 user_queries 记录，暂停等待
    return { projectId, segments, pendingQueries };
  }

  async clip(projectId) {
    // 1. 读取 selected_segments 的时间戳
    // 2. 调用 ffmpeg 裁剪片段（concat或独立片段）
    // 3. 更新 clip_project.status = 'reviewing'
    return { clipPaths, durations };
  }
}
```

### 3.4 ContentGenerator (内容生成器)
```javascript
class ContentGenerator {
  async generateSubtitles(clipProjectId) {
    // 1. 读取ASR转写结果
    // 2. 按裁剪后的时间范围过滤
    // 3. 生成 .srt 字幕文件
    return subtitlePath;
  }

  async generateTitle(clipProjectId) {
    // 1. 读取段落主题 + 历史爆款标题模板
    // 2. Ollama生成标题（emoji + 钩子式表达）
    // 3. 返回标题文本（后续通过ffmpeg drawtext叠加到视频上方）
    return { title, subtitle };
  }

  async generateCover(clipProjectId) {
    // 1. 提取视频第一帧（ffmpeg -ss 0 -vframes 1）
    // 2. 叠加标题文字（ffmpeg drawtext）
    // 3. 可选：叠加品牌色边框、产品图等
    return coverPath;
  }
}
```

### 3.5 UserQuery (用户交互)
```javascript
class UserQuery {
  async ask({ projectId, type, question, options, context }) {
    // 1. 写入 user_queries 表
    // 2. 暂停关联的clip_project
    // 3. 通过以下方式通知用户：
    //    a. IPC弹窗（如果GLB支持）
    //    b. Web界面弹窗（/dashboard 页面）
    //    c. 在 output/ 目录下创建 .pending 标记文件
    return queryId;
  }

  async checkAnswer(queryId) {
    // 1. 查询 user_queries 表
    // 2. 如果已回答，恢复流水线继续
    // 3. 如果超时（30分钟无回答），使用默认选项自动继续
    return { answered, answer };
  }
}
```

### 3.6 IdleScheduler (空闲调度)
```javascript
class IdleScheduler {
  start() {
    // 1. 每30秒扫描 upload/hits/ 目录，发现新文件触发 HitAnalyzer
    // 2. 每30秒扫描 upload/live/ 目录，发现新文件触发 LiveAnalyzer
    // 3. 当没有分析任务时，自动触发 Clipper 处理待剪辑的直播
    // 4. 维护一个任务队列，避免并发冲突
  }
}
```

## 4. 与 GLB 联动方案

### 4.1 不改动 GLB 本体的前提下，有三种联动方式：

| 联动方式 | 场景 | 实现 |
|---------|------|------|
| **文件监听** | 新视频上传 | chokidar 监听 upload/hits/ 和 upload/live/ |
| **GLB IPC** | 调用转写/剪辑能力 | 通过已有的25个IPC handler |
| **直接ffmpeg** | 裁剪/叠加/封面 | Hermes直接调用 GLB 目录下的 ffmpeg.dll/ffmpeg.exe |
| **Webhook** | GLB处理完成后通知Hermes | 已有的 /webhook 端点 |

### 4.2 具体联动策略：

**ASR转写** — 优先复用 GLB 能力：
- 方案A：通过 IPC 调用 GLB 的 `transcribe` handler，将视频路径传入，GLB 输出 transcript JSON 到 upload/temp/
- 方案B：如果 IPC 调用受限，Hermes 直接调用 ffmpeg 提取音频 + 本地 whisper/ollama 转写

**视频裁剪** — Hermes 直接调用 ffmpeg：
- `ffmpeg -ss <start> -t <duration> -i input.mp4 -c copy output.mp4`（快速裁剪）
- `ffmpeg -i input.mp4 -vf "drawtext=text='标题':fontsize=60"`（标题叠加）
- `ffmpeg -i input.mp4 -vf "subtitles=subs.srt"`（字幕叠加）

**关键帧提取** — ffmpeg：
- `ffmpeg -i input.mp4 -vf "select='gt(scene,0.3)',showinfo" -vsync vfr frames/%d.jpg`

**封面生成** — ffmpeg + drawtext：
- 提取第一帧 + 叠加标题文字 + 可选品牌色边框

### 4.3 数据流：

```
用户操作                              Hermes处理

上传爆款视频到 upload/hits/     →   [文件监听] HitAnalyzer.analyze()
                                      ├─ ffprobe 元数据
                                      ├─ ASR 转写（IPC或ffmpeg）
                                      ├─ 关键帧提取（ffmpeg）
                                      ├─ Ollama 结构分析
                                      └─ 写入 hit_structure + hit_themes

上传直播视频到 upload/live/     →   [文件监听] LiveAnalyzer.analyze()
                                      ├─ ffprobe 元数据
                                      ├─ ASR 转写
                                      ├─ Ollama 主题分段
                                      └─ 写入 live_segments

[空闲调度器触发]                  →   Clipper.createProject(liveId)
                                      ├─ 读取 live_segments
                                      ├─ 匹配历史爆款主题
                                      ├─ 提取钩子
                                      ├─ [如需确认] UserQuery.ask()
                                      └─ 写入 clip_project

[用户确认后/自动继续]             →   Clipper.clip(projectId)
                                      ├─ ffmpeg 裁剪片段
                                      └─ status = 'reviewing'

                                  →   ContentGenerator.generate()
                                      ├─ 字幕 (.srt)
                                      ├─ 标题 (文本，drawtext叠加)
                                      └─ 封面 (关键帧+标题)

                                  →   ffmpeg 合成最终成片
                                      ├─ 视频 + 字幕 + 标题叠加
                                      └─ 输出到 output/finished/
```

## 5. 配置项扩展

```json
{
  "upload": {
    "hitsDir": "D:/GLB/Hermes/upload/hits",
    "liveDir": "D:/GLB/Hermes/upload/live",
    "tempDir": "D:/GLB/Hermes/upload/temp"
  },
  "output": {
    "finishedDir": "<GLB_OUTPUT>/finished",
    "draftDir": "<GLB_OUTPUT>/draft"
  },
  "analyzer": {
    "ffmpegPath": "D:/GLB/GLB/ffmpeg.dll",
    "asrMode": "glb_ipc",
    "keyframeThreshold": 0.3,
    "minSegmentDurationMs": 30000,
    "maxSegmentDurationMs": 180000
  },
  "clipper": {
    "minHookQuality": 0.6,
    "maxClipsPerLive": 10,
    "targetClipDurationMs": 60000,
    "autoConfirmTimeoutMs": 1800000
  },
  "generator": {
    "titleFontSize": 48,
    "titleFontColor": "#FFFFFF",
    "titleBgColor": "#FF6B35",
    "subtitleFontSize": 32,
    "coverTemplate": "default"
  },
  "scheduler": {
    "enabled": true,
    "scanIntervalMs": 30000,
    "maxConcurrentTasks": 2
  }
}
```

## 6. 用户交互机制

### 6.1 何时需要向用户提问：
1. **主题不确定**：AI无法判断直播某段的主题分类（如"这是产品介绍还是用户互动？"）
2. **钩子选择**：多个候选开头钩子，需要用户选择最佳方案
3. **标题生成**：AI生成3个标题方案，用户选择或修改
4. **爆款类型未知**：上传的爆款视频风格与已有模型差异过大
5. **话术冲突**：检测到的话术模式与用户历史风格不一致

### 6.2 提问方式：
- **Web界面**（最可靠）：Hermes 在 127.0.0.1:17841 上增加一个简易 dashboard 页面
- **文件标记**：在 `upload/query/` 目录下创建 `.pending` 文件，用户编辑后流水线继续
- **IPC弹窗**：如果 GLB 支持弹出确认对话框（需验证 IPC handler）

### 6.3 超时自动处理：
- 用户30分钟未回答 → 使用AI默认选择继续
- 记录到 `user_queries` 表中，后续可人工修正

## 7. 技术难点与风险

### 7.1 ASR转写
- **难点**：GLB 使用的是 sherpa-onnx，Hermes 无法直接复用其 ASR 引擎
- **方案**：
  - 方案A：通过 IPC 调用 GLB 的转写功能（如果 GLB 暴露该接口）
  - 方案B：Hermes 自行集成 whisper.cpp 或 faster-whisper（本地运行）
  - 方案C：先用 ffmpeg 提取音频，再调用 Ollama 的音频理解能力（如果支持）

### 7.2 视频处理性能
- **难点**：RTX 4060 8GB VRAM，处理数小时直播的 ASR + 分析 + 裁剪需要较长时间
- **缓解**：
  - 分段处理，优先处理已完成的分析任务
  - 使用 ffmpeg 的 `-c copy` 做快速裁剪（不解码重编码）
  - Ollama 推理可以走 GPU，但分析长文本需分批输入

### 7.3 Ollama 长文本限制
- **难点**：qwen3:8b 的上下文窗口约 32K-128K，数小时直播的 ASR 文本可能超出
- **方案**：
  - 先对直播做粗略分段（按静音/场景切换），再逐段分析
  - 使用滑动窗口方式，每次分析 5-10 分钟片段
  - 最终汇总时提取关键信息而非完整文本

### 7.4 GLB IPC 能力未知
- **难点**：25个 IPC handler 的具体功能未完全确认，不确定能否反向调用
- **缓解**：
  - 优先使用文件监听 + 直接 ffmpeg 方案
  - IPC 仅作为增强能力，不作为必要依赖

## 8. 实现优先级

| 优先级 | 模块 | 说明 |
|--------|------|------|
| P0 | 数据库表 + 配置 | 必须先有数据模型 |
| P0 | HitAnalyzer | 爆款分析是后续一切的基础 |
| P1 | LiveAnalyzer | 直播分段是粗剪的前提 |
| P1 | IdleScheduler | 让系统自动运转起来 |
| P2 | Clipper | 粗剪核心逻辑 |
| P2 | ContentGenerator | 字幕/标题/封面 |
| P3 | UserQuery | 增强体验，可先用默认自动处理 |
| P3 | Dashboard | Web界面，方便查看状态和确认 |
