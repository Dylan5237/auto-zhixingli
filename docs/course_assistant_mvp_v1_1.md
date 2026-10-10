# AI 课程托管助手 — 技术方案与 Codex 任务书 V1.1

> 更新日期：2026-10-10  
> 执行环境：Windows 11 + Chrome / Edge（建议 Chromium 116+）  
> 当前阶段：**M0 技术验证待执行**。截图可确认课程/章节两级结构；用户确认播放器在同一浏览器页签内切换页面；尚未取得登录后网页的 DOM、播放器事件、课程完成机制或真实音频采集测试结果。

## 0. 一句话决策

采用 **单页签 Chrome/Edge MV3 扩展 + 本地 Python 服务**。

- 扩展处理课程/章节队列、真实播放事件观察、通过网站正常 UI 的章节切换、后台页签音频采集。
- 本地 Python 服务处理音频持久化、ASR、LLM 笔记、索引与错误恢复。
- 不引入常驻 Playwright、桌面 GUI/壳、通用视觉 Agent、复杂编排平台。
- **先验证 M0，再做自动调度**。若播放器、平台验证或自动播放策略阻止无人值守，必须报告真实限制并等待用户操作，不绕过控制。

## 1. 已知事实与约束

### 1.1 已知事实

1. 课程列表显示多门课程，有搜索及筛选；目前截图出现「共 2772 门课程」。该数目只是课程库大小，不是执行队列。
2. 课程详情有「介绍 / 目录 / 评价」以及「开始学习」。
3. 目录展示若干章节及各自视频时长。必须采用「课程 -> 章节」的两级队列，而不是只按课程切换。
4. 播放器画面有播放控件、总时长、播放倍速与进度条；截图中的示例时长为 17:05。
5. **用户已确认：进入下一章节/播放页面，不会新开标签页；仍在当前浏览器标签页内切换。**
6. 播放器区域出现「下载」入口，但来源不明（平台按钮、浏览器或第三方扩展）；不能直接推定视频可下载或可另行获取。

### 1.2 尚未验证的关键事实

- 同页签切换是 SPA 路由、整页导航还是弹层/嵌套 iframe。
- HTML DOM 中是否能访问 `<video>`，是否为跨源 iframe / Shadow DOM / 自定义播放器。
- 视频结束时是否发出 `ended`，平台是否显示完成状态，是否自动开始下一节。
- 下一节自动播放是否受到浏览器策略或平台要求互动的限制。
- 实际后台行为：浏览器失焦、窗口最小化、屏幕锁定各是什么情况。
- 公司是否允许录制或保存培训材料，以及是否允许用本地 ASR 处理。

### 1.3 明确边界

- **只能基于真实播放的媒体事件判断“观测到播放结束”**；平台是否认可完成以平台正常页面反馈为准。
- 不篡改学习记录、学分、时长、进度、网络请求或后台数据库；不伪造心跳/人机交互；不绕过强制测试、验证码、人脸/在场校验或 DRMs。
- 发生人工交互要求时暂停并提示；不把“视频自动播放完”冒充“用户已掌握内容”。
- 默认只处理用户明确加入队列的课程；不自动批量扫课程库。
- 沿用用户浏览器现有登录态；不读取、记录或上传 Cookie、Token、SSO 凭据。
- 企业课程材料默认本地保存，是否可录制、保存、使用第三方云端模型须由用户确认符合公司规定。无授权不进行受限内容导出。
- 本地 Codex Agent 不做截图阅读或视觉验收；网页探查以 DOM、公开媒体事件、运行日志和测试为准；需要视觉审查时由用户提供截图交给 ChatGPT。

## 2. 架构与责任边界

```text
[Chrome/Edge：唯一目标页签 tabId]
  │
  ├─ extension action/popup [一次性用户启动，展示队列与状态]
  │
  ├─ content script + site-adapter [平台 DOM / 原生播放器事件]
  │     ├─ read catalog / chapter titles and order
  │     ├─ observe: play / pause / playing / waiting / ended
  │     └─ normal next action; UI obstacles => manual required
  │
  ├─ MV3 service worker [事件路由、任务调度，不常驻]
  │     ├─ tabs lifecycle / navigation handling
  │     ├─ persistent runId/courseId/chapterId/checkpoint
  │     └─ command/state reconciliation, idempotency
  │
  ├─ offscreen document [持续音频采集，与网页 DOM 生命周期分离]
  │     └─ tabCapture stream -> getUserMedia -> MediaRecorder
  │           └─ audio-only chunks -> local ingest; bounded queue
  │
  └─ chrome.storage.local [控制状态、运行中的轻量 checkpoint]
                           │
                           ▼
                localhost (127.0.0.1)
                           │
              [Python FastAPI local worker]
                ├─ /ingest/audio-chunk
                ├─ SQLite: course/section/run/capture/transcript/note
                ├─ local file archive
                ├─ ASR (FunASR / SenseVoice, fallback faster-whisper)
                └─ LLM summarization -> Markdown (course + section)
```

