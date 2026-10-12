# 跨课程接力 v1（本地自用，Issue #11）

授权边界见 #11 V1 冻结：单页签、只点网站原生 UI 元素、默认学习模式、不录音、不联网外传、不碰平台接口与存储。遇到考试/验证码/在场确认/登录失效自动停止并提示人工。

## 加载

1. Chrome 打开 `chrome://extensions`，右上角开启"开发者模式"。
2. 点"加载已解压的扩展程序"，选择本目录（`extension/relay-v1`）。
3. 刷新课程页签。Console 出现 `[RELAY v1] 已启动 relay vX.Y.Z`、页面右下角出现启动横幅即生效。

## 配置

编辑 `content.js` 顶部 `DEFAULT_CONFIG`，改完在扩展页点"重新加载"：

| 字段 | 说明 |
| --- | --- |
| `autoClick` | `false`=学习模式（只观察+提示人工，不点击）；`true`=允许真实点击 |
| `courseEntrySelector` | 列表页课程条目选择器（已按真机观察配置） |
| `coursePickRule` | `index:1`（默认，跳过首个条目=刚结束课程）\| `first` \| `index:N` \| `contains:文本` |
| `nextChapterSelector` | 课内"下一节/继续学习"控件选择器（暂未配置，课内连播靠平台自动） |
| `courseStartSelector` | 课程详情页"继续学习/开始学习"按钮选择器（暂未配置，学习模式转人工） |
| `courseListUrl` | 可选：列表页直达地址；留空则课程结束后点击底部导航"学习"进列表 |
| `learnNavText` | 底部导航进列表按钮文本（默认"学习"） |

## 运行流程

`watch`（观察播放）→ 媒体自然结束 → `wait-auto`（等平台自动连播）→ 无连播则 `goto-list`（点底部导航"学习"或导航 courseListUrl）→ 检测到"在学课程"列表页 → `pick-course`（按 coursePickRule 选课）→ `wait-play`（等新媒体播放，可配 courseStartSelector 点开始学习）。

学习模式（autoClick=false）下：不点击，改为 Console 提示 + 横幅提示人工操作，接力保持存活继续观察。

## 首次使用（学习模式）

1. 保持 `autoClick:false`，Console 执行 `__RELAY_V1__.status()` 确认版本与阶段。
2. 让一门课自然播完；每个阶段看 Console 的 `[RELAY v1]` 输出（候选控件、列表条目、现场说明）。
3. 把观察到的选择器填入配置；确认无误后才把 `autoClick` 改为 `true` 做全自动接力。
4. 手动试跑列表流程：Console 执行 `__RELAY_V1__.gotoList()`，再人工点底部导航"学习"。

## 停止

- 点页面右下角"停止接力"按钮；或
- 在扩展页关闭/移除本扩展；或
- Console 执行 `__RELAY_V1__.stop()`。

状态查看：Console 执行 `__RELAY_V1__.status()`。
