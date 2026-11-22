# 剪映分层导出 · Jianying Layered Export

> OpenFilm 插件：把 HTML 页面拆成**独立图形轨 + 剪映原生可编辑文字轨**，导出到剪映专业版草稿，不再把文字烧录进视频。

基于 OpenFilm 0.4.0 原生剪映（Jianying Pro）草稿导出能力做的扩展插件。

## 解决的问题

OpenFilm 原生导出会把 `<iframe>` 里的 HTML 页面（标题、字幕、图表等）整体渲染成视频画面烧进去。文字一旦成像素，进剪映后就**没法改字、改颜色、改位置**，只能在像素上重做一遍。

本插件在导出时把页面拆成两层：

| 轨道类型 | 内容 | 剪映里的形态 |
| --- | --- | --- |
| `Graphics` 图形轨 | 透明 PNG 图形，**文字字形全部隐藏** | 独立的透明图片素材，可单独调位置/时长 |
| `Text` 文字轨 | 文字内容、行内颜色/字重、位置、字号、旋转、时间 | 剪映原生 `type: "text"`（`flag: 0`）文字片段，**可直接双击改字** |
| 视频轨 | `<iframe>` 内无文字页面（动效环、遮罩、压暗层等） | 独立透明视频叠加层 |

原生视频、图片、音频、字幕轨仍走 OpenFilm 自己的导出链路，不做二次处理。可编辑文字轨与剪映的 `flag: 1` 字幕轨是分开的两套，互不干扰。

## 目录结构

```
bin/
  export.mjs                 # 命令行入口（jianying-layered-export）
  install-to-openfilm.mjs    # 把插件安装进本地 OpenFilm
lib/
  export-layered.mjs         # 草稿组装：轨道、时间轴、颜色/文字样式映射
  extract-layers.mjs         # 页面图层提取：图形去文字 + 文字层结构化
  openfilm-runtime.mjs       # 复用 OpenFilm 运行时与模块加载
server.mjs                   # 本地网页版操作面板（127.0.0.1）
openfilm.json                # OpenFilm 插件清单
SKILL.md                     # 插件说明（给 Agent/skill 用的规范描述）
test/
  export-layered.test.mjs    # 端到端测试
  fixtures/                  # 最小 OpenFilm 工程样本
```

## 使用方式

### 方式一：作为 OpenFilm 插件

```bash
openfilm jianying-layered-export --project <工程目录> [--drafts-dir <剪映草稿目录>] \
  [--name <草稿名>] [--fps 30] [--overwrite] [--json]
```

先把插件装进本机 OpenFilm：

```bash
node bin/install-to-openfilm.mjs
```

### 方式二：直接用 Node 跑

```bash
node bin/export.mjs --project "<工程目录>" --drafts-dir "D:\JianyingPro Drafts" \
  --name "<草稿名>" --overwrite
```

### 方式三：网页面板

```bash
npm start        # 起本地服务，默认 127.0.0.1 随机端口
```

面板里填工程目录、草稿名、帧率，点导出，实时看阶段进度与结果表。

## 注意事项

- 导出新草稿时如果剪映专业版正开着，**先完全退出再重开**，否则首页扫描不到新草稿。
- 文字轨使用剪映原生文字片段，字体以剪映侧可用字体为准；字形度量按页面 CSS 计算，个别异形字体可能有毫厘偏移。
- 测试依赖 Playwright 浏览器内核，首次跑测试前需 `npx playwright install`。

## 依赖

- Node.js ≥ 20（`type: module`，ESM）
- 本机安装 OpenFilm 0.4.0（导出链路复用其 runtime）
- 剪映专业版（用于打开生成的草稿）

## 开发

```bash
npm test         # 端到端导出测试
```

## 许可

未声明开源许可。如需对外分发请先补 LICENSE。
