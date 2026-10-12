# 跨课程接力 v1（本地自用，Issue #11）

授权边界见 #11 V1 冻结：单页签、只点网站原生 UI 元素、默认学习模式、不录音、不联网外传、不碰平台接口与存储。遇到考试/验证码/在场确认/登录失效自动停止并提示人工。

## 加载

1. Chrome 打开 `chrome://extensions`，右上角开启"开发者模式"。
2. 点"加载已解压的扩展程序"，选择本目录（`extension/relay-v1`）。
3. 刷新课程页签。页面右下角出现"接力 v1 已启动（autoClick=false）"即生效。

## 配置

编辑 `content.js` 顶部 `DEFAULT_CONFIG`，改完在扩展页点"重新加载"：

| 字段 | 说明 |
| --- | --- |
| `autoClick` | `false`=学习模式（只观察，把候选控件输出到 Console）；`true`=允许真实点击 |
| `courseListUrl` | 课程列表页地址（课程结束后去这里选下一门） |
| `nextChapterSelector` | 课内"下一节/继续学习"控件的 CSS 选择器 |
| `courseEntrySelector` | 列表页课程条目的 CSS 选择器 |
| `coursePickRule` | `first`（默认）\| `index:N` \| `contains:文本` |

## 首次使用（学习模式）

1. 不填选择器、保持 `autoClick:false`，让一门课自然播完。
2. 结束后看 Console 里 `[RELAY v1] 学习模式候选…` 输出的候选控件描述。
3. 把观察到的选择器填入配置；确认无误后才把 `autoClick` 改为 `true`。
4. 若平台整页刷新会硬导航，扩展内容脚本会自动随新页面重跑，无需干预。

## 停止

- 点页面右下角"停止接力"按钮；或
- 在扩展页关闭/移除本扩展；或
- Console 执行 `__RELAY_V1__.stop()`。

状态查看：Console 执行 `__RELAY_V1__.status()`。