### ADR-01：采集一旦开始，应尽量跨页面切换保持同一条音频流

`chrome.tabCapture` 官方说明：捕获在同一 tab 的页面导航间继续保持，直到 tab 或流关闭。Chrome 116+ 可以通过 service worker 获取一次性 stream ID，再由 offscreen document 使用 `getUserMedia` 获取流。优先采用这种组合，而不是 content script 直接录制；后者遇到整页导航会销毁。

**注意**：stream ID 数秒内过期且只能使用一次。必须由用户主动操作触发首次采集授权；断流后是否能恢复、需否再次手动触发，都要按 Chrome 实际返回结果处理，不能承诺静默无限重授权。

M0 必须真实验证一次「播放 2 分钟 -> 同页签导航 -> 下一页继续有声」，不能仅把官方文档当作企业平台实测结论。

### ADR-02：Offscreen 使用 `USER_MEDIA` 原因，不使用 popup 做长时间录音

- `chrome.offscreen.createDocument({url, reasons: ['USER_MEDIA'], justification})`。
- Offscreen 页面仅能使用少数扩展 API，消息以 `chrome.runtime` 为主；音频流与 MediaRecorder 位于 offscreen 文档。
- offscreen 的 `AUDIO_PLAYBACK` 原因单独使用存在「一段时间无声后关闭」的生命周期要求；本用例首先需要 `USER_MEDIA`。
- `tabCapture` 的音频采集可能令原页签声音不再直接外放；确有试听需求时按官方指引通过 AudioContext 路由到输出设备。不要为了录音无声而误把录音流静音。

### ADR-03：Service Worker 不维持长计时器，也不存储唯一内存状态

MV3 service worker 通常在一段空闲时间后休眠，因此：

- 在 `chrome.storage.local` 保存 `runId`、`tabId`、课程/章节指针、播放与采集状态。
- 用 content script 的真实播放器事件驱动状态变化；同页签整页导航则自动重建观察器。
- 对每个章节应用幂等 `runId + sectionKey + eventType` 防重操作，防止多次点击下一章。
- 恢复执行时先对照当前 tab URL / DOM / 音频流状态，**对不上就暂停**，不猜测已经播到哪。
- 不通过 `setInterval(视频时长)` 来决定是否完播。超时只用于“疑似卡住”的提示。

### ADR-04：网站适配器按真实 DOM 设计，不先编造 CSS 选择器

站点适配器只需要五类能力：

```ts
interface CourseSiteAdapter {
  identifyPage(): 'catalog'|'course'|'section'|'unknown';
  readCourseAndChapters(): CourseSnapshot | null;
  observePlayer(report: (event: PlayerEvent) => void): () => void;
  openSection(sectionKey: string): Promise<ActionResult>; // 仅正常 UI
  readVisibleCompletion(): CompletionEvidence | null;
}
```

此接口为目标形态，不要求 M0 全部实现。`sectionKey` 如果页面未提供稳定 ID，M1 可用「课程 URL 规范化路径 + 目录顺序 + 章节标题」作为候选，并处理同名冲突。

- 视频在主 DOM：优先 `HTMLMediaElement` 标准事件；监听 `ended`、`play`、`pause`、`waiting` 等。
- 视频在同源 iframe / 开放 shadow root：按实际可访问性注入观察器。
- 视频在跨源 iframe：需要明确的额外 host permission 和 `all_frames`，或通过网站公开的可观测完成提示；不可试图破解跨源隔离。
- 只有图片/截图，不足以判断这些情况。M0 必须读取真实页面结构。

### ADR-05：章节切换是“本地完成观察”和“平台完成认可”两条不同证据

`video.ended === true` 只能证明本地播放器观察到媒体结束。它不能证明服务器已写入学分或培训完成状态。

因此保存两列：`playbackObserved = true/false` 与 `platformCompletion = complete/incomplete/unknown`。若平台没有可观察完成标识，显示 `unknown`，不伪造 `complete`。播放事件、网络异常、验证码或强制测试都可能使平台不记完成。

