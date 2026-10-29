# dsh-quote-annotate-pro

[![npm version](https://img.shields.io/npm/v/dsh-quote-annotate-pro?color=2ea44f&label=npm)](https://www.npmjs.com/package/dsh-quote-annotate-pro)
[![ci](https://github.com/zhao-guang-ai/dsh-quote-annotate-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/zhao-guang-ai/dsh-quote-annotate-pro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![XERJ Corpus Hub contributor](https://hub.xerj.org/contributors/zhao-guang-ai/badge.svg)](https://hub.xerj.org/contributors/zhao-guang-ai)

**划词 → 批注 → 引用；发送之后，引用块仍然看得见，点一下就能回到原文。**

选中的文字变成带锚点的引用块：输入框里、已发送的消息里都只显示**紧凑的原文片段**（最多 3 行，轮次/角色那一行被隐藏），点它跳回原文并高亮；而发给模型的文本仍标明**这是第几处批注 + 哪一轮 + 谁说的**（`【批注 2 · 第5轮 · DSH 回复】`），并要求模型按 `Annotation 1：`、`Annotation 2：` 逐条回应 —— **回复里的每个 `Annotation N：` 都会渲染成 `批注 N` 芯片，悬浮看原文与评语，点击跳回原文。**

> ⭐ **如果这个插件帮到了你，点个 Star 是最直接的支持** → [zhao-guang-ai/dsh-quote-annotate-pro](https://github.com/zhao-guang-ai/dsh-quote-annotate-pro)（也会让更多 DSH 用户找到它）
>
> 已收录：in-DSH 市场（`dshmarket`）、[DSH Market](https://dsh.market/?q=zhao-guang-ai%2Fdsh-quote-annotate-pro)、[dsh-plugin.org](https://dsh-plugin.org/zh/plugins/zhao-guang-ai/dsh-quote-annotate-pro)、dsh.pub、dsh-xray、HackSing/dsh-plugins、[awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness)、[XERJ Corpus Hub](https://hub.xerj.org/contributors/zhao-guang-ai)（收录审核中）。

## 设计取舍：引用块"看得见"，而不是收进 chip

划词引用/批注这类插件，市场上的主流做法是**把引用收起来**：气泡里只剩一颗 `引用1` chip 或一个「批注 ×N」标签，原文要点开或悬停才能看到。本插件走的是另一条路：

| | 收进 chip / 标签（常见做法） | **本插件：紧凑引用块** |
|---|---|---|
| 发送后的气泡 | 只剩 chip / 标签，看不到引的是哪段 | **直接显示原文片段**（最多 3 行，超长省略） |
| 想对照原文 | 悬停或点开标签 | **点引用块 → 跳回原文并高亮** |
| 输入框 | chip 短标签 | 同样显示原文片段，与消息里一致 |
| 模型侧 | 取决于实现 | 文本仍带 `【引用 · 第N轮 · 角色】`，位置不丢 |
| 代价 | 气泡更"干净" | 气泡会多一块灰底引用区（所以压到 3 行、隐藏位置行） |

一句话：**引用是对话的一部分，不该被藏起来。** 如果你更希望气泡绝对干净、只在悬停时看引用，市面上有更合适的方案；如果你常要"这段是我引的哪一句"来回对照，这就是本插件存在的理由。

## 三步上手

1. 在任意消息里**选中一段文字** → 选区上方浮出小气泡 → 点「批注」→ 写评语（可留空）→ `Enter`；
   可以在多轮消息里连续批注多处：插件按**对话从上到下**的顺序统一编号（`批注 1`、`批注 2`…）——
   先批注第 5 轮、再回头批注第 2 轮，也会自动排成 1、2，编号与对话顺序永远一致；
2. 输入框里出现**紧凑引用块**（首行前面一个圆形编号 + 原文片段 + `批注：评语`，位置行隐藏，左侧有强调色竖条便于和手写文字区分），点它可跳回原文；
   圆形编号就是这块批注的序号（与发出后 `Annotation N` / `批注 N` 芯片的编号一致），由 CSS 生成、不写进正文 —— **删不掉、选不中、编辑不到**；
   想整块不要了，点块右侧的 **✕** —— 只删掉这一块，其余正文和别的引用块都保留，剩下的编号自动重排；
3. 发送后气泡里仍是紧凑引用块，点它随时回到原文并高亮；模型回复里的 `Annotation 1：`、`Annotation 2：`
   会变成 `批注 N` 芯片 —— **悬浮看这条批注的原文与评语，点击跳回原文**。
4. **审阅文档时**：在右侧文档预览里划词 → 「批注」→ **加入批注列表**（不立即写输入框）→ 底部浮条
   `批注 · N` 里可展开/编辑/删除 → 「**全部发送**」把 N 条按顺序一次性写进输入框；
   之后**点任意文档批注块**，会重新打开来源文件并定位到对应行/页。

## 功能

| 能力 | 说明 |
|---|---|
| 划词批注 | 会话里选中任意文字 → 选区上方浮出气泡（预览 + 「批注」）→ 编辑框里写评语（可留空）→ `Enter` 插入 |
| **自动编号** | 多轮、多处批注按**对话从上到下**统一编号 1..N（轮次 → 同一轮内的先后 → 点击时间）；先批注靠后的轮次、再回头批注靠前的，编号会自动重排，输入框里的顺序与对话顺序一致 |
| **块首编号** | 输入框里每块引用的首行前面有一个圆形序号（`1`、`2`…，与发出后的 `批注 N` 芯片一致）；编号用 CSS `::before` 画出来，**不在正文里**，删不掉、选不中、编辑不到，删中间一块后自动重排 1..N |
| **输入框里的引用块** | 插入后输入框里直接显示原文片段（位置行隐藏），与发送后完全一致；**点它跳回原文并高亮**；左侧强调色竖条与手写文字区分 |
| **位置行锁定** | 块首的 `【批注 N · …】` 与评语行的 `批注：` 前缀删不掉：退格/删除到块边界会被拦下（提示用 ✕），万一切割/撤销弄丢了也会自动补回；原文与评语正文里的字仍可自由编辑，删剩的残片会自动清除 |
| **整块取消** | 输入框里每块引用右侧一个 **✕**：只删这块（位置行 + 原文 + 评语），其它内容原样保留并重编号；按钮画在浮层里，不会误删、删不掉 |
| **残片清理** | 位置行被删剩半截（`引用 · 第14轮`、`（请按「Annotation 1：」…`）时自动隐藏，输入框里不留残渣 |
| **引用块（输入框内）** | 插入引用后输入框里只显示**原文片段**（位置行隐藏）；**点一下即跳回原文并高亮** —— 不做任何可见的"跳转"提示 |
| **对话页里的紧凑引用** | 已发送消息里的引用同样只显示**紧凑原文块**（最多 3 行），评语以 `批注：…` 跟在其后。**消息文本仍以位置行开头** —— 界面隐藏、模型照旧知道出处 |
| **回复逐条对照** | 协议指令内嵌在第一条批注的位置行里（界面隐藏）；模型回复的 `Annotation N：` 渲染成 `批注 N` 芯片，悬浮显示原文 + 评语，点击跳回原文 |
| **模型侧精确定位** | 引用块首行是 `【批注 2 · 第5轮 · 你的消息】`，后接原文与评语，让模型明确知道**哪一处、哪一轮、谁说的** |
| 回合级引用 | 每条已完成回合尾部有「引用提问 / 引用回答」，整段引用该轮 |
| 锚点持久化 | `ref → 锚点` 映射写入 `localStorage`（按会话，最多 60 条），**刷新页面后引用块仍能跳回原文** |
| **文档预览批注** | 右侧文档预览（docx / pdf / xlsx / 图片 / Markdown / 代码）里划词也能批注；位置行带来源文件：`【批注 1 · 文件 · <路径>[:L行\|:p页]】`，取不到路径时退回 `【批注 1】`，不报错 |
| **文件批注列表** | 不可编辑预览里的批注先攒起来（不立即写输入框），底部浮条 `批注 · N`：展开可单条编辑/删除/清空，点空白或 Esc 收起，「全部发送」一次性写进输入框 |
| **文档批注跳回来源** | 点文档批注块 → 用官方 `sidebarRight.openResource` 打开来源文件：文本/代码预览带 `line` 参数自动滚到行并高亮；PDF/Office 打开后滚到对应页 |
| **代码 / 文本 / Markdown 预览** | 这些不可编辑预览与 docx/pdf 走同一条文件批注链路：位置行带文件名，文本类带 `:L行号`（代码用 `pre .line` 序号回退），Markdown 没有逐行 DOM 故不带行号 |
| **Excel 预览选区批注（0.4.2 / 0.4.3）** | 表格单元格画在 canvas 上、没有可选文字，改用公式栏 Name Box 的选区地址定位：`【批注 1 · 文件 · 预算.xlsx:Sheet1!A1:C3】`；支持 `xls / xlsx / xlsm / xlsb / xlt / xltx / xltm / ods / ots / fods / numbers / csv / tsv`，整行 / 整列归一化成 `Sheet1!3:5` / `Sheet1!B:D`，不读单元格内容 |
| **语音输入（0.4.3）** | 批注框输入框右侧的麦克风：点一下说话、再点一下结束，识别结果按光标插进评论（复用宿主「语音输入」插件的识别能力；没开语音插件时按钮不显示） |
| 中英自适应 | 按钮文案跟随界面语言（沿用上游） |

### 文档预览划词：位置行带文件路径（0.4.0）

在右侧栏的文档预览（docx / pdf / xlsx / 图片 / Markdown / 代码）里划词批注时，引用块位置行会带来源文件：

- 聊天消息：`【批注 2 · 第5轮 · DSH 回复】`（与旧版完全一致）
- 文档预览：`【批注 1 · 文件 · sidebar-test\测试文档.docx】`；文本类追加 `:L12`，PDF/Office 追加 `:p3`

路径默认显示为「工作区内相对会话 cwd、工作区外绝对路径」；想一律用绝对路径，把 `lib/client.js` 顶部的
`DOC_PATH_STYLE` 改成 `'absolute'`。取不到路径（旧版本没有预览槽位、侧栏被第三方接管等）时自动退回
`【批注 1】`，不报错、不影响聊天批注与回跳。

### 文件批注列表：先攒批注，再一次性发送（0.4.0）

只对**不可编辑的文档预览**生效（docx / pdf / xlsx / 官方 md 预览 / 文本与代码预览）。可编辑预览（milkdown、
sidebar-editor）和聊天输入框里的选区仍然不会弹气泡——保持原设定。

1. 在文档预览里划词 → 浮出「批注」→ 写意见 → **加入批注列表**（不再立即写输入框）；
2. 文件有批注后，预览**底部**浮出一条半透明胶囊：`批注 · N` + **展开 / 收起** + **全部发送** + **全部删除**；
   - 展开后在上方浮出列表：单条点击原文可**展开 / 收起**；每条可**编辑**（行内输入框，Enter 保存 / Esc 取消）或**删除**；
   - **点浮条/列表以外任意位置、或按 Esc 自动收起**（行内编辑时 Esc 只取消该条编辑）；
   - 「**全部发送**」把 N 条按 `【批注 N · 文件 · <路径>[:p页|:L行]】` 一次性写进对话输入框，按回车即可发送；
   - 「**全部删除**」清空本文件批注，浮条随之消失；
3. 列表按「会话 + 文件绝对路径」存 `localStorage`，刷新 / 切 tab 不丢；「全部发送」后列表会清空（避免重复插入），需要时继续攒下一批。

聊天消息里的划词批注不受影响：仍然「立即插入 + 位置行 + 点击跳回」。

### Excel 预览：选区即定位（0.4.2，0.4.3 补齐格式）

单元格由官方预览用 Fortune-Sheet 画在 `<canvas>` 上，`window.getSelection()`
拿不到内容，所以「划词」链路在 Excel 里不触发（0.4.2 之前 Excel 预览只能看、不能批注）。0.4.2 起改为按
**选区地址**定位；0.4.3 把支持的格式补全为 DSH 自己的 excel 分类
（`xls / xlsx / xlsm / xlsb / xlt / xltx / xltm / ods / ots / fods / numbers` 以及 `csv / tsv`），
扩展名认不出时只要预览里有 Fortune-Sheet 的标记（`[data-excel-preview]` / `.fortune-name-box`）也照样能用：

1. 打开工作簿 → 点单元格 / 拖选区域 / 点行头或列头选整行整列 → 选区旁浮出「批注」气泡（地址来自公式栏 Name Box）；
2. 写意见 → 加入底部 `批注 · N` 列表 → 「全部发送」：
   `【批注 1 · 文件 · 预算.xlsx:Sheet1!A1:C3】`（单格 `Sheet1!A1`、整行 `Sheet1!3:5`、整列 `Sheet1!B:D`）；
   sheet 名含空格等特殊字符时按 Excel 规则加引号（`'2024 预算'!B2`）；
3. 不读单元格内容；点已发送的批注块会打开工作簿（Excel 预览不自带定位，暂不自动选中区域）。
   合并单元格按左上角焦点单元格定位，多个不连续选区只取最后一个（与 Name Box 一致）。

### 语音输入：写批注不用切输入法（0.4.3）

新版 DSH 的输入框自带语音输入。0.4.3 把这个麦克风搬进了批注框：

1. 选中文字 → 气泡里点「批注」→ 编辑框**输入框右侧**的麦克风，点一下开始说话（按钮变红、提示行显示 `正在录音 0:03`）；
2. 再点一下结束 → 识别结果按**光标位置**插进正在写的评论（选中的文字会被替换）；
3. 文件批注面板里展开某条批注后的编辑框也有同一个麦克风。

录好的音频在浏览器内重采样成 16kHz 单声道 WAV，再交给宿主语音插件的 `speech` Remote 识别，插件本身不联网。
时长 / 体积上限跟着宿主设置走（默认 120 秒 / 4MB），到点自动结束。语音输入插件没开启时按钮不显示。

> 文档预览批注的原型来自 [DoggyHU 的 fork](https://github.com/DoggyHU/dsh-quote-annotate-pro)（MIT，
> `document-preview annotations originally prototyped by DoggyHU`），0.4.0 在最新代码上重做并合并，署名保留。

> 这是 [`dsh-quote-annotate`](https://github.com/wangwei-wade/dsh-quote-annotate)（MIT，作者 wangwei-wade）的增强 fork。
> 上游 v0.1.1 在 **DSH 0.2.0-rc.2** 上会**静默失效**（既不报错也不注册任何 UI），本 fork 修掉了 4 个兼容性问题，
> 并补上了 3 项能力；另有 2 个接口变化（当前会话、chip DOM 定位）一并适配。许可仍为 MIT，见 [LICENSE](./LICENSE)。
> 完整汇总见 [SUMMARY.md](./SUMMARY.md)。

## 安装

```sh
# 从 npm 安装（推荐，一步到位）
dsh plugin --profile <profile> add dsh-quote-annotate-pro

# 或直接从 GitHub 安装
dsh plugin --profile <profile> add github:zhao-guang-ai/dsh-quote-annotate-pro

# 本地开发：
#   <本仓库绝对路径> 为克隆后的目录；link 安装后改文件即刻热更，无需重启
dsh plugin --profile <profile> add <本仓库绝对路径>
```

装好后 profile 的 `package.json` 会出现：

```
"dsh-quote-annotate-pro": "link:<本仓库绝对路径>"
```

## 工作原理

```
选中文字
  │ 气泡「批注」→ 编辑框 → Enter
  ▼
input.setDraft(...)  写入纯文本【批注 N · 第5轮 · 角色】+ 原文 + 「批注：评语」
  │ 输入框装饰立刻把这三段折叠成紧凑引用块（位置行隐藏，原文浅色块）
  ▼
输入框里显示：紧凑引用块 + 批注：你的评语（点引用块可跳回原文）
  │ 发送（消息文本 = 输入框文本，原样带上位置行）
  ▼
模型收到"第几处批注 + 哪一轮 + 谁说的 + 原文 + 评语"
  ▼
模型回复里出现 Annotation 1：… → 插件渲染成「批注 1」芯片
     （悬浮看原文+评语，点击跳回原文）

界面侧：插件在渲染时把位置行与引用正文包成紧凑块（隐藏位置行、只留原文），
        点击引用块 → 按锚点 scrollIntoView + 高亮（无可见提示）。
        输入框与已发送消息使用**同一套**视觉规则，观感一致。
```

用到的官方接口：`slots`（`shell.overlay` / `conversation.chat.turnTail` / `conversation.input.dock`）、
`conversation.input`（草稿 + occurrences）、`sessions.binding/scope`、`inputTriggers.registerSource` + codec、
DOM 锚点 `data-chat-anchor-key` / `data-chat-turn`。

## 与上游的差异

### 兼容性修复（否则整插件静默失效）

1. **缺 cordis 依赖声明** —— 上游 `apply(ctx)` 里 `const slots = ctx.get('slots')`，拿不到就 `return`。
   没有声明 `inject: ['slots']` 时 `apply` 可能早于 slots 服务就绪执行，于是**无声退出，一个 UI 都不注册**。
   → 本 fork 声明 `exports.name` + `exports.inject = ['slots']`，并给每一步注册加 `try/catch` + 上报。

2. **`conversation.chat.turnTail` 已从 chain 变 list**（DSH 0.1.6-alpha.2 起）—— 上游仍用 `{ select, priority }` 注册，
   会抛错；而它排在 4 个 overlay 注册**之前**，一崩全崩。→ 改为 `{ name, id, order }`。

3. **chip 插入 API 变了** —— 上游调用 `input.insertReference(...)`，该对象在本版本没有此方法，永远退化为纯文本。
   → 改走官方会话事件 `slash/input-insert-reference`（与 `dsh-better-sidebar` 同一条在本版本已验证的通路）。

4. **回合尾部按钮不出现（快照形状变了）** —— 上游用 `useSession` 的快照 + `Array.isArray(snapshot.nodes)` + 节点 `seq`
   来取该轮文本；本版本真实形状是 **Chat 快照（`useChat`）**、**`nodes` 是 Map**、**节点身份是 `anchorSeq`**、
   文本在 `user.data.content[{type:'text'}]` / `assistant-step.data.blocks[{kind:'text'}]`，
   assistant 节点 kind 也不是 `assistant` 而是 `assistant-step`。→ 全部按本版本形状重写取文与锚点解析。

### 能力增强

5. **当前会话解析** —— 上游读 `useSessions(s => s.current)`，而**本版本会话列表快照没有 `current` 字段**（恒为 `undefined`），
   导致点「批注」只关掉气泡、什么都不发生。→ 改为由**会话作用域槽位**（`conversation.input.dock` 探针）回填 `sessionId`，
   并去掉"必须先解析到会话才开编辑框"的门槛（解析失败也照常进入编辑，插入时再解析）。

6. **引用块带轮次/角色** —— 上游只发原文。→ 首行加 `【引用 · 第N轮 · 角色】`（轮次取自 `data-chat-turn`，角色取自 `data-chat-flow-kind`）。

7. **输入框里的引用块 + 点击/悬停回原文** —— 输入框里直接写入纯文本（位置行 + 原文 + 评语），由插件装饰成
   与消息侧一致的紧凑引用块，**点击即可跳回原文**；不依赖 chip，因此不会被宿主的 chip 渲染细节拖住。
   `ref → 锚点` 映射仍落 `localStorage`（按会话，最多 60 条），刷新页面后消息侧的引用块仍能精确跳回。

## 开发

```
lib/client.js          全部功能（手写 bundle，无构建步骤 —— 改完保存即生效）
tools/diag-sink.mjs    本地诊断接收端（可选）
tools/check-manifest.mjs  清单一致性自检（CI 同款）
```

```sh
npm run check    # 校验 package.json / patch / bundle 注册 id 是否一致
npm test         # 客户端纯函数自检（编号 / 位置行解析 / 输入框摘要，无需浏览器与网络）
npm run diag     # 起诊断接收端（默认 http://127.0.0.1:47821）
```

改完 `lib/client.js` **无需重启 DSH**：宿主按磁盘内容提供 bundle，客户端 HMR 检测到内容变化会自动热更该插件。

### 诊断通道（开发期）

`lib/client.js` 顶部有：

```js
const DIAG_ENABLED = true
const DIAG_URL = 'http://127.0.0.1:47821/dsh-quote-pro'
```

插件启动时 POST 一次 `/ping`；**探测不到接收端就本次运行静默**（不会产生网络噪音）。
配合 `npm run diag`，终端会实时打出全链路事件：

> ⚠️ **隐私 / 网络说明（收录信息里必须如实写）**：本插件是纯客户端插件，**不访问任何外部服务、不碰凭证**，
> 唯一的数据落点是 `localStorage` 里的锚点表（每会话 ≤60 条）。
> 但它默认会向**本机** `http://127.0.0.1:47821` 发一次探测（以及探测成功后的诊断事件）——
> 这是 `DIAG_ENABLED = true` 的默认行为，**不要写成"零网络请求"**。
> 2026-10-16 我们就因为这句不准确的表述，被 `0xsline/awesome-deepseek-harness` 的维护者在合并时改写成
> *"the client enables localhost diagnostic requests by default"*。想让"无网络请求"成为事实，就把 `DIAG_ENABLED` 改成 `false`。


```
module:materialized / apply:start / register:ok …   插件加载与槽位注册
selection:show / selection:stage                    划词与「批注」
insert:plaintext / cmp:decorated               引用插入（纯文本）与输入框装饰
dock:rows / dock:click / jump:ok / toast            导航条与跳回原文
turnTail:render                                     回合尾部按钮取文
```

不需要时把 `DIAG_ENABLED` 改成 `false` 即可（`console.log('[quote-pro]', …)` 会保留）。

## 发版（维护者）

发布走 **npm Trusted Publishing（OIDC）**，仓库里不保存任何 token，也不需要动态验证码：

1. 改 `package.json` 的 `version`，并在 `CHANGELOG.md` 记录变更
2. 提交、打标签、推送：

   ```sh
   git tag -a v0.2.2 -m "v0.2.2"
   git push origin main --follow-tags
   ```

3. GitHub Actions 的 [`release.yml`](.github/workflows/release.yml) 自动执行：
   校验 tag 与版本一致 → 语法与清单自检 → `npm publish --provenance`（带 SLSA 签名）
4. 该版本已存在时自动跳过，工作流可安全重跑

已在 npm 包设置页配置的 Trusted Publisher：

| 字段 | 值 |
|---|---|
| Organization or user | `zhao-guang-ai` |
| Repository | `dsh-quote-annotate-pro` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |

> 注：npm 现在对"绕过 2FA 的 token 直接发布"逐步收紧（账号变更已限制，直接发布 2027-01 起限制），
> 因此本仓库从一开始就只走 OIDC —— 这是官方推荐方向，也避免了 token 泄漏风险。

## 已知限制

- **输入框里的引用块是纯文本 + 样式**：它由插件装饰出来，不是宿主的原子节点；全选复制输入框会把位置行一起复制走（
  发给模型的内容本来就是这段文本，因此不影响模型理解）。
- **跳转要求原文行在当前页面**：目标消息未加载（历史未翻到）时只能给出提示，不做自动翻页加载。
- **引用块在会话切换后重建**：锚点按会话存储；切到别的会话不会串。
- **整块取消**：输入框里每块引用右侧有 **✕**（浮层按钮），点一下只删这一块并重编号；它不写进正文，删不掉。
- **文档预览批注的“跳回”是打开文件并定位**：点批注块会用官方 `sidebarRight.openResource` 打开来源文件；文本 / 代码预览通过导航参数 `line` 自动滚到行并高亮，PDF / Office 打开后按 `[data-pdf-page]` 滚到目标页。它不像聊天批注那样高亮消息里的原文。
- **行号/页码来自 DOM**：文本与代码预览的 `:L` 取 `data-textpreview-line`（代码块回退到 `pre .line` 序号），PDF 的 `:p` 取 `data-pdf-page`；docx 走 Office→PDF 管线，所以页码是转换后的页码，Markdown 没有逐行 DOM 就没有 `:L`。
- **可编辑预览不走文件批注列表**：milkdown 等可编辑面与聊天一致（立即插入），只有不可编辑预览才攒批注。
- **回合尾部按钮在有交付文件的回合也会显示**：上游会隐藏、让位给官方「已生成文件」chips。

## 贡献

欢迎 Issue / PR。提 PR 前请跑一遍 `npm run check`，并说明验证时使用的 DSH 版本（本仓库在 **0.2.0-rc.2** 上真机验证）。
由于 DSH 仍处于 rc 阶段，内部契约可能随版本变化，改动请附上验证方式。

## 许可与来源

MIT，见 [LICENSE](./LICENSE)。

- 上游：[`wangwei-wade/dsh-quote-annotate`](https://github.com/wangwei-wade/dsh-quote-annotate) v0.1.1（MIT，© 2026 wangwei-wade）
- 本 fork：修复其在 **DSH 0.2.0-rc.2** 上的 6 个兼容性问题，并补充引用定位相关能力，同样以 MIT 发布
- 文档预览批注原型：[`DoggyHU/dsh-quote-annotate-pro`](https://github.com/DoggyHU/dsh-quote-annotate-pro)（MIT，2026-10），0.4.0 中重做并合并，保留署名
- 深色模式适配与多行批注修复：[PR #3](https://github.com/zhao-guang-ai/dsh-quote-annotate-pro/pull/3) by [@Jayden-27](https://github.com/Jayden-27)，0.4.1 中合入
- Excel 预览选区批注：[PR #4](https://github.com/zhao-guang-ai/dsh-quote-annotate-pro/pull/4) by [@DoggyHU](https://github.com/DoggyHU)，0.4.2 中合入
