# 第三方组件声明

GLB Studio (© 2026 郭洛斌) 的自有源代码以 MIT 许可发布,见根目录 `LICENSE`。
本文件列出 GLB 运行时依赖的第三方开源组件及其许可,使用这些组件时须遵守
各自许可的条款。第三方组件的版权归各自作者所有。

## 运行时依赖

| 组件 | 许可 | 用途 | 备注 |
| --- | --- | --- | --- |
| Electron | MIT | 桌面运行时 | 随包分发,含 Chromium/Node |
| React / React DOM | MIT | 界面框架 | 渲染层 |
| zustand | MIT | 状态管理 | 渲染层 |
| tailwindcss | MIT | 原子化样式 | 构建期工具 |
| @tailwindcss/vite | MIT | 样式构建 | 构建期工具 |
| react-icons | MIT | 图标集 | 渲染层 |
| typescript | Apache-2.0 | 类型系统 | 构建期工具 |
| vite / electron-vite | MIT | 构建工具 | 构建期工具 |
| electron-builder | MIT | 打包工具 | 构建期工具 |
| vitest | MIT | 测试框架 | 构建期工具 |
| tar | ISC / BSD-2-Clause | 解包下载包 | 主进程 |
| unbzip2-stream | MIT | bz2 解压流 | 主进程 |
| ffmpeg-static | GPL-3.0 | 音视频处理二进制 | 独立可执行文件,主进程以子进程方式调用,未静态链接进 GLB 本体 |
| @ffprobe-installer/ffprobe | GPL-3.0 / LGPL-2.1 | 媒体探测二进制 | 独立可执行文件,子进程调用,未静态链接 |
| onnxruntime-node | MIT | ONNX 推理运行时 | Hermes 算法服务 |
| sherpa-onnx-node | Apache-2.0 | 语音识别(ASR) | Hermes 算法服务 |

## 外部服务(不随包分发,需用户自行配置)

| 组件 | 许可/条款 | 用途 |
| --- | --- | --- |
| Ollama | MIT | 本地大模型推理服务 |
| qwen3:8b / qwen3:8b-chat | Apache-2.0 | 本地默认分析模型 |
| Google Gemini API | 按 Google 服务条款 | 可选云端长上下文增强引擎 |

## 媒体编解码器

FFmpeg(含 ffprobe)依据其构建选项以 GPL-3.0 分发,作为独立可执行文件随包提供。
GLB Studio 不修改 FFmpeg 源码,仅以命令行方式调用其能力。若二次分发,请随包附带
FFmpeg 官方提供的 LGPL/GPL 许可文本与对应的源码获取说明。

## 字体

界面使用的字体来自操作系统(系统 UI 字体栈),不随包分发任何第三方字体文件。

## 说明

上述许可声明是法律要求,不构成对 GLB Studio 自有代码权属的任何影响。
GLB Studio 的自有设计、界面、交互与业务代码版权归 郭洛斌 所有。