### ADR-06：自动播放失败要显式停止，不伪造用户手势

从视频 A 进入 B 后，浏览器可能因自动播放策略拒绝 `video.play()`（例如返回 `NotAllowedError`）；某些网站也必须由真实用户按「开始学习」。可以监听合法播放控件与浏览器返回的真实错误，但不制造虚假的可信点击事件、不禁用企业浏览器安全配置。

此情况的结果应是 `needs_user_action` 并通知用户。是否真的能够无人值守跨章节播放，是 M0 的关键实测结论，**而不是同页签导航自动保证的性质**。

## 3. 队列、状态机与异常

### 3.1 两级队列

```text
Run (一个目标浏览器标签页)
  ├─ Course A
  │    ├─ Section A1
  │    ├─ Section A2
  │    └─ Section A3
  └─ Course B
       ├─ Section B1
       └─ Section B2
```

M1 先支持用户手动选定当前课程。跨课程批量排队放到 M2；不存在“自动从 2772 门课程随机选课”的默认策略。

### 3.2 章节主状态机

```text
queued
  └→ opening ─→ waiting_for_media ─→ playing ─→ ended_observed
                     │                  ↕           │
                     │             buffering        └→ archiving ─→ done_local
                     │                  ↕
                     │                paused
                     └──────────────→ blocked / needs_user_action
```

播放器失败、DOM 无法确定目标、跳转后不匹配课程/章节、音频采集断流、登录失效、人工验证、浏览器自动播放拒绝时，不擅自切到下一章；等待用户或重试策略。局部可恢复错误需有明确重试次数和退避。

### 3.3 音频是独立状态机

```text
not_started → permission_requested → capturing → closing_segment → persisted
                       └── rejected        └── capture_lost / ingest_failed
```

章节开始/结束事件通过消息告诉 offscreen 哪个片段属于哪个章节。浏览器页面导航和录音分片属于不同生命周期，不应在 DOM 卸载时直接结束整个 capture stream。

### 3.4 异常处理策略

| 事件 | 产品行为 | 能否静默继续 |
|---|---|---|
| 正常视频 `ended`，下一章正常可访问 | 关闭本章片段，按网站 UI 进入下一章 | M0 验证后可 |
| `waiting/stalled` 网络缓冲 | 继续观察，不使用时长计时器跳过 | 可有限重试 |
| 当前页签关闭、采集流断开 | 暂停，保存已有音频；提示重新授权 | 否 |
| 自动播放被拦截 | 停在待用户操作 | 否 |
| SSO 登录到期、验证码、测试题、在场验证 | 暂停并通知本人 | 否 |
| 页面未知、章节序号找不到、状态矛盾 | 暂停，记录证据 | 否 |
| 电脑进入睡眠 | 不承诺后台运行；醒来核对状态 | 否 |
| 本地 Python 进程停止 | 分片有限缓冲；超过容量自动暂停 | 有条件 |

## 4. 录制与笔记

### 4.1 音频技术路径

1. 用户在目标活动页签点击扩展「开始」并确认公司材料录制授权。
2. service worker 获取该 `tabId` 的 stream ID，立即交给 offscreen；offscreen 建立音频 MediaStream。
3. Offscreen `MediaRecorder` 对音频分片（建议以约 30 秒为目标）；实际回调时间可能因后台节流而延后，因此**不可依赖 chunk 序号 × 30 秒作为精确时间戳**。
4. 分片带 `runId, captureId, sequence, sectionKey, receivedAt` 交本地 ingest，落盘后回 ACK，防重复上传和错误关联。
5. 每章保留独立音频索引；在播放器标准媒体时间和采集时间之间建立事件记录，便于对齐 ASR 时间戳。
6. 本地 ASR 输出带时间戳逐字稿；本地 LLM 根据逐字稿生成结构化 Markdown 笔记。识别失败和缺失音频必须显式标注。

### 4.2 本地安全

- FastAPI **仅**绑定 `127.0.0.1`，拒绝未授权 CORS Origin；扩展与本地服务采用安装时生成的随机本地认证令牌（不传给网页脚本）。
- 扩展只向**明确的公司平台域名**声明 host permissions；待 M0 获取域名后填写，避免 `<all_urls>`。
- 不抓取课程 API、上传课程文件到远程云端、不在日志输出身份凭证。默认音频、逐字稿、笔记仅本机存储，可一键删除。
- 录制可能受公司规章或版权限制；未经许可不录制、不复制受保护内容；M0 可先使用自有测试媒体验证录音链路。

