// dsh-quote-annotate-pro —— Client 半区（浏览器）
// Fork of dsh-quote-annotate v0.1.1 (MIT, wangwei-wade) —— 增强：精确锚点 / 可观测性
// 上游 bundle 形态保留：window.__ModuleLoader__ 工厂式 CJS
//
// ⚠️ 开发注意（踩过的坑，改装饰逻辑前必读）
//   1) 装饰（把"【引用 · 第N轮 · 角色】+ 原文"重排成紧凑块）**绝不能破坏用户当前选区**：
//      一旦替换了用户正在划词的文本节点，range.getBoundingClientRect() 会退化成"贴文档原点"的矩形，
//      用它算出的位置正好是 left≈12/top≈8 —— 批注编辑框就跑到窗口左上角（0.2.8 的现象）。
//      因此：① 扫描时用 selectionTouches(row) 跳过用户正在划词的那条消息；
//            ② 编辑框定位一律走 anchorRect()：优先**当前活着的选区** → 校验过的旧矩形 → 视口底部居中。
//   2) 装饰必须是"幂等 + 只加样式类/包一层隐藏元素"，且判定要看**内容**（是否还有未接管的位置行），
//      不能只看 data-* 标记 —— 宿主会重排气泡内容，标记会骗人。
//   3) 所有装饰都要 try/catch 且不抛到 React 渲染路径上；观察者回调里同步执行（先于绘制）才不会闪。
window.__ModuleLoader__.load({
  id: 'dsh-quote-annotate-pro',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let React = require('react')

    // ============ 诊断通道（开发期；探测不到本地接收端就本次运行静默） ============
    // 想彻底关闭：把 DIAG_ENABLED 改成 false（或注释掉 sendReport 的 fetch）。
    const DIAG_ENABLED = true
    const DIAG_URL = 'http://127.0.0.1:47821/dsh-quote-pro'
    let diagReady = null // null=探测中 true=可用 false=不可用
    const diagQueue = []
    function sendReport(text) {
      try {
        if (typeof fetch === 'function') {
          Promise.resolve(fetch(DIAG_URL, { method: 'POST', body: text, keepalive: true })).catch(() => {})
        }
      } catch (e) { /* ignore */ }
    }
    function report(tag, detail) {
      try {
        let text
        if (detail === undefined) text = tag
        else if (typeof detail === 'string') text = tag + ' ' + detail
        else {
          try { text = tag + ' ' + JSON.stringify(detail) } catch (e) { text = tag + ' <unserializable>' }
        }
        console.log('[quote-pro]', text)
        if (!DIAG_ENABLED || diagReady === false) return
        if (diagReady === null) {
          diagQueue.push(text)
          if (diagQueue.length > 60) diagQueue.shift()
          return
        }
        sendReport(text)
      } catch (e) { /* diagnostics must never throw */ }
    }
    if (DIAG_ENABLED && typeof fetch === 'function') {
      const pingOnce = () => {
        try {
          fetch(DIAG_URL + '/ping', { method: 'POST', body: 'ping' }).then(() => {
            if (diagReady === true) return
            diagReady = true
            const pending = diagQueue.splice(0)
            for (const text of pending) sendReport(text)
          }).catch(() => { diagReady = false })
        } catch (e) { diagReady = false }
      }
      pingOnce()
      // 接收端比页面晚启动也来得及：未就绪时每 5 秒重试探测；
      // 就绪后仍然每 20 秒心跳一次 —— 接收端中途挂掉（例如诊断进程被杀）也能自愈，不用刷新页面。
      try {
        let tick = 0
        const retryTimer = setInterval(() => {
          tick += 1
          if (diagReady !== true || tick % 4 === 0) pingOnce()
        }, 5000)
        // Node（自检脚本里 import 本模块）不会自己退出 → 解除引用；浏览器里返回的是数字，跳过
        if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref()
      } catch (e) { /* ignore */ }
    } else {
      diagReady = false
    }
    report('module:materialized', { id: 'dsh-quote-annotate-pro' })

    // ============ 引用锚点文案：让模型知道"这指的是哪一处" ============
    // role/kind 取自 DOM 的 data-chat-flow-kind，turn 取自 data-chat-turn（与 TurnLocation.turn 同源，0 基）
    function roleText(role, kind) {
      const k = role || kind
      if (k === 'user') return '你的消息'
      if (k === 'assistant-step' || k === 'assistant') return 'DSH 回复'
      if (k === 'tool-call') return '工具调用'
      if (k === 'steering') return '插话'
      if (k === 'turn-tail') return '回合结算'
      if (k === 'question-reply') return '你的答复'
      if (k === 'command' || k === 'command-input') return '命令'
      return k ? '消息(' + k + ')' : ''
    }
    function anchorLabelOf(item) {
      const parts = []
      if (item && typeof item.turn === 'number' && Number.isFinite(item.turn)) parts.push('第' + (item.turn + 1) + '轮')
      const role = roleText(item && item.role, item && item.kind)
      if (role !== '') parts.push(role)
      return parts.join(' · ')
    }
    /** 引用块首行：模型据此确定"这是第几处批注、哪一轮、谁说的（或来自哪个文件）"。 */
    function buildQuoteHeader(item, no) {
      const label = anchorLabelOf(item)
      const doc = docSourceLabel(item)
      const numbered = typeof no === 'number' && Number.isFinite(no) && no > 0
      const parts = [numbered ? '批注 ' + no : '引用']
      if (label !== '') parts.push(label)
      // 文档预览选区没有消息行锚点，位置行改带「文件 · <路径>[:L行|:p页]」
      if (doc !== '') {
        parts.push('文件')
        parts.push(doc)
      }
      // 老格式（无编号且无位置信息）保持空串，避免出现只有「【引用】」的块
      if (parts.length === 1 && parts[0] === '引用') return ''
      return '【' + parts.join(' · ') + '】'
    }
    /** 批注编号：同一条消息内从 1 开始；删掉中间某条不会重号（取现有最大号 + 1）。 */
    function nextAnnotationNo(draft) {
      let max = 0
      try {
        const text = String(draft || '')
        const re = /【批注\s*(\d+)/g
        let m
        while ((m = re.exec(text)) !== null) {
          const n = Number(m[1])
          if (Number.isFinite(n) && n > max) max = n
        }
      } catch (e) { /* ignore */ }
      return max + 1
    }
    /** 位置行（兼容旧格式「【引用 · …】」与新格式「【批注 N · …】」；中间分隔符可能是 " · "） */
    const QUOTE_HEADER_RE = /【(?:引用|批注)[^\n】]*】/
    /** 从「… · 文件 · <路径>[:L行|:p页]】」里取文件名（不是文档来源返回 ''） */
    function stripHeaderInstruction(headerText) {
      return String(headerText || '').replace(/（请按「Annotation[^）]*）/g, '')
    }

    function docFileNameOfHeader(headerText) {
      try {
        // 路径本身可能含「】」（如「预算】2026.xlsx」），这里取到最后一个「】」为止
        const m = / · 文件 · ([\s\S]+)】$/.exec(stripHeaderInstruction(headerText))
        if (!m) return ''
        const p = stripExcelSourceSuffix(String(m[1] || '').replace(/:(?:L|p)\d+$/, '')).trim()
        return p === '' ? '' : fileNameOfPath(p)
      } catch (e) { return '' }
    }

    /**
     * 位置行末尾的 Excel 选区后缀：`:Sheet1!A1:C3` / `:'2024 预算'!B2` / `:3:5` / `:B:D`。
     * Excel 批注只做定位（canvas 上没有可跳转的行/页），跳回来源时只打开文件，
     * 所以解析路径前先把这个后缀去掉，别让它混进 path。
     */
    // sheet 名为空时先生成 `:!A1`（而不是裸 `:A1`），否则会被当成 `:L12`/`:p3` 那种行/页后缀解析
    const EXCEL_SOURCE_SUFFIX_RE = /:(?:(?:'((?:[^']|'')+)'|([^:'!]*))!)?((?:[A-Z]+)?\d+(?::(?:[A-Z]+)?\d+)?|[A-Z]+:[A-Z]+)$/
    function stripExcelSourceSuffix(text) {
      const s = String(text || '')
      const m = EXCEL_SOURCE_SUFFIX_RE.exec(s)
      if (!m) return s
      const base = s.slice(0, m.index)
      // 只剥 Excel 文件、或带 `!` 的 sheet 引用：别的预览里 `名字:2024` 之类的不能被改坏
      if (s.slice(m.index).indexOf('!') < 0 && !isExcelPath(base)) return s
      return base
    }

    /** 从「… · 文件 · <路径>[:L行|:p页]】」里取出 { path, line, page }（不是文档来源返回空对象） */
    function parseDocSourceHeader(headerText) {
      const out = { path: '', line: null, page: null }
      try {
        const m = / · 文件 · ([\s\S]+)】$/.exec(stripHeaderInstruction(headerText))
        if (!m) return out
        let p = String(m[1] || '').trim()
        const lineMatch = /:L(\d+)$/.exec(p)
        if (lineMatch) {
          out.line = Number(lineMatch[1])
          p = p.slice(0, lineMatch.index)
        }
        const pageMatch = /:p(\d+)$/.exec(p)
        if (pageMatch) {
          out.page = Number(pageMatch[1])
          p = p.slice(0, pageMatch.index)
        }
        // Excel 批注：`:Sheet1!A1:C3` 这类后缀只表示定位，跳回时只打开文件、不定位
        out.path = stripExcelSourceSuffix(p).trim()
        return out
      } catch (e) { return out }
    }

    /**
     * 把位置行里的（可能相对 cwd 的）路径换成 DSH 的 `dsh-resource://file/…` 地址，
     * 交给官方 `sidebarRight.openResource` 打开 / 定位。
     * 会话内文件用 session scope（相对路径），工作区外的绝对路径用 absolute scope。
     */
    function fileResourceAddress(sessionId, path) {
      try {
        const raw = String(path || '').replace(/\\/g, '/')
        if (raw === '') return ''
        const segments = raw.split('/').filter((seg) => seg !== '')
        const encoded = segments.map((seg) => {
          try { return encodeURIComponent(seg) } catch (e) { return seg }
        }).join('/')
        const absolute = /^[A-Za-z]:/.test(raw) || raw.charAt(0) === '/'
        if (absolute) return 'dsh-resource://file/absolute/' + encoded
        return 'dsh-resource://file/session/' + encodeURIComponent(String(sessionId || '')) + '/' + encoded
      } catch (e) { return '' }
    }

    /** 从位置行里取批注编号（旧格式「【引用 · …】」没有编号，返回 null） */
    function annotationNoOf(headerText) {
      const m = /^【批注\s*(\d+)/.exec(String(headerText || ''))
      if (!m) return null
      const n = Number(m[1])
      return Number.isFinite(n) && n > 0 ? n : null
    }
    /**
     * 把「位置行 + 原文（空行）批注：…」拆成结构化块 —— 纯函数，单测与渲染共用：
     *   { before, header, no, quote, comment, rest }
     * 解析不了（没有位置行/没有原文）返回 null。
     *
     * 引用正文的边界**不是空行**：多段划词选中的原文本身就带空行（例如选中两段
     * 中间隔着空行的回答），按空行切会把第 2 段之后的内容漏成正文。
     * 真正的边界是「批注：」评语行，以及下一个位置行。
     */
    function parseQuoteBlock(raw) {
      const text = String(raw || '')
      const m = QUOTE_HEADER_RE.exec(text)
      if (!m) return null
      const after = text.slice(m.index + m[0].length)
      const nl = after.indexOf('\n')
      if (nl < 0) return null
      const lines = after.slice(nl + 1).split('\n')
      // 引用正文 = 位置行之后，直到「批注：」评语行或下一个位置行为止（空行属于正文，保留）
      const quote = []
      let i = 0
      for (; i < lines.length; i++) {
        const t = lines[i].trim()
        if (/^批注[:：]/.test(t)) break
        if (HEADER_LINE_RE.test(t)) break
        quote.push(lines[i].replace(/^>\s?/, ''))
      }
      // 去掉正文首尾的空行（正文内部空行保留）
      while (quote.length > 0 && quote[0].trim() === '') quote.shift()
      while (quote.length > 0 && quote[quote.length - 1].trim() === '') quote.pop()
      if (quote.length === 0) return null
      const rest = lines.slice(i).join('\n')
      let comment = ''
      const cm = /(?:^|\n)\s*批注[:：]\s*([^\n]*)/.exec(rest)
      if (cm) comment = cm[1].trim()
      return {
        before: text.slice(0, m.index),
        header: m[0],
        no: annotationNoOf(m[0]),
        // 多行正文用换行连接（保留段落结构）；单行时与旧行为一致
        quote: quote.join('\n').trim(),
        comment,
        rest,
      }
    }

    // ============ 多轮批注：按对话从上到下排序、统一重编号 ============
    // 用户痛点（0.3.5 反馈）：批注按"点击顺序"追加 —— 先批注第 3 轮、再批注第 1 轮时，
    // 输入框里编号是 1、2，对应却是「第3轮、第1轮」，人和模型都对不上。这里改成按
    // 对话里的出现先后（轮次 → 同一轮内的 DOM 顺序）排序，并重编号 1..N。
    const ANNOT_STORE_PREFIX = 'dsh-quote-pro:ann:'
    const MAX_ANNOTATIONS = 12
    /** 草稿里的一整行位置行（【引用 · …】/【批注 N · …】） */
    const HEADER_LINE_RE = /^【(?:引用|批注)[^\n]*】$/
    const normForMatch = (s) => String(s || '').replace(/\s+/g, ' ').trim()

    /**
     * 看起来像"位置行残片"的行：用户把位置行删了一半（`引用 · 第14轮`、`（请按「Annotation…`），
     * 正则已经匹配不上完整格式，但这些字仍然不该出现在输入框里 —— 装饰时统一藏掉。
     */
    function looksLikeQuoteFragment(t) {
      const s = String(t || '').trim()
      if (s === '') return false
      if (/^[【】〕〔\[]/.test(s)) return true
      if (/^（请按「Annotation/.test(s)) return true
      if (/^批注\s*\d/.test(s)) return true
      if (/·\s*第\s*\d+\s*轮\s*·/.test(s)) return true
      if (/^(引用|批注)\s*[·：:]/.test(s)) return true
      // 删到只剩一个词（截图里那条 `批注`）：同样算残片
      if (/^(引用|批注|Annotation)\s*[\d：:]?\s*$/.test(s)) return true
      if (/第\s*\d+\s*轮/.test(s) && /(DSH|你|回复|消息)/.test(s) && s.length <= 24) return true
      return false
    }

    /**
     * 从草稿里剥掉所有引用块（连同「批注：…」行与删除残片），只留下用户自己写的文字。
     *
     * 两种块的收尾方式不同：
     *   - 完整块（位置行 HEADER_LINE_RE 开头）：正文可能**内含空行**（多段划词选中的原文），
     *     只有在遇到「批注：」评语行或下一个位置行时才结束；
     *   - 残片行（`引用 · 第14轮`、`（请按「Annotation…`）：本身没有正文，顺手吞掉它后面的
     *     空行即可，遇到正常文字就算块外，不能把用户文字一起吃掉。
     */
    function stripQuoteBlocks(raw, knownQuotes) {
      const lines = String(raw || '').split('\n')
      const kept = []
      // 调用方已知的原文（来自批注存储）：用来精确判断"正文到哪一行为止"。
      // 只靠「批注：」评语行/下一个位置行收块时，没有评语的块（用户压根没写评语，
      // 或把「批注：…」整行删掉了）会把块后面的用户文字一起吞掉 —— 再插一条批注时
      // 用户文字就没了。正文一命中已知原文就收块，后面的行按用户文字保留。
      const quotes = new Set(
        (Array.isArray(knownQuotes) ? knownQuotes : []).map(normForMatch).filter((s) => s !== ''),
      )
      let acc = ''
      let mode = 'none' // 'quote' = 完整块正文；'fragment' = 残片
      for (const line of lines) {
        const t = line.trim()
        if (mode === 'quote') {
          if (/^批注[:：]/.test(t)) { mode = 'none'; acc = ''; continue }
          if (HEADER_LINE_RE.test(t)) { mode = 'quote'; acc = ''; continue }
          if (looksLikeQuoteFragment(t)) { mode = 'fragment'; acc = ''; continue }
          if (t !== '' && quotes.size > 0) {
            acc = acc === '' ? normForMatch(t) : acc + ' ' + normForMatch(t)
            if (quotes.has(acc)) { mode = 'none'; acc = '' } // 正文已完整命中 → 块到此结束
          }
          continue // 正文（含内部空行）
        }
        if (mode === 'fragment') {
          if (t === '' || looksLikeQuoteFragment(t)) continue
          mode = 'none' // 残片后面是正常文字 → 块已结束，落到下面按用户文字处理
        }
        if (/^批注[:：]/.test(t)) continue
        if (HEADER_LINE_RE.test(t)) { mode = 'quote'; continue }
        if (looksLikeQuoteFragment(t)) { mode = 'fragment'; continue }
        kept.push(line)
      }
      return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    }

    /**
     * 只删掉"这一块"引用（位置行 + 原文 + 评语 + 相邻空行），其它内容原样保留 —— 纯函数。
     * 用文本手术而不是整段重建：旧版本/手工插入的引用块不会因为一次取消而整体丢失。
     */
    function removeBlockFromDraft(raw, quote, comment) {
      const text = String(raw || '')
      const lines = text.split('\n')
      const target = normForMatch(quote)
      if (target === '') return text
      const norm = lines.map((l) => normForMatch(l))
      // 1) 定位引用正文（原文可能跨多行，且中间可能带空行 —— 多段划词）
      //    比较时两侧都走 normForMatch（空白规约成单空格），否则 target 里的换行/空行
      //    与逐行累加的 acc 永远对不上，整块取消会失效。
      let bodyStart = -1
      let bodyEnd = -1
      for (let i = 0; i < lines.length && bodyStart < 0; i++) {
        if (norm[i] === '') continue
        if (HEADER_LINE_RE.test(lines[i].trim())) continue
        let acc = ''
        for (let j = i; j < lines.length; j++) {
          const raw = lines[j].trim()
          if (HEADER_LINE_RE.test(raw) || /^批注[:：]/.test(raw)) break
          const cur = norm[j]
          if (cur !== '') acc = acc === '' ? cur : acc + ' ' + cur
          if (acc === target) {
            // 命中后继续向后延伸：调用方给的 quote 可能只是正文的前一部分
            //（历史草稿 / 手工插入），后面的行仍属于同一块的正文。
            let e = j
            for (let k = j + 1; k < lines.length; k++) {
              const r2 = lines[k].trim()
              if (HEADER_LINE_RE.test(r2) || /^批注[:：]/.test(r2)) break
              if (norm[k] !== '') e = k
            }
            bodyStart = i
            bodyEnd = e
            break
          }
          if (acc.length > target.length + 2) break
        }
      }
      if (bodyStart < 0) {
        // 实在找不到原文：若给了评语，至少把孤立的「批注：…」行清掉（否则清空输入框后会留下残句）
        const want = normForMatch(comment)
        if (want !== '') {
          for (let i = 0; i < norm.length; i++) {
            if (norm[i] !== '批注：' + want && norm[i] !== '批注:' + want) continue
            return lines.slice(0, i).concat(lines.slice(i + 1)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
          }
        }
        return text
      }
      // 2) 正文范围已在第 1 步确定（支持内部空行）；只把尾部的空行排除在块外
      while (bodyEnd > bodyStart && norm[bodyEnd] === '') bodyEnd -= 1
      // 3) 往上找位置行（最多跳 3 行）
      let from = bodyStart
      for (let k = bodyStart - 1; k >= 0 && k >= bodyStart - 3; k--) {
        const t = lines[k].trim()
        if (t === '') continue
        if (HEADER_LINE_RE.test(t) || looksLikeQuoteFragment(t)) from = k
        break
      }
      // 4) 往下找评语行（与原文之间可能隔空行）
      let to = bodyEnd
      const want = normForMatch(comment)
      for (let k = bodyEnd + 1; k < lines.length && k <= bodyEnd + 3; k++) {
        const t = norm[k]
        if (t === '') continue
        if (/^批注[:：]/.test(t)) {
          const got = normForMatch(t.replace(/^批注[:：]\s*/, ''))
          if (want === '' || got === want) to = k
        }
        break
      }
      // 5) 连同相邻空行一起删，避免留下连续空行
      const out = lines.slice(0, from).concat(lines.slice(to + 1))
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    }

    /** 按出现顺序把草稿里的 `【批注 N · …】` 重编号 1..N，指令只留在第一条 —— 纯函数 */
    function renumberAnnotationsInDraft(raw) {
      const lines = String(raw || '').split('\n')
      let n = 0
      for (let i = 0; i < lines.length; i++) {
        // 编号允许缺失（被误删成 `【批注 · 第3轮】`）：照样识别并重排，把编号补回来
        const m = /^【批注\s*(\d*)([^】]*)】$/.exec(lines[i].trim())
        if (!m) continue
        n += 1
        const rest = String(m[2] || '').replace(/（请按「Annotation[^）]*）/, '')
        let line = '【批注 ' + n + rest + '】'
        if (n === 1) line = line.replace(/】$/, '（请按「Annotation 1：」「Annotation 2：」…逐条回应）】')
        lines[i] = line
      }
      return lines.join('\n')
    }

    /** 单个批注块文本（位置行 + 原文 + 「批注：…」）—— 纯函数 */
    function renderAnnotationBlock(entry, no, opts) {
      const item = entry || {}
      // 统一走 buildQuoteHeader：聊天块是「批注 N · 第X轮 · 角色」，文档块是「批注 N · 文件 · <路径>[:L|:p]」
      let header = buildQuoteHeader(item, no)
      if (opts && opts.instruction && header !== '') {
        // 指令只贴第一条：模型按 Annotation 1..N 逐条回应，就是"从上到下"的顺序
        header = header.replace(/】$/, '（请按「Annotation 1：」「Annotation 2：」…逐条回应）】')
      }
      const comment = String(item.comment || '').trim()
      const quote = String(item.quote || '').trim()
      return header + '\n' + quote + (comment === '' ? '' : '\n\n批注：' + comment)
    }

    /** 整段批注区（重编号 1..N；首条带回复格式指令）—— 纯函数 */
    function renderAnnotationSection(list) {
      const arr = Array.isArray(list) ? list : []
      if (arr.length === 0) return ''
      return arr.map((e, i) => renderAnnotationBlock(e, i + 1, { instruction: i === 0 })).join('\n\n')
    }

    /** 从上到下排序：轮次 → 同一轮内的 DOM 顺序 → 点击时间 —— 纯函数 */
    function sortAnnotations(list, domIndexOf) {
      const arr = Array.isArray(list) ? list.slice() : []
      const indexOfKey = (key) => {
        if (typeof domIndexOf !== 'function' || !key) return -1
        const i = Number(domIndexOf(key))
        return Number.isFinite(i) && i >= 0 ? i : -1
      }
      return arr.sort((a, b) => {
        const ta = Number.isFinite(a && a.turn) ? a.turn : Number.MAX_SAFE_INTEGER
        const tb = Number.isFinite(b && b.turn) ? b.turn : Number.MAX_SAFE_INTEGER
        if (ta !== tb) return ta - tb
        const ia = indexOfKey(a && a.anchorKey)
        const ib = indexOfKey(b && b.anchorKey)
        const na = ia < 0 ? Number.MAX_SAFE_INTEGER : ia
        const nb = ib < 0 ? Number.MAX_SAFE_INTEGER : ib
        if (na !== nb) return na - nb
        return (Number(a && a.at) || 0) - (Number(b && b.at) || 0)
      })
    }

    /** 该条批注是否还在草稿里（用户手动删掉的块不再复活） */
    function draftHasAnnotation(draft, entry) {
      const quote = normForMatch(entry && entry.quote)
      if (quote === '') return false
      return normForMatch(draft).indexOf(quote) !== -1
    }

    function loadAnnotations(sessionId) {
      try {
        if (!sessionId) return []
        const raw = localStorage.getItem(ANNOT_STORE_PREFIX + sessionId)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.quote === 'string') : []
      } catch (e) { return [] }
    }
    function saveAnnotations(sessionId, list) {
      try {
        if (!sessionId) return
        const arr = (Array.isArray(list) ? list : []).slice(0, MAX_ANNOTATIONS)
        localStorage.setItem(ANNOT_STORE_PREFIX + sessionId, JSON.stringify(arr))
      } catch (e) { /* 存储不可用不影响插入 */ }
    }
    /** 当前页面里锚点的 DOM 先后序号（同一轮内选了两段的排序用） */
    function anchorDomIndex() {
      const order = new Map()
      try {
        let i = 0
        for (const el of document.querySelectorAll('[data-chat-anchor-key]')) {
          const key = el.getAttribute('data-chat-anchor-key')
          if (key && !order.has(key)) order.set(key, i)
          i += 1
        }
      } catch (e) { /* ignore */ }
      return (key) => (key && order.has(key) ? order.get(key) : -1)
    }

    // ============ 锚点持久化：刷新后 chip 仍能跳回原文 ============
    // key: dsh-quote-pro:ref:<sessionId> -> { <ref>: { anchorKey, body, label, at } }
    const STORE_PREFIX = 'dsh-quote-pro:ref:'
    function loadRefMap(sessionId) {
      try {
        const raw = localStorage.getItem(STORE_PREFIX + sessionId)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (e) { return null }
    }
    function saveRef(sessionId, ref, info) {
      try {
        const map = loadRefMap(sessionId) || {}
        map[ref] = { anchorKey: info.anchorKey || null, body: info.body || '', label: info.label || '', at: Date.now() }
        const keys = Object.keys(map)
        if (keys.length > 60) {
          keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
          for (const k of keys.slice(0, keys.length - 60)) delete map[k]
        }
        localStorage.setItem(STORE_PREFIX + sessionId, JSON.stringify(map))
      } catch (e) { /* 存储不可用不影响主流程 */ }
    }
    function hydrateRefs(sessionId) {
      const map = loadRefMap(sessionId)
      if (!map) return 0
      let n = 0
      for (const ref of Object.keys(map)) {
        if (refTargets.has(ref)) continue
        const info = map[ref] || {}
        refTargets.set(ref, { sessionId, anchorKey: info.anchorKey || null, body: info.body || '', label: info.label || '', restored: true })
        n += 1
      }
      if (n > 0) report('refs:hydrated', { sessionId: String(sessionId).slice(0, 8), count: n })
      return n
    }
    // 每次页面运行使用独立前缀，避免刷新后新 ref 与历史 ref 撞号
    const REF_RUN = Math.random().toString(36).slice(2, 6)


    // ============ chip 插入：走官方 session 事件（本版本 shell.insertReference 由它驱动） ============
    // 注意：这里必须直接对传入的 Cordis 上下文调用 .emit —— 写成 ctx.ctx 会触发
    // 「cannot get property "ctx" without inject」守卫错误（本插件未声明该 inject）。
    function emitInsertReference(emitCtx, input, before, reference) {
      if (!emitCtx || typeof emitCtx.emit !== 'function') return false
      if (!before || before.draftRev === undefined) return false
      try {
        emitCtx.emit('slash/input-insert-reference', {
          reference,
          span: { draftRev: before.draftRev, start: (before.draft || '').length, end: (before.draft || '').length },
        })
      } catch (e) {
        report('emit:throw', String((e && e.stack) || (e && e.message) || e))
        return false
      }
      const after = input.state.getSnapshot()
      return after.draftRev !== before.draftRev
    }

    // ============ 模块级状态 ============
    let rootCtx = null
    let currentSessionId = null
    let refSeq = 0
    let pipelineAvailable = null // null=未知 false=不可用 true=可用
    // 引用 source 的注册函数（懒加载 + 重试）：服务晚就绪、HMR 重载后仍能恢复 chip 插入
    let ensureQuoteSource = null
    // ref -> { sessionId, anchorKey, body, label } 用于点击 chip 跳回原文 / 悬停显示原文
    const refTargets = new Map()
    // ref -> { body, clipboardText } 提交时经 codec 序列化
    const refCodecs = new Map()
    // 输入框引用装饰的"立即执行"钩子：插入后马上贴样式，避免先露出旧样子再变（用户反馈的瞬间闪烁）
    let composerDecorateNow = null
    // 诊断用：最近一次插入引用的时刻（毫秒），用于测"装饰相对插入晚了多久"
    let lastInsertAt = 0
    // 位置行快照：normalize(原文) -> 位置行文本。用户退格把位置行吃掉时按它补回来
    //（整块取消只走右侧 ✕，位置行本身不该能被删掉）
    const headerByQuote = new Map()
    let lastGuardHintAt = 0

    // 页面内反馈 toast（点击 chip 时显示结果）
    const toastStore = {
      text: '',
      pos: null, // { left, top }
      ok: false,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(text, pos, ok) {
        this.text = text
        this.pos = pos
        this.ok = !!ok
        this.emit()
        // 统一 3s 自动消失：位置行拦截这类提示以前会一直挂在页面上（用户反馈"出现之后无法消失"）
        if (this.timer) { try { clearTimeout(this.timer) } catch (e) { /* ignore */ } }
        this.timer = setTimeout(() => { this.timer = null; this.hide() }, 3000)
      },
      hide() {
        if (this.timer) { try { clearTimeout(this.timer) } catch (e) { /* ignore */ } this.timer = null }
        if (!this.text) return
        this.text = ''
        this.pos = null
        this.emit()
      },
    }

    function useToast() {
      const [, force] = React.useState(0)
      React.useEffect(() => toastStore.subscribe(() => force((v) => v + 1)), [])
      return toastStore
    }

    // ============ 选区浮动小气泡 store ============
    const selectionStore = {
      visible: false,
      text: '',
      rect: null,
      anchorKey: null,
      filePath: null, // 文档预览选区：来源文件（绝对路径）
      line: null, // 文本类预览：选区起始行号
      page: null, // PDF/Office 预览：页码
      excel: null, // Excel 预览：{ sheet, ref, kind }（canvas 单元格没有文字，选区即定位）
      mode: 'text', // 'text' = 普通 DOM 选区；'excel' = Excel 选区（由 Excel watcher 驱动）
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.rect = info.rect
        this.anchorKey = info.anchorKey || null
        // 位置信息必须一起存：否则 stage() 读到的 turn/kind 恒为 null，引用块首行就空了
        this.turn = typeof info.turn === 'number' && Number.isFinite(info.turn) ? info.turn : null
        this.kind = info.kind || null
        // 文档来源（聊天消息选区恒为 null）
        this.filePath = typeof info.filePath === 'string' && info.filePath !== '' ? info.filePath : null
        this.line = typeof info.line === 'number' && Number.isFinite(info.line) ? info.line : null
        this.page = typeof info.page === 'number' && Number.isFinite(info.page) ? info.page : null
        this.excel = normalizeExcelMeta(info.excel)
        this.mode = info.mode === 'excel' ? 'excel' : 'text'
        this.emit()
      },
      hide() {
        if (!this.visible) return
        this.visible = false
        this.mode = 'text'
        this.excel = null
        this.emit()
      },
    }

    function useSelection() {
      const [, force] = React.useState(0)
      React.useEffect(() => selectionStore.subscribe(() => force((v) => v + 1)), [])
      return selectionStore
    }

    // ============ 悬浮批注编辑框 store（单条，锚定在对应文字附近） ============
    const editorStore = {
      item: null, // { sessionId, label, text, anchorKey }
      rect: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      open(item, rect) {
        this.item = item
        this.rect = rect
        this.emit()
      },
      close() {
        if (!this.item) return
        this.item = null
        this.rect = null
        this.emit()
      },
    }

    function useEditor() {
      const [, force] = React.useState(0)
      React.useEffect(() => editorStore.subscribe(() => force((v) => v + 1)), [])
      return editorStore
    }

    // ============ 输入框里每块引用右侧的「取消」按钮（overlay 层，不写进编辑器 DOM） ============
    // 为什么用 overlay：往 Lexical 的 contenteditable 里塞按钮会被编辑器回收，也会被当成文本删掉；
    // 这里只按行的位置画悬浮按钮，点一下按文本手术删掉"这一块"（见 removeBlockFromDraft）。
    const blockActionsStore = {
      items: [], // [{ key, quote, comment, left, top }]
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      set(items) {
        const next = Array.isArray(items) ? items : []
        const same = next.length === this.items.length && next.every((it, i) => {
          const p = this.items[i]
          return !!p && p.key === it.key && p.left === it.left && p.top === it.top && p.quote === it.quote
        })
        if (same) return
        this.items = next
        this.emit()
      },
      hide() {
        if (this.items.length === 0) return
        this.items = []
        this.emit()
      },
    }

    function useBlockActions() {
      const [, force] = React.useState(0)
      React.useEffect(() => blockActionsStore.subscribe(() => force((v) => v + 1)), [])
      return blockActionsStore
    }


    // ============ 引用悬停提示 store ============
    const tooltipStore = {
      visible: false,
      text: '',
      label: '',
      rect: null,
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        this.listeners.forEach((fn) => fn())
      },
      show(info) {
        this.visible = true
        this.text = info.text
        this.label = info.label
        this.rect = info.rect
        this.emit()
      },
      hide() {
        if (!this.visible) return
        this.visible = false
        this.emit()
      },
    }

    function useTooltip() {
      const [, force] = React.useState(0)
      React.useEffect(() => tooltipStore.subscribe(() => force((v) => v + 1)), [])
      return tooltipStore
    }

    // ============ 样式注入（静态包环境：直接操作 document） ============
    function insertStyleSheet(css) {
      const tag = document.createElement('style')
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    // ============ 文本工具 ============
    function textBlocksToText(blocks, kindField, typeValue) {
      const parts = []
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && b[kindField] === typeValue && typeof b.text === 'string' && b.text.trim() !== '') {
            parts.push(b.text.trim())
          }
        }
      }
      return parts.join('\n\n')
    }

    function clipText(text, max) {
      if (text.length <= max) return text
      return text.slice(0, max) + '\n…（已截断）'
    }

    const MAX_QUOTE = 1500
    const MAX_SELECTION = 2000

    // ============ 文档来源（第二类锚点）：侧栏预览里划词时带上文件路径 ============
    // 聊天消息的锚点是 data-chat-anchor-key（消息行），轮次/角色也来自消息行；
    // 文档预览里没有消息行，选区的"来源"只能是文件本身 —— 因此把文件路径写进引用块位置行，
    // 让模型知道原文出自哪个文件（以及文本类的行号 / PDF·Office 的页码）。
    //
    // 路径来源优先级：
    //   ① 预览头部探针（`sidebar.right.tab.document.actions` 槽的 owner prop `absolutePath`，
    //      覆盖 docx / pdf / xlsx / 图片 / md / code 全部渲染器）；
    //   ② 文本类预览根节点自带的 `data-textpreview-url`（`dsh-resource://` 地址，本地解码）。
    // 两者都拿不到时（旧版本没有该槽、侧栏被第三方接管等）path 为 null，
    // 位置行退回旧的「【批注 N】」形态 —— 不报错、不阻塞、不影响聊天批注。
    const DOC_PATH_STYLE = 'relative' // 'relative'：工作区内显示相对会话 cwd 的路径；'absolute'：一律绝对路径
    const docProbes = new Set() // { node, path }

    function fileNameOfPath(p) {
      const s = String(p || '')
      const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
      return i < 0 ? s : s.slice(i + 1)
    }

    /** dsh-resource://file/session/<sessionId>/<path> | …/absolute/<path> → 本地路径（仅解码，不保证存在） */
    function pathOfFileAddress(address) {
      try {
        const prefix = 'dsh-resource://file/'
        if (typeof address !== 'string' || address.indexOf(prefix) !== 0) return null
        const segments = address.slice(prefix.length).split('/')
        const scope = segments[0]
        const tail = scope === 'session' ? segments.slice(2) : scope === 'absolute' ? segments.slice(1) : null
        if (!tail) return null
        const path = tail.map((segment) => {
          try { return decodeURIComponent(segment) } catch (e) { return segment }
        }).join('/')
        return path === '' ? null : path
      } catch (e) { return null }
    }

    function sessionCwd(sessionId) {
      try {
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        const list = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
        const row = list && list.byId && sessionId ? list.byId[sessionId] : undefined
        return row && typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
      } catch (e) { return null }
    }

    /** 纯函数：把 target 相对 root 化（Windows 分隔符；不在 root 下则原样返回） */
    function pathRelativeTo(target, root) {
      if (!target || !root) return target
      try {
        const normalize = (s) => String(s).replace(/\//g, '\\').replace(/\\+$/, '')
        const t = normalize(target)
        const r = normalize(root)
        if (t.toLowerCase() === r.toLowerCase()) return fileNameOfPath(t)
        if (t.toLowerCase().indexOf((r + '\\').toLowerCase()) === 0) return t.slice(r.length + 1)
      } catch (e) { /* ignore */ }
      return target
    }

    /** 模型/用户看到的路径：工作区内给相对 cwd 的路径（默认），工作区外保持绝对路径 */
    function displayPathOf(path) {
      if (!path) return ''
      if (DOC_PATH_STYLE !== 'relative') return path
      try {
        const cwd = sessionCwd(currentSessionId)
        if (!cwd) return path
        return pathRelativeTo(path, cwd)
      } catch (e) { /* ignore */ }
      return path
    }

    /** 文档来源的位置行片段：相对/绝对路径 + Excel 选区 / 行号（文本类）或页码（PDF/Office） */
    function docSourceLabel(item) {
      const path = item && item.filePath
      if (!path) return ''
      let out = displayPathOf(path)
      if (item.excel && item.excel.ref) out += ':' + excelLocationOf(item.excel.sheet, item.excel.ref)
      else if (typeof item.line === 'number' && Number.isFinite(item.line) && item.line > 0) out += ':L' + item.line
      else if (typeof item.page === 'number' && Number.isFinite(item.page) && item.page > 0) out += ':p' + item.page
      return out
    }

    /**
     * 选区是否落在文档预览里；是则返回 { path, line, page }，否则 null。
     * 判定顺序：先看探针（不依赖任何 data-* 命名，`absolutePath` 命中即算预览），
     * 再退回预览容器的 DOM 标记；聊天消息选区两者都不命中，直接返回 null —— 聊天批注完全不受影响。
     */
    function docSourceOf(anchorEl) {
      if (!anchorEl || typeof anchorEl.closest !== 'function') return null
      let path = null
      try {
        // 探针节点在预览头部，选区在预览正文：向上找到同时包含两者的祖先，即同一 tab
        for (const probe of docProbes) {
          const node = probe && probe.node
          if (!node || !node.isConnected) continue
          let el = node.parentElement || node
          while (el && el !== document.body) {
            if (typeof el.contains === 'function' && el.contains(anchorEl)) { path = probe.path; break }
            el = el.parentElement
          }
          if (path) break
        }
      } catch (e) { path = null }
      let inPreview = path !== null
      if (!inPreview) {
        try {
          inPreview = !!(anchorEl.closest('[data-slot="sidebar.right.tab.document"]') ||
            anchorEl.closest('[data-textpreview-url]') ||
            anchorEl.closest('[data-pdf-preview]') ||
            anchorEl.closest('[data-pdf-page]') ||
            anchorEl.closest('[data-code-preview]') ||
            anchorEl.closest('[data-code-block-content]') ||
            anchorEl.closest('[data-excel-preview]'))
        } catch (e) { inPreview = false }
      }
      if (!inPreview) return null
      if (!path) {
        try { report('doc:path-miss', { root: !!findPreviewRoot(anchorEl) }) } catch (e) { /* ignore */ }
      }
      try {
        // 兜底 1：文本类预览的根节点自带资源地址（探针没覆盖时）
        if (!path) {
          const urlEl = anchorEl.closest('[data-textpreview-url]')
          if (urlEl) path = pathOfFileAddress(urlEl.getAttribute('data-textpreview-url'))
        }
        // 兜底 2：预览头部共用的路径标签（docx/pdf/office 都有 data-textpreview-path）
        if (!path) {
          const root = findPreviewRoot(anchorEl)
          const label = root && root.querySelector ? root.querySelector('[data-textpreview-path]') : null
          const txt = label && label.textContent ? String(label.textContent).trim() : ''
          if (txt !== '') path = txt
        }
      } catch (e) { path = null }
      let line = null
      let page = null
      try {
        const lineEl = anchorEl.closest('[data-textpreview-line]')
        if (lineEl) {
          const n = Number(lineEl.getAttribute('data-textpreview-line'))
          if (Number.isFinite(n) && n > 0) line = n
        }
        // 代码预览：DSH 用 `pre .line` 逐行渲染（没有 data-textpreview-line），按它在父节点里的序号取行号
        if (line === null) {
          const previewRootForLine = findPreviewRoot(anchorEl)
          const codeRoot = anchorEl.closest('[data-code-block-content]') || (previewRootForLine && previewRootForLine.querySelector ? previewRootForLine.querySelector('[data-code-block-content]') : null)
          if (codeRoot) {
            const codeLines = codeRoot.querySelectorAll('pre .line')
            for (let i = 0; i < codeLines.length; i++) {
              if (codeLines[i] === anchorEl || codeLines[i].contains(anchorEl)) { line = i + 1; break }
            }
          }
        }
        const pageEl = anchorEl.closest('[data-pdf-page]')
        if (pageEl) {
          const n = Number(pageEl.getAttribute('data-pdf-page'))
          if (Number.isFinite(n) && n > 0) page = n
        }
      } catch (e) { /* ignore */ }
      // 预览里但拿不到文件路径：当作普通聊天引用，别造出一条永远发不出去的文件批注
      if (!path) return null
      return { path, line, page }
    }

    // ============ Excel 预览：选区即定位 ============
    // xlsx/xls/csv/tsv 由官方 ExcelBody（Fortune-Sheet）渲染，单元格画在 <canvas> 上、没有可选文字，
    // 所以 window.getSelection() 拿不到内容，也不能像 docx/pdf 那样"读原文"。
    // 但 Excel 批注不需要原文，只需要"选区地址"：
    //   Name Box（.fortune-name-box，DOM 文本）随选区实时显示 A1 / A1:C3，
    //   行头/列头高亮的类名用来把"整行/整列"归一化成 3:5 / B:D，
    //   选区覆盖层 .luckysheet-cell-selected-focus 提供气泡定位矩形。
    // 选中 → 气泡 → 写意见 → 进「文件批注列表」→ 和 docx/pdf 一样一次性发送。
    // DSH 自己把 xls/xlsx/xlsm/xlsb/xlt/xltx/xltm/ods/ots/fods/numbers 都归为 "excel" 类预览，
    // csv/tsv 也走同一个 Fortune-Sheet 渲染器；插件若只认 xlsx，这些文件虽然能预览却批注不了。
    const EXCEL_FILE_RE = /\.(xlsx?|xlsm|xlsb|xltx?|xltm|ods|ots|fods|numbers|csv|tsv)$/i
    const EXCEL_POLL_MS = 150

    /** Name Box 文本（A1 / A1:C3）+ 行/列头选中状态 → 归一化的选区定位（纯函数） */
    function normalizeExcelSelection(rawText, flags) {
      const text = String(rawText || '').replace(/\s+/g, '').toUpperCase()
      // 整行/整列还有第二种形态：getRangetxt 在 row/column 为 null 时直接给 `3:5` / `B:D`
      // （取决于 Fortune-Sheet 内部选区结构，两种形态都真实存在，必须都能解析）
      const rowOnly = /^(\d+):(\d+)$/.exec(text)
      if (rowOnly) return { ref: rowOnly[1] + ':' + rowOnly[2], kind: 'row' }
      const colOnly = /^([A-Z]+):([A-Z]+)$/.exec(text)
      if (colOnly) return { ref: colOnly[1] + ':' + colOnly[2], kind: 'col' }
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(text)
      if (!m) return null
      const c1 = m[1]
      const r1 = Number(m[2])
      const c2 = m[3] || c1
      const r2 = m[4] !== undefined ? Number(m[4]) : r1
      if (!(r1 > 0 && r2 > 0)) return null
      const rowSelected = !!(flags && flags.rowSelected)
      const colSelected = !!(flags && flags.colSelected)
      // 整行 / 整列：Name Box 给的是整片范围（如 A1:T3），按行头/列头选中状态收成 3:3 / B:B
      if (rowSelected && !colSelected) return { ref: r1 + ':' + r2, kind: 'row' }
      if (colSelected && !rowSelected) return { ref: c1 + ':' + c2, kind: 'col' }
      if (c1 === c2 && r1 === r2) return { ref: c1 + r1, kind: 'cell' }
      return { ref: c1 + r1 + ':' + c2 + r2, kind: 'range' }
    }

    /** sheet 名需要引号时（空格 / 特殊字符 / 数字开头）按 Excel 规则加 '...'（纯函数） */
    function excelSheetLabel(name) {
      const s = String(name || '').trim()
      if (s === '') return ''
      const simple = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5]*$/.test(s)
      return simple ? s : "'" + s.replace(/'/g, "''") + "'"
    }

    /** 模型/用户看到的 Excel 定位：Sheet1!A1 / Sheet1!A1:C3 / Sheet1!3:5 / Sheet1!B:D（纯函数） */
    function excelLocationOf(sheet, ref) {
      const label = excelSheetLabel(sheet)
      const r = String(ref || '').trim()
      if (r === '') return ''
      // 读不到 sheet 名时保留 `!`：`:!A1` 仍然只表示"选区地址"，不会被当成行号/页码
      return (label === '' ? '!' : label + '!') + r
    }

    function isExcelPath(path) {
      return typeof path === 'string' && EXCEL_FILE_RE.test(path)
    }

    /** 校验并收敛批注里保存的 Excel 元数据（localStorage 读回时用） */
    function normalizeExcelMeta(raw) {
      if (!raw || typeof raw !== 'object') return null
      const sheet = typeof raw.sheet === 'string' ? raw.sheet : ''
      const ref = typeof raw.ref === 'string' ? raw.ref : ''
      if (ref === '') return null
      const kind = raw.kind === 'cell' || raw.kind === 'row' || raw.kind === 'col' ? raw.kind : 'range'
      return { sheet, ref, kind }
    }

    // ============ 文件批注列表（docx / pdf / xlsx 等"不可编辑预览"专用） ============
    // 可编辑预览（milkdown / sidebar-editor、聊天输入框）在 selectionchange 阶段就被忽略了，
    // 所以能走到这里的文档选区都来自不可编辑的官方预览。
    // 这些选区不立即写输入框，而是按「会话 + 文件绝对路径」攒在列表里：
    //   预览头部「批注 · N」按钮 → 面板（单条展开 / 删除 / 清空）→「全部发送」一次性插入输入框。
    // 数据存 localStorage，刷新/切 tab 不丢；聊天消息选区仍然走原来的"立即插入"。
    const DOC_NOTES_PREFIX = 'dsh-quote-pro:doc-notes:'
    const MAX_DOC_NOTES = 200

    function docNotesStorageKey(sessionId, path) {
      return String(sessionId || '') + '|' + String(path || '')
    }

    function loadDocNotes(key) {
      try {
        const raw = localStorage.getItem(DOC_NOTES_PREFIX + key)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const notes = []
        for (const item of parsed) {
          if (!item || typeof item.quote !== 'string' || item.quote === '') continue
          notes.push({
            id: typeof item.id === 'string' && item.id !== '' ? item.id : 'n' + Math.random().toString(36).slice(2, 10),
            quote: item.quote,
            comment: typeof item.comment === 'string' ? item.comment : '',
            line: typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : null,
            page: typeof item.page === 'number' && Number.isFinite(item.page) ? item.page : null,
            excel: normalizeExcelMeta(item.excel),
            at: typeof item.at === 'number' ? item.at : 0,
          })
        }
        return notes
      } catch (e) { return [] }
    }

    function saveDocNotes(key, notes) {
      try {
        if (!Array.isArray(notes) || notes.length === 0) localStorage.removeItem(DOC_NOTES_PREFIX + key)
        else localStorage.setItem(DOC_NOTES_PREFIX + key, JSON.stringify(notes))
      } catch (e) { /* 存储不可用不影响主流程 */ }
    }

    const docNotesStore = {
      map: new Map(), // key -> notes[]
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of this.listeners) {
          try { fn() } catch (e) { /* ignore */ }
        }
      },
      get(sessionId, path) {
        const key = docNotesStorageKey(sessionId, path)
        let notes = this.map.get(key)
        if (notes === undefined) {
          notes = loadDocNotes(key)
          this.map.set(key, notes)
        }
        return notes
      },
      snapshot(sessionId, path) {
        return this.get(sessionId, path).slice()
      },
      add(sessionId, path, note) {
        const notes = this.get(sessionId, path)
        const record = {
          id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          quote: String((note && note.quote) || ''),
          comment: String((note && note.comment) || ''),
          line: note && typeof note.line === 'number' && Number.isFinite(note.line) ? note.line : null,
          page: note && typeof note.page === 'number' && Number.isFinite(note.page) ? note.page : null,
          excel: normalizeExcelMeta(note && note.excel),
          at: Date.now(),
        }
        notes.push(record)
        if (notes.length > MAX_DOC_NOTES) notes.splice(0, notes.length - MAX_DOC_NOTES)
        saveDocNotes(docNotesStorageKey(sessionId, path), notes)
        this.emit()
        return record
      },
      remove(sessionId, path, id) {
        const notes = this.get(sessionId, path)
        const index = notes.findIndex((item) => item && item.id === id)
        if (index < 0) return false
        notes.splice(index, 1)
        saveDocNotes(docNotesStorageKey(sessionId, path), notes)
        this.emit()
        return true
      },
      /** 编辑一条批注（目前只改评语；quote 是原文快照，不允许改） */
      update(sessionId, path, id, patch) {
        const notes = this.get(sessionId, path)
        const note = notes.find((item) => item && item.id === id)
        if (!note) return false
        if (patch && typeof patch.comment === 'string') note.comment = patch.comment
        saveDocNotes(docNotesStorageKey(sessionId, path), notes)
        this.emit()
        return true
      },
      clear(sessionId, path) {
        const notes = this.get(sessionId, path)
        const count = notes.length
        if (count === 0) return 0
        notes.splice(0, notes.length)
        saveDocNotes(docNotesStorageKey(sessionId, path), notes)
        this.emit()
        return count
      },
    }

    /** 文档预览探针的挂载/卸载通知（用于底部批注条跟随当前打开的预览 tab） */
    const docPreviewStore = {
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of this.listeners) {
          try { fn() } catch (e) { /* ignore */ }
        }
      },
    }

    // 底部批注条的状态诊断（只在状态变化时上报一次，便于排"浮条没出现"）
    let lastDocBarReport = ''

    /**
     * 把一批文件批注格式化成"一次性发送"的文本（纯函数，单测覆盖）。
     * 沿用现有位置行协议：每条一个【批注 N · 文件 · <路径>[:p页|:L行]】块，
     * 第一条内嵌回复格式指令 —— 模型侧与回复侧 Annotation N 芯片都不需要改动。
     */
    function buildDocNotesBatch(notes, options) {
      const list = Array.isArray(notes) ? notes : []
      const path = options && options.path ? options.path : ''
      const startNo = options && typeof options.startNo === 'number' && Number.isFinite(options.startNo) && options.startNo > 0
        ? Math.floor(options.startNo)
        : 1
      const blocks = []
      let no = startNo - 1
      for (const note of list) {
        if (!note || typeof note.quote !== 'string' || note.quote.trim() === '') continue
        no += 1
        let header = buildQuoteHeader({ filePath: path, line: note.line, page: note.page, excel: note.excel }, no)
        if (no === 1 && header !== '') {
          header = header.replace(/】$/, '（请按「Annotation 1：」「Annotation 2：」…格式逐条回应我的批注）】')
        }
        const comment = String(note.comment || '').trim()
        const commentLine = comment === '' ? '' : '\n\n批注：' + comment
        blocks.push((header === '' ? '' : header + '\n') + note.quote.trim() + commentLine)
      }
      return blocks.join('\n\n')
    }

    /** 解析当前会话的输入框句柄（文件批注"全部发送"与普通插入共用） */
    function resolveComposerInput(sessionId) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return { error: 'conversation/sessions 服务不可用' }
        const sid = sessionId || resolveSessionId()
        if (!sid) return { error: '拿不到当前会话，请在对话区里点一下再重试' }
        const binding = sessions.binding(sid)
        if (!binding) return { error: '会话不可用' }
        return { sessionId: sid, input: conversation.input.for(binding.ctx) }
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }

    // 从 Chat 快照中提取某一轮的用户提问文本与最终 AI 回答文本。
    // 本版本（0.2.0-rc.1）的真实形状：
    //   snapshot.nodes 是 Map（不是数组）、身份字段是 anchorSeq（不是 seq）、
    //   user 文本在 node.data.content[{type:'text'}]、assistant-step 在 node.data.blocks[{kind:'text'}]。
    function extractTurnTexts(chat, turnLoc) {
      const empty = { userText: '', assistantText: '' }
      try {
        if (!chat || !turnLoc || typeof turnLoc.turn !== 'number') return empty
        const turn = turnLoc.turn
        const endSeq = turnLoc.end ? turnLoc.end.seq : Number.POSITIVE_INFINITY
        let prevEnd = 0
        if (chat.turnEnds && typeof chat.turnEnds.forEach === 'function') {
          chat.turnEnds.forEach((seq, t) => {
            if (typeof t === 'number' && typeof seq === 'number' && t < turn && seq > prevEnd) prevEnd = seq
          })
        }
        const nodes = chat.nodes
        if (!nodes) return empty
        const userParts = []
        let assistantText = ''
        let assistantSeq = -1
        const visit = (node) => {
          if (!node || typeof node.anchorSeq !== 'number') return
          if (node.anchorSeq <= prevEnd || node.anchorSeq > endSeq) return
          const data = node.data || {}
          if (node.kind === 'user' || node.kind === 'steering') {
            const text = textBlocksToText(data.content, 'type', 'text')
            if (text !== '') userParts.push(text)
          } else if (node.kind === 'assistant-step') {
            if (typeof data.turn === 'number' && data.turn !== turn) return
            if (node.anchorSeq > assistantSeq) {
              const text = textBlocksToText(data.blocks, 'kind', 'text')
              if (text !== '') {
                assistantSeq = node.anchorSeq
                assistantText = text
              }
            }
          }
        }
        const keys = chat.locations && typeof chat.locations.getTurn === 'function' ? chat.locations.getTurn(turn) : null
        if (Array.isArray(keys) && typeof nodes.get === 'function') {
          for (const key of keys) visit(nodes.get(key))
        } else if (typeof nodes.forEach === 'function') {
          nodes.forEach(visit)
        }
        return { userText: userParts.join('\n\n'), assistantText }
      } catch (e) {
        report('turnTail:extract-throw', String((e && e.message) || e))
        return empty
      }
    }

    // 解析某一轮里指定类型消息行的 DOM 锚点 key（= ChatNode.key，即 data-chat-anchor-key）
    function anchorKeyFor(chat, turn, kind, closingSeq) {
      try {
        if (!chat || !chat.locations || !chat.nodes) return null
        const keys = chat.locations.getTurn(turn) || []
        let fallback = null
        let prefer = null
        for (const key of keys) {
          const node = chat.nodes.get(key)
          if (!node || node.kind !== kind) continue
          fallback = key
          if (kind === 'user') return key
          if (kind === 'assistant-step') {
            const finalSeq = node.data && node.data.finalNode ? node.data.finalNode.seq : undefined
            if (typeof closingSeq === 'number' && finalSeq === closingSeq) prefer = key
          }
        }
        return prefer || fallback
      } catch (e) {
        return null
      }
    }

    // ============ 跳转与提示（模块级：dock 导航条与旧 chip 处理共用） ============
    let notifyTimer = null
    function notify(text, pos, ok) {
      try {
        report('toast', (ok ? 'ok | ' : 'err | ') + text)
        toastStore.show(text, pos, ok)
        if (notifyTimer) clearTimeout(notifyTimer)
        notifyTimer = setTimeout(() => toastStore.hide(), 2600)
      } catch (e) { /* ignore */ }
    }
    /** 跳到某个锚点行并高亮它。opts.silent=true 时不弹成功提示（高亮本身就是反馈）。 */
    function jumpToAnchorKey(anchorKey, pos, opts) {
      if (!anchorKey) return false
      let row = null
      for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
        if (r.getAttribute('data-chat-anchor-key') === anchorKey) { row = r; break }
      }
      if (!row) {
        notify('跳转失败：原文不在当前页面（可能切了会话或还没加载）', pos, false)
        report('jump:miss', { anchorKey })
        return false
      }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.classList.add('dshq-flash')
      setTimeout(() => row.classList.remove('dshq-flash'), 1600)
      if (!(opts && opts.silent)) notify('已跳转到原文 ✓', pos, true)
      report('jump:ok', { anchorKey })
      return true
    }
    /** 按 ref 跳回原文：优先用锚点键，退化到按引用正文反查。 */
    function jumpToRef(ref, pos, opts) {
      const info = refTargets.get(ref)
      if (!info) {
        notify('跳转失败：找不到该引用（可能已发送或已删除）', pos, false)
        return false
      }
      let anchorKey = info.anchorKey || null
      if (!anchorKey && info.body) {
        const probe = String(info.body)
          .split('\n')
          .map((line) => line.replace(/^【(?:引用|批注)[^\n]*】\s*/, '').replace(/^> ?/, ''))
          .join('\n')
          .trim()
          .slice(0, 24)
        for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
          if (probe && r.textContent && r.textContent.indexOf(probe) !== -1) {
            anchorKey = r.getAttribute('data-chat-anchor-key')
            break
          }
        }
      }
      if (!anchorKey) {
        notify('跳转失败：没有定位键（选中时未识别到消息行）', pos, false)
        return false
      }
      return jumpToAnchorKey(anchorKey, pos, opts)
    }
    /**
     * 按引用正文片段跳回原文（输入框里紧凑引用块点击时用）：
     * 输入框里的引用是纯文本，没有 ref/anchorKey，因此用正文片段在消息行里反查。
     */
    function jumpByQuoteText(text, pos) {
      const probe = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24)
      if (probe === '') return false
      for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
        const t = String(r.textContent || '').replace(/\s+/g, ' ')
        if (t.indexOf(probe) !== -1) {
          r.scrollIntoView({ block: 'center', behavior: 'smooth' })
          r.classList.add('dshq-flash')
          setTimeout(() => r.classList.remove('dshq-flash'), 1600)
          report('cmp:jump', { anchorKey: r.getAttribute('data-chat-anchor-key') })
          return true
        }
      }
      notify('跳转失败：原文不在当前页面（可能切了会话或还没加载）', pos, false)
      return false
    }

    /**
     * 文档预览批注的「跳回来源」：用官方 sidebarRight.openResource 打开该文件；
     * 文本/代码预览通过 navigation param `line` 让官方自动滚到行并高亮，
     * PDF/Office 没有页参数，则打开后等页面渲染出来再按 [data-pdf-page] 滚过去。
     */
    function jumpToDocSource(src, pos) {
      try {
        const source = src || {}
        const path = String(source.path || '').trim()
        if (path === '') return false
        const sidebar = rootCtx ? rootCtx.get('sidebarRight') : undefined
        if (!sidebar || typeof sidebar.openResource !== 'function') {
          notify('跳转失败：当前 DSH 版本没有 sidebarRight 服务', pos, false)
          return false
        }
        const sessionId = resolveSessionId()
        const address = fileResourceAddress(sessionId, path)
        if (address === '') {
          notify('跳转失败：路径不可用', pos, false)
          return false
        }
        const line = typeof source.line === 'number' && source.line > 0 ? source.line : null
        const page = typeof source.page === 'number' && source.page > 0 ? source.page : null
        if (line !== null) sidebar.openResource(address, { params: { line } })
        else sidebar.openResource(address)
        if (page !== null) scrollToDocPage(page, pos)
        const where = line !== null ? '第 ' + line + ' 行' : page !== null ? '第 ' + page + ' 页' : ''
        notify('已打开来源文件' + (where ? '（' + where + '）' : ''), pos, true)
        report('doc:jump', { file: fileNameOfPath(path), line, page })
        return true
      } catch (e) {
        report('doc:jump-throw', String((e && e.message) || e))
        return false
      }
    }

    /** PDF/Office 预览：等目标页渲染出来后滚过去（页面渲染是异步的，最多重试 ~3s） */
    function scrollToDocPage(page, pos) {
      let tries = 0
      const tick = () => {
        tries += 1
        try {
          const el = document.querySelector('[data-pdf-page="' + page + '"]')
          if (el) {
            el.scrollIntoView({ block: 'start', behavior: 'smooth' })
            el.classList.add('dshq-flash')
            setTimeout(() => { try { el.classList.remove('dshq-flash') } catch (e) { /* ignore */ } }, 1600)
            return
          }
        } catch (e) { /* ignore */ }
        if (tries < 25) setTimeout(tick, 120)
        else notify('已打开文件，但没自动滚到第 ' + page + ' 页，请手动滚动一下', pos, false)
      }
      setTimeout(tick, 150)
    }

    /** 按 chip 的 title（= 我们插入时写入的 label）反查 ref。
     * 本版本 chip 没有 data-* 属性，但 ReferenceChip 会把 label 渲染成 title，
     * 因此 title 是最可靠的 DOM 侧标识，不必按 CSS 类猜顺序。
     */
    function refByLabel(label) {
      if (typeof label !== 'string' || label === '') return null
      const wanted = label.trim()
      // 同名的 chip label 可能出现多次（每条消息的编号都从 1 开始）——
      // refTargets 按插入顺序排列，取最后一个命中项（最近插入的那条）
      let found = null
      for (const [ref, info] of refTargets) {
        if (info && typeof info.label === 'string' && info.label.trim() === wanted) found = ref
      }
      if (found !== null) return found
      // 退化：只按 `引用#N` 前缀匹配（label 可能被截断显示）
      const short = wanted.split('·')[0].trim()
      if (short.startsWith('引用#')) {
        for (const [ref, info] of refTargets) {
          if (info && typeof info.label === 'string' && info.label.trim().startsWith(short)) return ref
        }
      }
      return null
    }

    // 按 occurrenceId 解析引用（chip 点击跳转 / 悬停提示共用）
    function resolveOccurrence(occId) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return null
        const trySession = (sessionId) => {
          if (!sessionId) return null
          const binding = sessions.binding(sessionId)
          if (!binding) return null
          const input = conversation.input.for(binding.ctx)
          const occurrences = input.state.getSnapshot().occurrences || []
          const found = occurrences.find((o) => o.occurrenceId === occId) || null
          // 刷新后 ref → 锚点映射从 localStorage 复原（上游此映射仅存内存，刷新即失效）
          if (found && found.source === 'quote-ref' && !refTargets.has(found.ref)) hydrateRefs(sessionId)
          return found
        }
        let occ = trySession(currentSessionId)
        if (!occ) {
          for (const refKey of refTargets.keys()) {
            const info = refTargets.get(refKey)
            if (!info || !info.sessionId) continue
            occ = trySession(info.sessionId)
            if (occ) break
          }
        }
        if (!occ || occ.source !== 'quote-ref') return null
        return { occ, info: refTargets.get(occ.ref) }
      } catch (e) {
        return null
      }
    }

    // ============ 链条目选择器：仅在已结束且无交付文件的回合挂载 ============
    function selectTurnQuote(owner) {
      if (!owner || !owner.turn || !owner.turn.end) return null
      const delivered = owner.turn.data ? owner.turn.data.get('deliverables') : undefined
      if (delivered && Array.isArray(delivered.produced) && delivered.produced.length > 0) return null
      return { turn: owner.turn.turn }
    }

    function rectOf(e) {
      try {
        const r = e.currentTarget.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      } catch (err) {
        return null
      }
    }

    // ============ 组件一：回合尾部的引用按钮（点击直接打开悬浮编辑框） ============
    const TurnQuoteActions = (props) => {
      // 本版本该轮文本在 Chat 快照里（useChat），不在 session 快照里；
      // 且 nodes 是 Map、身份字段是 anchorSeq —— 上游按数组 + seq 读，永远取空，所以按钮不出现。
      const chat = typeof props.useChat === 'function' ? props.useChat((s) => s) : undefined
      const texts = React.useMemo(() => extractTurnTexts(chat, props.turn), [chat, props.turn])
      if (props.turn && !turnTailReported.has(props.turn.turn)) {
        turnTailReported.add(props.turn.turn)
        try {
          report('turnTail:render', {
            turn: props.turn.turn,
            hasChat: !!chat,
            nodeCount: chat && chat.nodes && typeof chat.nodes.size === 'number' ? chat.nodes.size : null,
            userChars: texts.userText.length,
            assistantChars: texts.assistantText.length,
            userAnchor: anchorKeyFor(chat, props.turn.turn, 'user', props.seq) || null,
            assistantAnchor: anchorKeyFor(chat, props.turn.turn, 'assistant-step', props.seq) || null,
          })
        } catch (e) { /* ignore */ }
      }
      const open = (e, role, label, text) => {
        noteSession(props.sessionId, 'turnTail')
        const anchorKey = anchorKeyFor(chat, props.turn.turn, role, props.seq)
        editorStore.open({ sessionId: props.sessionId, label, text, anchorKey, turn: props.turn.turn, kind: role === 'user' ? 'user' : 'assistant-step' }, rectOf(e))
      }
      const buttons = []
      if (texts.userText) {
        buttons.push(React.createElement('button', {
          key: 'user',
          type: 'button',
          className: 'dshq-btn',
          onClick: (e) => open(e, 'user', '引用提问 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.userText, MAX_QUOTE)),
        }, '引用提问'))
      }
      if (texts.assistantText) {
        buttons.push(React.createElement('button', {
          key: 'assistant',
          type: 'button',
          className: 'dshq-btn',
          onClick: (e) => open(e, 'assistant', '引用回答 · 第 ' + (props.turn.turn + 1) + ' 轮', clipText(texts.assistantText, MAX_QUOTE)),
        }, '引用回答'))
      }
      if (buttons.length === 0) return null
      return React.createElement('div', { className: 'dshq-tail' }, buttons)
    }

    // ============ 当前会话解析 ============
    // 重要：本版本（0.1.6+）的会话列表快照没有 current 字段，读 s.current 恒为 undefined。
    // 可靠来源是「会话作用域槽位」回填的 sessionId（root 作用域的 shell.overlay 拿不到它），
    // 其次才是右侧栏 mounted 席位。
    let toolbarPropsReported = false
    let cancelSelectionHide = null // 全局监听 effect 内赋值：让 Excel watcher 能取消"选区消失"的延迟隐藏
    let insertProbeDone = false
    const turnTailReported = new Set()
    /**
     * 零副作用插入探针：用过期 draftRev 发一次 insert-reference 事件。
     * shell.insertReference 会先做 CAS（span.draftRev !== rev → return false），
     * 因此不会改动草稿，但能验证"上下文可用 + 监听器会被派发"这条通路。
     */
    function probeInsertPath(sessionId) {
      if (insertProbeDone) return
      insertProbeDone = true
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        const binding = sessions ? sessions.binding(sessionId) : undefined
        if (!conversation || !conversation.input || !binding) {
          report('probe:emit-skip', 'no conversation/binding')
          return
        }
        const input = conversation.input.for(binding.ctx)
        let emitCtx = binding.ctx
        let isScope = false
        try {
          if (typeof sessions.scope === 'function') {
            const scoped = sessions.scope(sessionId)
            if (scoped) { emitCtx = scoped; isScope = true }
          }
        } catch (e) { report('probe:scope-throw', String((e && e.message) || e)) }
        emitCtx.emit('slash/input-insert-reference', {
          reference: { source: 'quote-ref', ref: 'probe-noop', label: 'probe', clipboardText: 'probe' },
          span: { draftRev: -1, start: 0, end: 0 },
        })
        report('probe:emit-ok', { viaScope: isScope, draftRev: input.state.getSnapshot().draftRev })
      } catch (e) {
        report('probe:emit-throw', String((e && e.message) || e))
      }
    }
    function noteSession(id, via) {
      if (typeof id !== 'string' || id === '') return null
      if (currentSessionId !== id) {
        currentSessionId = id
        report('session:resolved', { id: id.slice(0, 8), via })
        setTimeout(() => { try { probeInsertPath(id) } catch (e) { /* ignore */ } }, 0)
      }
      return id
    }
    function resolveSessionId() {
      if (typeof currentSessionId === 'string' && currentSessionId !== '') return currentSessionId
      try {
        const sr = rootCtx ? rootCtx.get('sidebarRight') : undefined
        const snap = sr && sr.mounted && typeof sr.mounted.getSnapshot === 'function' ? sr.mounted.getSnapshot() : undefined
        if (noteSession(snap, 'sidebarRight.mounted')) return currentSessionId
      } catch (e) {
        report('session:sidebarRight-throw', String((e && e.message) || e))
      }
      return currentSessionId || null
    }

    // 会话作用域探针：注册进 conversation.input.dock —— 它在屏即代表该会话正在被查看
    const SessionProbe = (props) => {
      try { noteSession(props && props.sessionId, 'dock-probe') } catch (e) { /* ignore */ }
      return null
    }

    // ============ 组件二：鼠标选区浮动小气泡（点击「批注」打开悬浮编辑框） ============
    const SelectionToolbar = (props) => {
      const sel = useSelection()
      // 本版本会话列表快照没有 current 字段（读取恒为 undefined），
      // 所以这里只把 props 里可能存在的 sessionId 当线索，真正的来源是会话作用域探针。
      if (!toolbarPropsReported) {
        toolbarPropsReported = true
        try {
          report('env:overlay-props', {
            keys: Object.keys(props || {}),
            hasSessionId: typeof (props && props.sessionId) === 'string',
            hasUseSession: typeof (props && props.useSession) === 'function',
            hasUseSessions: typeof (props && props.useSessions) === 'function',
          })
        } catch (e) { /* ignore */ }
      }
      if (typeof props.sessionId === 'string' && props.sessionId !== '') currentSessionId = props.sessionId
      if (!sel.visible || !sel.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      // 气泡宽度随文字增长：估算 = 每字约13px + 按钮与留白约76px，封顶384px
      const est = Math.min(384, Math.max(120, sel.text.length * 13 + 76))
      const center = sel.rect.left + (sel.rect.right - sel.rect.left) / 2
      const left = Math.max(12, Math.min(center - est / 2, vw - est - 12))
      const top = sel.rect.top - 42 >= 8 ? sel.rect.top - 42 : sel.rect.bottom + 8
      const finish = () => {
        try {
          const s = window.getSelection()
          if (s && s.removeAllRanges) s.removeAllRanges()
        } catch (e) { /* ignore */ }
        selectionStore.hide()
      }
      const stage = () => {
        // 关键修复：不再要求"已解析到会话"才打开编辑框；解析不到也照常进入编辑，
        // 真正的会话在插入时再解析，避免整条链路因为拿不到 sessionId 而静默失效。
        const sid = resolveSessionId()
        const anchorLabel = anchorLabelOf({ turn: sel.turn, kind: sel.kind })
        const filePath = sel.filePath || null
        const line = typeof sel.line === 'number' ? sel.line : null
        const page = typeof sel.page === 'number' ? sel.page : null
        const excel = sel.excel || null
        // 文档来源：编辑框标题显示「文件批注 · 文件名 · 页码/行号/Excel 选区」；聊天来源保持「第N轮 · 角色」
        const docLabel = filePath ? docSourceLabel({ filePath, line, page, excel }) : ''
        let openLabel = anchorLabel
        if (docLabel !== '') {
          let where = ''
          if (excel && excel.ref) where = ' · ' + excelLocationOf(excel.sheet, excel.ref)
          else if (typeof page === 'number' && page > 0) where = ' · 第' + page + '页'
          else if (typeof line === 'number' && line > 0) where = ' · 第' + line + '行'
          openLabel = '文件批注 · ' + fileNameOfPath(filePath) + where
        }
        report('selection:stage', {
          anchorKey: sel.anchorKey || null,
          turn: typeof sel.turn === 'number' ? sel.turn : null,
          kind: sel.kind || null,
          sessionId: sid ? String(sid).slice(0, 8) : null,
          file: filePath ? fileNameOfPath(filePath) : null,
          excel: excel ? excelLocationOf(excel.sheet, excel.ref) : null,
        })
        editorStore.open({
          sessionId: sid || null,
          label: openLabel === '' ? '选中文字' : '选中 · ' + openLabel,
          text: clipText(sel.text, MAX_SELECTION),
          anchorKey: sel.anchorKey,
          turn: sel.turn,
          kind: sel.kind,
          filePath,
          line,
          page,
          excel,
        }, anchorRect(sel.rect))
        try {
          const r = anchorRect(sel.rect)
          report('editor:anchor', { src: r.__dshq === 'fallback' ? 'fallback' : (liveSelectionRect() ? 'live' : 'stored'), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right - r.left), Math.round(r.bottom - r.top)] })
        } catch (e) { /* ignore */ }
        finish()
      }
      return React.createElement('div', { className: 'dshq-toolbar', style: { left, top } },
        React.createElement('span', { className: 'dshq-toolbar-preview' }, sel.text),
        React.createElement('button', {
          type: 'button',
          className: 'dshq-btn dshq-primary dshq-bubble-cta',
          onMouseDown: (e) => e.preventDefault(),
          onClick: stage,
        }, '批注'),
        React.createElement('button', {
          type: 'button',
          className: 'dshq-btn dshq-close',
          onMouseDown: (e) => e.preventDefault(),
          onClick: finish,
        }, '✕'),
      )
    }

    // ============ 组件三：悬浮批注编辑框（评论输入框元素永久驻留，复用时输入法上下文不重建） ============
    /**
     * 选区矩形兜底。矩形失效（节点被装饰/重渲染替换后 getBoundingClientRect 会返回"文档原点附近"的退化矩形）
     * 时，直接用它会算出 left≈12 / top≈8 —— 编辑框就跑到窗口左上角（用户反馈的现象）。
     * 取值优先级：**当前还活着的选区** → 存下来的矩形（且看着正常）→ 视口底部居中。
     */
    function liveSelectionRect() {
      try {
        const s = typeof window !== 'undefined' ? window.getSelection() : null
        if (!s || s.rangeCount === 0 || s.isCollapsed) return null
        const r = s.getRangeAt(0).getBoundingClientRect()
        return plausibleRect(r) ? r : null
      } catch (e) { return null }
    }
    /** 排除"贴文档原点"的退化矩形：那是选区失效后的典型产物 */
    function plausibleRect(r) {
      if (!r) return false
      if (!(Number.isFinite(r.left) && Number.isFinite(r.top) && Number.isFinite(r.right) && Number.isFinite(r.bottom))) return false
      const w = r.right - r.left
      const h = r.bottom - r.top
      if (!(w > 0 || h > 0)) return false
      if (r.left < 24 && r.top < 24) return false           // 原点附近 → 视为失效
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      if (r.left > vw || r.top > vh) return false
      return true
    }
    function bottomCenterRect() {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const left = Math.max(12, Math.round(vw / 2 - 140))
      const top = Math.max(12, Math.round(vh - 200))
      return { left, right: left + 280, top, bottom: top + 24, width: 280, height: 24, __dshq: 'fallback' }
    }
    function anchorRect(stored) {
      const live = liveSelectionRect()
      if (live) return live
      if (plausibleRect(stored)) return stored
      return bottomCenterRect()
    }
    function safeRect(rect) {
      return anchorRect(rect)
    }

    // ============ 语音输入：批注框右侧的麦克风 ============
    // 录音全在浏览器里做：MediaRecorder 采流 → Web Audio 重采样成 16kHz 单声道 PCM16 WAV →
    // 交给宿主「语音输入」插件挂出来的 speech Remote（experimental-api-speech-to-text）识别，拿回文本。
    // 语音插件没开、或宿主没挂 speech Remote 时按钮不出现（不做"点了没反应"的半残 UI）。
    const VOICE_LIMITS = { maxDurationSeconds: 120, maxAudioBytes: 4 * 1024 * 1024 }
    let voiceProbeLogged = false
    function speechRemote() {
      try {
        if (!rootCtx) return null
        const direct = rootCtx.get('remote.speech')
        if (direct && typeof direct.transcribe === 'function') return direct
      } catch (e) { /* 服务没挂载时 ctx.get 会抛 */ }
      try {
        const remote = rootCtx ? rootCtx.get('remote') : null
        const inner = remote && remote.speech
        if (inner && typeof inner.transcribe === 'function') return inner
      } catch (e) { /* ignore */ }
      return null
    }
    function voiceAvailable() {
      const speech = speechRemote()
      const ok = !!speech && typeof MediaRecorder !== 'undefined' && typeof AudioContext !== 'undefined'
      if (!voiceProbeLogged) {
        voiceProbeLogged = true
        try {
          report('voice:probe', {
            speech: !!speech,
            recorder: typeof MediaRecorder !== 'undefined',
            audio: typeof AudioContext !== 'undefined',
            ok,
          })
        } catch (e) { /* ignore */ }
      }
      return ok
    }
    class VoiceRecordingError extends Error {
      constructor(kind) {
        super(kind)
        this.kind = kind
        this.name = 'VoiceRecordingError'
      }
    }
    function voiceFailureText(err) {
      const kind = err && err.kind
      if (kind === 'permission') return '没有麦克风权限（在浏览器地址栏允许麦克风后重试）'
      if (kind === 'deviceMissing') return '没找到可用的麦克风设备'
      if (kind === 'unavailable') return '当前环境不支持录音'
      if (kind === 'empty') return '没录到声音'
      if (kind === 'cancelled') return '已取消'
      if (kind === 'interrupted') return '麦克风被中断了'
      const msg = err && err.message ? err.message : String(err)
      return '语音识别失败：' + msg
    }
    /** 单声道浮点采样 → 宿主认可的规范 PCM16 WAV（16kHz 单声道） */
    function encodeVoiceWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => {
        for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
      }
      text(0, 'RIFF')
      view.setUint32(4, bytes.length - 8, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }
    function voiceBase64(bytes) {
      let text = ''
      for (let i = 0; i < bytes.length; i += 8192) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      }
      return btoa(text)
    }
    /** 一次麦克风采集：拿到权限 → 录音 → 重采样成 WAV；dispose 负责把轨道和 AudioContext 都关掉 */
    class VoiceRecorder {
      constructor() {
        this.stream = null
        this.recorder = null
        this.context = null
        this.chunks = []
        this.disposed = false
        this.onInterrupt = null
      }
      async start(onInterrupt) {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices) throw new VoiceRecordingError('unavailable')
        if (typeof MediaRecorder === 'undefined') throw new VoiceRecordingError('unavailable')
        this.onInterrupt = onInterrupt || null
        let stream
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          })
        } catch (error) {
          if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) throw new VoiceRecordingError('permission')
          if (error && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')) throw new VoiceRecordingError('deviceMissing')
          throw new VoiceRecordingError('unavailable')
        }
        if (this.disposed) {
          try { stream.getTracks().forEach((track) => track.stop()) } catch (e) { /* ignore */ }
          throw new VoiceRecordingError('cancelled')
        }
        this.stream = stream
        try {
          this.context = new AudioContext()
        } catch (e) { /* 只为重采样，建不出来也不影响 MediaRecorder */ }
        try {
          this.recorder = new MediaRecorder(stream)
        } catch (e) {
          await this.dispose()
          throw new VoiceRecordingError('unavailable')
        }
        this.recorder.ondataavailable = (event) => {
          if (!this.disposed && event.data && event.data.size > 0) this.chunks.push(event.data)
        }
        this.recorder.onerror = () => {
          if (this.disposed) return
          const cb = this.onInterrupt
          this.dispose().catch(() => undefined)
          try { if (cb) cb(new VoiceRecordingError('interrupted')) } catch (e) { /* ignore */ }
        }
        try {
          this.recorder.start()
        } catch (e) {
          await this.dispose()
          throw new VoiceRecordingError('unavailable')
        }
      }
      /** 结束采集并返回完整 WAV 字节 */
      async stop(maxDurationSeconds) {
        const recorder = this.recorder
        const context = this.context
        const maxSeconds = Number.isFinite(maxDurationSeconds) && maxDurationSeconds > 0 ? maxDurationSeconds : VOICE_LIMITS.maxDurationSeconds
        if (!recorder || recorder.state !== 'recording') {
          await this.dispose()
          throw new VoiceRecordingError('empty')
        }
        try {
          await new Promise((resolve, reject) => {
            recorder.onstop = () => resolve()
            recorder.onerror = () => reject(new VoiceRecordingError('empty'))
            try { recorder.stop() } catch (e) { reject(new VoiceRecordingError('empty')) }
          })
          try { this.stream && this.stream.getTracks().forEach((track) => track.stop()) } catch (e) { /* ignore */ }
          const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' })
          if (!blob.size) throw new VoiceRecordingError('empty')
          let decoded = null
          if (context && typeof context.decodeAudioData === 'function') {
            try { decoded = await context.decodeAudioData(await blob.arrayBuffer()) } catch (e) { decoded = null }
          }
          if (!decoded) throw new VoiceRecordingError('unavailable')
          const frames = Math.max(1, Math.floor(Math.min(decoded.duration, maxSeconds) * 16000))
          const Offline = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : (typeof webkitOfflineAudioContext !== 'undefined' ? webkitOfflineAudioContext : null)
          if (!Offline) throw new VoiceRecordingError('unavailable')
          const offline = new Offline(1, frames, 16000)
          const source = offline.createBufferSource()
          source.buffer = decoded
          source.connect(offline.destination)
          source.start()
          const resampled = await offline.startRendering()
          return encodeVoiceWave(resampled.getChannelData(0))
        } finally {
          await this.dispose()
        }
      }
      async dispose() {
        if (this.disposed) return
        this.disposed = true
        try { if (this.recorder && this.recorder.state === 'recording') this.recorder.stop() } catch (e) { /* ignore */ }
        try { if (this.stream) this.stream.getTracks().forEach((track) => track.stop()) } catch (e) { /* ignore */ }
        this.stream = null
        this.recorder = null
        this.chunks = []
        const context = this.context
        this.context = null
        try { if (context && context.state !== 'closed') await context.close() } catch (e) { /* ignore */ }
      }
    }
    function voiceMicIcon(size) {
      return React.createElement('svg', {
        width: size || 15, height: size || 15, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      },
        React.createElement('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
        React.createElement('path', { d: 'M5.5 10.5a6.5 6.5 0 0 0 13 0' }),
        React.createElement('path', { d: 'M12 17v4' }),
        React.createElement('path', { d: 'M9 21h6' }),
      )
    }
    function voiceClock(totalSeconds) {
      const s = Math.max(0, Math.floor(totalSeconds))
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
    }
    /**
     * 批注框右侧的麦克风：点一下开始录，再点一下结束并识别，识别结果插到光标处。
     * inputRef 用来取光标位置；getValue/setValue 走父组件的受控 state；
     * onNotice(ok, text) 用来把"正在录音/识别中/失败"写到父组件的提示行。
     */
    const VoiceMicButton = ({ inputRef, getValue, setValue, onNotice }) => {
      // 语音插件的 Remote 可能比本插件晚挂载：先当不可用，短时间内轮询几次再定
      const [available, setAvailable] = React.useState(() => voiceAvailable())
      const [phase, setPhase] = React.useState('idle')
      const [seconds, setSeconds] = React.useState(0)
      const recorderRef = React.useRef(null)
      const abortRef = React.useRef(null)
      const timerRef = React.useRef(null)
      const limitsRef = React.useRef({ maxDurationSeconds: VOICE_LIMITS.maxDurationSeconds, selection: null })
      // 录音计时、识别都是异步的：回调里可能闭包住旧的 props，
      // 统一从 ref 读最新的取值器/写入器，避免"录着音又手动打了几个字"时被旧值覆盖。
      const liveRef = React.useRef({ inputRef, getValue, setValue, onNotice })
      liveRef.current.inputRef = inputRef
      liveRef.current.getValue = getValue
      liveRef.current.setValue = setValue
      liveRef.current.onNotice = onNotice
      React.useEffect(() => {
        if (available) return undefined
        let tries = 0
        const timer = setInterval(() => {
          tries += 1
          let ok = false
          try { ok = voiceAvailable() } catch (e) { ok = false }
          if (ok) { setAvailable(true); clearInterval(timer); return }
          if (tries >= 15) clearInterval(timer)
        }, 200)
        return () => clearInterval(timer)
      }, [available])
      React.useEffect(() => () => {
        try { if (timerRef.current) clearInterval(timerRef.current) } catch (e) { /* ignore */ }
        timerRef.current = null
        try { if (abortRef.current) abortRef.current.abort() } catch (e) { /* ignore */ }
        abortRef.current = null
        const recorder = recorderRef.current
        recorderRef.current = null
        try { if (recorder) recorder.dispose().catch(() => undefined) } catch (e) { /* ignore */ }
      }, [])
      if (!available) return null
      const notice = (ok, text) => { try { const fn = liveRef.current.onNotice; if (fn) fn(ok, text) } catch (e) { /* ignore */ } }
      const insertText = (text) => {
        if (!text) return
        const live = liveRef.current
        const el = live.inputRef && live.inputRef.current
        const value = String(live.getValue ? live.getValue() : '')
        let start = value.length
        let end = value.length
        if (el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
          start = Math.max(0, Math.min(value.length, el.selectionStart))
          end = Math.max(start, Math.min(value.length, el.selectionEnd))
        }
        const next = value.slice(0, start) + text + value.slice(end)
        if (live.setValue) live.setValue(next)
        const caret = start + text.length
        setTimeout(() => {
          try {
            if (el && el.isConnected) { el.focus(); el.setSelectionRange(caret, caret) }
          } catch (e) { /* ignore */ }
        }, 0)
      }
      const loadLimits = async (speech) => {
        try {
          const result = await speech.catalog()
          const catalog = result && result.ok === true ? result.value : result
          if (!catalog || typeof catalog !== 'object') return
          const maxSeconds = Number(catalog.maxDurationSeconds)
          if (Number.isFinite(maxSeconds) && maxSeconds > 0) limitsRef.current.maxDurationSeconds = maxSeconds
          const selection = catalog.selection && typeof catalog.selection === 'object' ? catalog.selection : null
          limitsRef.current.selection = selection && typeof selection.providerId === 'string' ? selection : null
          report('voice:catalog', {
            seconds: limitsRef.current.maxDurationSeconds,
            provider: limitsRef.current.selection ? limitsRef.current.selection.providerId : null,
          })
        } catch (e) {
          report('voice:catalog-throw', String((e && e.message) || e))
        }
      }
      const start = async () => {
        const speech = speechRemote()
        if (!speech) { notice(false, '语音输入不可用：宿主没有挂载语音识别服务（在设置里开启语音输入插件）'); return }
        setPhase('requesting')
        notice(true, '正在打开麦克风…')
        const recorder = new VoiceRecorder()
        recorderRef.current = recorder
        let abort = null
        try {
          abort = new AbortController()
          abortRef.current = abort
        } catch (e) {
          abortRef.current = null
        }
        try {
          await recorder.start((failure) => {
            setPhase('idle')
            if (timerRef.current) clearInterval(timerRef.current)
            timerRef.current = null
            notice(false, voiceFailureText(failure))
          })
          setPhase('recording')
          setSeconds(0)
          notice(true, '正在录音 0:00 · 点击麦克风结束')
          const startedAt = Date.now()
          timerRef.current = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startedAt) / 1000)
            setSeconds(elapsed)
            notice(true, '正在录音 ' + voiceClock(elapsed) + ' · 点击麦克风结束')
            if (elapsed >= limitsRef.current.maxDurationSeconds) {
              try { finish() } catch (e) { /* ignore */ }
            }
          }, 250)
          loadLimits(speech)
        } catch (failure) {
          setPhase('idle')
          try { await recorder.dispose() } catch (e) { /* ignore */ }
          recorderRef.current = null
          notice(false, voiceFailureText(failure))
        }
      }
      const finish = async () => {
        const recorder = recorderRef.current
        if (!recorder) { setPhase('idle'); return }
        if (timerRef.current) clearInterval(timerRef.current)
        timerRef.current = null
        setPhase('transcribing')
        notice(true, '正在识别…')
        try {
          const bytes = await recorder.stop(limitsRef.current.maxDurationSeconds)
          recorderRef.current = null
          if (bytes.length > VOICE_LIMITS.maxAudioBytes) throw new Error('录音太长（超过 ' + Math.round(VOICE_LIMITS.maxAudioBytes / 1024) + 'KB 上限）')
          const speech = speechRemote()
          if (!speech) throw new Error('语音识别服务已不可用')
          const selection = limitsRef.current.selection || {}
          const request = Object.assign({ audioBase64: voiceBase64(bytes) }, selection)
          report('voice:transcribe', { seconds: Math.max(1, Math.round((bytes.length - 44) / 32000)) })
          const result = await speech.transcribe(request, abortRef.current ? abortRef.current.signal : undefined)
          const value = result && result.ok === true ? result.value : null
          if (!value) {
            const message = result && result.error && result.error.message ? result.error.message : '识别失败'
            throw new Error(message)
          }
          const text = String(value.text || '').trim()
          if (text === '') {
            setPhase('idle')
            notice(false, '没有识别到内容，再点麦克风重试')
            return
          }
          insertText(text)
          setPhase('idle')
          notice(true, '已识别并插入 ' + text.length + ' 字')
          report('voice:ok', { chars: text.length })
        } catch (failure) {
          setPhase('idle')
          const recorderAfter = recorderRef.current
          recorderRef.current = null
          try { if (recorderAfter) await recorderAfter.dispose() } catch (e) { /* ignore */ }
          notice(false, voiceFailureText(failure))
          report('voice:fail', String((failure && failure.message) || failure))
        }
      }
      const onClick = (e) => {
        try { e.preventDefault(); e.stopPropagation() } catch (err) { /* ignore */ }
        if (phase === 'idle') start()
        else if (phase === 'recording') finish()
        else notice(true, phase === 'transcribing' ? '正在识别，稍等…' : '正在打开麦克风…')
      }
      const recording = phase === 'recording'
      return React.createElement('button', {
        type: 'button',
        className: 'dshq-mic' + (recording ? ' dshq-mic-rec' : '') + (phase === 'transcribing' ? ' dshq-mic-busy' : '') + (phase === 'requesting' ? ' dshq-mic-wait' : ''),
        title: recording ? '结束录音并识别' : '语音输入：点一下开始说话，再点一下结束',
        'aria-label': recording ? '结束录音并识别' : '语音输入',
        disabled: phase === 'transcribing',
        onMouseDown: (e) => { try { e.preventDefault(); e.stopPropagation() } catch (err) { /* ignore */ } },
        onClick,
      }, recording ? React.createElement('span', { className: 'dshq-mic-dot' }) : voiceMicIcon(15))
    }

    const AnnotationEditor = () => {
      const state = useEditor()
      const inputRef = React.useRef(null)
      const [comment, setComment] = React.useState('')
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        setComment('')
        setStatus(null)
        if (state.item && inputRef.current) {
          // 同一元素重复聚焦：输入法记住的语言模式得以保留
          inputRef.current.focus()
        }
      }, [state.item])
      const open = !!(state.item && state.rect)
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const item = state.item
      // 文档预览（docx/pdf/xlsx 等不可编辑预览）走"文件批注列表"，聊天消息仍走"立即插入"
      const docMode = !!(item && item.filePath)
      const rect = open ? anchorRect(state.rect) : null
      if (rect && rect.__dshq === 'fallback') {
        try { report('editor:anchor', { src: 'fallback' }) } catch (e) { /* ignore */ }
      }
      let left = -9999
      let top = -9999
      let w = 200
      if (open && rect) {
        // 宽度：默认约 10 字（120px），随评论输入变宽，封顶 340px
        const quoteW = Math.min(220, item.text.length * 12 + 16)
        const inputW = Math.min(300, Math.max(140, comment.length * 13 + 44))
        w = Math.max(120, Math.min(340, Math.max(quoteW, inputW)))
        const center = rect.left + (rect.right - rect.left) / 2
        left = Math.max(12, Math.min(center - w / 2, vw - w - 12))
        const estH = 200
        top = rect.bottom + 8 + estH <= vh - 8 ? rect.bottom + 8 : Math.max(8, rect.top - estH - 8)
      }
      const insert = () => {
        if (!open || !item) return
        try {
          const c = (comment || '').trim()
          // 文档预览（不可编辑预览）的批注：不写输入框，先进「文件批注列表」，
          // 由预览头部「批注 · N」面板统一查看 / 删除 / 一次性发送。
          if (item.filePath) {
            const sessionId = item.sessionId || resolveSessionId()
            if (!sessionId) {
              setStatus({ ok: false, text: '加入失败：拿不到当前会话，请在对话区点一下再重试' })
              return
            }
            docNotesStore.add(sessionId, item.filePath, {
              quote: item.text,
              comment: c,
              line: item.line,
              page: item.page,
              excel: item.excel || null,
            })
            const count = docNotesStore.get(sessionId, item.filePath).length
            report('doc-notes:add', { file: fileNameOfPath(item.filePath), count })
            setStatus({ ok: true, text: '已加入文件批注（' + count + ' 条），点头部「批注 · ' + count + '」统一发送' })
            setTimeout(() => { try { editorStore.close() } catch (e) { /* ignore */ } }, 900)
            return
          }
          const conversation = rootCtx ? rootCtx.get('conversation') : undefined
          const sessions = rootCtx ? rootCtx.get('sessions') : undefined
          if (!conversation || !conversation.input || !sessions) {
            setStatus({ ok: false, text: '写入输入框失败：conversation/sessions 服务不可用' })
            return
          }
          const sessionId = item.sessionId || resolveSessionId()
          if (!sessionId) {
            report('insert:no-session', {})
            setStatus({ ok: false, text: '写入失败：拿不到当前会话，请在对话区里点一下再重试' })
            return
          }
          const binding = sessions.binding(sessionId)
          if (!binding) {
            report('insert:no-binding', { sessionId: String(sessionId).slice(0, 8) })
            setStatus({ ok: false, text: '写入输入框失败：会话不可用' })
            return
          }
          const input = conversation.input.for(binding.ctx)
          const st = input.state.getSnapshot()
          const draftNow = String(st.draft || '')
          const entry = {
            anchorKey: item.anchorKey || null,
            turn: Number.isFinite(item.turn) ? item.turn : null,
            kind: item.kind || null,
            quote: String(item.text || '').trim(),
            comment: c,
            at: Date.now(),
          }
          // 多轮批注：先把历史批注按草稿现状对账（用户手动删掉的不复活），
          // 再并入新的一条 → 按对话先后排序 → 重编号 1..N → 整段重写草稿。
          const kept = loadAnnotations(sessionId).filter((e) => draftHasAnnotation(draftNow, e))
          kept.push(entry)
          const ordered = sortAnnotations(kept, anchorDomIndex())
          const no = ordered.indexOf(entry) + 1
          saveAnnotations(sessionId, ordered)
          // 传入已知原文：块没有评语时也能在正文末尾收块，避免把用户文字一起剥掉
          const userText = stripQuoteBlocks(draftNow, ordered.map((e) => e.quote))
          const section = renderAnnotationSection(ordered)
          const nextDraft = [userText, section].filter((s) => s !== '').join('\n\n')
          input.setDraft(nextDraft)
          report('insert:plaintext', {
            no,
            count: ordered.length,
            turns: ordered.map((e) => (Number.isFinite(e.turn) ? e.turn + 1 : null)),
            draftLen: nextDraft.length,
          })
          // 立刻给刚插入的内容贴样式，避免"先露出旧样子、稍后才变紧凑"的闪烁
          lastInsertAt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
          try { if (typeof composerDecorateNow === 'function') composerDecorateNow() } catch (e) { /* ignore */ }
          setStatus({
            ok: true,
            text: '已插入批注 ' + no + ' ✓（共 ' + ordered.length + ' 条，按对话顺序排列）'
              + (item.filePath ? '（来源：' + fileNameOfPath(item.filePath) + '）' : ''),
          })
          editorStore.close()
        } catch (e) {
          setStatus({ ok: false, text: '插入失败：' + (e && e.message ? e.message : String(e)) })
          report('insert:throw', String((e && e.stack) || (e && e.message) || e))
          console.error('[quote-pro] 插入失败', e)
        }
      }
      const hint = docMode
        ? '加入后可在预览底部「批注 · N」里展开 / 删除，或一次性发送到输入框'
        : '插入后输入框里会显示紧凑引用块，点它可跳回原文'
      return React.createElement('div', {
        className: open ? 'dshq-editor' : 'dshq-editor dshq-editor-hidden',
        style: { left, top, width: w },
      },
        React.createElement('div', { className: 'dshq-editor-label' }, open ? item.label : ''),
        React.createElement('div', { className: 'dshq-editor-quote' }, open ? item.text : ''),
        React.createElement('div', { className: 'dshq-editor-inputrow' },
          React.createElement('input', {
            ref: inputRef,
            className: 'dshq-editor-input',
            value: comment,
            placeholder: '输入评论…',
            onChange: (e) => setComment(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') insert()
              if (e.key === 'Escape') editorStore.close()
            },
          }),
          // 语音输入：和 DSH 输入框同款麦克风，识别结果按光标位置插进评论
          React.createElement(VoiceMicButton, {
            inputRef,
            getValue: () => comment,
            setValue: (next) => setComment(next),
            onNotice: (ok, text) => setStatus({ ok, text }),
          }),
        ),
        status && open ? React.createElement('div', { className: status.ok ? 'dshq-editor-status dshq-ok' : 'dshq-editor-status dshq-err' }, status.text) : (open ? React.createElement('div', { className: 'dshq-editor-hint' }, hint) : null),
        React.createElement('div', { className: 'dshq-editor-actions' },
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-primary', onClick: insert }, docMode ? '加入批注列表' : '插入输入框'),
          React.createElement('button', { type: 'button', className: 'dshq-btn', onClick: () => editorStore.close() }, '✕'),
        ),
      )
    }

    // ============ 取消整块引用（点引用块右侧的 ✕） ============
    function cancelAnnotationBlock(item) {
      try {
        const conversation = rootCtx ? rootCtx.get('conversation') : undefined
        const sessions = rootCtx ? rootCtx.get('sessions') : undefined
        if (!conversation || !conversation.input || !sessions) return
        const sessionId = resolveSessionId()
        if (!sessionId) return
        const binding = sessions.binding(sessionId)
        if (!binding) return
        const input = conversation.input.for(binding.ctx)
        const st = input.state.getSnapshot()
        const draftNow = String(st.draft || '')
        // 文本手术：只删这一块（位置行 + 原文 + 评语），其余内容原样保留，然后重编号
        const nextDraft = renumberAnnotationsInDraft(removeBlockFromDraft(draftNow, item.quote, item.comment))
        try { headerByQuote.delete(normForMatch(item.quote)) } catch (e) { /* ignore */ }
        // 批注表里也去掉这一条（多轮排序的依据），否则下次插入会把它写回来
        try {
          const keep = loadAnnotations(sessionId).filter((e) => normForMatch(e.quote) !== normForMatch(item.quote))
          saveAnnotations(sessionId, keep)
        } catch (e) { /* ignore */ }
        input.setDraft(nextDraft)
        blockActionsStore.hide()
        try { if (typeof composerDecorateNow === 'function') composerDecorateNow() } catch (e) { /* ignore */ }
        toastStore.show('已取消这块引用', { left: item.left, top: item.top }, true)
        report('block:cancel', { len: nextDraft.length })
      } catch (e) {
        report('block:cancel-throw', String((e && e.message) || e))
      }
    }

    // ============ 组件：引用块右侧的 ✕（浮层按钮，不进编辑器 DOM） ============
    const ComposerBlockCancel = () => {
      const store = useBlockActions()
      if (!store.items || store.items.length === 0) return null
      return React.createElement('div', { className: 'dshq-cancel-layer' },
        store.items.map((it, i) => React.createElement('button', {
          key: it.key || String(i),
          type: 'button',
          className: 'dshq-cancel-btn',
          title: '取消整块引用',
          'aria-label': '取消整块引用',
          style: { left: it.left + 'px', top: it.top + 'px' },
          onMouseDown: (e) => { try { e.preventDefault(); e.stopPropagation() } catch (err) { /* ignore */ } },
          onClick: (e) => {
            try { e.preventDefault(); e.stopPropagation() } catch (err) { /* ignore */ }
            cancelAnnotationBlock(it)
          },
        }, '✕')),
      )
    }

    // ============ 组件四：引用悬停提示（显示当时选中的文字） ============
    const QuoteTooltip = () => {
      const t = useTooltip()
      if (!t.visible || !t.rect) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const w = Math.min(340, Math.max(180, Math.min(t.text.length, 60) * 11 + 48))
      const estH = Math.min(200, 56 + Math.ceil(Math.min(t.text.length, 400) / 22) * 15)
      const center = t.rect.left + (t.rect.right - t.rect.left) / 2
      const left = Math.max(8, Math.min(center - w / 2, vw - w - 8))
      let top = t.rect.top - estH - 8
      if (top < 8) top = Math.min(vh - estH - 8, t.rect.bottom + 8)
      return React.createElement('div', { className: 'dshq-tip', style: { left, top, width: w } },
        React.createElement('div', { className: 'dshq-tip-label' }, t.label),
        React.createElement('div', { className: 'dshq-tip-quote' }, t.text),
      )
    }

    // ============ 组件五：点击 chip 的反馈 toast（shell.overlay 条目） ============
    const FeedbackToast = () => {
      const t = useToast()
      if (!t.text || !t.pos) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const left = Math.max(12, Math.min(t.pos.left - 80, vw - 180))
      return React.createElement('div', {
        className: t.ok ? 'dshq-toast dshq-toast-ok' : 'dshq-toast dshq-toast-err',
        style: { left, top: t.pos.top + 18 },
      }, t.text)
    }

    // ============ 文件批注：订阅工具 ============
    function useDocNotesVersion() {
      const [, force] = React.useState(0)
      React.useEffect(() => docNotesStore.subscribe(() => force((v) => v + 1)), [])
      return docNotesStore
    }

    function useDocPreviewVersion() {
      const [, force] = React.useState(0)
      React.useEffect(() => docPreviewStore.subscribe(() => force((v) => v + 1)), [])
      return docPreviewStore
    }

    function noteWhereLabel(note) {
      if (note && note.excel && note.excel.ref) return '' // Excel：quote 本身就是定位，不重复显示
      if (note && typeof note.page === 'number' && note.page > 0) return '第' + note.page + '页'
      if (note && typeof note.line === 'number' && note.line > 0) return '第' + note.line + '行'
      return ''
    }

    // ============ 组件七：文档预览来源探针 ============
    // `sidebar.right.tab.document.actions` 是 documentpreview 声明的 list 槽，
    // 渲染时 owner prop 带当前文档的 `absolutePath`（官方 open-in-app 也注册在这里）。
    // 这里只做登记：把「探针节点 → 文件路径 / 会话」放进 docProbes，划词时用 DOM 包含关系
    // 把选区和文件对上；挂载/卸载时通知底部批注条跟随当前预览 tab。
    let docProbePropsReported = false
    const DocPathProbe = (props) => {
      if (!docProbePropsReported) {
        docProbePropsReported = true
        try { report('doc-probe:props', { keys: Object.keys(props || {}) }) } catch (e) { /* ignore */ }
      }
      const raw = props && (
        (typeof props.absolutePath === 'string' && props.absolutePath) ||
        (props.owner && typeof props.owner.absolutePath === 'string' && props.owner.absolutePath) ||
        (props.tabInfo && typeof props.tabInfo.absolutePath === 'string' && props.tabInfo.absolutePath) ||
        ''
      )
      const path = raw !== '' ? raw : null
      const slotSessionId = props && typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      const probeRef = React.useRef(null)
      React.useLayoutEffect(() => {
        const node = probeRef.current
        if (!node) return undefined
        const entry = { node, path, sessionId: slotSessionId }
        docProbes.add(entry)
        if (path) report('doc-probe:mounted', { file: fileNameOfPath(path) })
        docPreviewStore.emit()
        return () => {
          docProbes.delete(entry)
          docPreviewStore.emit()
        }
      }, [path, slotSessionId])
      return React.createElement('span', {
        ref: probeRef,
        'data-dshq-doc-path': path || '',
        style: { display: 'none' },
      })
    }

    // 预览正文的几种标记：官方 documentpreview 的 slot 包裹层，以及正文渲染器自带属性。
    // 用集合而非单一选择器 —— 换个渲染器（PDF / 文本页 / 图片）也能找到同一个预览根。
    // 文档预览的几种标记：text / code / pdf 三类渲染器，以及 document preview 的 slot 包裹层。
    // 代码预览（CodeBody）只有 [data-code-preview] / [data-code-block-content]，没有 textpreview-* 标记。
    const PREVIEW_ROOT_MARKERS = '[data-slot="sidebar.right.tab.document"], [data-textpreview-body], [data-textpreview-url], [data-textpreview-state], [data-pdf-preview], [data-pdf-page], [data-code-preview], [data-code-block-content], [data-excel-preview]'

    function findPreviewRoot(node) {
      try {
        let el = node && node.parentElement
        let found = null
        let hops = 0
        while (el && el !== document.body && hops < 14) {
          hops += 1
          if (typeof el.querySelector === 'function') {
            // 头部带路径标签的容器才算完整预览根（代码预览的 header 在 body 外面）
            if (el.querySelector('[data-textpreview-path]')) return el
            if (!found && el.querySelector(PREVIEW_ROOT_MARKERS)) found = el
          }
          el = el.parentElement
        }
        return found
      } catch (e) { /* ignore */ }
      return null
    }

    /** 当前可见的文档预览（多个 tab 时取最后一个可见的） */
    function activeDocPreview() {
      let best = null
      for (const probe of docProbes) {
        if (!probe || !probe.path || !probe.node || !probe.node.isConnected) continue
        const root = findPreviewRoot(probe.node)
        if (!root) continue
        const rect = root.getBoundingClientRect()
        if (!rect || rect.width < 60 || rect.height < 60) continue
        try {
          const style = window.getComputedStyle(root)
          if (style.visibility === 'hidden' || style.display === 'none') continue
        } catch (e) { /* ignore */ }
        best = { path: probe.path, sessionId: probe.sessionId || null, root, rect }
      }
      // 兜底：有些预览（代码 / 纯文本）没有 document.actions 探针，靠预览根节点 + 头部路径标签拿文件
      if (!best) {
        try {
          const roots = document.querySelectorAll(PREVIEW_ROOT_MARKERS)
          for (const el of roots) {
            if (!el || !el.isConnected) continue
            const rect = el.getBoundingClientRect()
            if (!rect || rect.width < 60 || rect.height < 60) continue
            try {
              const style = window.getComputedStyle(el)
              if (style.visibility === 'hidden' || style.display === 'none') continue
            } catch (e) { /* ignore */ }
            let holder = el
            for (let hops = 0; holder && holder !== document.body && hops < 10; hops += 1) {
              if (holder.querySelector && holder.querySelector('[data-textpreview-path]')) break
              holder = holder.parentElement
            }
            if (!holder || holder === document.body) holder = el
            let path = ''
            try {
              const label = holder.querySelector ? holder.querySelector('[data-textpreview-path]') : null
              const txt = label && label.textContent ? String(label.textContent).trim() : ''
              if (txt) path = txt
              if (!path) {
                const urlEl = holder.querySelector ? holder.querySelector('[data-textpreview-url]') : null
                if (urlEl) path = pathOfFileAddress(urlEl.getAttribute('data-textpreview-url')) || ''
              }
            } catch (e) { /* ignore */ }
            if (path === '') continue
            best = { path, sessionId: null, root: holder, rect: holder.getBoundingClientRect ? holder.getBoundingClientRect() : rect }
          }
        } catch (e) { /* ignore */ }
      }
      return best
    }

    /** 预览根里是不是 Fortune-Sheet 渲染器（扩展名认不出时靠 DOM 判定，别误判别的预览） */
    function hasExcelRenderer(root) {
      try {
        if (!root || typeof root.querySelector !== 'function') return false
        // root 自己就可能是 [data-excel-preview]（预览根只上跳一层的情况）
        if (typeof root.matches === 'function' && root.matches('[data-excel-preview]')) return true
        if (root.querySelector('[data-excel-preview]')) return true
        if (root.querySelector('.fortune-name-box')) return true
        return false
      } catch (e) { return false }
    }

    /** 当前可见的 Excel 预览：扩展名命中，或 DOM 上确实是表格渲染器（xlsb/ods/自定义后缀都不漏） */
    function activeExcelPreview() {
      const active = activeDocPreview()
      if (!active || !active.root) return null
      if (active.path && isExcelPath(active.path)) return active
      if (hasExcelRenderer(active.root)) return active
      return null
    }

    /**
     * 读当前 Excel 选区：Name Box 文本 + 行/列头选中状态 + 选区覆盖层矩形。
     * 拿不到（不是 Excel / 没打开 / 没选中）返回 null。
     */
    function readExcelSelection() {
      const active = activeExcelPreview()
      if (!active) return null
      const root = active.root
      let nameBox = null
      try { nameBox = root.querySelector('.fortune-name-box') } catch (e) { nameBox = null }
      if (!nameBox) return null
      const raw = (nameBox.textContent || '').trim()
      if (raw === '') return null
      let rowSelected = false
      let colSelected = false
      try {
        // 行头/列头高亮元素只在有整行/整列选中时才渲染（React 内联 style 里 display:block），
        // 用存在性判断即可，别去匹配 style 字符串（序列化格式一变就失效）
        rowSelected = !!root.querySelector('.fortune-row-header-selected')
        colSelected = !!root.querySelector('.fortune-col-header-selected')
      } catch (e) { /* ignore */ }
      const norm = normalizeExcelSelection(raw, { rowSelected, colSelected })
      if (!norm) return null
      let sheet = ''
      try {
        // sheet 名的展示形态随 Fortune-Sheet 版本/皮肤不同，逐个候选取第一个非空文本
        const candidates = [
          '.luckysheet-sheets-item-active .luckysheet-sheets-item-name',
          '.fortune-sheet-list-item-active .fortune-sheet-list-item-name',
          '.luckysheet-sheets-item-active',
          '.fortune-sheet-list-item-active',
        ]
        for (const sel of candidates) {
          const node = root.querySelector(sel)
          const text = node ? String(node.textContent || '').trim() : ''
          if (text !== '') { sheet = text; break }
        }
      } catch (e) { sheet = '' }
      const location = excelLocationOf(sheet, norm.ref)
      if (location === '') return null
      let rect = null
      try {
        const overlay = root.querySelector('.luckysheet-cell-selected-focus') || root.querySelector('.luckysheet-cell-selected')
        rect = overlay ? overlay.getBoundingClientRect() : null
      } catch (e) { rect = null }
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        try { rect = nameBox.getBoundingClientRect() } catch (e) { rect = null }
      }
      if (!rect || (rect.width === 0 && rect.height === 0)) return null
      return {
        path: active.path,
        sheet,
        ref: norm.ref,
        kind: norm.kind,
        location,
        root,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      }
    }

    // ============ 组件八：底部文件批注条（半透明浮层） ============
    // 当前文档预览里有批注时，在预览底部浮出一条：
    //   `批注 · N` + 展开/收起 + 全部发送 + 全部删除。
    // 展开后在上方浮出列表（单条可展开原文 / 删除）；全部删除后批注清空、这条自动消失。
    const DocNotesBar = () => {
      useDocNotesVersion()
      useDocPreviewVersion()
      const [, force] = React.useState(0)
      const [expandedKey, setExpandedKey] = React.useState(null)
      const [openQuoteId, setOpenQuoteId] = React.useState(null)
      const [editingId, setEditingId] = React.useState(null)
      const [editText, setEditText] = React.useState('')
      const [editMsg, setEditMsg] = React.useState(null)
      const editRef = React.useRef(null)
      const barRef = React.useRef(null)
      const panelRef = React.useRef(null)
      // 跟随预览滚动 / 窗口尺寸 / 文档 tab 切换重新定位
      React.useEffect(() => {
        let raf = 0
        const bump = () => {
          if (raf) return
          raf = requestAnimationFrame(() => { raf = 0; force((v) => v + 1) })
        }
        const timer = setInterval(bump, 700)
        document.addEventListener('scroll', bump, true)
        window.addEventListener('resize', bump)
        return () => {
          clearInterval(timer)
          document.removeEventListener('scroll', bump, true)
          window.removeEventListener('resize', bump)
          if (raf) cancelAnimationFrame(raf)
        }
      }, [])
      const active = activeDocPreview()
      const sessionId = (active && active.sessionId) || resolveSessionId()
      const path = active ? active.path : null
      const notes = active && sessionId ? docNotesStore.get(sessionId, path) : []
      const count = notes.length
      // 状态诊断：浮条没出现时，看是"没找到预览根"还是"批注 key 对不上"
      React.useEffect(() => {
        try {
          const resolved = resolveSessionId()
          const signature = [path || '', count, String(sessionId || ''), String(active && active.sessionId || ''), String(resolved || '')].join('|')
          if (signature === lastDocBarReport) return
          lastDocBarReport = signature
          const storedKeys = []
          try {
            if (typeof localStorage !== 'undefined' && typeof localStorage.length === 'number') {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i)
                if (typeof key === 'string' && key.indexOf(DOC_NOTES_PREFIX) === 0) storedKeys.push(key.slice(DOC_NOTES_PREFIX.length))
              }
            }
          } catch (e) { /* ignore */ }
          report('doc-bar:state', {
            file: path ? fileNameOfPath(path) : null,
            count,
            resolvedCount: resolved && path ? docNotesStore.get(resolved, path).length : null,
            sessionId: String(sessionId || '').slice(0, 14),
            probeSessionId: String(active && active.sessionId || '').slice(0, 14),
            resolvedSessionId: String(resolved || '').slice(0, 14),
            storedKeys: storedKeys.slice(0, 8),
          })
        } catch (e) { /* ignore */ }
      }, [path, count, sessionId, active && active.sessionId])
      // 切换文件时收起列表 / 收起单条展开 / 取消编辑
      React.useEffect(() => {
        setEditingId(null)
        setEditText('')
      }, [path])
      React.useEffect(() => {
        if (expandedKey && expandedKey !== path) {
          setExpandedKey(null)
          setOpenQuoteId(null)
        }
      }, [path, expandedKey])
      // 展开后：点浮条 / 列表以外的地方（或按 Esc）自动收起，不用再去找「收起」按钮
      React.useEffect(() => {
        if (!path || expandedKey !== path) return undefined
        const collapse = () => {
          setExpandedKey(null)
          setOpenQuoteId(null)
          setEditingId(null)
          setEditText('')
        }
        const onDown = (e) => {
          try {
            const target = e.target
            const inBar = barRef.current && target instanceof Node && barRef.current.contains(target)
            const inPanel = panelRef.current && target instanceof Node && panelRef.current.contains(target)
            if (inBar || inPanel) return
          } catch (err) { /* ignore */ }
          collapse()
        }
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          // 行内编辑时 Esc 交给输入框自己"取消编辑"，不收起整个列表
          if (editingId) return
          collapse()
        }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [path, expandedKey, editingId])
      if (!active || !sessionId || !path || count === 0) return null
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
      const vh = typeof window !== 'undefined' ? window.innerHeight : 768
      const rect = active.rect
      const barWidth = Math.max(280, Math.min(rect.width - 16, 620, vw - 24))
      const barLeft = Math.max(8, Math.min(rect.left + (rect.width - barWidth) / 2, vw - barWidth - 8))
      const barTop = Math.max(8, Math.min(rect.bottom - 52, vh - 52))
      const expanded = expandedKey === path
      const panelMaxH = Math.max(120, Math.min(340, barTop - 24))
      const panelTop = Math.max(8, barTop - panelMaxH - 8)
      const pos = { left: barLeft + barWidth / 2, top: barTop }
      const sendAll = () => {
        const composer = resolveComposerInput(sessionId)
        if (composer.error) {
          report('doc-notes:send-all-fail', composer.error)
          notify('发送失败：' + composer.error, pos, false)
          return
        }
        try {
          const input = composer.input
          const draftNow = String(input.state.getSnapshot().draft || '')
          // 与聊天批注共用同一张批注表：先按草稿现状对账（用户删掉的不复活），再把文件批注并进来
          const kept = loadAnnotations(composer.sessionId).filter((e) => draftHasAnnotation(draftNow, e))
          const at = Date.now()
          const fileEntries = notes.map((n, i) => ({
            filePath: path,
            line: typeof n.line === 'number' && Number.isFinite(n.line) ? n.line : null,
            page: typeof n.page === 'number' && Number.isFinite(n.page) ? n.page : null,
            excel: normalizeExcelMeta(n.excel),
            quote: String(n.quote || '').trim(),
            comment: String(n.comment || '').trim(),
            at: at + i,
          })).filter((e) => e.quote !== '')
          if (fileEntries.length === 0) return
          // 排序：聊天批注按轮次在前，文件批注（无 turn）排在后面，块内编号统一重排 1..N
          const ordered = sortAnnotations(kept.concat(fileEntries), anchorDomIndex())
          saveAnnotations(composer.sessionId, ordered)
          // 传入已知原文：块没有评语时也能在正文末尾收块，避免把用户文字一起剥掉
          const userText = stripQuoteBlocks(draftNow, ordered.map((e) => e.quote))
          const section = renderAnnotationSection(ordered)
          const nextDraft = [userText, section].filter((v) => v !== '').join('\n\n')
          input.setDraft(nextDraft)
          lastInsertAt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
          try { if (typeof composerDecorateNow === 'function') composerDecorateNow() } catch (e) { /* ignore */ }
          // 发送后清空该文件的批注列表，避免再点一次「全部发送」重复插入
          const removed = docNotesStore.clear(sessionId, path)
          setOpenQuoteId(null)
          setExpandedKey(null)
          setEditingId(null)
          setEditText('')
          report('doc-notes:send-all', { file: fileNameOfPath(path), count: removed, draftLen: nextDraft.length })
          notify('已将 ' + removed + ' 条文件批注插入输入框（列表已清空）', pos, true)
        } catch (e) {
          report('doc-notes:send-all-throw', String((e && e.stack) || (e && e.message) || e))
          notify('发送失败：' + String((e && e.message) || e), pos, false)
          return
        }
      }
      const clearAll = () => {
        const removed = docNotesStore.clear(sessionId, path)
        report('doc-notes:clear', { file: fileNameOfPath(path), count: removed })
        setOpenQuoteId(null)
        setExpandedKey(null)
        setEditingId(null)
        setEditText('')
      }
      const toggleExpanded = () => {
        setExpandedKey(expanded ? null : path)
        setOpenQuoteId(null)
        setEditingId(null)
        setEditText('')
        report('doc-notes:toggle', { file: fileNameOfPath(path), count, expanded: !expanded })
      }
      const startEdit = (note) => {
        setEditingId(note.id)
        setEditText(String(note.comment || ''))
        setOpenQuoteId(note.id)
        report('doc-notes:edit-start', { file: fileNameOfPath(path), id: String(note.id).slice(0, 8) })
      }
      const cancelEdit = () => {
        setEditingId(null)
        setEditText('')
      }
      const saveEdit = (note) => {
        const text = String(editText || '').trim()
        const ok = docNotesStore.update(sessionId, path, note.id, { comment: text })
        if (ok) report('doc-notes:edit', { file: fileNameOfPath(path), id: String(note.id).slice(0, 8), chars: text.length })
        setEditingId(null)
        setEditText('')
      }
      const rows = notes.map((note) => {
        const open = openQuoteId === note.id
        const editing = editingId === note.id
        const where = noteWhereLabel(note)
        return React.createElement('div', { className: 'dshq-doc-note' + (editing ? ' dshq-doc-note-editing' : ''), key: note.id },
          React.createElement('div', { className: 'dshq-doc-note-head' },
            where !== '' ? React.createElement('span', { className: 'dshq-doc-note-where' }, where) : null,
            React.createElement('span', {
              className: 'dshq-doc-note-quote' + (open ? ' dshq-doc-note-quote-open' : ''),
              role: 'button',
              tabIndex: 0,
              title: open ? '收起原文' : '展开原文',
              onClick: () => setOpenQuoteId(open ? null : note.id),
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setOpenQuoteId(open ? null : note.id) },
            }, note.quote),
          ),
          editing ? React.createElement('div', { className: 'dshq-doc-note-editbox' },
            React.createElement('textarea', {
              ref: editRef,
              className: 'dshq-doc-note-input',
              value: editText,
              rows: 3,
              placeholder: '写批注…',
              autoFocus: true,
              onChange: (e) => setEditText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(note) }
                if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
              },
            }),
            React.createElement('div', { className: 'dshq-doc-note-edit-actions' },
              editMsg ? React.createElement('span', { className: 'dshq-voice-msg' + (editMsg.ok ? '' : ' dshq-voice-msg-err') }, editMsg.text) : null,
              // 语音输入：批注面板的编辑框也挂一个麦克风
              React.createElement(VoiceMicButton, {
                inputRef: editRef,
                getValue: () => editText,
                setValue: (next) => setEditText(next),
                onNotice: (ok, text) => setEditMsg({ ok, text }),
              }),
              React.createElement('button', { type: 'button', className: 'dshq-btn dshq-primary', onClick: () => saveEdit(note) }, '保存'),
              React.createElement('button', { type: 'button', className: 'dshq-btn', onClick: cancelEdit }, '取消'),
            ),
          ) : (open && note.comment ? React.createElement('div', { className: 'dshq-doc-note-comment' }, '批注：' + note.comment) : null),
          React.createElement('div', { className: 'dshq-doc-note-actions' },
            editing ? null : React.createElement('button', {
              type: 'button',
              className: 'dshq-btn dshq-doc-note-edit',
              onClick: (e) => { e.stopPropagation(); startEdit(note) },
            }, '编辑'),
            editing ? null : React.createElement('button', {
              type: 'button',
              className: 'dshq-btn dshq-doc-note-del',
              onClick: (e) => {
                e.stopPropagation()
                docNotesStore.remove(sessionId, path, note.id)
                setOpenQuoteId(null)
              },
            }, '删除'),
          ),
        )
      })
      return React.createElement(React.Fragment, null,
        expanded ? React.createElement('div', {
          ref: panelRef,
          className: 'dshq-doc-bar-panel',
          style: { left: barLeft, width: barWidth, top: panelTop, maxHeight: panelMaxH },
        },
          React.createElement('div', { className: 'dshq-doc-panel-path', title: path }, fileNameOfPath(path)),
          React.createElement('div', { className: 'dshq-doc-panel-list' }, rows),
        ) : null,
        React.createElement('div', {
          ref: barRef,
          className: 'dshq-doc-bar',
          style: { left: barLeft, top: barTop, width: barWidth },
        },
          React.createElement('span', { className: 'dshq-doc-bar-count' }, '批注 · ' + count),
          React.createElement('span', { className: 'dshq-doc-bar-spacer' }),
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-doc-bar-btn', onClick: toggleExpanded }, expanded ? '收起' : '展开'),
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-doc-bar-btn dshq-doc-bar-send', onClick: sendAll }, '全部发送'),
          React.createElement('button', { type: 'button', className: 'dshq-btn dshq-doc-bar-btn dshq-doc-bar-del', onClick: clearAll }, '全部删除'),
        ),
      )
    }

    // ============ 样式（主题令牌自适应明暗） ============
    // ============ 组件六：输入框上方的引用块（紧凑样式；点击可跳回原文，但不显式提示） ============
    // 本版本输入框里的引用 chip 没有 data 属性（只有 CSS 类），DOM 无法反查 occurrence；
    // 因此这里直接读官方输入状态的 occurrences（source === 'quote-ref'）来渲染。
    // 展示的是**原文片段本身**（不再显示「引用#N · 第N轮 · 角色」这类标签），保持输入区干净；
    // 定位能力保留：点一下就跳回原文并高亮，只是不做任何可见的"跳转"提示。
    const SNIPPET_MAX = 90
    const snippetOf = (body) => {
      const raw = String(body || '')
        .split('\n')
        .filter((line) => line.trim() !== '' && !/^【(?:引用|批注)/.test(line.trim()) && !/^批注[:：]/.test(line.trim()))
        .map((line) => line.replace(/^>\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX) + '…' : raw
    }

    const QuoteBlock = ({ item }) => {
      const onJump = (e) => {
        try {
          const r = e.currentTarget.getBoundingClientRect()
          report('dock:click', { ref: String(item.ref), anchorKey: item.anchorKey || null })
          jumpToRef(item.ref, { left: r.left + 16, top: r.top }, { silent: true })
        } catch (err) { /* ignore */ }
      }
      return React.createElement('div', {
        className: 'dshq-quote-block',
        onClick: onJump,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') onJump(e) },
        role: 'button',
        tabIndex: 0,
        title: '点击跳回原文',
      }, React.createElement('span', { className: 'dshq-quote-block-text' }, item.snippet || '引用'))
    }

    const QuoteDock = (props) => {
      // 槽位作用域是 session，正常会带 sessionId；拿不到时退回模块级解析结果
      const sessionId = (props && typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null) || resolveSessionId() || null
      const [rows, setRows] = React.useState([])
      React.useEffect(() => {
        if (!sessionId) { setRows([]); return undefined }
        let input = null
        try {
          const conversation = rootCtx ? rootCtx.get('conversation') : undefined
          const sessions = rootCtx ? rootCtx.get('sessions') : undefined
          const binding = sessions ? sessions.binding(sessionId) : undefined
          input = conversation && conversation.input && binding ? conversation.input.for(binding.ctx) : null
        } catch (e) {
          report('dock:input-throw', String((e && e.message) || e))
        }
        if (!input || !input.state) return undefined
        const read = () => {
          try {
            const snap = input.state.getSnapshot()
            const occurrences = (snap && snap.occurrences) || []
            const draftText = String((snap && snap.draft) || '')
            const next = []
            for (const occ of occurrences) {
              if (!occ || occ.source !== 'quote-ref') continue
              const info = refTargets.get(occ.ref)
              const snippet = snippetOf(info && info.body)
              // 旧版本遗留的 occurrence：正文里已经没有这段原文（用户把引用块删了）就不显示，
              // 否则输入框上方会残留一颗空的「批注」壳子。
              if (snippet !== '' && normForMatch(draftText).indexOf(normForMatch(snippet)) === -1) continue
              next.push({
                ref: occ.ref,
                anchorKey: (info && info.anchorKey) || null,
                snippet,
              })
            }
            setRows(next)
            if (next.length > 0) report('dock:rows', { count: next.length })
          } catch (e) { /* ignore */ }
        }
        read()
        let off
        let timer = null
        try {
          if (typeof input.state.subscribe === 'function') off = input.state.subscribe(read)
          else timer = setInterval(read, 800)
        } catch (e) { timer = setInterval(read, 800) }
        return () => {
          try { if (typeof off === 'function') off() } catch (e) { /* ignore */ }
          if (timer !== null) clearInterval(timer)
        }
      }, [sessionId])
      if (!sessionId || rows.length === 0) return null
      const children = []
      for (const row of rows) children.push(React.createElement(QuoteBlock, { key: row.ref, item: row }))
      return React.createElement('div', { className: 'dshq-dock' }, children)
    }

    const css = `
.dshq-tail{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:2px}
.dshq-btn{appearance:none;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.4;padding:2px 8px;border-radius:6px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshq-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshq-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.dshq-primary:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);opacity:.9}
.dshq-toolbar{position:fixed;display:flex;align-items:center;gap:4px;min-width:10em;width:max-content;max-width:min(32em,calc(100vw - 24px));font-size:12px;padding:3px 7px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-label-secondary) 6%,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 14px rgba(0,0,0,.14);pointer-events:auto;box-sizing:border-box}
.dshq-toolbar-preview{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-bubble-cta{flex:none;padding:1px 8px;border-radius:999px}
.dshq-close{flex:none;padding:1px 5px;opacity:.7}
.dshq-editor{position:fixed;display:flex;flex-direction:column;gap:5px;box-sizing:border-box;padding:8px 10px;border-radius:10px;background:color-mix(in oklab,var(--dsw-alias-label-secondary) 6%,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:auto;font-size:12px}
.dshq-editor-hidden{opacity:0;pointer-events:none}
.dshq-editor-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-editor-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}
.dshq-editor-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:4px 8px}
.dshq-editor-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshq-editor-inputrow{display:flex;align-items:center;gap:6px;width:100%}
.dshq-editor-inputrow .dshq-editor-input{flex:auto;min-width:0}
.dshq-mic{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .12s ease,border-color .12s ease,background .12s ease}
.dshq-mic:hover{color:var(--dsw-alias-label-primary);background:color-mix(in oklab,var(--dsw-alias-label-secondary) 12%,transparent)}
.dshq-mic:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshq-mic-rec,.dshq-mic-rec:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 10%,transparent);animation:dshq-mic-pulse 1.2s ease-in-out infinite}
.dshq-mic-dot{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-state-error-primary);animation:dshq-mic-blink 1s steps(2,start) infinite}
.dshq-mic-busy{opacity:.55;cursor:progress}
.dshq-mic-wait{opacity:.85}
@keyframes dshq-mic-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in oklab,var(--dsw-alias-state-error-primary) 42%,transparent)}55%{box-shadow:0 0 0 5px color-mix(in oklab,var(--dsw-alias-state-error-primary) 0%,transparent)}}
@keyframes dshq-mic-blink{50%{opacity:.25}}
.dshq-voice-msg{margin-right:auto;min-width:0;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshq-voice-msg-err{color:var(--dsw-alias-state-error-primary)}
.dshq-editor-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dshq-editor-status{font-size:11px;line-height:1.5}
.dshq-editor-status.dshq-ok{color:var(--dsw-alias-state-success-primary)}
.dshq-editor-status.dshq-err{color:var(--dsw-alias-state-error-primary)}
.dshq-editor-actions{display:flex;justify-content:flex-end;gap:6px}
.dshq-tip{position:fixed;display:flex;flex-direction:column;gap:4px;box-sizing:border-box;padding:8px 10px;border-radius:8px;background:color-mix(in oklab,var(--dsw-alias-label-secondary) 6%,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l1);box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:none;z-index:2147483000;font-size:12px}
.dshq-tip-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-tip-quote{margin:0;padding:3px 8px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;font-size:11px}
.dshq-flash{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:8px}
.dshq-toast{position:fixed;max-width:240px;padding:5px 9px;border-radius:8px;font-size:11px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,.18);pointer-events:none;z-index:2147483000}
.dshq-toast-ok{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 6%,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.dshq-toast-err{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 6%,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
/* 根因：textarea（透明文字、absolute、inset:0）渲染在 backdrop 之后，整层盖住 chip。
   给 chip 提升 z-index 使其浮到 textarea 之上，点击才能落到 chip 上。 */
[data-occurrence]{pointer-events:auto;cursor:pointer;position:relative;z-index:1}
/* 引用块：贴在输入框卡片上沿（点一下跳回原文，不显示任何"跳转"提示） */
.dshq-dock{display:flex;flex-direction:column;gap:4px;padding:0 6px;margin:6px 0 -2px;min-width:0;box-sizing:border-box}
.dshq-quote-block{display:flex;align-items:center;min-width:0;max-width:100%;box-sizing:border-box;padding:6px 10px;border-radius:12px 12px 4px 4px;background:var(--dsw-alias-bg-layer-2);background:color-mix(in oklab,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshq-quote-block:hover{color:var(--dsw-alias-label-primary)}
.dshq-quote-block-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 已发送消息里的引用：隐藏位置标签，只显示紧凑的原文块（点击可跳回原文，无可见引导） */
.dshq-sent-header{display:none}
.dshq-sent-quote{display:block;position:relative;margin:3px 0;padding:6px 10px;border-radius:8px;background:color-mix(in oklab,var(--dsw-alias-label-secondary) 10%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;cursor:pointer;overflow:hidden;transition:background .12s ease,color .12s ease}
.dshq-sent-quote:hover{color:var(--dsw-alias-label-primary)}
.dshq-sent-quote[data-dshq-file-name]::before{content:'📄 ' attr(data-dshq-file-name);display:block;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);opacity:.8;margin-bottom:2px}
.dshq-sent-quote-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
/* 输入框里的引用：隐藏位置行，正文显示为紧凑块（输入框与消息观感一致） */
.dshq-cmp-header{display:none !important}
/* 光标停在位置行里时临时显示（否则打字看不见字）；必须排在上一行之后才能覆盖 !important */
/* 光标停在位置行里时：**绝不显示协议原文**（位置行是给模型看的），只显示一行占位提示；
   用 font-size:0 把真实文字压成不可见，占位符由 ::before 提供。删字/编辑仍可正常工作。 */
.dshq-cmp-header-active{display:block !important;font-size:0 !important;line-height:0 !important;margin:2px 0;max-height:18px;overflow:hidden;pointer-events:none;user-select:none}
.dshq-cmp-header-active::before{content:'〔位置行 · 界面隐藏〕';font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);opacity:.65}
.dshq-cmp-comment{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 10%,transparent);border-left:3px solid color-mix(in oklab,var(--dsw-alias-label-secondary) 45%,transparent);border-radius:0 8px 8px 0;padding:0 10px 2px;margin-top:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshq-cmp-orphan{display:none !important}
/* 引用块由若干行组成，行与行之间不能留缝，否则多行原文会呈现为一串独立小条。
   圆角只给首行顶部与末行底部，中间行直角 —— 整段看起来才是一个连续块。 */
.dshq-cmp-quote{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 10%,transparent);border-left:3px solid color-mix(in oklab,var(--dsw-alias-brand-primary) 55%,transparent);border-radius:0;padding:2px 30px 2px 10px;margin:0;cursor:pointer}
.dshq-cmp-quote:hover{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 16%,transparent)}
.dshq-cmp-quote-first{margin-top:4px;position:relative;padding-left:30px;border-radius:2px 8px 0 0}
/* 深色下输入框卡片本身已是 #343537 级灰，引用块只叠 10% 灰太淡（实测约 1.28:1，看不出块边界），
   深色单独抬高一点；左边条保持不变，仍然靠它给"这是引用"的强提示 */
[data-ds-dark-theme] .dshq-cmp-quote{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 16%,transparent)}
[data-ds-dark-theme] .dshq-cmp-quote:hover{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 22%,transparent)}
[data-ds-dark-theme] .dshq-cmp-comment{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 13%,transparent)}
[data-ds-dark-theme] .dshq-sent-quote{background:color-mix(in oklab,var(--dsw-alias-label-secondary) 14%,transparent)}
/* 文档来源的块：在块上方显示「📄 文件名」（CSS 生成，不进入正文） */
.dshq-cmp-file{margin-top:20px}
.dshq-cmp-file::after{content:'📄 ' attr(data-dshq-file-name);position:absolute;top:-16px;left:28px;max-width:74%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);opacity:.8;pointer-events:none;user-select:none}
/* 块首行前面的可见编号：由装饰阶段写入 data-dshq-no，CSS 生成 —— 不在正文里，删不掉、编辑不到 */
.dshq-cmp-quote-first::before{content:attr(data-dshq-no);position:absolute;left:7px;top:4px;width:18px;height:18px;border-radius:9px;background:color-mix(in oklab,var(--dsw-alias-brand-primary) 88%,black);color:var(--dsw-alias-label-primary-inverted);font-size:11px;font-weight:600;line-height:18px;text-align:center;pointer-events:none;user-select:none;font-variant-numeric:tabular-nums}
.dshq-cmp-quote-last{margin-bottom:4px;border-radius:0 8px 8px 0}
/* 末行直接接评语时把 4px 下边距收掉：否则块底与评语之间露一条卡片底色（0.4.1 遗留） */
.dshq-cmp-quote-last:has(+ .dshq-cmp-comment){margin-bottom:0}
/* 只有一行时首=末，两个圆角都要给 */
.dshq-cmp-quote-first.dshq-cmp-quote-last{border-radius:2px 8px 8px 2px}
/* 块内空行（多段原文之间的空行）：压扁成段落间距，不撑出大片空白 */
.dshq-cmp-quote-blank{min-height:0 !important;height:8px;line-height:8px;font-size:0;overflow:hidden}
/* 块尾紧跟评语时：两边贴合，避免"块底圆角 + 评语顶边"叠出缝隙 */
.dshq-cmp-quote-last + .dshq-cmp-comment{margin-top:0;border-radius:0 8px 8px 0}
.dshq-cmp-quote-blank.dshq-cmp-quote-last{height:4px;line-height:4px}
/* 引用块右侧的取消按钮（浮层，不进编辑器 DOM） */
.dshq-cancel-layer{position:fixed;inset:0;pointer-events:none;z-index:2147482000}
.dshq-cancel-btn{position:fixed;width:22px;height:22px;display:flex;align-items:center;justify-content:center;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in oklab,var(--dsw-alias-label-secondary) 6%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;pointer-events:auto;opacity:.75;box-shadow:0 2px 8px rgba(0,0,0,.12);transition:opacity .12s ease,color .12s ease,border-color .12s ease}
.dshq-cancel-btn:hover{opacity:1;color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
/* 位置行/评语的删除残片：匹配不上完整格式，但也不该露在输入框里 */
.dshq-cmp-frag{display:none !important}
.dshq-cmp-frag-active{display:block !important;opacity:.5}
/* 回复里的「Annotation N」芯片：悬浮看原文+评语，点击跳回原文 */
.dshq-anno-chip{display:inline-flex;align-items:center;margin:0 2px;padding:0 7px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-label-secondary) 12%,transparent);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;cursor:pointer;vertical-align:baseline;user-select:none;white-space:nowrap}
.dshq-anno-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
/* 文件批注：预览头部的计数入口 + 面板（docx / pdf / xlsx 等不可编辑预览） */
.dshq-doc-bar{position:fixed;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:40px;padding:4px 10px;border-radius:999px;background:color-mix(in oklab,var(--dsw-alias-bg-layer-2) 72%,transparent);-webkit-backdrop-filter:blur(12px) saturate(1.2);backdrop-filter:blur(12px) saturate(1.2);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.16);z-index:2147483000;font-size:12px;color:var(--dsw-alias-label-primary);pointer-events:auto}
.dshq-doc-bar-count{font-weight:600;white-space:nowrap}
.dshq-doc-bar-spacer{flex:auto}
.dshq-doc-bar-btn{padding:1px 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.dshq-doc-bar-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshq-doc-bar-send{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshq-doc-bar-send:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.dshq-doc-bar-del:hover{background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.dshq-doc-bar-panel{position:fixed;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;padding:10px;border-radius:12px;background:color-mix(in oklab,var(--dsw-alias-bg-layer-2) 82%,transparent);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 12px 32px rgba(0,0,0,.2);z-index:2147483000;overflow:auto;pointer-events:auto;font-size:12px;color:var(--dsw-alias-label-primary)}
.dshq-doc-panel-path{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshq-doc-panel-list{display:flex;flex-direction:column;gap:6px;margin:2px 0}
.dshq-doc-note{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dshq-doc-note-head{display:flex;align-items:baseline;gap:6px;min-width:0}
.dshq-doc-note-where{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshq-doc-note-quote{flex:auto;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.dshq-doc-note-quote:hover{color:var(--dsw-alias-label-primary)}
.dshq-doc-note-quote-open{white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;cursor:pointer;color:var(--dsw-alias-label-primary)}
.dshq-doc-note-comment{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.dshq-doc-note-actions{display:flex;justify-content:flex-end;gap:4px}
.dshq-doc-note-editing{border-color:var(--dsw-alias-brand-primary)}
.dshq-doc-note-edit{padding:0 6px;font-size:11px;opacity:.8}
.dshq-doc-note-edit:hover{opacity:1;color:var(--dsw-alias-brand-primary)}
.dshq-doc-note-editbox{display:flex;flex-direction:column;gap:4px}
.dshq-doc-note-input{width:100%;box-sizing:border-box;resize:vertical;min-height:52px;max-height:160px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;padding:4px 8px}
.dshq-doc-note-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dshq-doc-note-edit-actions{display:flex;justify-content:flex-end;gap:6px}
.dshq-doc-note-del{padding:0 6px;font-size:11px;opacity:.75}
.dshq-doc-note-del:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}
`

    // ============ 插件主体 ============
    function apply(ctx) {
      rootCtx = ctx
      report('apply:start')
      try {
        const names = ['slots', 'inputTriggers', 'conversation', 'sessions', 'sidebarRight', 'uiSession', 'layout', 'uiWorkspace', 'workspaces', 'chat', 'remote', 'remote.speech']
        const have = {}
        for (const n of names) {
          try { have[n] = ctx.get(n) !== undefined } catch (e) { have[n] = 'throw' }
        }
        report('env:services', have)
      } catch (e) { /* ignore */ }
      let slots
      try { slots = ctx.get('slots') } catch (e) { report('apply:slots-throw', String((e && e.message) || e)) }
      report('apply:slots', slots === undefined ? 'undefined' : typeof slots)
      if (slots === undefined) return
      try {
        ctx.effect(() => insertStyleSheet(css), 'dsh-quote-annotate-pro: styles')
      } catch (e) {
        report('apply:styles-throw', String((e && e.stack) || (e && e.message) || e))
      }
      // 注册引用 source（提交时把占位符序列化为引用正文；空候选分组不渲染，不污染 @ 菜单）
      let inputTriggers
      try { inputTriggers = ctx.get('inputTriggers') } catch (e) { report('apply:inputTriggers-throw', String((e && e.message) || e)) }
      pipelineAvailable = !!(inputTriggers && typeof inputTriggers.registerSource === 'function')
      report('apply:pipeline', {
        available: pipelineAvailable,
        hasInsertReference: !!(inputTriggers && typeof inputTriggers.insertReference === 'function'),
      })
      // 注册机：幂等、可重试。宿主服务可能晚于插件就绪（或 HMR 重载后旧注册仍在），
      // 一次性判定会让整页退化成"纯文本回退"，因此这里允许后续再次调用。
      let quoteSourceRegistered = false
      ensureQuoteSource = () => {
        if (quoteSourceRegistered) return true
        let triggers = inputTriggers
        if (!triggers) {
          try { triggers = ctx.get('inputTriggers') } catch (e) { triggers = undefined }
        }
        if (!triggers || typeof triggers.registerSource !== 'function') {
          pipelineAvailable = false
          return false
        }
        try {
          ctx.effect(() => triggers.registerSource({
            trigger: '@',
            name: 'quote-ref',
            order: 100,
            candidates: async () => [],
            onPick: () => undefined,
            codec: {
              clipboardText: (ref) => (refCodecs.get(ref) ? refCodecs.get(ref).clipboardText : ''),
              serialize: (ref) => Promise.resolve(refCodecs.get(ref) ? refCodecs.get(ref).body : ''),
            },
          }), 'dsh-quote-annotate-pro: quote-ref source')
          quoteSourceRegistered = true
          pipelineAvailable = true
          report('register:quote-ref-source', 'ok')
          return true
        } catch (e) {
          const msg = String((e && e.stack) || (e && e.message) || e)
          // 已注册（HMR 重载后宿主保留旧注册）不算失败：序列化仍会路由到当前模块的 codec
          if (/already|duplicate|exist|注册/i.test(msg)) {
            quoteSourceRegistered = true
            pipelineAvailable = true
            report('register:quote-ref-source', 'already')
            return true
          }
          pipelineAvailable = false
          report('register:quote-ref-source', 'throw ' + msg)
          return false
        }
      }
      if (!ensureQuoteSource()) {
        // 退避重试：最多 20 次、间隔 500ms（约 10s），把启动时序造成的退化救回来
        try {
          ctx.effect(() => {
            let tries = 0
            let timer = null
            const tick = () => {
              timer = null
              if (quoteSourceRegistered || tries >= 20) return
              tries += 1
              if (!ensureQuoteSource()) timer = setTimeout(tick, 500)
            }
            timer = setTimeout(tick, 500)
            report('register:quote-ref-source', 'retry-scheduled')
            return () => { if (timer !== null) clearTimeout(timer) }
          }, 'dsh-quote-annotate-pro: quote-ref retry')
        } catch (e) { /* ignore */ }
      }
      // 全局监听（选区气泡 / chip 点击跳转 / chip 悬停提示；ctx.effect 保证卸载时全部清理）
      try {
        ctx.effect(() => {
        let raf = 0
        let toastTimer = null
        let hideTimer = null
        const onKey = (e) => {
          if (e.key === 'Escape') {
            selectionStore.hide()
            toastStore.hide()
            tooltipStore.hide()
          }
        }
        const showToast = (text, pos, ok) => notify(text, pos, ok)
        const cancelHide = () => {
          if (hideTimer) {
            clearTimeout(hideTimer)
            hideTimer = null
          }
        }
        cancelSelectionHide = cancelHide
        const scheduleHide = () => {
          if (hideTimer) return
          hideTimer = setTimeout(() => {
            hideTimer = null
            // Excel 选区气泡由 Excel watcher 驱动：canvas 上永远没有 DOM 选区，
            // 不能被"选区消失"的延迟隐藏误关（否则点击单元格时气泡会闪现即消失）。
            if (selectionStore.mode === 'excel') return
            selectionStore.hide()
          }, 150)
        }
        const onScroll = () => {
          schedule()
          tooltipStore.hide()
        }
        // 用 pointerdown 捕获（比 click 更早，且不受 click 阶段任何 stopPropagation 影响）
        const onChipPress = (e) => {
          try {
            tooltipStore.hide()
            const pos = { left: e.clientX, top: e.clientY }
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            if (el) {
              const occId = Number(el.getAttribute('data-occurrence'))
              if (!Number.isFinite(occId)) return
              const found = resolveOccurrence(occId)
              if (!found) {
                notify('跳转失败：找不到该引用（可能已发送或被删除）', pos, false)
                return
              }
              report('chip:click', { via: 'occurrence', ref: String(found.occ.ref) })
              jumpToRef(found.occ.ref, pos)
              return
            }
            // 本版本输入框 chip 无 data-occurrence，但带 title=<label>：按 title 反查并跳转
            const titled = e.target && e.target.closest ? e.target.closest('[title]') : null
            if (!titled) return
            const title = titled.getAttribute('title')
            const ref = refByLabel(title)
            if (!ref) return
            report('chip:click', { via: 'title', ref: String(ref), title: String(title).slice(0, 40) })
            jumpToRef(ref, pos)
          } catch (err) {
            notify('跳转出错：' + (err && err.message ? err.message : String(err)), { left: e.clientX, top: e.clientY }, false)
            report('chip:click-throw', String((err && err.message) || err))
          }
        }
        // 悬停 chip：显示当时选中的文字
        const onChipOver = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            if (!el) {
              tooltipStore.hide()
              return
            }
            const occId = Number(el.getAttribute('data-occurrence'))
            if (!Number.isFinite(occId)) {
              tooltipStore.hide()
              return
            }
            const found = resolveOccurrence(occId)
            if (!found || !found.info || !found.info.body) {
              tooltipStore.hide()
              return
            }
            const r = el.getBoundingClientRect()
            tooltipStore.show({
              text: (found.info.body || '').replace(/^> /gm, '').trim(),
              label: found.info.label || '引用',
              rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            })
          } catch (err) { /* ignore */ }
        }
        const onChipOut = (e) => {
          try {
            const el = e.target && e.target.closest ? e.target.closest('[data-occurrence]') : null
            if (!el) return
            const next = e.relatedTarget
            if (next && next.closest && next.closest('[data-occurrence]')) return
            tooltipStore.hide()
          } catch (err) { /* ignore */ }
        }
        const compute = () => {
          raf = 0
          try {
            const sel = window.getSelection()
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
              // Excel 选区气泡由 Excel watcher 管：canvas 上永远没有 DOM 选区，不能在这里被误关
              if (selectionStore.mode === 'excel') return
              // 选区消失：延迟隐藏，避免流式渲染抖动导致气泡闪没
              scheduleHide()
              return
            }
            const text = (sel.toString() || '').trim()
            if (!text) {
              if (selectionStore.mode === 'excel') return
              scheduleHide()
              return
            }
            const range = sel.getRangeAt(0)
            const node = range.commonAncestorContainer
            const host = node && node.nodeType === 1 ? node : (node ? node.parentElement : null)
            const hostPreviewRoot = host && typeof findPreviewRoot === 'function' ? findPreviewRoot(host) : null
            if (host && !hostPreviewRoot && host.closest('textarea, input, [contenteditable="true"]')) {
              scheduleHide()
              return
            }
            const rect = range.getBoundingClientRect()
            if (!rect || (rect.width === 0 && rect.height === 0)) {
              scheduleHide()
              return
            }
            // 选区滚出视口（自动滚动场景）才隐藏；仍在视口内则跟随重定位
            const vh = typeof window !== 'undefined' ? window.innerHeight : 768
            if (rect.bottom < -8 || rect.top > vh + 8) {
              scheduleHide()
              return
            }
            cancelHide()
            const anchor = sel.anchorNode && sel.anchorNode.nodeType === 1 ? sel.anchorNode : (sel.anchorNode ? sel.anchorNode.parentElement : null)
            let anchorKey = null
            let turn
            let kind = null
            if (anchor) {
              const row = anchor.closest('[data-chat-anchor-key]')
              if (row) {
                anchorKey = row.getAttribute('data-chat-anchor-key')
                // 位置信息：轮次 + 该行种类（用于给模型标注"这是哪一处"）
                const rawTurn = row.getAttribute('data-chat-turn')
                if (rawTurn !== null && rawTurn !== '' && Number.isFinite(Number(rawTurn))) turn = Number(rawTurn)
                kind = row.getAttribute('data-chat-flow-kind') || null
              }
            }
            // 文档预览选区：没有消息行锚点，取文件路径（取不到就是 null，行为与旧版一致）
            const doc = !anchorKey && anchor ? docSourceOf(anchor) : null
            if (!anchorKey && !doc) {
              try {
                const side = anchor && anchor.closest ? anchor.closest('[data-slot*="sidebar.right"], [class*="sidebarRight"], aside') : null
                if (side) {
                  const markerCount = typeof PREVIEW_ROOT_MARKERS === 'string' ? side.querySelectorAll(PREVIEW_ROOT_MARKERS).length : 0
                  report('doc:src-miss', { markers: markerCount, slot: (side.getAttribute && side.getAttribute('data-slot')) || '', editable: !!(host && host.closest('[contenteditable="true"]')) })
                }
              } catch (e) { /* ignore */ }
            }
            report('selection:show', {
              chars: text.length,
              anchorKey,
              turn,
              kind,
              file: doc && doc.path ? fileNameOfPath(doc.path) : null,
              line: doc ? doc.line : null,
              page: doc ? doc.page : null,
            })
            selectionStore.show({
              text: clipText(text, MAX_SELECTION),
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              anchorKey,
              turn,
              kind,
              filePath: doc ? doc.path : null,
              line: doc ? doc.line : null,
              page: doc ? doc.page : null,
              mode: 'text',
            })
          } catch (e) {
            scheduleHide()
          }
        }
        const schedule = () => {
          if (!raf) raf = requestAnimationFrame(compute)
        }
        document.addEventListener('selectionchange', schedule)
        // 滚动/缩放不再盲目隐藏：重新计算选区位置，跟随重定位（执行任务自动滚动时气泡不消失）
        document.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onChipPress, true)
        document.addEventListener('pointerover', onChipOver, true)
        document.addEventListener('pointerout', onChipOut, true)
        return () => {
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onChipPress, true)
          document.removeEventListener('pointerover', onChipOver, true)
          document.removeEventListener('pointerout', onChipOut, true)
          if (raf) cancelAnimationFrame(raf)
          if (hideTimer) clearTimeout(hideTimer)
          cancelSelectionHide = null
          if (toastTimer) clearTimeout(toastTimer)
        }
        }, 'dsh-quote-annotate-pro: global listeners')
      } catch (e) {
        report('apply:listeners-throw', String((e && e.stack) || (e && e.message) || e))
      }

      // ============ Excel 预览选区 → 气泡 ============
      // Excel 的单元格画在 canvas 上，没有 DOM 文字选区；改读公式栏 Name Box 的地址，
      // 气泡贴着选区覆盖层。选中（点击/拖选/整行整列）后进入和 docx/pdf 一样的批注管线。
      try {
        ctx.effect(() => {
          let timer = 0
          let armed = false
          let lastKey = ''
          const isOwnUi = (target) => {
            try {
              return !!(target && target.closest &&
                target.closest('.dshq-toolbar, .dshq-editor, .dshq-doc-bar, .dshq-doc-bar-panel'))
            } catch (e) { return false }
          }
          const onDown = (e) => {
            try {
              if (isOwnUi(e.target)) return
              const active = activeExcelPreview()
              if (active && active.root && e.target instanceof Node && active.root.contains(e.target)) {
                armed = true
                lastKey = ''
                // 别等下一次 150ms 轮询：点击后立刻算一次，气泡不会"慢半拍"
                setTimeout(poll, 40)
                return
              }
              if (selectionStore.mode === 'excel') selectionStore.hide()
              armed = false
            } catch (err) { /* ignore */ }
          }
          const updateRect = (info) => {
            const old = selectionStore.rect
            if (!old) return false
            return Math.round(old.left) !== Math.round(info.rect.left) ||
              Math.round(old.top) !== Math.round(info.rect.top) ||
              Math.round(old.right) !== Math.round(info.rect.right) ||
              Math.round(old.bottom) !== Math.round(info.rect.bottom)
          }
          const poll = () => {
            try {
              const info = readExcelSelection()
              if (!info) {
                if (selectionStore.mode === 'excel') selectionStore.hide()
                lastKey = ''
                return
              }
              if (!armed) {
                // 只用键盘 / 直接点 Name Box 时没有 pointerdown：焦点在表格里也算"用户进来了"
                let focused = false
                try {
                  const el = document.activeElement
                  focused = !!(el && info.root && info.root.contains(el))
                } catch (e) { focused = false }
                if (!focused) return
              }
              const key = info.path + '|' + info.location + '|' + info.kind
              if (key === lastKey) {
                // 滚动/缩放：同一选区只跟随位置；已经手动关掉的气泡不自动重开
                if (selectionStore.visible && selectionStore.mode === 'excel' && updateRect(info)) {
                  selectionStore.show({
                    text: info.location,
                    rect: info.rect,
                    filePath: info.path,
                    excel: { sheet: info.sheet, ref: info.ref, kind: info.kind },
                    mode: 'excel',
                  })
                  try { if (cancelSelectionHide) cancelSelectionHide() } catch (e) { /* ignore */ }
                }
                return
              }
              lastKey = key
              selectionStore.show({
                text: info.location,
                rect: info.rect,
                filePath: info.path,
                excel: { sheet: info.sheet, ref: info.ref, kind: info.kind },
                mode: 'excel',
              })
              try { if (cancelSelectionHide) cancelSelectionHide() } catch (e) { /* ignore */ }
              report('excel:select', { file: fileNameOfPath(info.path), location: info.location, kind: info.kind })
            } catch (err) { /* ignore */ }
          }
          document.addEventListener('pointerdown', onDown, true)
          timer = setInterval(poll, EXCEL_POLL_MS)
          report('excel:watch-ready', {})
          return () => {
            document.removeEventListener('pointerdown', onDown, true)
            clearInterval(timer)
          }
        }, 'dsh-quote-annotate-pro: excel selection')
      } catch (e) {
        report('apply:excel-watch-throw', String((e && e.stack) || (e && e.message) || e))
      }

      // ============ 已发送消息里的引用：把「【引用 · 第N轮 · 角色】+ > 原文」变成紧凑块 ============
      // 目标（用户要求）：对话页面里不再显示"第几轮/谁说的"这类位置标签，只留一个紧凑的原文块；
      // 点击该块可跳回原文并高亮；**消息本体文本不变**，模型仍然拿得到完整的位置信息。
      try {
        ctx.effect(() => {
          let timer = null
          let observer = null
          const jumpByText = (text, pos) => {
            const probe = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24)
            if (probe === '') return
            for (const r of document.querySelectorAll('[data-chat-anchor-key]')) {
              const t = String(r.textContent || '').replace(/\s+/g, ' ')
              if (t.indexOf(probe) !== -1) {
                r.scrollIntoView({ block: 'center', behavior: 'smooth' })
                r.classList.add('dshq-flash')
                setTimeout(() => r.classList.remove('dshq-flash'), 1600)
                report('sent:jump', { anchorKey: r.getAttribute('data-chat-anchor-key') })
                return
              }
            }
            notify('跳转失败：原文不在当前页面', pos, false)
          }
          const buildBlock = (quoteText) => {
            const wrap = document.createElement('div')
            wrap.className = 'dshq-sent-quote'
            wrap.setAttribute('role', 'button')
            wrap.setAttribute('title', '点击跳回原文')
            const span = document.createElement('span')
            span.className = 'dshq-sent-quote-text'
            span.textContent = quoteText
            wrap.appendChild(span)
            wrap.addEventListener('click', (ev) => {
              const r = wrap.getBoundingClientRect()
              const pos = { left: r.left + 16, top: r.top }
              if (wrap.getAttribute('data-dshq-file') === '1') {
                const src = {
                  path: wrap.getAttribute('data-dshq-src-path') || '',
                  line: Number(wrap.getAttribute('data-dshq-src-line')) || null,
                  page: Number(wrap.getAttribute('data-dshq-src-page')) || null,
                }
                jumpToDocSource(src, pos)
              } else {
                jumpByText(quoteText, pos)
              }
              if (ev && ev.stopPropagation) ev.stopPropagation()
            })
            return wrap
          }
          /** 用户当前选区是否落在这个行里（是则暂缓装饰，别动 DOM 把选区搞失效） */
          const selectionTouches = (row) => {
            try {
              const s = typeof window !== 'undefined' ? window.getSelection() : null
              if (!s || s.rangeCount === 0 || s.isCollapsed) return false
              for (let i = 0; i < s.rangeCount; i++) {
                const r = s.getRangeAt(i)
                const a = r.startContainer
                const b = r.endContainer
                if ((a && row.contains(a)) || (b && row.contains(b))) return true
              }
            } catch (e) { /* ignore */ }
            return false
          }
          /** 把承载「位置行 + 原文（+ 批注：…）」的文本节点拆成：隐藏头部 + 紧凑引用块 + 其余文本 */
          const transformTextNode = (node) => {
            const raw = node.nodeValue || ''
            const parsed = parseQuoteBlock(raw)
            if (!parsed) {
              // 清空输入框时残留的孤立「批注：…」行：发送后也别显示
              const t = raw.trim()
              if (t !== '' && /^批注[:：]/.test(t)) {
                const hidden = document.createElement('span')
                hidden.className = 'dshq-sent-header'
                hidden.textContent = raw
                node.parentNode.replaceChild(hidden, node)
                return true
              }
              return false
            }
            const frag = document.createDocumentFragment()
            if (parsed.before !== '') frag.appendChild(document.createTextNode(parsed.before))
            const hidden = document.createElement('span')
            hidden.className = 'dshq-sent-header'
            hidden.textContent = parsed.header   // 位置信息仍留在 DOM（只是不显示）
            frag.appendChild(hidden)
            const block = buildBlock(parsed.quote)
            // 回复侧「Annotation N」芯片靠这几项 dataset 对上号；
            // 位置行里的编号万一被弄丢了，就按"这条消息里的第几块引用"补一个顺序号，芯片不至于没号
            let no = parsed.no
            if (no === null) {
              try {
                const row = node.parentNode && node.parentNode.closest ? node.parentNode.closest('[data-chat-flow-kind]') : null
                no = (row ? row.querySelectorAll('.dshq-sent-quote').length : 0) + 1
              } catch (e) { no = null }
            }
            if (no !== null) block.setAttribute('data-dshq-no', String(no))
            // 文档预览批注没有聊天锚点，点和回复芯片都不该去找消息行
            if (parsed.header.indexOf(' · 文件 · ') !== -1) {
              block.setAttribute('data-dshq-file', '1')
              const fname = docFileNameOfHeader(parsed.header)
              if (fname) block.setAttribute('data-dshq-file-name', fname)
              // 点它 → 打开来源文件并定位到行/页
              const src = parseDocSourceHeader(parsed.header)
              if (src.path) block.setAttribute('data-dshq-src-path', src.path)
              if (src.line !== null) block.setAttribute('data-dshq-src-line', String(src.line))
              if (src.page !== null) block.setAttribute('data-dshq-src-page', String(src.page))
              block.setAttribute('title', '点击打开来源文件')
            }
            block.setAttribute('data-dshq-quote', parsed.quote)
            if (parsed.comment !== '') block.setAttribute('data-dshq-comment', parsed.comment)
            frag.appendChild(block)
            if (parsed.rest.trim() !== '') frag.appendChild(document.createTextNode(parsed.rest))
            node.parentNode.replaceChild(frag, node)
            report('sent:decorated', { chars: parsed.quote.length, no: no })
            return true
          }
          // ---- 回复侧「Annotation N：」→ 批注芯片（悬浮显示原文+评语，点击跳回原文） ----
          const ANNO_TOKEN_RE = /Annotation\s*(\d+)\s*[:：]/g
          /** 取"离这条回复最近的那条用户消息"里的批注数据（编号 → 原文/评语） */
          const annotationMapBefore = (row) => {
            const map = new Map()
            try {
              const all = document.querySelectorAll('[data-chat-flow-kind]')
              const idx = Array.prototype.indexOf.call(all, row)
              for (let i = idx - 1; i >= 0; i--) {
                const r = all[i]
                if (r.getAttribute('data-chat-flow-kind') !== 'user') continue
                const blocks = r.querySelectorAll('.dshq-sent-quote[data-dshq-no]')
                for (const b of blocks) {
                  const no = Number(b.getAttribute('data-dshq-no'))
                  if (!Number.isFinite(no)) continue
                  map.set(no, {
                    quote: b.getAttribute('data-dshq-quote') || '',
                    comment: b.getAttribute('data-dshq-comment') || '',
                  })
                }
                break
              }
            } catch (e) { /* ignore */ }
            return map
          }
          const buildAnnoChip = (no, ann) => {
            const chip = document.createElement('span')
            chip.className = 'dshq-anno-chip'
            chip.setAttribute('role', 'button')
            chip.setAttribute('tabindex', '0')
            chip.textContent = '批注 ' + no
            chip.title = ann.comment !== '' ? '批注 ' + no + '：' + ann.comment : '批注 ' + no
            chip.addEventListener('click', (ev) => {
              const r = chip.getBoundingClientRect()
              jumpByText(ann.quote, { left: r.left + 16, top: r.top })
              if (ev && ev.stopPropagation) ev.stopPropagation()
            })
            chip.addEventListener('mouseenter', () => {
              const r = chip.getBoundingClientRect()
              const text = '原文：' + ann.quote + (ann.comment !== '' ? '\n\n批注：' + ann.comment : '')
              tooltipStore.show({ text, label: '批注 ' + no, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
            })
            chip.addEventListener('mouseleave', () => { tooltipStore.hide() })
            return chip
          }
          /** 把一个文本节点里的「Annotation N：」替换成芯片（同一节点可能有多处） */
          const transformReplyNode = (node, map) => {
            const raw = node.nodeValue || ''
            if (raw.indexOf('Annotation') < 0) return false
            ANNO_TOKEN_RE.lastIndex = 0
            const parts = []
            let last = 0
            let m
            let any = false
            while ((m = ANNO_TOKEN_RE.exec(raw)) !== null) {
              const no = Number(m[1])
              const ann = map.get(no)
              if (!ann || ann.quote === '') continue
              parts.push(raw.slice(last, m.index))
              parts.push(buildAnnoChip(no, ann))
              last = m.index + m[0].length
              any = true
            }
            if (!any) return false
            parts.push(raw.slice(last))
            const frag = document.createDocumentFragment()
            for (const p of parts) {
              if (typeof p === 'string') { if (p !== '') frag.appendChild(document.createTextNode(p)) }
              else frag.appendChild(p)
            }
            node.parentNode.replaceChild(frag, node)
            return true
          }
          const decorateReplies = () => {
            try {
              for (const row of document.querySelectorAll('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="assistant"]')) {
                if (row.dataset && row.dataset.dshqAnnoDone === '1') continue
                // 流式输出中不动 DOM（还没定稿）
                if (row.hasAttribute('data-streaming') || row.querySelector('[data-streaming]')) continue
                if (selectionTouches(row)) continue
                const map = annotationMapBefore(row)
                if (map.size === 0) { if (row.dataset) row.dataset.dshqAnnoDone = '1'; continue }
                let walker
                try { walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null) } catch (e) { continue }
                const targets = []
                let n = walker.nextNode()
                while (n) {
                  const parent = n.parentElement
                  const managed = parent && typeof parent.closest === 'function'
                    ? parent.closest('.dshq-anno-chip') : null
                  if (!managed && (n.nodeValue || '').indexOf('Annotation') >= 0) targets.push(n)
                  n = walker.nextNode()
                }
                let done = false
                for (const t of targets) { try { if (transformReplyNode(t, map)) done = true } catch (e) { /* ignore */ } }
                if (row.dataset) row.dataset.dshqAnnoDone = '1'
                if (done) report('reply:chips', { row: String(row.getAttribute('data-chat-anchor-key') || '').slice(0, 12) })
              }
            } catch (e) { report('reply:scan-throw', String((e && e.message) || e)) }
          }
          const scan = () => {
            timer = null
            try {              for (const row of document.querySelectorAll(USER_ROW_SEL)) {
                const kind = row.getAttribute('data-chat-flow-kind')
                if (kind && kind !== 'user') continue
                // 用户正在这条消息里划词时**不要动它的 DOM**：替换文本节点会让选区失效，
                // 选区矩形随即变成全 0，批注气泡/编辑框就会定位到左上角（用户反馈过）。
                if (selectionTouches(row)) continue
                let walker
                try { walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null) } catch (e) { continue }
                const targets = []
                let n = walker.nextNode()
                while (n) {
                  const parent = n.parentElement
                  // 已经装饰过的部分（隐藏的位置行 / 紧凑引用块）不再重复处理
                  const managed = parent && typeof parent.closest === 'function'
                    ? parent.closest('.dshq-sent-header, .dshq-sent-quote') : null
                  if (!managed && QUOTE_HEADER_RE.test(n.nodeValue || '')) targets.push(n)
                  n = walker.nextNode()
                }
                if (targets.length === 0) continue
                let done = false
                for (const t of targets) { try { if (transformTextNode(t)) done = true } catch (e) { /* ignore */ } }
                if (done && row.dataset) row.dataset.dshqSent = '1'
              }
              decorateReplies()
            } catch (e) { report('sent:scan-throw', String((e && e.message) || e)) }
          }
          const schedule = () => { if (timer === null) timer = setTimeout(scan, 300) }
          // 消息从输入框进入对话区时，首帧先画出的是原始文本（含"【引用 · …】"位置行），
          // 300ms 防抖会让它闪一下。MutationObserver 回调在下一次绘制前执行，
          // 因此只要这次变动牵扯到"还没装饰过的用户消息行"就同步扫一次，首帧即完成隐藏；
          // 其余情况（例如助手流式输出）仍走防抖，不增加扫描开销。
          // 用户消息行有两副面孔：正式行带 anchor 属性；但实测"刚发出去"的那一下，
          // 宿主先渲染出 <div class="cJsG2q_userRow">（还没有 data-chat-anchor-key），
          // 等属性挂上才轮得到插件 —— 那段空窗就是用户看到的闪。两类都按用户行处理。
          const USER_ROW_SEL = '[data-chat-anchor-key][data-chat-flow-kind="user"], [class*="userRow" i]'
          const asElement = (node) => (node && node.nodeType === 1 ? node : (node && node.parentElement) || null)
          // 行里是否还存在"没被插件接管过的"位置行文本。
          // 宿主会在渲染后重排/替换气泡内容（实测发送后约 120ms 会有一次），
          // 那时我们贴好的隐藏 span 会被换回原始文本 —— 用内容判断而不是用标记判断，
          // 才能在重渲染的同一帧里立刻补装饰。
          const rowHasRawHeader = (row) => {
            try {
              const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null)
              let n = walker.nextNode()
              while (n) {
                const parent = n.parentElement
                const managed = parent && typeof parent.closest === 'function'
                  ? parent.closest('.dshq-sent-header, .dshq-sent-quote') : null
                if (!managed && QUOTE_HEADER_RE.test(n.nodeValue || '')) return true
                n = walker.nextNode()
              }
              return false
            } catch (e) { return false }
          }
          const touchesPendingUserRow = (node) => {
            const el = asElement(node)
            if (!el || typeof el.closest !== 'function') return false
            const row = el.closest(USER_ROW_SEL)
            // ① 变动落在用户消息行内部（含行自身）：只要还能找到未接管的位置行就立刻扫
            if (row) {
              const kind = row.getAttribute('data-chat-flow-kind')
              if (kind && kind !== 'user') return false
              return rowHasRawHeader(row)
            }
            // ② 新增的子树里带着这样的用户消息行（宿主可能整块替换容器）
            if (typeof el.querySelector === 'function') {
              try {
                for (const r of el.querySelectorAll(USER_ROW_SEL)) {
                  const kind = r.getAttribute('data-chat-flow-kind')
                  if (kind && kind !== 'user') continue
                  if (rowHasRawHeader(r)) return true
                }
              } catch (e) { /* ignore */ }
            }
            return false
          }
          const onMutations = (records) => {
            let urgent = false
            try {
              for (const r of records) {
                const cands = [r.target]
                const added = r.addedNodes
                if (added) { for (const n of added) cands.push(n) }
                for (const c of cands) {
                  if (!urgent && touchesPendingUserRow(c)) urgent = true
                }
              }
              if (urgent) scan()
            } catch (e) { /* ignore */ }
            schedule()
          }
          scan()
          try {
            observer = new MutationObserver(onMutations)
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
              attributes: true,
              attributeFilter: ['data-chat-anchor-key', 'data-chat-flow-kind'],
            })
          } catch (e) { report('sent:observer-throw', String((e && e.message) || e)) }
          return () => {
            if (timer !== null) clearTimeout(timer)
            if (observer) { try { observer.disconnect() } catch (e) { /* ignore */ } }
          }
        }, 'dsh-quote-annotate-pro: sent quote decoration')
      } catch (e) {
        report('apply:sent-decor-throw', String((e && e.message) || e))
      }

      // ============ 输入框里的引用：隐藏位置行 + 紧凑块（与消息里的渲染保持一致） ============
      // 只给编辑器的行元素加 class，**不改动编辑器文本** → 发送出去的内容不变（模型仍拿到位置信息）。
      // 编辑器重渲染会丢掉 class，因此用 MutationObserver 重新贴上。
      try {
        ctx.effect(() => {
          let observer = null
          // 位置行：`【引用 · 第N轮 · DSH 回复】` 或 `【批注 N · 第N轮 · DSH 回复（…）】`
          const HEADER_RE = /^【(?:引用|批注)[^\n]*】$/
          // 评语行：`批注：…`（紧跟引用块，空行分隔）
          const COMMENT_RE = /^批注[:：]/
          const isBlockEl = (el) => !!el && el.nodeType === 1 && /^(DIV|P|LI)$/.test(el.tagName)
          /**
           * 编辑器根下的"行元素"：通常是 <div>/<p>；个别宿主会再包一层容器。
           * 逐层向下展开"含块级子元素"的容器（最多 4 层），叶子层就是真正的行。
           * （早期版本只在"单容器且子元素 >1"时展开一层，单行草稿时会把整个容器当成一行处理）
           */
          const lineElements = (ed) => {
            let cur = [ed]
            for (let depth = 0; depth < 4; depth++) {
              const next = []
              let descended = false
              for (const el of cur) {
                const blocks = Array.from(el.children || []).filter(isBlockEl)
                if (blocks.length > 0) { descended = true; for (const b of blocks) next.push(b) } else next.push(el)
              }
              if (!descended) return cur
              cur = next
            }
            return cur
          }
          // 光标所在行：装饰时不能把光标那行藏起来，否则用户打字"看不见字"
          const caretLineOf = (ed, lines) => {
            try {
              const sel = window.getSelection()
              if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null
              let el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement
              while (el && el !== ed) {
                if (lines.indexOf(el) !== -1) return el
                el = el.parentElement
              }
            } catch (e) { /* ignore */ }
            return null
          }
          /**
           * 把输入框里的正文"装饰"成紧凑块：
           * - 位置行 → `.dshq-cmp-header`（display:none，界面上看不到，但文本仍然在 → 发送后模型拿得到）
           * - 位置行后面紧跟的引用正文行 → `.dshq-cmp-quote`（浅色块；首行/末行分别圆角）
           * 一条消息里可以有多条批注，所以这里按"状态机"逐行扫描，遇到空行即结束当前块，
           * 然后继续扫后面的块（早期版本遇到第一个空行就 break，导致第二条批注不再装饰）。
           *
           * 关键：**完整对账**（既加类、也删类）。Lexical 会复用行 DOM，删掉位置行文字后新打的字
           * 若落回同一个行元素，残留的 `.dshq-cmp-header` 会让新文字看不见（用户反馈"输入框无法显示字"）。
           */
          // 装饰阶段发现"位置行丢了编号"时，用它排一次自愈（在 healHeaderNow 定义之后赋值）
          let scheduleHealOnCorrupt = null
          const decorate = () => {
            const cancelItems = []
            try {
              for (const ed of document.querySelectorAll('[contenteditable="true"]')) {
                const lines = lineElements(ed)
                const headerSet = new Set()
                const commentSet = new Set()
                const orphanSet = new Set()
                const fragSet = new Set()
                const quoteMap = new Map()
                const groups = []
                let block = null
                let awaitComment = false
                let lastGroup = null
                let lastHeaderText = ''
                const endBlock = (allowComment) => {
                  const had = !!(block && block.length > 0)
                  if (had) {
                    // 圆角与左边框要覆盖整块（含末尾由回车留下的空行），否则边框会在
                    // 最后一个非空行处断开，多行批注看起来"没闭合"。空行本身很矮，
                    // 交给 CSS 的 :empty 收缩高度即可。
                    block.forEach((el, i) => quoteMap.set(el, { first: i === 0, last: i === block.length - 1 }))
                    lastGroup = {
                      first: block[0],
                      els: block.slice(),
                      header: lastHeaderText,
                      quote: String(block[0].textContent || '').trim(),
                      commentEl: null,
                    }
                    groups.push(lastGroup)
                  }
                  block = null
                  awaitComment = allowComment ? had : false
                }
                for (const el of lines) {
                  const t = String(el.textContent || '').trim()
                  const single = t !== '' && t.indexOf('\n') === -1
                  if (single && HEADER_RE.test(t)) {
                    endBlock(false)
                    headerSet.add(el)
                    lastHeaderText = t
                    block = []
                    continue
                  }
                  if (single && COMMENT_RE.test(t)) {
                    // 「批注：…」只有在紧跟引用块（隔着空行）时才是这条批注的评语；
                    // 否则是删掉引用块后留下的孤儿行 —— 界面上藏起来，避免残留"空壳"
                    // 注意：必须先把当前正文块收尾（endBlock），否则 quoteMap/groups 里
                    // 没有这一块 → 输入框里不显示引用块、右侧 ✕ 也不出现。
                    if (awaitComment) {
                      endBlock(false)
                      commentSet.add(el)
                      awaitComment = false
                      if (lastGroup && !lastGroup.commentEl) lastGroup.commentEl = el
                    } else { orphanSet.add(el) }
                    block = null
                    continue
                  }
                  if (!block) {
                    if (single) {
                      awaitComment = false
                      // 删了一半的位置行（`引用 · 第14轮`、`（请按「Annotation…`）：藏掉
                      if (looksLikeQuoteFragment(t)) fragSet.add(el)
                    }
                    continue
                  }
                  // 引用正文里允许空行：多段划词选中的原文本身就带空行，
                  // 遇到空行就收块会把后面的段落漏成普通正文（多行批注样式失效）。
                  // 只有「批注：」评语行 / 下一个位置行才是真正的块边界（上面已处理）。
                  // 空行同时是"正文结束、可能接评语"的信号（awaitComment）。
                  if (t === '') awaitComment = true
                  block.push(el)
                }
                endBlock(false)
                // 兜底：如果整段内容都是位置行（用户把正文删光了），并且光标就在里面，
                // 不隐藏任何行 —— 否则输入框看起来是空的，用户会以为"打不出字"。
                try {
                  const focused = ed === document.activeElement || ed.contains(document.activeElement)
                  if (focused && lines.length > 0 && headerSet.size === lines.length) headerSet.clear()
                } catch (e) { /* ignore */ }
                const caret = caretLineOf(ed, lines)
                let changed = 0
                for (const el of lines) {
                  const cls = el.classList
                  const isHeader = headerSet.has(el)
                  const isActive = isHeader && el === caret
                  if (isHeader && !isActive) {
                    if (!cls.contains('dshq-cmp-header')) { cls.add('dshq-cmp-header'); changed++ }
                  } else if (cls.contains('dshq-cmp-header')) { cls.remove('dshq-cmp-header'); changed++ }
                  if (isActive) {
                    if (!cls.contains('dshq-cmp-header-active')) { cls.add('dshq-cmp-header-active'); changed++ }
                  } else if (cls.contains('dshq-cmp-header-active')) { cls.remove('dshq-cmp-header-active'); changed++ }
                  // 评语行：跟引用块连成一体（浅色块的下半段）
                  if (commentSet.has(el)) {
                    if (!cls.contains('dshq-cmp-comment')) changed++
                    cls.add('dshq-cmp-comment')
                  } else if (cls.contains('dshq-cmp-comment')) { cls.remove('dshq-cmp-comment'); changed++ }
                  // 孤儿「批注：…」行：引用块已被删掉，界面上藏起来（光标进去时临时显示，便于删除）
                  if (orphanSet.has(el) && el !== caret) {
                    if (!cls.contains('dshq-cmp-orphan')) { cls.add('dshq-cmp-orphan'); changed++ }
                  } else if (cls.contains('dshq-cmp-orphan')) { cls.remove('dshq-cmp-orphan'); changed++ }
                  // 位置行/评语的删除残片（`引用 · 第14轮`、`（请按「Annotation…`）：藏起来
                  if (fragSet.has(el) && el !== caret) {
                    if (!cls.contains('dshq-cmp-frag')) { cls.add('dshq-cmp-frag'); changed++ }
                  } else if (cls.contains('dshq-cmp-frag')) { cls.remove('dshq-cmp-frag'); changed++ }
                  if (cls.contains('dshq-cmp-frag-active')) { cls.remove('dshq-cmp-frag-active'); changed++ }
                  const q = quoteMap.get(el)
                  if (q) {
                    if (!cls.contains('dshq-cmp-quote')) changed++
                    cls.add('dshq-cmp-quote')
                    cls.toggle('dshq-cmp-quote-first', q.first)
                    cls.toggle('dshq-cmp-quote-last', q.last)
                    // 块内空行（多段原文之间的空行）：显式打标记，交给 CSS 压扁高度。
                    // 不用 :empty —— 真实 Lexical 的空行里通常挂着 <br>，:empty 匹配不到。
                    cls.toggle('dshq-cmp-quote-blank', String(el.textContent || '').trim() === '')
                  } else if (cls.contains('dshq-cmp-quote')) {
                    cls.remove('dshq-cmp-quote')
                    cls.remove('dshq-cmp-quote-first')
                    cls.remove('dshq-cmp-quote-last')
                    cls.remove('dshq-cmp-quote-blank')
                    changed++
                  }
                }
                // 每块引用首行前面画一个可见编号（用户反馈：输入框里看不出哪块是 1、哪块是 2）
                // 用 CSS ::before + attr() 画，编号不进入正文、删不掉也编辑不到
                groups.forEach((g, idx) => {
                  if (!g || !g.first || !g.first.isConnected) return
                  const no = annotationNoOf(g.header) || (idx + 1)
                  try {
                    if (g.first.getAttribute('data-dshq-no') !== String(no)) {
                      g.first.setAttribute('data-dshq-no', String(no))
                      changed++
                    }
                    // 文档来源：块首行上方显示「📄 文件名」，让用户看得出这条来自哪个文件
                    const fileName = docFileNameOfHeader(g.header)
                    const cur = g.first.getAttribute('data-dshq-file-name') || ''
                    if (fileName) {
                      if (cur !== fileName) { g.first.setAttribute('data-dshq-file-name', fileName); changed++ }
                      if (!g.first.classList.contains('dshq-cmp-file')) { g.first.classList.add('dshq-cmp-file'); changed++ }
                      // 供点击跳回来源文件用：块内每一行都带上 路径 + 行号/页码
                      const src = parseDocSourceHeader(g.header)
                      const lineEls = Array.isArray(g.els) && g.els.length > 0 ? g.els : [g.first]
                      for (const lineEl of lineEls) {
                        if (!lineEl) continue
                        if (lineEl.getAttribute('data-dshq-src-path') !== src.path) {
                          lineEl.setAttribute('data-dshq-src-path', src.path)
                          changed++
                        }
                        lineEl.setAttribute('data-dshq-src-line', src.line === null ? '' : String(src.line))
                        lineEl.setAttribute('data-dshq-src-page', src.page === null ? '' : String(src.page))
                      }
                    } else if (cur !== '' || g.first.classList.contains('dshq-cmp-file')) {
                      const lineEls = Array.isArray(g.els) && g.els.length > 0 ? g.els : [g.first]
                      for (const lineEl of lineEls) {
                        if (!lineEl) continue
                        lineEl.removeAttribute('data-dshq-file-name')
                        lineEl.removeAttribute('data-dshq-src-path')
                        lineEl.removeAttribute('data-dshq-src-line')
                        lineEl.removeAttribute('data-dshq-src-page')
                        lineEl.classList.remove('dshq-cmp-file')
                      }
                      changed++
                    }
                  } catch (e) { /* ignore */ }
                })
                if (changed > 0) report('cmp:decorated', { changed })
                // 记下这一轮看到的位置行（正常块才记），用于"位置行被退格吃掉"时的自愈
                for (const g of groups) {
                  const q = normForMatch(g.quote)
                  if (q !== '' && g.header && /^【(?:引用|批注)\s*\d+/.test(g.header)) headerByQuote.set(q, g.header)
                }
                if (headerByQuote.size > 40) {
                  const drop = headerByQuote.size - 40
                  let i = 0
                  for (const k of headerByQuote.keys()) { if (i >= drop) break; headerByQuote.delete(k); i += 1 }
                }
                // 位置行丢了编号（`【批注 · 第3轮】`）：不用等用户再打字，装饰一看到就排一次自愈
                try {
                  let corrupt = false
                  for (const g of groups) {
                    if (g.header && g.header.indexOf('【') === 0 && !/^【(?:引用|批注)\s*\d+/.test(g.header)) { corrupt = true; break }
                  }
                  if (corrupt && typeof scheduleHealOnCorrupt === 'function') scheduleHealOnCorrupt()
                } catch (e) { /* ignore */ }
                // 每块引用右侧的 ✕：按块首行位置画浮层按钮（不写进编辑器 DOM，删不掉也删不到）
                let edRect = null
                try { edRect = ed.getBoundingClientRect() } catch (e) { /* ignore */ }
                for (const g of groups) {
                  const firstEl = g.first
                  if (!firstEl || !firstEl.isConnected || g.quote === '') continue
                  const r = firstEl.getBoundingClientRect()
                  if (!r || r.width === 0) continue
                  const right = edRect ? Math.min(edRect.right, r.right) : r.right
                  let bodyText = g.quote
                  try {
                    bodyText = (g.els || []).map((el) => String(el.textContent || '').trim()).filter((v) => v !== '').join('\n') || g.quote
                  } catch (e) { bodyText = g.quote }
                  cancelItems.push({
                    key: g.quote.slice(0, 40) + '|' + Math.round(r.top),
                    quote: bodyText,
                    comment: g.commentEl ? String(g.commentEl.textContent || '').replace(/^批注[:：]\s*/, '').trim() : '',
                    left: Math.max(8, Math.round(right - 30)),
                    top: Math.round(r.top + 4),
                  })
                }
              }
              blockActionsStore.set(cancelItems)
            } catch (e) { report('cmp:scan-throw', String((e && e.message) || e)) }
          }
          // ---- 位置行保护：退格/删除不能吃掉位置行（整块取消只走右侧 ✕） ----
          const lineIndexOf = (lines, node) => {
            try {
              let el = node && node.nodeType === 3 ? node.parentElement : node
              while (el && lines.indexOf(el) === -1) el = el.parentElement
              return el ? lines.indexOf(el) : -1
            } catch (e) { return -1 }
          }
          const headerLinesOf = (lines) => {
            const set = new Set()
            for (const el of lines) {
              const t = String(el.textContent || '').trim()
              if (t !== '' && t.indexOf('\n') === -1 && HEADER_RE.test(t)) set.add(el)
            }
            return set
          }
          const showGuardHint = (range) => {
            const now = Date.now()
            if (now - lastGuardHintAt <= 1800) return
            lastGuardHintAt = now
            try {
              const r = range && range.getBoundingClientRect ? range.getBoundingClientRect() : null
              toastStore.show('位置行/「批注：」前缀不能删：整块取消请点右侧 ✕', {
                left: (r && r.left) || 240,
                top: Math.max(8, ((r && r.top) || 200) - 34),
              }, false)
            } catch (e) { /* ignore */ }
          }
          /** 光标/选区是否落在位置行里 —— 位置行是给模型看的协议行，界面上不可编辑 */
          const caretInHeader = () => {
            try {
              const ed = document.activeElement
              const root = ed && ed.closest ? ed.closest('[contenteditable="true"]') : null
              if (!root) return false
              const lines = lineElements(root)
              const headers = headerLinesOf(lines)
              if (headers.size === 0) return false
              const sel = window.getSelection()
              if (!sel || sel.rangeCount === 0) return false
              const range = sel.getRangeAt(0)
              const si = lineIndexOf(lines, range.startContainer)
              const ei = lineIndexOf(lines, range.endContainer)
              if (si < 0) return false
              if (headers.has(lines[si])) return true
              if (ei >= 0 && ei !== si && headers.has(lines[ei])) return true
              return false
            } catch (e) { return false }
          }
          const guardStructuralDelete = (backward) => {
            try {
              const ed = document.activeElement
              const root = ed && ed.closest ? ed.closest('[contenteditable="true"]') : null
              if (!root) return false
              const lines = lineElements(root)
              const headers = headerLinesOf(lines)
              if (headers.size === 0) return false
              const sel = window.getSelection()
              if (!sel || sel.rangeCount === 0) return false
              const range = sel.getRangeAt(0)
              const si = lineIndexOf(lines, range.startContainer)
              const ei = lineIndexOf(lines, range.endContainer)
              const lineText = (idx) => (idx >= 0 ? String(lines[idx].textContent || '') : '')
              const isCommentLine = (idx) => idx >= 0 && COMMENT_RE.test(lineText(idx).trim())
              // 评语行的「批注：」前缀不可删：后面评语正文随便改，前缀归结构
              const commentPrefixLen = (idx) => {
                const m = /^批注\s*[:：]/.exec(lineText(idx))
                return m ? m[0].length : 0
              }
              const neighbourNonEmpty = (from, step) => {
                for (let k = from; k >= 0 && k < lines.length; k += step) {
                  if (String(lines[k].textContent || '').trim() !== '') return k
                }
                return -1
              }
              let hit = false
              if (!range.collapsed && si >= 0 && ei >= 0) {
                // 选中范围里只要碰到位置行，就整体拦下（想整块取消请点 ✕）
                for (let i = Math.min(si, ei); i <= Math.max(si, ei); i++) {
                  if (headers.has(lines[i])) { hit = true; break }
                }
                // 选区把「批注：」前缀也框进去了同样拦下
                if (!hit && si === ei && range.startOffset < commentPrefixLen(si)) hit = true
                if (!hit && si !== ei && range.startOffset < commentPrefixLen(si)) hit = true
              } else if (si >= 0) {
                const line = lines[si]
                const text = String(line.textContent || '')
                const off = backward ? range.startOffset : range.endOffset
                const prefixLen = commentPrefixLen(si)
                if (headers.has(line)) {
                  hit = true // 位置行整行只读：任意位置的删除都拦
                } else if (backward && off <= prefixLen && prefixLen > 0) {
                  hit = true // 退格吃到了「批注：」前缀
                } else if (!backward && off < prefixLen && prefixLen > 0) {
                  hit = true // 删除键吃到了「批注：」前缀
                } else if (backward && off === 0) {
                  // 光标在行首：退格要么吃掉本行（位置行），要么把上一段并进来（块首行/评语）
                  if (headers.has(line)) hit = true
                  else {
                    const prev = neighbourNonEmpty(si - 1, -1)
                    if (prev >= 0 && (headers.has(lines[prev]) || isCommentLine(prev))) hit = true
                    if (prev >= 0 && isCommentLine(si)) hit = true // 评语行不被并进原文
                  }
                } else if (!backward && off >= text.length) {
                  // 光标在行尾：删除键要么吃掉本行（位置行/评语），要么把下一段并进来
                  if (headers.has(line) || isCommentLine(si)) hit = true
                  else {
                    const next = neighbourNonEmpty(si + 1, 1)
                    if (next >= 0 && (headers.has(lines[next]) || isCommentLine(next))) hit = true
                  }
                }
              }
              if (!hit) return false
              showGuardHint(range)
              return true
            } catch (e) { return false }
          }
          const onKeyDownGuard = (ev) => {
            try {
              if (!ev) return
              const tgt = ev.target
              if (!tgt || !tgt.closest || !tgt.closest('[contenteditable="true"]')) return
              if (ev.key === 'Backspace' || ev.key === 'Delete') {
                if (ev.ctrlKey || ev.metaKey || ev.altKey) return
                if (guardStructuralDelete(ev.key === 'Backspace')) {
                  ev.preventDefault()
                  ev.stopPropagation()
                }
                return
              }
              // 位置行只读：在位置行里打字 / 回车 / 删字符，都会让编号被悄悄改掉（用户反馈"编号消失了"）
              if (ev.ctrlKey || ev.metaKey || ev.altKey) return
              if (caretInHeader()) {
                ev.preventDefault()
                ev.stopPropagation()
                showGuardHint(window.getSelection() && window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null)
              }
            } catch (e) { /* ignore */ }
          }
          // 第二道网：beforeinput 比 keydown 覆盖更全（鼠标剪切、输入法、触屏删除都走这里）
          const onBeforeInputGuard = (ev) => {
            try {
              if (!ev) return
              const tgt = ev.target
              if (!tgt || !tgt.closest || !tgt.closest('[contenteditable="true"]')) return
              const it = String(ev.inputType || '')
              if (it === 'insertCompositionText' || it === 'insertFromComposition') return
              if (it.indexOf('delete') === 0) {
                const backward = /Backward$/.test(it)
                if (guardStructuralDelete(backward)) {
                  ev.preventDefault()
                  ev.stopPropagation()
                }
                return
              }
              if (it.indexOf('insert') !== 0) return
              if (ev.ctrlKey || ev.metaKey || ev.altKey) return
              if (caretInHeader()) {
                ev.preventDefault()
                ev.stopPropagation()
                showGuardHint(window.getSelection() && window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null)
              }
            } catch (e) { /* ignore */ }
          }
          // ---- 位置行自愈：万一位置行还是被删掉了（剪切/撤销/输入法），补回来 ----
          let healTimer = null
          const healHeaderNow = () => {
            try {
              const conversation = rootCtx ? rootCtx.get('conversation') : undefined
              const sessions = rootCtx ? rootCtx.get('sessions') : undefined
              if (!conversation || !conversation.input || !sessions) return
              const sessionId = resolveSessionId()
              if (!sessionId) return
              const binding = sessions.binding(sessionId)
              if (!binding) return
              const input = conversation.input.for(binding.ctx)
              const draftNow = String(input.state.getSnapshot().draft || '')
              if (draftNow === '') return
              const normDraft = normForMatch(draftNow)
              let text = draftNow
              let changed = false
              // ① 残片行自动清掉：位置行被删剩 `批注`、`引用 · 第3轮` 这类碎字，
              //    与其藏起来（光标进去还会露出来），直接在草稿里删掉，输入框永远不留渣
              try {
                const keptLines = []
                for (const ln of text.split('\n')) {
                  const t = ln.trim()
                  if (t === '' || HEADER_LINE_RE.test(t) || /^批注\s*[:：]/.test(t)) {
                    keptLines.push(ln)
                    continue
                  }
                  if (looksLikeQuoteFragment(t)) { changed = true; continue }
                  keptLines.push(ln)
                }
                if (changed) text = keptLines.join('\n')
              } catch (e) { /* ignore */ }
              // ② 位置行补回：万一还是被剪切/撤销/输入法弄丢了
              for (const [q, header] of headerByQuote) {
                if (q === '' || normDraft.indexOf(q) === -1) continue
                const lines = text.split('\n')
                let at = -1
                for (let i = 0; i < lines.length; i++) {
                  const t = normForMatch(lines[i])
                  if (t === q || t.indexOf(q) === 0) { at = i; break }
                }
                if (at < 0) continue
                // 上一行已经是位置行 → 没丢（可能只是重编号了），不补
                let above = -1
                for (let k = at - 1; k >= 0; k--) {
                  if (normForMatch(lines[k]) !== '') { above = k; break }
                }
                if (above >= 0) {
                  const aboveText = lines[above].trim()
                  if (HEADER_LINE_RE.test(aboveText) && /^【(?:引用|批注)\s*\d+/.test(aboveText)) continue
                  if (aboveText.indexOf('【') === 0) {
                    // 位置行还在、但编号被抹掉了（或整行被改坏）→ 用快照整行替换回来
                    lines[above] = header
                    text = lines.join('\n')
                    changed = true
                    continue
                  }
                }
                lines.splice(at, 0, header)
                text = lines.join('\n')
                changed = true
              }
              // ③ 编号被抹掉的位置行（`【批注 · 第3轮】`）：靠重编号把 1..N 补回来
              try {
                if (/^【批注\s*·/m.test(text)) {
                  const renum = renumberAnnotationsInDraft(text)
                  if (renum !== text) { text = renum; changed = true }
                }
              } catch (e) { /* ignore */ }
              if (!changed) return
              input.setDraft(renumberAnnotationsInDraft(text))
              report('heal:header', {})
            } catch (e) { report('heal:throw', String((e && e.message) || e)) }
          }
          const onInputHeal = () => {
            if (healTimer) { try { clearTimeout(healTimer) } catch (e) { /* ignore */ } }
            healTimer = setTimeout(healHeaderNow, 260)
          }
          scheduleHealOnCorrupt = onInputHeal
          // 关键：MutationObserver 回调在**下一次绘制之前**执行 —— 因此在这里同步装饰即可消除
          // "先露出完整引用块、稍后才变紧凑"的闪烁（之前用 setTimeout(40ms) 期间已经画了一帧）。
          // decorate() 只在缺少 class 时改动 DOM，不会形成观察循环。
          decorate()
          composerDecorateNow = decorate
          try {
            observer = new MutationObserver(() => { decorate() })
            observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          } catch (e) { report('cmp:observer-throw', String((e && e.message) || e)) }
          // 输入框内部滚动 / 窗口缩放时重算 ✕ 的位置（MutationObserver 不监听这些）
          const onViewportChange = () => { try { decorate() } catch (e) { /* ignore */ } }
          try {
            document.addEventListener('scroll', onViewportChange, true)
            window.addEventListener('resize', onViewportChange)
          } catch (e) { /* ignore */ }
          // 位置行保护：捕获阶段拦下会吃掉位置行的退格/删除；再挂一个自愈兜底
          try {
            document.addEventListener('keydown', onKeyDownGuard, true)
            document.addEventListener('beforeinput', onBeforeInputGuard, true)
            document.addEventListener('input', onInputHeal, true)
          } catch (e) { report('cmp:guard-throw', String((e && e.message) || e)) }
          // 光标进出位置行时立即更新（光标在位置行里时临时显示该行，避免"打字看不见"）
          const onSelectionChange = () => { try { decorate() } catch (e) { /* ignore */ } }
          try { document.addEventListener('selectionchange', onSelectionChange) } catch (e) { /* ignore */ }
          // 点击输入框里的引用块 → 跳回原文并高亮（与消息侧一致；不依赖 chip，纯文本反查）
          const onCmpClick = (ev) => {
            try {
              const tgt = ev && ev.target
              const el = tgt && typeof tgt.closest === 'function' ? tgt.closest('.dshq-cmp-quote') : null
              if (!el) return
              if (!(el.closest && el.closest('[contenteditable="true"]'))) return
              const text = String(el.textContent || '').trim()
              if (text === '') return
              const r = el.getBoundingClientRect()
              const pos = { left: r.left + 16, top: r.top }
              // 文档来源的块：跳回「文件 + 行/页」，而不是在聊天里找原文
              const srcPath = el.getAttribute ? (el.getAttribute('data-dshq-src-path') || '') : ''
              if (srcPath !== '') {
                const src = {
                  path: srcPath,
                  line: Number(el.getAttribute('data-dshq-src-line')) || null,
                  page: Number(el.getAttribute('data-dshq-src-page')) || null,
                }
                if (jumpToDocSource(src, pos)) return
              }
              jumpByQuoteText(text, pos)
            } catch (e) { /* ignore */ }
          }
          try { document.addEventListener('click', onCmpClick, true) } catch (e) { /* ignore */ }
          return () => {
            if (composerDecorateNow === decorate) composerDecorateNow = null
            if (observer) { try { observer.disconnect() } catch (e) { /* ignore */ } }
            try { document.removeEventListener('scroll', onViewportChange, true) } catch (e) { /* ignore */ }
            try { window.removeEventListener('resize', onViewportChange) } catch (e) { /* ignore */ }
            try { document.removeEventListener('keydown', onKeyDownGuard, true) } catch (e) { /* ignore */ }
            try { document.removeEventListener('beforeinput', onBeforeInputGuard, true) } catch (e) { /* ignore */ }
            try { document.removeEventListener('input', onInputHeal, true) } catch (e) { /* ignore */ }
            if (healTimer) { try { clearTimeout(healTimer) } catch (e) { /* ignore */ } }
            try { blockActionsStore.hide() } catch (e) { /* ignore */ }
            try { document.removeEventListener('selectionchange', onSelectionChange) } catch (e) { /* ignore */ }
            try { document.removeEventListener('click', onCmpClick, true) } catch (e) { /* ignore */ }
          }
        }, 'dsh-quote-annotate-pro: composer quote decoration')
      } catch (e) {
        report('apply:cmp-decor-throw', String((e && e.message) || e))
      }
      const tryRegister = (tag, fn) => {
        try { fn(); report('register:ok', tag); return true } catch (e) {
          report('register:throw', tag + ' :: ' + String((e && e.stack) || (e && e.message) || e))
          return false
        }
      }
      // 注意：conversation.chat.turnTail 自 0.1.6-alpha.2 起是 list 槽（不是 chain），
      // 注册参数必须是 { name, id, order }；上游用的 { select, priority } 在本版本会抛错，
      // 且它排在 4 个 overlay 注册之前 —— 一旦抛错就导致整个插件"静默失效"。
      tryRegister('dock:session-probe', () => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'quote-pro-session-probe', order: 1 },
        SessionProbe,
      )))
      // 引用块回到「输入框卡片上沿」的 dock 槽位（官方说明：Full-width entries above the composer card），
      // 用样式把它做成"贴在输入框上沿"的样子 —— DSH 没有"卡片内部、文字上方"的静态槽位：
      //   conversation.input.overlay 是浮动弹层（放的是 slash-menu / command-popup 这类），
      //   conversation.input.attachments 是官方草稿附件栏（single，占用会顶掉官方附件 UI，不能碰）。
      tryRegister('dock:quote-nav', () => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'quote-pro-quote-block', order: 2 },
        QuoteDock,
      )))
      tryRegister('turnTail', () => slots.inject('conversation.chat.turnTail', () => slots.register(
        { name: 'conversation.chat.turnTail', id: 'quote-turn-actions', order: 10 },
        TurnQuoteActions,
      )))
      tryRegister('overlay:toolbar', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-selection-toolbar', order: 100 },
        SelectionToolbar,
      )))
      tryRegister('overlay:editor', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-annotation-editor', order: 101 },
        AnnotationEditor,
      )))
      tryRegister('overlay:tooltip', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-tooltip', order: 103 },
        QuoteTooltip,
      )))
      tryRegister('overlay:toast', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-feedback-toast', order: 102 },
        FeedbackToast,
      )))
      // 引用块右侧的 ✕：浮层按钮，点一下只删掉「这一块」，其余正文和别的引用块都保留
      tryRegister('overlay:block-cancel', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-block-cancel', order: 104 },
        ComposerBlockCancel,
      )))
      // 底部文件批注条（docx/pdf/xlsx 等不可编辑预览里攒了批注时浮出）
      tryRegister('overlay:doc-notes', () => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'quote-pro-doc-notes-bar', order: 105 },
        DocNotesBar,
      )))
      // 文档预览来源探针：注册在现有 UI 之后，且单独 try/catch ——
      // 槽位不存在时只是拿不到文件路径，绝不影响上面的 overlay 注册（避免"一个槽抛错全插件静默"）。
      tryRegister('slot:doc-path-probe', () => slots.inject('sidebar.right.tab.document.actions', () => slots.register(
        { name: 'sidebar.right.tab.document.actions', id: 'quote-pro-doc-path-probe', order: 200 },
        DocPathProbe,
      )))
      report('apply:done', { pipelineAvailable })
    }

    // Cordis 客户端插件：声明依赖让 apply 在 slots 服务就绪后才执行
    // （上游缺少这一行，slots 未就绪时 apply 第 534 行静默 return → 全插件失效）
    exports.name = 'dsh-quote-annotate-pro'
    exports.inject = ['slots']
    exports.apply = apply
    // 纯函数自检出口：tools/test-client.mjs 在 Node 里直接断言（宿主只读取 name/inject/apply）
    exports.__test = {
      roleText, anchorLabelOf, buildQuoteHeader, nextAnnotationNo, annotationNoOf, parseQuoteBlock, snippetOf,
      stripQuoteBlocks, renderAnnotationBlock, renderAnnotationSection, sortAnnotations, draftHasAnnotation,
      looksLikeQuoteFragment, removeBlockFromDraft, renumberAnnotationsInDraft,
      docSourceLabel, pathOfFileAddress, fileNameOfPath, pathRelativeTo, docSourceOf, docProbes, buildDocNotesBatch, docFileNameOfHeader,
      parseDocSourceHeader, fileResourceAddress, jumpToDocSource,
      docNotesStore, docNotesStorageKey, noteWhereLabel,
      normalizeExcelSelection, excelSheetLabel, excelLocationOf, isExcelPath, normalizeExcelMeta, stripExcelSourceSuffix,
    }
    return module.exports
  },
})