### 4.3 笔记产出结构

```text
notes/
└─ <course-safe-name>/
   ├─ index.md                 # 课程摘要、知识结构、章节导航
   ├─ 01-<section>.md          # 核心观点、论据、重要时间戳、复习题
   ├─ 02-<section>.md
   ├─ transcript/
   │    ├─ 01.json            # 时间戳/转写文字/质量标记
   │    └─ 02.json
   └─ capture-index.json      # 音频文件位置、分片完整性、采集质量
```

首期不做界面花哨的知识库、RAG、搜索或云端同步。音频信息无法还原的 PPT 图表由笔记注明“需结合画面”，后续视授权添加课件文本/截图输入。

## 5. 实施与验收门槛（先过证据关）

### M0 — 真实站点与后台采集验证（**本轮唯一开发范围**）

**用户和本地 Codex 共同完成**，无需 Codex 看截图，也不预先开发完整 AI 功能。

M0-A 只读 DOM/媒体探查（使用随包的 `tools/course_assistant_readonly_probe.js` 或等效只读检查）：
- 收集当前页签内各页面类型的 origin/路径（**不含 query token**）、主 DOM 内视频数、iframe 数、是否 Shadow DOM。
- 正常播放章节，记录至少 `play`, `playing`, `waiting`, `pause`, `ended` 中实际出现的事件；若 `ended` 没有出现，观察平台公开完成状态与“下一节”界面。
- 手动完成一个章节后，记录正常进入下一节的步骤，确认 tabId 未变化、播放器是否重新创建、下一节能否自动开始。
- 失焦、切其他页签、窗口最小化，观察 `currentTime` 是否仍增长；不要仅以操作系统任务栏图标或页面动画判断成功。

M0-B 官方 API 音频采集 PoC：
- 按 Chrome 官方示例实现极小 MV3 扩展。`action` 用户手势 → `tabCapture.getMediaStreamId` → `offscreen(USER_MEDIA)` → `getUserMedia` → `MediaRecorder`；不要求课程自动切换。
- 至少采集**连续 2 分钟**真实合法媒体音频，验证分片有声、时长与目标页签一致；然后在同一页签执行正常页面导航，核对音频流是否保持。
- 录音必须可显式停止，并有授权状态、录制中/失败状态。失败后不能“看起来在录”。
- 对照最小化与失焦场景检验采集行为，返回真实结论；浏览器最小化并不代表电脑可进入睡眠。

M0-C 章节结束 → 下一章能否自动正常播放：
- 优先验证网站自身是否已支持正常自动连播/下一节；若无，则尝试平台支持的普通 UI 流程。
- 区分网页脚本可以触发的正常操作与被浏览器要求用户手势的播放操作；确认 `play()` 是否被拒绝。
- 若出现登录、考试或人工在场检查，记录阻塞，不绕过。

**M0 验收证据（缺一不可）：**

1. 一份脱敏平台 DOM/导航观察记录，包含视频可访问性和完成/下一节路径。
2. 一份包含实际播放事件顺序的日志，明确视频 `ended`/完成 UI 的可靠程度。
3. 一份真实可播放的录音样本，以及音频分片完整性记录（不要求将公司录音发给 ChatGPT）。
4. 同页签导航前后采集流状态测试结果、最小化后台测试结果。
5. 下一章节自动播放通过或失败的证据，尤其 `NotAllowedError` 或互动要求。
6. M0 结论必须填「通过 / 有条件通过 / 阻塞」，且分别给出证据。未通过不进入自动化执行。

**M0 退出门槛：** 不做 AI 摘要、不做跨课程自动遍历、不开发 UI 设计系统；必须等以上事实明确才安排 M1。

### M1 — 单门课程顺序处理

- 能导入用户当前课程目录，构建稳定的章节序列；支持手动开始、暂停、结束。
- 通过实际播放结束和站点可见反馈进入下一章节；等待播放成功再推进状态。
- 3 个以上连续章节通过完整真实时长测试；刷新页面或 SW 休眠后可安全恢复。
- 遇到人工验证/自动播放阻塞立即暂停；不得提前声明“平台已完成”。

### M2 — 多课程队列与后台音频归档

- 用户明确加入多个课程，按章完成再切课；在页面可正常访问且已授权时运行。
- Offscreen 分段录音、断流告警、有限缓存、本地服务落盘 ACK、防串章与重复。
- 测试最小化/切其他 Windows 应用时完成至少一整章，结果可核查。

### M3 — 本地转写与 AI 笔记

- 接入 FunASR/SenseVoice 或 faster-whisper，本地转写并保留句段时间戳。
- 按章笔记 + 课程总览 Markdown；有缺失音频时显式提示。
- 核对至少 2 个实际章节的内容准确性，关键结论可追溯到时间戳。

## 6. 建议工程目录（M0 仅创建必要文件）

```text
auto-zhixingli/
  README.md
  docs/
    course_assistant_mvp_v1_1.md
    architecture.md
    m0-evidence.md
  tools/
    course_assistant_readonly_probe.js
  extension/
    manifest.json
    service-worker.js
    offscreen.html
    offscreen.js
    content-probe.js        # DOM 观察；M0 不写站点自动点击
    popup.html
    popup.js
  local/
    server.py               # M0 仅做录音分片接收与保存
    requirements.txt
  tests/
    fixtures/               # 自有测试 HTML5 video 页面
    ...
```

M0 项目可以更小；以上是可演进目录，不是必须一次性建齐。

## 7. 可复制给本地 Codex 的执行指令

> 你负责 AI 课程托管助手的 **M0 可行性验证**，本轮不要实现 M1~M3。先阅读 `docs/course_assistant_mvp_v1_1.md`。已知用户确认：课程视频在**同一浏览器标签页内**切换页面，但不能自行假设是 SPA、HTML5 video 还是 iframe，更不能编造生产站点 CSS 选择器。
>
> 任务目标是通过真实可重复的技术证据，判断 ① 如何观测视频真实结束，② 通过网页正常 UI 如何进入下一章及下一章能否自动启动，③ Chrome MV3 `tabCapture + offscreen USER_MEDIA` 能否在该单页签跨页面导航时连续采集音频。
>
> 开发极小 MV3 探测扩展，按官方方式由用户点击 action 触发捕获，offscreen 负责录音；先在自有测试视频页面验证 API 组合，再由用户在公司已登录浏览器授权下验证。提供只读 DOM 诊断脚本（已有 `tools/course_assistant_readonly_probe.js` 可复用）；若你无法操作用户的已登录浏览器，不要声称生产环境已经验证：把必要的本地运行步骤、脱敏日志收集方法交给用户即可。不要要求你自己看图或做截图视觉判断。
>
> 全程不得篡改或模拟学习完成状态、网络心跳、服务器记录、测试/在场验证；不得读取或保存登录凭据；默认不将公司音视频上传到云端。需要录制公司课程时先确认授权；也可用自有测试视频完成非敏感 PoC。
>
> 交付：可运行的 M0 扩展源码、最小录音落盘方式、README、最小权限清单、DOM/播放器事件日志、跨导航与后台录制证据、自动播放限制结论、已验证/未验证清单。严格停在 M0 验收，等待我明确授权后再进入 M1。

## 8. 用户如何配合 M0（无需让 Agent 读截图）

1. 在当前已登录课程播放器页签中打开 DevTools 的 Console，必要时启用 `Preserve log`；将 `tools/course_assistant_readonly_probe.js` 的内容粘贴执行。它只读观察，不访问 Cookie、Token，不触发课程学习接口。
2. 正常播放约 30～60 秒、切换到其他页签再回来；查看 Console `[COURSE_M0]` 日志。可用 `__COURSE_M0_PROBE__.report()` 查看内部缓冲，`__COURSE_M0_PROBE__.stop()` 停止观察。
3. 让一个合法可结束的测试章节自然播放到末尾，观察完成状态、下一章是否自动启动；如发生整页导航，脚本会随文档退出，旧日志须靠 `Preserve log` 保留。
4. 分享给 Codex/ChatGPT 时请删除含个人/企业敏感信息的标题和路径，不分享登录信息、音视频原文件或敏感课程内容。若平台不允许录制，用自有媒体测试音频采集模块。

## 9. 官方技术依据（参考来源，不等于实测）

- tabCapture：<https://developer.chrome.com/docs/extensions/reference/api/tabCapture>
- Offscreen API：<https://developer.chrome.com/docs/extensions/reference/api/offscreen>
- 后台录制官方教程：<https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture>
- MV3 Service Worker 生命周期：<https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Chrome 自动播放策略：<https://developer.chrome.com/blog/autoplay/>
- Manifest 权限最小化：<https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- FunASR：<https://github.com/modelscope/FunASR>
- faster-whisper：<https://github.com/SYSTRAN/faster-whisper>