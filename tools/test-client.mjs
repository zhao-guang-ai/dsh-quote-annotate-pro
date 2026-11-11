// 客户端 bundle 自检（纯函数 + composer 事件；不依赖浏览器 / 网络）
// 运行：npm test   （node tools/test-client.mjs）
//
// 做法：给 client.js 提供最小化的 window/document/localStorage/fetch 桩，
// 捕获 window.__ModuleLoader__.load(...) 注册的工厂，再调用工厂拿到 exports，
// 然后断言 exports.__test 里的纯函数。这些函数是消息解析与编号的核心，回归风险最高。
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured = spec } },
  getSelection: () => null,
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1280,
  innerHeight: 800,
}
const fakeElement = () => ({
  style: {},
  className: '',
  textContent: '',
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {},
  getAttribute() { return null },
  appendChild() {},
  addEventListener() {},
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } },
})
globalThis.document = {
  createElement: fakeElement,
  createDocumentFragment: () => ({ appendChild() {} }),
  createTextNode: (t) => ({ nodeValue: t }),
  createTreeWalker: () => ({ nextNode: () => null }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.fetch = () => Promise.reject(new Error('offline (test)'))
globalThis.requestAnimationFrame = () => 0
globalThis.cancelAnimationFrame = () => {}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.NodeFilter = { SHOW_TEXT: 4 }

// 以 data: URL 作为 ESM 加载 —— 源文件是"注册工厂"的脚本，不导出任何东西
await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(SOURCE))

assert.ok(captured, 'client.js 应调用 window.__ModuleLoader__.load(...)')
assert.equal(captured.id, 'dsh-quote-annotate-pro')
const api = captured.factory((name) => (name === 'react' ? {} : {}))
const { buildQuoteHeader, nextAnnotationNo, annotationNoOf, parseQuoteBlock, snippetOf, anchorLabelOf, roleText,
  stripQuoteBlocks, renderAnnotationBlock, renderAnnotationSection, sortAnnotations, draftHasAnnotation, reconcileDraftAnnotations,
  looksLikeQuoteFragment, removeBlockFromDraft, renumberAnnotationsInDraft,
  docSourceLabel, pathOfFileAddress, fileNameOfPath, pathRelativeTo, docSourceOf, docProbes, buildDocNotesBatch,
  docFileNameOfHeader, parseDocSourceHeader, fileResourceAddress, docNotesStore, docNotesStorageKey, noteWhereLabel,
  normalizeExcelSelection, excelSheetLabel, excelLocationOf, isExcelPath, normalizeExcelMeta, stripExcelSourceSuffix } = api.__test

test('roleText / anchorLabelOf：轮次与角色文案', () => {
  assert.equal(roleText('assistant-step'), 'DSH 回复')
  assert.equal(roleText('user'), '你的消息')
  assert.equal(roleText(null, 'tool-call'), '工具调用')
  assert.equal(anchorLabelOf({ turn: 0, role: 'user' }), '第1轮 · 你的消息')
  assert.equal(anchorLabelOf({ turn: 4, kind: 'assistant-step' }), '第5轮 · DSH 回复')
  assert.equal(anchorLabelOf({}), '')
})

test('buildQuoteHeader：带编号 / 旧格式 / 空', () => {
  assert.equal(buildQuoteHeader({ turn: 4, role: 'assistant-step' }, 2), '【批注 2 · 第5轮 · DSH 回复】')
  assert.equal(buildQuoteHeader({ turn: 0, role: 'user' }), '【引用 · 第1轮 · 你的消息】')
  assert.equal(buildQuoteHeader({}, undefined), '')
})

test('nextAnnotationNo：草稿内编号（空 → 1，取最大 + 1）', () => {
  assert.equal(nextAnnotationNo(''), 1)
  assert.equal(nextAnnotationNo('你好'), 1)
  assert.equal(nextAnnotationNo('【批注 1 · 第3轮 · DSH 回复】\n原文'), 2)
  assert.equal(nextAnnotationNo('【批注 1 · 第1轮 · 你的消息】\nA\n\n批注：x\n\n【批注 3 · 第2轮 · DSH 回复】\nB'), 4)
  assert.equal(nextAnnotationNo('旧格式【引用 · 第1轮 · 你的消息】\n原文'), 1)
})

test('annotationNoOf：从位置行取编号（旧格式 → null）', () => {
  assert.equal(annotationNoOf('【批注 7 · 第3轮 · DSH 回复】'), 7)
  assert.equal(annotationNoOf('【批注 1 · 第1轮 · 你的消息（请按「Annotation 1：」格式回应）】'), 1)
  assert.equal(annotationNoOf('【引用 · 第1轮 · 你的消息】'), null)
  assert.equal(annotationNoOf(''), null)
})

test('parseQuoteBlock：新格式（原文 + 批注）', () => {
  const raw = '【批注 2 · 第5轮 · DSH 回复】\n选中的原文片段\n\n批注：这条不太对'
  const r = parseQuoteBlock(raw)
  assert.ok(r)
  assert.equal(r.no, 2)
  assert.equal(r.header, '【批注 2 · 第5轮 · DSH 回复】')
  assert.equal(r.quote, '选中的原文片段')
  assert.equal(r.comment, '这条不太对')
  assert.equal(r.before, '')
  assert.match(r.rest, /批注：这条不太对/)
})

test('parseQuoteBlock：多行原文 / 前置文本 / 旧格式', () => {
  const raw = '开头的一句话【引用 · 第2轮 · 你的消息】\n第一行\n第二行\n\n批注：补充说明\n结尾'
  const r = parseQuoteBlock(raw)
  assert.ok(r)
  assert.equal(r.no, null)
  assert.equal(r.before, '开头的一句话')
  // 多行原文按换行保留（渲染侧 white-space:pre-wrap，能看到原始段落结构）
  assert.equal(r.quote, '第一行\n第二行')
  assert.equal(r.comment, '补充说明')
  assert.match(r.rest, /结尾/)
})

test('parseQuoteBlock：原文里含空行（多段划词）不被截断', () => {
  // 多段划词选中时，原文本身就带空行；旧实现遇空行即收块，第 2 段会被漏成正文
  const raw = '【批注 1 · 第10轮 · DSH 回复】\n还能继续跑的\n\n已部署但未重测的：\nTC-TR-023\n\n批注：先跑这两条'
  const r = parseQuoteBlock(raw)
  assert.ok(r)
  assert.equal(r.quote, '还能继续跑的\n\n已部署但未重测的：\nTC-TR-023')
  assert.equal(r.comment, '先跑这两条')
})

test('parseQuoteBlock：正文遇到下一个位置行即结束', () => {
  const raw = '【批注 1 · 第1轮 · 你的消息】\n原文A\n\n【批注 2 · 第2轮 · 你的消息】\n原文B\n\n批注：y'
  const r = parseQuoteBlock(raw)
  assert.ok(r)
  assert.equal(r.quote, '原文A')
  assert.equal(r.comment, '') // 下一块的评语不能归到这一块，即使旧草稿没有空评语行。
  assert.equal(r.rest.indexOf('【批注 2'), 0)
})

test('parseQuoteBlock：解析不了时返回 null', () => {
  assert.equal(parseQuoteBlock('没有位置行的一段文字\n原文'), null)
  assert.equal(parseQuoteBlock('【批注 1 · 第1轮 · 你的消息】'), null)
  assert.equal(parseQuoteBlock(''), null)
})

test('snippetOf：输入框引用条只显示原文（不显示位置行/批注）', () => {
  assert.equal(snippetOf('【批注 1 · 第1轮 · 你的消息】\n选中的原文\n\n批注：这条不对'), '选中的原文')
  assert.equal(snippetOf('【引用 · 第2轮 · DSH 回复】\n> 旧格式原文'), '旧格式原文')
  assert.equal(snippetOf(''), '')
})

test('stripQuoteBlocks：剥掉所有引用块，留下用户自己的文字', () => {
  const draft = '我的问题\n\n【批注 1 · 第1轮 · 你的消息】\n原文A\n\n批注：x\n\n【批注 2 · 第2轮 · DSH 回复】\n原文B\n\n批注：y\n尾巴'
  assert.equal(stripQuoteBlocks(draft), '我的问题\n\n尾巴')
  assert.equal(stripQuoteBlocks(''), '')
  assert.equal(stripQuoteBlocks('没有批注的草稿'), '没有批注的草稿')
  // 只有块、没有用户文字 → 空串（重建时不会留下空段落）
  assert.equal(stripQuoteBlocks('【批注 1 · 第1轮 · 你的消息】\n原文A'), '')
})

test('renderAnnotationBlock：位置行 + 原文 + 批注；首条带回复格式指令', () => {
  const e = { turn: 1, kind: 'assistant-step', quote: '原文A', comment: '不太对' }
  assert.equal(renderAnnotationBlock(e, 2), '【批注 2 · 第2轮 · DSH 回复】\n原文A\n\n批注：不太对')
  const withIns = renderAnnotationBlock(e, 1, { instruction: true })
  assert.match(withIns, /^【批注 1 · 第2轮 · DSH 回复（请按「Annotation 1：」/)
  // 空评语仍保留边界，插入后可继续写评语；没有位置信息时只剩编号
  assert.equal(renderAnnotationBlock({ quote: 'Q' }, 3), '【批注 3】\nQ\n\n批注：')
})

test('renderAnnotationSection：重编号 1..N，只有首条带指令', () => {
  assert.equal(renderAnnotationSection([]), '')
  const out = renderAnnotationSection([
    { turn: 0, kind: 'user', quote: 'A', comment: 'a' },
    { turn: 2, kind: 'assistant-step', quote: 'B', comment: '' },
  ])
  const blocks = out.split('\n【批注')
  assert.equal(blocks.length, 2)
  assert.equal(out.includes('\n\n【批注'), false)
  assert.match(out, /^【批注 1 · 第1轮 · 你的消息/)
  assert.ok(out.includes('【批注 2 · 第3轮 · DSH 回复】\nB'))
  assert.equal((out.match(/请按「Annotation/g) || []).length, 1)
})

test('sortAnnotations：按轮次 → 同一轮内 DOM 顺序 → 点击时间', () => {
  const dom = { k1: 5, k2: 2, k3: 0 }
  const list = [
    { anchorKey: 'k3', turn: 4, at: 1 },
    { anchorKey: 'k1', turn: 0, at: 2 },
    { anchorKey: 'k2', turn: 0, at: 3 },
  ]
  const ordered = sortAnnotations(list, (k) => (k in dom ? dom[k] : -1))
  assert.deepEqual(ordered.map((e) => e.anchorKey), ['k2', 'k1', 'k3'])
  // 轮次未知的排在最后；不传 domIndexOf 时退化为按点击时间
  const noTurn = sortAnnotations([{ anchorKey: 'a', turn: null, at: 9 }, { anchorKey: 'b', turn: 1, at: 8 }])
  assert.equal(noTurn[1].anchorKey, 'a')
  // 不改原数组
  assert.equal(list[0].anchorKey, 'k3')
})

test('draftHasAnnotation：草稿里还有这条原文才保留（删掉的不复活）', () => {
  const draft = '【批注 1 · 第1轮 · 你的消息】\n选中的原文\n\n批注：x'
  assert.equal(draftHasAnnotation(draft, { quote: '选中的原文' }), true)
  assert.equal(draftHasAnnotation(draft, { quote: '别的原文' }), false)
  assert.equal(draftHasAnnotation(draft, { quote: '' }), false)
})

test('looksLikeQuoteFragment：删了一半的位置行也要认出来（否则残片露在输入框里）', () => {
  assert.equal(looksLikeQuoteFragment('【批注 1 · 第3轮 · DSH 回复'), true)
  assert.equal(looksLikeQuoteFragment('（请按「Annotation 1：」「Annotation 2：」…逐条回应）'), true)
  assert.equal(looksLikeQuoteFragment('批注 1 · 第3轮'), true)
  assert.equal(looksLikeQuoteFragment('· 第14轮 · DSH 回复'), true)
  assert.equal(looksLikeQuoteFragment('引用 · 第2轮'), true)
  assert.equal(looksLikeQuoteFragment('批注'), true) // 删到只剩一个词（用户截图里的残片）
  assert.equal(looksLikeQuoteFragment('引用：'), true)
  assert.equal(looksLikeQuoteFragment('〔位置行'), true)
  assert.equal(looksLikeQuoteFragment('第3轮 DSH 回复'), true)
  assert.equal(looksLikeQuoteFragment('我自己写的普通文字'), false)
  assert.equal(looksLikeQuoteFragment('第3轮的答案不对'), false) // 用户自己的短句，不能误伤
  assert.equal(looksLikeQuoteFragment(''), false)
})

test('stripQuoteBlocks：块、孤儿评语、删除残片都不留，用户文字按原顺序保留', () => {
  const draft = [
    '开头一句',
    '【批注 1 · 第1轮 · 你的消息（请按「Annotation 1：」…逐条回应）】',
    '第一段原文',
    '',
    '批注：评语一',
    '',
    '中间一句',
    '（请按「Annotation 1：」…逐条回应）',
    '· 第14轮 · DSH 回复',
    '',
    '结尾一句',
  ].join('\n')
  const out = stripQuoteBlocks(draft)
  // 用户自己写的段落之间的空行保留（只清掉块与残片）
  assert.equal(out, '开头一句\n\n中间一句\n结尾一句')
  assert.equal(out.includes('第一段原文'), false)
  assert.equal(out.includes('评语一'), false)
  assert.equal(out.includes('第14轮'), false)
})

test('removeBlockFromDraft：只删目标块，别的块和用户文字都保留', () => {
  const draft = '先说一句\n\n【批注 1 · 第1轮 · 你的消息（请按「Annotation 1：」「Annotation 2：」…逐条回应）】\n第一段原文\n\n批注：第一条评语\n\n【批注 2 · 第3轮 · DSH 回复】\n第二段原文\n\n批注：第二条评语'
  const out = removeBlockFromDraft(draft, '第二段原文', '第二条评语')
  assert.ok(out.startsWith('先说一句'), out)
  assert.ok(out.includes('第一段原文'), out)
  assert.ok(out.includes('批注：第一条评语'), out)
  assert.equal(out.includes('第二段原文'), false)
  assert.equal(out.includes('第二条评语'), false)
  assert.equal(/批注 2/.test(out), false)
  // 找不到原文时原样返回（不做破坏性删除）
  assert.equal(removeBlockFromDraft(draft, '不存在的原文', ''), draft)
})

test('removeBlockFromDraft：原文跨多行也能整块删掉', () => {
  const draft = '【批注 1 · 第1轮 · 你的消息】\n第一行原文\n第二行原文\n\n批注：评语\n\n尾巴'
  const out = removeBlockFromDraft(draft, '第一行原文\n第二行原文', '评语')
  assert.equal(out, '尾巴')
})

test('removeBlockFromDraft：quote 只含正文首行时，后续正文一并删掉', () => {
  // 历史草稿 / 手工插入的块，调用方可能只拿到首行；不应残留后续正文行
  const draft = '【批注 1 · 第1轮 · 你的消息】\n一行\n二行\n\n批注：x\n\n尾巴'
  assert.equal(removeBlockFromDraft(draft, '一行', 'x'), '尾巴')
})

test('removeBlockFromDraft：多段正文（内含空行）整块删掉', () => {
  const draft = '问题\n\n【批注 1 · 第10轮 · DSH 回复】\n段一\n\n段二\nTC-023\n\n批注：先跑'
  assert.equal(removeBlockFromDraft(draft, '段一\n\n段二\nTC-023', '先跑'), '问题')
})

test('removeBlockFromDraft：两块相邻时只删目标块，不误伤下一块', () => {
  const draft = '【批注 1 · 第1轮 · 你】\n原文A\n\n批注：a\n\n【批注 2 · 第2轮 · 你】\n原文B\n\n批注：b'
  assert.equal(
    removeBlockFromDraft(draft, '原文A', 'a'),
    '【批注 2 · 第2轮 · 你】\n原文B\n\n批注：b',
  )
})

test('stripQuoteBlocks：多段正文（内含空行）也被整体剥掉', () => {
  const draft = '问题\n\n【批注 1 · 第10轮 · DSH 回复】\n段一\n\n段二\nTC-023\n\n批注：先跑\n\n尾巴'
  assert.equal(stripQuoteBlocks(draft), '问题\n\n尾巴')
})

test('stripQuoteBlocks：块没有评语时，块后用户文字不被吞掉（传入已知原文）', () => {
  // 用户把「批注：…」整行删掉（或插入时就没写评语）后，块后紧接着写自己的话：
  // 只靠评语行收块会把这段用户文字一起吞掉 → 再插一条批注时被静默删除。
  const draft = '【批注 1 · 第1轮 · 你的消息】\n原文一\n原文二\n\n我自己想说的话'
  assert.equal(stripQuoteBlocks(draft, ['原文一\n原文二']), '我自己想说的话')
  // 多段正文（内含空行）时同样按已知原文收块
  const multi = '【批注 1 · 第10轮 · DSH 回复】\n段一\n\n段二\n\n我要补一句'
  assert.equal(stripQuoteBlocks(multi, ['段一\n\n段二']), '我要补一句')
  // 不传已知原文时保持原行为（没有块边界可依据，只能吞到结尾）
  assert.equal(stripQuoteBlocks(draft), '')
})

test('renumberAnnotationsInDraft：按顺序重编号，指令只留在第一条', () => {
  const draft = '【批注 3 · 第1轮 · 你的消息】\nA\n\n【批注 7 · 第3轮 · DSH 回复】\nB'
  const out = renumberAnnotationsInDraft(draft)
  const lines = out.split('\n')
  assert.match(lines[0], /^【批注 1 · 第1轮 · 你的消息（请按「Annotation/)
  assert.equal(lines[3], '【批注 2 · 第3轮 · DSH 回复】')
  assert.equal((out.match(/请按「Annotation/g) || []).length, 1)
})
// ---------- 文档来源（上游化自 DoggyHU fork）：文件路径 / 地址解码 / 位置行 ----------

// ---------- 文档来源（本 fork 新增）：文件路径 / 地址解码 / 位置行 ----------

test('fileNameOfPath / pathRelativeTo：路径展示', () => {
  assert.equal(fileNameOfPath('D:\\a\\b\\测试文档.docx'), '测试文档.docx')
  assert.equal(fileNameOfPath('a/b/c.md'), 'c.md')
  assert.equal(fileNameOfPath(''), '')
  assert.equal(pathRelativeTo('D:\\ws\\sidebar-test\\测试文档.docx', 'D:\\ws'), 'sidebar-test\\测试文档.docx')
  assert.equal(pathRelativeTo('D:\\ws\\x.md', 'd:/WS/'), 'x.md')
  assert.equal(pathRelativeTo('E:\\other\\x.md', 'D:\\ws'), 'E:\\other\\x.md')
})

test('pathOfFileAddress：dsh-resource 地址解码', () => {
  assert.equal(pathOfFileAddress('dsh-resource://file/session/sess-1/docs/a%20b.md'), 'docs/a b.md')
  assert.equal(pathOfFileAddress('dsh-resource://file/absolute/D%3A/tmp/x.md'), 'D:/tmp/x.md')
  assert.equal(pathOfFileAddress('dsh-resource://file/other/x'), null)
  assert.equal(pathOfFileAddress('http://x'), null)
  assert.equal(pathOfFileAddress(undefined), null)
})

test('buildQuoteHeader：文档来源带路径与行号/页码，聊天格式不变', () => {
  const doc = { filePath: 'D:\\ws\\sidebar-test\\测试文档.docx' }
  // 测试环境拿不到会话 cwd → 按绝对路径展示
  assert.equal(buildQuoteHeader(doc, 1), '【批注 1 · 文件 · D:\\ws\\sidebar-test\\测试文档.docx】')
  assert.equal(buildQuoteHeader({ ...doc, line: 12 }, 2), '【批注 2 · 文件 · D:\\ws\\sidebar-test\\测试文档.docx:L12】')
  assert.equal(buildQuoteHeader({ ...doc, page: 3 }, 3), '【批注 3 · 文件 · D:\\ws\\sidebar-test\\测试文档.docx:p3】')
  // 聊天消息选区仍然只带轮次/角色（路径字段不参与）
  assert.equal(buildQuoteHeader({ turn: 2, role: 'user' }, 1), '【批注 1 · 第3轮 · 你的消息】')
})

test('docSourceLabel：无路径/无行号时退回旧形态', () => {
  assert.equal(docSourceLabel({}), '')
  assert.equal(docSourceLabel({ filePath: '' }), '')
  assert.equal(docSourceLabel({ filePath: 'D:\\ws\\a.md', line: 0 }), 'D:\\ws\\a.md')
})

test('parseQuoteBlock：文件来源的位置行同样可解析（原文/批注不受影响）', () => {
  const raw = '【批注 1 · 文件 · sidebar-test\\测试文档.docx】\n用于测试 better-sidebar 对 Word 文档的预览效果。\n\n批注：测试1 来自哪？'
  const r = parseQuoteBlock(raw)
  assert.ok(r)
  assert.equal(r.no, 1)
  assert.equal(r.quote, '用于测试 better-sidebar 对 Word 文档的预览效果。')
  assert.equal(r.comment, '测试1 来自哪？')
})

// ---------- 文档来源判定（最小 DOM 桩）：聊天选区不得产生文件来源 ----------

function matchesSelector(el, selector) {
  const part = String(selector || '').trim()
  const withValue = /^\[([\w-]+)="([^"]*)"\]$/.exec(part)
  if (withValue) return el.attrs != null && el.attrs[withValue[1]] === withValue[2]
  const presence = /^\[([\w-]+)\]$/.exec(part)
  if (presence) return el.attrs != null && Object.prototype.hasOwnProperty.call(el.attrs, presence[1])
  return false
}

function makeEl(attrs = {}, parent = null) {
  const el = {
    attrs,
    parentElement: parent,
    isConnected: true,
    contains(other) {
      let cur = other
      while (cur) {
        if (cur === el) return true
        cur = cur.parentElement
      }
      return false
    },
    closest(selector) {
      let cur = el
      while (cur) {
        for (const one of String(selector).split(',')) {
          if (matchesSelector(cur, one)) return cur
        }
        cur = cur.parentElement
      }
      return null
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null
    },
  }
  return el
}

test('docSourceOf：聊天选区 → null；预览选区 → 探针路径 / 地址兜底 / 行号', () => {
  // 1) 聊天消息选区：祖先链里没有任何预览容器 → 不产生文件来源
  const chatRow = makeEl({ 'data-chat-anchor-key': 'k1' })
  const chatText = makeEl({}, chatRow)
  assert.equal(docSourceOf(chatText), null)

  // 2) 文档预览：探针在头部、选区在正文，共同祖先是预览根 → 取探针登记的路径 + 行号
  const previewRoot = makeEl({ 'data-slot': 'sidebar.right.tab.document' }, document.body)
  const header = makeEl({}, previewRoot)
  const probeNode = makeEl({ 'data-dshq-doc-path': 'D:\\ws\\a.docx' }, header)
  const body = makeEl({}, previewRoot)
  const lineEl = makeEl({ 'data-textpreview-line': '12' }, body)
  const anchorEl = makeEl({}, lineEl)
  const entry = { node: probeNode, path: 'D:\\ws\\a.docx' }
  docProbes.add(entry)
  try {
    assert.deepEqual(docSourceOf(anchorEl), { path: 'D:\\ws\\a.docx', line: 12, page: null })
  } finally {
    docProbes.delete(entry)
  }

  // 3) 文本类兜底：没有探针时用 data-textpreview-url 的资源地址解码
  const textRoot = makeEl({ 'data-textpreview-url': 'dsh-resource://file/session/s1/docs/a%20b.md' }, document.body)
  const textEl = makeEl({}, textRoot)
  assert.equal(docSourceOf(textEl).path, 'docs/a b.md')
})


// ---------- 文件批注列表（本 fork 新增）：收集 → 展开/删除 → 全部发送 ----------

test('noteWhereLabel：页码优先、行号其次、都没有就不显示', () => {
  assert.equal(noteWhereLabel({ page: 3 }), '第3页')
  assert.equal(noteWhereLabel({ page: 0, line: 12 }), '第12行')
  assert.equal(noteWhereLabel({}), '')
  assert.equal(noteWhereLabel({ page: null, line: null }), '')
})

test('docNotesStorageKey：按会话 + 文件路径隔离', () => {
  assert.equal(docNotesStorageKey('s1', 'D:\\ws\\a.pdf'), 's1|D:\\ws\\a.pdf')
  assert.notEqual(docNotesStorageKey('s1', 'D:\\ws\\a.pdf'), docNotesStorageKey('s2', 'D:\\ws\\a.pdf'))
  assert.notEqual(docNotesStorageKey('s1', 'D:\\ws\\a.pdf'), docNotesStorageKey('s1', 'D:\\ws\\b.pdf'))
})

test('docNotesStore：添加 / 快照 / 删除 / 清空（跨文件隔离）', () => {
  const sid = 'test-session'
  const a = 'D:\\ws\\a.pdf'
  const b = 'D:\\ws\\b.docx'
  docNotesStore.clear(sid, a)
  docNotesStore.clear(sid, b)
  const first = docNotesStore.add(sid, a, { quote: '原文一', comment: '意见一', page: 2 })
  const second = docNotesStore.add(sid, a, { quote: '原文二', comment: '', line: 7 })
  assert.equal(docNotesStore.get(sid, a).length, 2)
  assert.equal(docNotesStore.get(sid, b).length, 0)
  assert.equal(first.quote, '原文一')
  assert.equal(second.line, 7)
  assert.deepEqual(docNotesStore.get(sid, a).map((n) => n.quote), ['原文一', '原文二'])
  assert.equal(docNotesStore.remove(sid, a, first.id), true)
  assert.deepEqual(docNotesStore.get(sid, a).map((n) => n.quote), ['原文二'])
  assert.equal(docNotesStore.clear(sid, a), 1)
  assert.equal(docNotesStore.get(sid, a).length, 0)
  assert.equal(docNotesStore.remove(sid, a, 'missing'), false)
})

test('buildDocNotesBatch：一次性发送的文本格式（编号 / 路径 / 页码行号 / 首条指令）', () => {
  const path = 'D:\\ws\\sidebar-test\\测试文档.pdf'
  const text = buildDocNotesBatch([
    { quote: '第一段原文', comment: '这条不对', page: 2 },
    { quote: '第二段原文', comment: '', line: 12 },
  ], { path })
  const expected = '【批注 1 · 文件 · ' + path + ':p2（请按「Annotation 1：」「Annotation 2：」…格式逐条回应我的批注）】'
    + '\n第一段原文\n\n批注：这条不对'
    + '\n\n【批注 2 · 文件 · ' + path + ':L12】\n第二段原文\n\n批注：'
  assert.equal(text, expected)
  // 只处理有原文的条目；空列表返回空串
  assert.equal(buildDocNotesBatch([{ quote: '   ', comment: 'x' }], { path }), '')
  assert.equal(buildDocNotesBatch([], { path }), '')
  assert.equal(buildDocNotesBatch(null, { path }), '')
})

test('buildDocNotesBatch：第一条才有回复格式指令，且聊天来源不受影响', () => {
  const text = buildDocNotesBatch([
    { quote: 'A', comment: 'a' },
    { quote: 'B', comment: 'b' },
  ], { path: 'D:\\ws\\a.docx' })
  assert.equal((text.match(/请按「Annotation 1：」/g) || []).length, 1)
  assert.equal(text.indexOf('【批注 1 · 文件 · '), 0)
  assert.equal(text.includes('【批注 2 · 文件 · D:\\ws\\a.docx】'), true)
})

test('buildDocNotesBatch：startNo 接着输入框里已有编号（且不再插回复指令）', () => {
  const text = buildDocNotesBatch([{ quote: 'A', comment: '' }], { path: 'D:\\ws\\a.pdf', startNo: 4 })
  assert.equal(text.startsWith('【批注 4 · 文件 · D:\\ws\\a.pdf】'), true)
  assert.equal(text.includes('请按「Annotation 1：」'), false)
})

test('docNotesStore.update：编辑评语（保留原文；缺失 id 返回 false）', () => {
  const sid = 'test-edit-session'
  const path = 'D:\\ws\\edit.pdf'
  docNotesStore.clear(sid, path)
  const note = docNotesStore.add(sid, path, { quote: '原文', comment: '旧意见', page: 1 })
  assert.equal(docNotesStore.update(sid, path, note.id, { comment: '新意见' }), true)
  const after = docNotesStore.get(sid, path)[0]
  assert.equal(after.quote, '原文')
  assert.equal(after.comment, '新意见')
  assert.equal(docNotesStore.update(sid, path, 'missing', { comment: 'x' }), false)
})

test('buildQuoteHeader：文档来源带文件路径 / 行号 / 页码', () => {
  assert.equal(buildQuoteHeader({ filePath: 'D:\ws\a.docx' }, 1), '【批注 1 · 文件 · D:\ws\a.docx】')
  assert.equal(buildQuoteHeader({ filePath: 'D:\ws\a.txt', line: 12 }, 2), '【批注 2 · 文件 · D:\ws\a.txt:L12】')
  assert.equal(buildQuoteHeader({ filePath: 'D:\ws\a.pdf', page: 3 }, 3), '【批注 3 · 文件 · D:\ws\a.pdf:p3】')
})

test('renderAnnotationBlock：文件来源块 + 首条回复指令', () => {
  const e = { filePath: 'D:\ws\a.pdf', page: 2, quote: '原文', comment: '意见' }
  assert.equal(renderAnnotationBlock(e, 2), '【批注 2 · 文件 · D:\ws\a.pdf:p2】\n原文\n\n批注：意见')
  assert.match(renderAnnotationBlock(e, 1, { instruction: true }), /^【批注 1 · 文件 · D:\ws\a\.pdf:p2（请按「Annotation 1：」/)
})

test('sortAnnotations：文件批注（没有轮次）排在聊天批注之后', () => {
  const list = [
    { filePath: 'D:\ws\a.pdf', quote: 'F', at: 1 },
    { anchorKey: 'k', turn: 1, quote: 'C', at: 2 },
  ]
  const out = sortAnnotations(list, () => 0)
  assert.deepEqual(out.map((e) => e.quote), ['C', 'F'])
})

test('docFileNameOfHeader：从文档位置行取文件名（聊天位置行返回空）', () => {
  assert.equal(docFileNameOfHeader('【批注 1 · 文件 · sidebar-test/测试文档.docx】'), '测试文档.docx')
  assert.equal(docFileNameOfHeader('【批注 2 · 文件 · D:/ws/a.pdf:p3】'), 'a.pdf')
  assert.equal(docFileNameOfHeader('【批注 3 · 文件 · D:/ws/a.txt:L12】'), 'a.txt')
  assert.equal(docFileNameOfHeader('【批注 1 · 第3轮 · DSH 回复】'), '')
  assert.equal(docFileNameOfHeader(''), '')
})

test('removeBlockFromDraft：多行原文的块一次删干净（清空输入框后不留残句）', () => {
  const draft = '【批注 1 · 第1轮 · 你的消息】\n第一行原文\n第二行原文\n\n批注：45\n\n尾巴'
  assert.equal(removeBlockFromDraft(draft, '第一行原文', '45'), '尾巴')
  // 只剩孤立评语行（原文已被手动删掉）：按评语把它清掉
  assert.equal(removeBlockFromDraft('批注：45\n尾巴', '不存在的原文', '45'), '尾巴')
  // 找不到原文、也没有评语：原样返回
  assert.equal(removeBlockFromDraft('尾巴', '不存在的原文', ''), '尾巴')
})

test('parseDocSourceHeader：从位置行取 路径 / 行号 / 页码', () => {
  assert.deepEqual(parseDocSourceHeader('【批注 1 · 文件 · sidebar-test/测试文档.docx】'), { path: 'sidebar-test/测试文档.docx', line: null, page: null })
  assert.deepEqual(parseDocSourceHeader('【批注 2 · 文件 · a/b.py:L12】'), { path: 'a/b.py', line: 12, page: null })
  assert.deepEqual(parseDocSourceHeader('【批注 3 · 文件 · x.pdf:p3】'), { path: 'x.pdf', line: null, page: 3 })
  assert.deepEqual(parseDocSourceHeader('【批注 1 · 第3轮 · DSH 回复】'), { path: '', line: null, page: null })
})

test('fileResourceAddress：相对路径走 session，绝对路径走 absolute（供 openResource 打开）', () => {
  assert.equal(fileResourceAddress('s1', 'a/b c.txt'), 'dsh-resource://file/session/s1/a/b%20c.txt')
  assert.equal(fileResourceAddress('s1', 'D:/ws/a.docx'), 'dsh-resource://file/absolute/D%3A/ws/a.docx')
  assert.equal(fileResourceAddress('s1', ''), '')
})

test('parseDocSourceHeader：位置行内嵌「（请按…）」指令时也能正确取路径', () => {
  const header = '【批注 1 · 文件 · annotate-test/批注实验文档.docx:p1（请按「Annotation 1：」「Annotation 2：」…逐条回应）】'
  assert.deepEqual(parseDocSourceHeader(header), { path: 'annotate-test/批注实验文档.docx', line: null, page: 1 })
  assert.equal(docFileNameOfHeader(header), '批注实验文档.docx')
})

test('normalizeExcelSelection：单格 / 区域 / 整行 / 整列', () => {
  assert.deepEqual(normalizeExcelSelection('A1'), { ref: 'A1', kind: 'cell' })
  assert.deepEqual(normalizeExcelSelection('A1:C3'), { ref: 'A1:C3', kind: 'range' })
  assert.deepEqual(normalizeExcelSelection('a1:c3'), { ref: 'A1:C3', kind: 'range' })
  assert.deepEqual(normalizeExcelSelection('A1:T3', { rowSelected: true }), { ref: '1:3', kind: 'row' })
  assert.deepEqual(normalizeExcelSelection('A1:A9', { colSelected: true }), { ref: 'A:A', kind: 'col' })
  assert.deepEqual(normalizeExcelSelection('B2', { rowSelected: true }), { ref: '2:2', kind: 'row' })
  assert.equal(normalizeExcelSelection(''), null)
  assert.equal(normalizeExcelSelection('选区的文字'), null)
})

test('excelLocationOf / excelSheetLabel：sheet 名按 Excel 规则加引号', () => {
  assert.equal(excelLocationOf('Sheet1', 'A1:C3'), 'Sheet1!A1:C3')
  assert.equal(excelLocationOf('2024 预算', 'B2'), "'2024 预算'!B2")
  assert.equal(excelLocationOf("It's", 'A1'), "'It''s'!A1")
  assert.equal(excelLocationOf('', 'A1'), '!A1') // sheet 名读不到：保留 `!`，别退化成裸 `:A1`
  assert.equal(excelLocationOf('Sheet1', ''), '')
})

test('normalizeExcelMeta：只保留合法字段（读回 localStorage 用）', () => {
  assert.deepEqual(normalizeExcelMeta({ sheet: 'S', ref: 'A1', kind: 'cell' }), { sheet: 'S', ref: 'A1', kind: 'cell' })
  assert.equal(normalizeExcelMeta({ ref: '' }), null)
  assert.equal(normalizeExcelMeta(null), null)
  assert.equal(normalizeExcelMeta({ ref: 'A1', kind: 'weird' }).kind, 'range')
})

test('docSourceLabel / buildQuoteHeader：Excel 选区写进位置行', () => {
  const item = { filePath: 'D:\\ws\\预算.xlsx', excel: { sheet: 'Sheet1', ref: 'A1:C3', kind: 'range' } }
  assert.equal(docSourceLabel(item), 'D:\\ws\\预算.xlsx:Sheet1!A1:C3')
  assert.equal(buildQuoteHeader(item, 2), '【批注 2 · 文件 · D:\\ws\\预算.xlsx:Sheet1!A1:C3】')
})

test('docNotesStore / buildDocNotesBatch：Excel 批注持久化并参与全部发送', () => {
  const sid = 'test-excel-session'
  const path = 'D:\\ws\\预算.xlsx'
  docNotesStore.clear(sid, path)
  docNotesStore.add(sid, path, { quote: 'Sheet1!A1:C3', comment: '把这里改成 0', excel: { sheet: 'Sheet1', ref: 'A1:C3', kind: 'range' } })
  docNotesStore.add(sid, path, { quote: 'Sheet1!3:5', comment: '删掉这几行', excel: { sheet: 'Sheet1', ref: '3:5', kind: 'row' } })
  const notes = docNotesStore.get(sid, path)
  assert.equal(notes.length, 2)
  assert.equal(notes[0].excel.sheet, 'Sheet1')
  assert.equal(notes[1].excel.kind, 'row')
  const text = buildDocNotesBatch(notes, { path })
  assert.equal(text.includes('【批注 1 · 文件 · D:\\ws\\预算.xlsx:Sheet1!A1:C3（请按「Annotation 1：」'), true)
  assert.equal(text.includes('【批注 2 · 文件 · D:\\ws\\预算.xlsx:Sheet1!3:5】'), true)
  assert.equal(text.includes('批注：把这里改成 0'), true)
  assert.equal(noteWhereLabel(notes[0]), '')
})

test('normalizeExcelSelection：整行/整列也接受 Name Box 的 3:5 / B:D 形态', () => {
  assert.deepEqual(normalizeExcelSelection('3:5'), { ref: '3:5', kind: 'row' })
  assert.deepEqual(normalizeExcelSelection('3:3'), { ref: '3:3', kind: 'row' })
  assert.deepEqual(normalizeExcelSelection('B:D'), { ref: 'B:D', kind: 'col' })
  assert.deepEqual(normalizeExcelSelection('b:b'), { ref: 'B:B', kind: 'col' })
  // 带行/列头标记时，整片范围仍然收成整行/整列
  assert.deepEqual(normalizeExcelSelection('A1:T3', { rowSelected: true }), { ref: '1:3', kind: 'row' })
})

test('parseDocSourceHeader / docFileNameOfHeader：Excel 选区后缀不混进路径', () => {
  const h1 = '【批注 1 · 文件 · D:\\ws\\预算.xlsx:Sheet1!A1:C3（请按「Annotation 1：」「Annotation 2：」…格式逐条回应我的批注）】'
  assert.deepEqual(parseDocSourceHeader(h1), { path: 'D:\\ws\\预算.xlsx', line: null, page: null })
  assert.equal(docFileNameOfHeader(h1), '预算.xlsx')
  assert.deepEqual(parseDocSourceHeader('【批注 2 · 文件 · 预算.xlsx:Sheet1!3:5】'), { path: '预算.xlsx', line: null, page: null })
  assert.equal(parseDocSourceHeader("【批注 3 · 文件 · D:\\ws\\预算.xlsx:'2024 预算'!B2】").path, 'D:\\ws\\预算.xlsx')
  assert.equal(parseDocSourceHeader('【批注 4 · 文件 · D:\\ws\\预算.xlsx:B:D】').path, 'D:\\ws\\预算.xlsx')
  // 文本类预览的 :L / :p 仍然照常解析（不能被 Excel 后缀规则吃掉）
  assert.deepEqual(parseDocSourceHeader('【批注 5 · 文件 · 预算.xlsx:L12】'), { path: '预算.xlsx', line: 12, page: null })
  assert.deepEqual(parseDocSourceHeader('【批注 6 · 文件 · 批注实验文档.docx:p1】'), { path: '批注实验文档.docx', line: null, page: 1 })
})

test('isExcelPath：DSH 归为 excel 类的扩展名都要认（xlsm/xlsb/ods/numbers/csv…）', () => {
  const yes = ['a.xls', 'a.xlsx', 'a.XLSX', 'a.xlsm', 'a.xlsb', 'a.xlt', 'a.xltx', 'a.xltm', 'a.ods', 'a.ots', 'a.fods', 'a.numbers', 'a.csv', 'a.CSV', 'a.tsv', 'D:\\ws\\预算.xlsx', '报表.csv']
  for (const name of yes) assert.equal(isExcelPath(name), true, name)
  const no = ['a.docx', 'a.pdf', 'a.md', 'a.txt', 'a.py', 'a.xlsx.md', 'a.xlsx.bak', '', null, undefined]
  for (const name of no) assert.equal(isExcelPath(name), false, String(name))
})

test('位置行往返：csv/ods/带引号的 sheet 名都不污染路径', () => {
  const cases = [
    ['预算.ods:Sheet1!A1:C3', '预算.ods', '预算.ods'],
    ['D:\\ws\\数据.csv:Sheet1!3:5', 'D:\\ws\\数据.csv', '数据.csv'],
    ["D:\\ws\\预算.xlsx:'2024 预算'!B2", 'D:\\ws\\预算.xlsx', '预算.xlsx'],
    ["D:\\ws\\预算.xlsx:'It''s'!A1", 'D:\\ws\\预算.xlsx', '预算.xlsx'],
    ["D:\\ws\\预算.xlsx:'Q1!'!A1", 'D:\\ws\\预算.xlsx', '预算.xlsx'],
    ['D:\\ws\\预算.xlsx:Sheet1!A1', 'D:\\ws\\预算.xlsx', '预算.xlsx'],
    ['D:\\ws\\无后缀.xlsx', 'D:\\ws\\无后缀.xlsx', '无后缀.xlsx'],
  ]
  for (const [suffix, path, fileName] of cases) {
    const h = '【批注 1 · 文件 · ' + suffix + '】'
    assert.deepEqual(parseDocSourceHeader(h), { path, line: null, page: null }, suffix)
    assert.equal(docFileNameOfHeader(h), fileName, suffix)
    assert.equal(buildQuoteHeader({ filePath: '', excel: null }) === '', true)
  }
})

test('位置行边界：路径含「】」、sheet 名读不到、非 Excel 文件的冒号不能被误剥', () => {
  // 路径里带「】」时按最后一个「】」收尾，别把路径截断
  const h1 = '【批注 1 · 文件 · D:\\ws\\预算】2026.xlsx:Sheet1!A1】'
  assert.deepEqual(parseDocSourceHeader(h1), { path: 'D:\\ws\\预算】2026.xlsx', line: null, page: null })
  assert.equal(docFileNameOfHeader(h1), '预算】2026.xlsx')
  // 读不到 sheet 名时生成 `:!A1`，不会被当成行号/页码
  assert.equal(excelLocationOf('', 'A1'), '!A1')
  assert.equal(excelLocationOf('', '3:5'), '!3:5')
  const h2 = '【批注 2 · 文件 · D:\\ws\\预算.xlsx:!A1:C3】'
  assert.deepEqual(parseDocSourceHeader(h2), { path: 'D:\\ws\\预算.xlsx', line: null, page: null })
  assert.equal(docFileNameOfHeader(h2), '预算.xlsx')
  // 非 Excel 文件里的「名字:2024」是路径的一部分，stripExcelSourceSuffix 不能动它
  assert.equal(stripExcelSourceSuffix('D:\\ws\\文件.txt:2024'), 'D:\\ws\\文件.txt:2024')
  assert.equal(stripExcelSourceSuffix('D:\\ws\\预算.xlsx:Sheet1!A1'), 'D:\\ws\\预算.xlsx')
  assert.equal(stripExcelSourceSuffix('D:\\ws\\预算.xlsx:B:D'), 'D:\\ws\\预算.xlsx')
})

// ---------- English localization: fake optional locale service, no preference changes ----------

const EN_REPLY_INSTRUCTION = ' (Reply to each annotation using "Annotation 1:", "Annotation 2:", etc.)'

function bindTestLocale(locale) {
  const log = console.log
  console.log = () => {} // Binding a locale without slots is expected; omit apply diagnostics.
  try {
    api.apply({ get: (name) => name === 'locale' ? locale : undefined })
  } finally {
    console.log = log
  }
}

function withTestLocale(active, run) {
  const locale = { getLocale: () => ({ active }), subscribe: () => () => {} }
  bindTestLocale(locale)
  try {
    return run(locale)
  } finally {
    bindTestLocale(undefined)
  }
}

test('locale: absent optional service preserves Chinese; host locales choose translated text', () => {
  assert.equal(api.__test.localeId(), 'zh-CN')
  assert.equal(api.__test.tr('中文', 'English'), '中文')
  const unsubscribe = api.__test.subscribeLocale(() => assert.fail('No service should emit a change'))
  assert.equal(typeof unsubscribe, 'function')
  unsubscribe()
  for (const active of ['zh', 'zh-CN', 'zh-TW', 'zh-Hant-CN', 'ZH-cn']) {
    withTestLocale(active, () => {
      assert.equal(api.__test.localeId(), active)
      assert.equal(api.__test.tr('中文', 'English'), '中文', active)
    })
  }
  for (const active of ['en', 'en-US', 'en-GB', 'fr-FR']) {
    withTestLocale(active, () => {
      assert.equal(api.__test.localeId(), active)
      assert.equal(api.__test.tr('中文', 'English'), 'English', active)
    })
  }
  assert.equal(api.__test.localeId(), 'zh-CN')
})

test('locale: subscription delegates to the host and observes a language switch', () => {
  let active = 'zh-CN'
  let listener = null
  let unsubscribed = false
  let changes = 0
  const locale = {
    getLocale: () => ({ active }),
    subscribe(fn) {
      listener = fn
      return () => { unsubscribed = true; listener = null }
    },
  }
  bindTestLocale(locale)
  let unsubscribe
  try {
    const onChange = () => { changes += 1 }
    unsubscribe = api.__test.subscribeLocale(onChange)
    assert.equal(listener, onChange)
    assert.equal(api.__test.tr('批注', 'Annotate'), '批注')
    active = 'en-US'
    listener()
    assert.equal(changes, 1)
    assert.equal(api.__test.localeId(), 'en-US')
    assert.equal(api.__test.tr('批注', 'Annotate'), 'Annotate')
  } finally {
    if (unsubscribe) unsubscribe()
    bindTestLocale(undefined)
  }
  assert.equal(unsubscribed, true)
  assert.equal(listener, null)
  assert.equal(api.__test.tr('批注', 'Annotate'), '批注')
})

test('English chat: generated header, comment and reply instruction round-trip without translating content', () => {
  withTestLocale('en-US', () => {
    const quote = 'Quoted 用户 text\n\nSecond paragraph — naïve 🙂'
    const comment = 'Please keep 批注 and 文件 literally'
    const raw = renderAnnotationBlock({ turn: 34, kind: 'assistant-step', quote, comment }, 1, { instruction: true })
    assert.equal(raw, '【Annotation 1 · Turn 35 · DSH reply' + EN_REPLY_INSTRUCTION + '】\n' + quote + '\n\nComment: ' + comment)
    const parsed = parseQuoteBlock(raw)
    assert.equal(parsed.no, 1)
    assert.equal(parsed.quote, quote)
    assert.equal(parsed.comment, comment)
    assert.equal(snippetOf(raw), quote.replace(/\s+/g, ' ').trim())
    assert.equal(nextAnnotationNo(raw), 2)
    assert.equal(annotationNoOf(parsed.header), 1)
    assert.equal(roleText('user'), 'Your message')
    assert.equal(roleText('tool-call'), 'Tool call')
    assert.equal(anchorLabelOf({ turn: 0, role: 'user' }), 'Turn 1 · Your message')
    assert.equal(buildQuoteHeader({ turn: 0, role: 'user' }), '【Quote · Turn 1 · Your message】')
    assert.equal(buildQuoteHeader({}), '')
    assert.equal(noteWhereLabel({ page: 3 }), 'Page 3')
    assert.equal(noteWhereLabel({ line: 12 }), 'Line 12')
    assert.equal(noteWhereLabel({ page: 3, excel: { ref: 'A1' } }), '')
  })
})

test('Bilingual parsing: Chinese and English sent blocks work independently of the active locale', () => {
  const fixtures = [
    ['【批注 4 · 第2轮 · 你的消息（请按「Annotation 1：」「Annotation 2：」…逐条回应）】\n中文 quote\n\n批注：Keep 原文', 4, '中文 quote', 'Keep 原文'],
    ['【Annotation 7 · Turn 3 · DSH reply' + EN_REPLY_INSTRUCTION + '】\nEnglish 原文\n\nComment: 用户 comment', 7, 'English 原文', '用户 comment'],
    ['【引用 · 第1轮 · 你的消息】\nLegacy 中文 quote\n\n批注:旧评语', null, 'Legacy 中文 quote', '旧评语'],
    ['【Quote · Turn 1 · Your message】\nLegacy English quote\n\nComment:legacy comment', null, 'Legacy English quote', 'legacy comment'],
  ]
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      for (const [raw, no, quote, comment] of fixtures) {
        const parsed = parseQuoteBlock(raw)
        assert.ok(parsed, active + ': ' + raw)
        assert.equal(parsed.no, no)
        assert.equal(parsed.quote, quote)
        assert.equal(parsed.comment, comment)
        assert.equal(annotationNoOf(parsed.header), no)
        assert.equal(draftHasAnnotation(raw, { quote }), true)
      }
    })
  }
})

test('Mixed-language drafts: renumbering preserves header languages and is idempotent after a locale switch', () => {
  const chinese = '【批注 8 · 第2轮 · 你的消息（请按「Annotation 1：」「Annotation 2：」…逐条回应）】\n中文原文\n\n批注：中文评语'
  const english = '【Annotation 12 · Turn 4 · DSH reply' + EN_REPLY_INSTRUCTION + '】\nEnglish quote\n\nComment: English comment'
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      for (const blocks of [[chinese, english], [english, chinese]]) {
        const raw = 'User introduction 用户\n\n' + blocks.join('\n\n') + '\n\nUser ending 用户'
        assert.equal(nextAnnotationNo(raw), 13)
        const once = renumberAnnotationsInDraft(raw)
        assert.equal(renumberAnnotationsInDraft(once), once)
        assert.ok(once.startsWith('User introduction 用户\n\n'))
        assert.ok(once.endsWith('\n\nUser ending 用户'))
        assert.equal((once.match(/请按「Annotation|Reply to each annotation using/g) || []).length, 1)
        if (blocks[0] === chinese) {
          assert.ok(once.includes('【批注 1 · 第2轮 · 你的消息（请按「Annotation'))
          assert.ok(once.includes('【Annotation 2 · Turn 4 · DSH reply】'))
        } else {
          assert.ok(once.includes('【Annotation 1 · Turn 4 · DSH reply' + EN_REPLY_INSTRUCTION + '】'))
          assert.ok(once.includes('【批注 2 · 第2轮 · 你的消息】'))
        }
        assert.equal(nextAnnotationNo(once), 3)
        assert.equal(stripQuoteBlocks(once), 'User introduction 用户\n\nUser ending 用户')
        const removedEnglish = removeBlockFromDraft(once, 'English quote', 'English comment')
        assert.equal(removedEnglish.includes('English quote'), false)
        assert.equal(removedEnglish.includes('Comment: English comment'), false)
        assert.ok(removedEnglish.includes('中文原文\n\n批注：中文评语'))
        assert.ok(removedEnglish.startsWith('User introduction 用户'))
        assert.ok(removedEnglish.endsWith('User ending 用户'))
        const removedChinese = removeBlockFromDraft(once, '中文原文', '中文评语')
        assert.equal(removedChinese.includes('中文原文'), false)
        assert.ok(removedChinese.includes('English quote\n\nComment: English comment'))
      }
    })
  }
})

test('English drafts: missing annotation numbers repair to the normal header format', () => {
  withTestLocale('en-US', () => {
    const missing = '【Annotation · Turn 2 · Your message】\nQuote\n\nComment: Keep me'
    const repaired = renumberAnnotationsInDraft(missing)
    assert.ok(repaired.startsWith('【Annotation 1 · Turn 2 · Your message' + EN_REPLY_INSTRUCTION + '】'))
    assert.equal(renumberAnnotationsInDraft(repaired), repaired)
  })
})

test('English drafts: orphan comments remove and commentless quotes preserve following prose', () => {
  withTestLocale('en-US', () => {
    assert.equal(removeBlockFromDraft('Comment: orphan 用户\nKeep me 原文', 'Missing quote', 'orphan 用户'), 'Keep me 原文')
    assert.equal(removeBlockFromDraft('Comment:orphan 用户\nKeep me 原文', 'Missing quote', 'orphan 用户'), 'Keep me 原文')
    const quote = 'First 用户 paragraph\n\nSecond 原文 paragraph'
    const ownText = 'This is my own 用户 sentence, not part of the quote.'
    const raw = renderAnnotationBlock({ turn: 0, role: 'user', quote }, 1) + '\n\n' + ownText
    assert.equal(stripQuoteBlocks(raw, [quote]), ownText)
    assert.equal(removeBlockFromDraft(ownText, 'Missing quote', ''), ownText)
    assert.equal(looksLikeQuoteFragment('Annotation 1 · Turn 2'), true)
    assert.equal(looksLikeQuoteFragment('Turn 3 · DSH reply'), true)
    assert.equal(looksLikeQuoteFragment('Turn 3 is incorrect'), false)
    assert.equal(looksLikeQuoteFragment('My Annotation 1 needs review'), false)
  })
})

test('Bilingual document headers: Unicode, ordinary parentheses, closing delimiters and source locations round-trip', () => {
  const path = 'notes/批注实验（预算） (draft)】2026.md'
  const quote = 'Quoted 用户 text\n\nSecond paragraph'
  const comment = 'Keep 用户 words and (ordinary parentheses)'
  const headers = []
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      const raw = buildDocNotesBatch([{ quote, comment, line: 133 }], { path })
      const header = raw.split('\n')[0]
      headers.push(header)
      assert.deepEqual(parseDocSourceHeader(header), { path, line: 133, page: null })
      assert.equal(docFileNameOfHeader(header), '批注实验（预算） (draft)】2026.md')
      const parsed = parseQuoteBlock(raw)
      assert.equal(parsed.header, header)
      assert.equal(parsed.quote, quote)
      assert.equal(parsed.comment, comment)
      if (active === 'en-US') {
        assert.equal(header, '【Annotation 1 · File · ' + path + ':L133' + EN_REPLY_INSTRUCTION + '】')
        assert.ok(raw.endsWith('\n\nComment: ' + comment))
        const later = buildDocNotesBatch([{ quote, comment, page: 4 }], { path, startNo: 3 })
        assert.ok(later.startsWith('【Annotation 3 · File · ' + path + ':p4】'))
        assert.equal(later.includes('Reply to each annotation using'), false)
      }
    })
  }
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      for (const header of headers) {
        assert.deepEqual(parseDocSourceHeader(header), { path, line: 133, page: null })
        assert.equal(docFileNameOfHeader(header), '批注实验（预算） (draft)】2026.md')
      }
    })
  }
})

test('English Excel headers: ranges, rows, columns and quoted sheet names retain the original Unicode path', () => {
  withTestLocale('en-US', () => {
    const path = 'D:\\审阅 (draft)\\预算】2026.xlsx'
    for (const [sheet, ref, kind] of [
      ['Sheet1', 'A1:C3', 'range'],
      ['2024 预算', 'B2', 'cell'],
      ["It's", '3:5', 'row'],
      ['Q1!', 'B:D', 'col'],
      ['', 'A1', 'cell'],
    ]) {
      const address = excelLocationOf(sheet, ref)
      const raw = buildDocNotesBatch([{ quote: address, comment: 'Keep 原文', excel: { sheet, ref, kind } }], { path })
      const header = raw.split('\n')[0]
      assert.equal(header, '【Annotation 1 · File · ' + path + ':' + address + EN_REPLY_INSTRUCTION + '】')
      assert.deepEqual(parseDocSourceHeader(header), { path, line: null, page: null })
      assert.equal(docFileNameOfHeader(header), '预算】2026.xlsx')
      assert.equal(parseQuoteBlock(raw).header, header)
      assert.equal(parseQuoteBlock(raw).quote, address)
      assert.equal(parseQuoteBlock(raw).comment, 'Keep 原文')
      assert.equal(docNotesStorageKey('en-session', path), 'en-session|' + path)
    }
    assert.equal(stripExcelSourceSuffix('D:\\ws\\用户 (draft).txt:2024'), 'D:\\ws\\用户 (draft).txt:2024')
  })
})

test('空评语：聊天和文件批注都保留可继续输入的评语行', () => {
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      const prefix = active === 'zh-CN' ? '批注：' : 'Comment: '
      for (const comment of [undefined, '', ' \t ']) {
        const entry = { turn: 0, kind: 'assistant-step', quote: '原文 Quote', comment }
        const chat = renderAnnotationBlock(entry, 1)
        const doc = buildDocNotesBatch([entry], { path: 'notes/review.md' })
        for (const raw of [chat, doc]) {
          assert.ok(raw.endsWith('\n\n' + prefix), raw)
          assert.equal(parseQuoteBlock(raw).quote, entry.quote)
          assert.equal(parseQuoteBlock(raw).comment, '')
          // 直接在评语行末尾输入，不需要重新打开批注浮框。
          assert.equal(parseQuoteBlock(raw + '稍后补写 Comment added later').comment, '稍后补写 Comment added later')
        }
      }
    })
  }
})

test('空评语：后续普通段落不属于原文或评语，取消批注也不丢字', () => {
  const quote = '第一段 Quote\n\n第二段 Quote'
  const followUp = '这是我的问题 My follow-up question'
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      const entry = { turn: 0, kind: 'assistant-step', quote, comment: '' }
      const chat = renderAnnotationBlock(entry, 1)
      const doc = buildDocNotesBatch([entry], { path: 'notes/review.md' })
      for (const block of [chat, doc]) {
        // 同时覆盖宿主清掉行尾空格后的草稿。
        for (const raw of [block, block.trimEnd()]) {
          const draft = raw + '\n\n' + followUp
          const parsed = parseQuoteBlock(draft)
          assert.equal(parsed.quote, quote)
          assert.equal(parsed.comment, '')
          assert.ok(parsed.rest.endsWith(followUp))
          assert.equal(snippetOf(raw), quote.replace(/\s+/g, ' '))
          assert.equal(stripQuoteBlocks(draft), followUp)
          assert.equal(removeBlockFromDraft(draft, quote, ''), followUp)
        }
      }
    })
  }
})

test('空评语：下一条批注的位置行不能被读成上一条评语', () => {
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      const entries = [
        { turn: 0, kind: 'user', quote: '原文 A', comment: '' },
        { turn: 1, kind: 'assistant-step', quote: '原文 B', comment: '评语 B' },
      ]
      const followUp = '保留用户文字 Keep this question'
      const draft = renderAnnotationSection(entries) + '\n\n' + followUp
      const first = parseQuoteBlock(draft)
      assert.equal(first.quote, entries[0].quote)
      assert.equal(first.comment, '')
      const secondHeader = first.rest.indexOf('【')
      assert.ok(secondHeader >= 0)
      const second = parseQuoteBlock(first.rest.slice(secondHeader))
      assert.equal(second.quote, entries[1].quote)
      assert.equal(second.comment, entries[1].comment)
      assert.equal(stripQuoteBlocks(draft), followUp)
    })
  }
})

test('草稿对账：插入新的聊天或文件批注时保留后来补写、修改或清空的评语', () => {
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      const prefix = active === 'zh-CN' ? '批注：' : 'Comment: '
      for (const [before, after] of [['', '后来补写 Later comment'], ['Old comment', 'Updated comment'], ['Old comment', '']]) {
        for (const added of [
          { turn: 1, kind: 'assistant-step', quote: 'New chat quote', comment: 'New comment' },
          { filePath: 'notes/review.md', quote: 'New file quote', comment: 'New comment' },
        ]) {
          const stored = { anchorKey: 'source-1', turn: 0, kind: 'user', quote: 'First paragraph\n\nSecond paragraph', comment: before }
          const own = 'Keep my follow-up 用户正文'
          const draft = renderAnnotationSection([stored]).replace(prefix + before, prefix + after) + own
          const kept = reconcileDraftAnnotations(draft, [stored])
          const ordered = sortAnnotations(kept.concat(added))
          const prose = stripQuoteBlocks(draft, ordered.map((e) => e.quote))
          const next = [prose, renderAnnotationSection(ordered)].filter((s) => s !== '').join('\n\n')
          assert.equal(parseQuoteBlock(next).comment, after)
          assert.deepEqual(kept[0], { ...stored, comment: after })
          assert.equal(stored.comment, before, '不能直接改写存储快照')
          assert.ok(next.includes(own))
          assert.ok(next.includes(added.quote))
        }
      }
    })
  }
})

test('草稿对账：重复原文的批注逐一匹配，不串评语', () => {
  for (const active of ['zh-CN', 'en-US']) {
    withTestLocale(active, () => {
      const stored = [
        { turn: 0, kind: 'user', quote: 'Repeated quote', comment: 'Old first' },
        { turn: 1, kind: 'user', quote: 'Repeated quote', comment: 'Old second' },
      ]
      const draft = renderAnnotationSection([{ ...stored[0], comment: 'Updated first' }, { ...stored[1], comment: '' }])
      const kept = reconcileDraftAnnotations(draft, stored)
      assert.deepEqual(kept.map((e) => e.comment), ['Updated first', ''])
      assert.deepEqual(stored.map((e) => e.comment), ['Old first', 'Old second'])
    })
  }
})

test('草稿对账：旧草稿无法精确拆块时保留元数据，已删除的原文不复活', () => {
  const legacy = { turn: 0, kind: 'user', quote: 'Legacy quote', comment: 'Saved comment' }
  const deleted = { turn: 1, kind: 'user', quote: 'Deleted quote', comment: 'Deleted comment' }
  const draft = '【引用 · 第1轮 · 你的消息】\nLegacy quote\n\nUnmarked legacy prose'
  assert.deepEqual(reconcileDraftAnnotations(draft, [legacy, deleted]), [legacy])
})

// 最小编辑器节点桩：运行真实 composer effect 与事件监听器，不模拟 React 或 Lexical。
function composerNode(tag, ...children) {
  if (tag === '#text') return { nodeType: 3, nodeValue: children[0], get textContent() { return this.nodeValue } }
  const classes = new Set()
  const attrs = new Map()
  const node = {
    ...fakeElement(), nodeType: 1, tagName: tag, nodeName: tag, childNodes: children, isConnected: true,
    get children() { return this.childNodes.filter((n) => n.nodeType === 1) },
    get textContent() { return this.childNodes.map((n) => n.textContent).join('') },
    get lastChild() { return this.childNodes.at(-1) || null },
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    },
    setAttribute: (name, value) => attrs.set(name, value),
    getAttribute: (name) => attrs.get(name) || null,
    removeAttribute: (name) => attrs.delete(name),
    contains(other) { return other === this || this.childNodes.some((n) => n === other || (n.contains && n.contains(other))) },
    closest(selector) {
      if (selector === '[contenteditable="true"]' && this.tagName === 'DIV') return this
      return this.parentElement ? this.parentElement.closest(selector) : null
    },
  }
  children.forEach((child, i) => {
    child.parentNode = child.parentElement = node
    child.previousSibling = children[i - 1] || null
  })
  return node
}

function withComposerLines(lines, run, services = {}) {
  const root = composerNode('DIV', ...lines)
  const saved = { querySelectorAll: document.querySelectorAll, activeElement: document.activeElement,
    addEventListener: document.addEventListener, removeEventListener: document.removeEventListener,
    getSelection: window.getSelection, log: console.log, setTimeout: globalThis.setTimeout }
  const timers = new Set()
  globalThis.setTimeout = (...args) => { const timer = saved.setTimeout(...args); timers.add(timer); return timer }
  const events = new Map()
  const effects = new Map()
  let range = null
  let dispose
  document.querySelectorAll = (selector) => selector === '[contenteditable="true"]' ? [root] : []
  document.activeElement = root
  document.addEventListener = (name, fn) => events.set(name, fn)
  document.removeEventListener = () => {}
  window.getSelection = () => range ? { rangeCount: 1, anchorNode: range.startContainer, getRangeAt: () => range } : null
  console.log = () => {}
  try {
    const slots = { register() {}, inject() {} }
    api.apply({ slots, get: (name) => name === 'slots' ? slots : services[name], effect: (fn, name) => effects.set(name, fn) })
    dispose = effects.get('dsh-quote-annotate-pro: composer quote decoration')()
    run({ root, events, press(node, offset, key = 'Backspace', beforeInput = false, endNode = node, endOffset = offset) {
      range = { startContainer: node, endContainer: endNode, startOffset: offset, endOffset,
        collapsed: node === endNode && offset === endOffset }
      let prevented = false
      events.get(beforeInput ? 'beforeinput' : 'keydown')({
        target: root, key, inputType: key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward',
        preventDefault() { prevented = true }, stopPropagation() {},
      })
      return prevented
    } })
  } finally {
    if (dispose) dispose()
    for (const timer of timers) clearTimeout(timer)
    globalThis.setTimeout = saved.setTimeout
    document.querySelectorAll = saved.querySelectorAll
    document.activeElement = saved.activeElement
    document.addEventListener = saved.addEventListener
    document.removeEventListener = saved.removeEventListener
    window.getSelection = saved.getSelection
    console.log = saved.log
    bindTestLocale(undefined)
  }
}

const composerTextLine = (text) => composerNode('P', composerNode('#text', text))

test('输入框：插入后有独立可编辑的空段落，不必在批注里回车才能继续写', () => {
  for (const comment of ['', '已有评语']) {
    const draft = renderAnnotationSection([{ turn: 0, kind: 'user', quote: '原文', comment }])
    assert.match(draft, /[^\n]\n$/, '插入内容必须恰好留一个普通空段落')
    withComposerLines(draft.split('\n').map(composerTextLine), ({ root, press }) => {
      const tail = root.lastChild
      assert.equal(tail.textContent, '')
      assert.equal(tail.classList.contains('dshq-cmp-quote'), false)
      assert.equal(tail.classList.contains('dshq-cmp-comment'), false)
      assert.equal(press(tail.childNodes[0], 0, 'x'), false)
    })
  }
})

function cancelComposerDraft(draft, item) {
  let next
  const input = { state: { getSnapshot: () => ({ draft }) }, setDraft: (value) => { next = value } }
  const services = {
    conversation: { input: { for: () => input } },
    sessions: { binding: () => ({ ctx: {} }) },
    sidebarRight: { mounted: { getSnapshot: () => 'composer-lifecycle-test' } },
  }
  withComposerLines(draft.split('\n').map(composerTextLine), () => {
    api.__test.cancelAnnotationBlock({ ...item, left: 0, top: 0 })
  }, services)
  assert.equal(typeof next, 'string', '必须实际运行取消按钮的草稿写入路径')
  return next
}

test('输入框生命周期：连续加入批注时中间没有普通空行，底部始终只有一行', () => {
  const entries = [
    { turn: 0, kind: 'user', quote: '原文 A', comment: '' },
    { turn: 1, kind: 'assistant-step', quote: '原文 B', comment: '评语 B' },
    { filePath: 'notes/review.md', quote: '文件原文 C\n\n保留原文内部空行', comment: '' },
  ]
  for (const active of ['zh-CN', 'en-US']) {
    for (let count = 1; count <= entries.length; count++) {
      const draft = withTestLocale(active, () => renderAnnotationSection(entries.slice(0, count)))
      assert.equal(/\n\n【(?:批注|Annotation)/.test(draft), false, '批注之间不能插入普通空段落')
      assert.match(draft, /[^\n]\n$/)
      withComposerLines(draft.split('\n').map(composerTextLine), ({ root }) => {
        const ordinaryEmpty = root.children.filter((line) => line.textContent === '' && !line.classList.contains('dshq-cmp-quote'))
        assert.equal(ordinaryEmpty.length, 1, '唯一的普通空段落应在批注区末尾')
        assert.equal(ordinaryEmpty[0], root.lastChild)
      })
    }
  }
})

test('输入框生命周期：取消第一、中间、最后一条后仍能在批注外打字', () => {
  const entries = [
    { turn: 0, kind: 'user', quote: '原文 A', comment: '' },
    { turn: 1, kind: 'assistant-step', quote: '原文 B', comment: '评语 B' },
    { filePath: 'notes/review.md', quote: '文件原文 C', comment: '' },
  ]
  for (const active of ['zh-CN', 'en-US']) {
    const draft = withTestLocale(active, () => renderAnnotationSection(entries))
    for (const entry of entries) {
      const next = cancelComposerDraft(draft, entry)
      assert.equal(next.includes(entry.quote), false)
      assert.match(next, /[^\n]\n$/, '取消后必须保留恰好一个底部空段落')
      const numbers = [...next.matchAll(/^【(?:批注|Annotation) (\d+)/gm)].map((m) => Number(m[1]))
      assert.deepEqual(numbers, [1, 2])
      withComposerLines(next.split('\n').map(composerTextLine), ({ root, press }) => {
        const tail = root.lastChild
        assert.equal(tail.textContent, '')
        assert.equal(tail.classList.contains('dshq-cmp-quote'), false)
        assert.equal(tail.classList.contains('dshq-cmp-comment'), false)
        assert.equal(press(tail.childNodes[0], 0, 'x'), false)
      })
    }
    let remaining = draft
    for (const entry of entries) remaining = cancelComposerDraft(remaining, entry)
    assert.equal(remaining, '', '最后一条取消后回到原生空输入框，不残留空段落或协议')
  }
})

test('输入框生命周期：取消批注保留用户正文，旧草稿也补回可编辑尾行', () => {
  const entry = { turn: 0, kind: 'user', quote: '原文 A', comment: '' }
  const other = { turn: 1, kind: 'assistant-step', quote: '原文 B', comment: '评语 B' }
  const followUp = '用户自己的后续问题 Keep my text'
  const draft = renderAnnotationSection([entry, other]) + followUp
  const next = cancelComposerDraft(draft, entry)
  assert.ok(next.includes(followUp))
  assert.match(next, /[^\n]\n$/)
  assert.equal(cancelComposerDraft(next, other), followUp)
  const legacy = renderAnnotationSection([entry, other]).trimEnd()
  assert.match(cancelComposerDraft(legacy, entry), /[^\n]\n$/)
})

test('X 取消：原文与空评语之间有多个空行时不残留 Comment 前缀', () => {
  const quote = '要取消的原文 Quote to remove'
  const own = '保留用户正文 Keep this question'
  for (const active of ['zh-CN', 'en-US']) {
    const header = withTestLocale(active, () => buildQuoteHeader({ turn: 0, kind: 'user' }, 1))
    const prefix = active === 'zh-CN' ? '批注：' : 'Comment:'
    for (const gap of [2, 4, 8]) {
      const draft = header + '\n' + quote + '\n'.repeat(gap) + prefix + '\n' + own
      assert.equal(cancelComposerDraft(draft, { quote, comment: '' }), own, active + ': gap=' + gap)
    }
  }
})

test('X 取消：评语被编辑或清空后，旧按钮快照不能留下评语行', () => {
  const quote = '要取消的原文 Quote to remove'
  const own = '保留用户正文 Keep this question'
  for (const active of ['zh-CN', 'en-US']) {
    const header = withTestLocale(active, () => buildQuoteHeader({ turn: 0, kind: 'user' }, 1))
    const prefix = active === 'zh-CN' ? '批注：' : 'Comment:'
    for (const comment of ['', '更新后的评语 Edited comment']) {
      const draft = header + '\n' + quote + '\n\n' + prefix + comment + '\n' + own
      assert.equal(cancelComposerDraft(draft, { quote, comment: '旧评语 Stale comment' }), own)
    }
  }
})

test('X 取消：位置行与原文之间有多个空行时也完整移除批注', () => {
  const quote = '要取消的原文 Quote to remove'
  const own = '保留用户正文 Keep this question'
  for (const active of ['zh-CN', 'en-US']) {
    const header = withTestLocale(active, () => buildQuoteHeader({ turn: 0, kind: 'user' }, 1))
    const prefix = active === 'zh-CN' ? '批注：' : 'Comment:'
    const draft = header + '\n'.repeat(8) + quote + '\n\n' + prefix + '\n' + own
    assert.equal(cancelComposerDraft(draft, { quote, comment: '' }), own)
  }
})

test('X 取消：清掉目标评语行时保留下一条批注及其评语', () => {
  const quote = '要取消的原文 Quote to remove'
  const other = { turn: 1, kind: 'assistant-step', quote: '保留的原文 Keep this quote', comment: '保留评语 Keep this comment' }
  const own = '保留用户正文 Keep this question'
  for (const active of ['zh-CN', 'en-US']) {
    const header = withTestLocale(active, () => buildQuoteHeader({ turn: 0, kind: 'user' }, 1))
    const next = withTestLocale(active, () => renderAnnotationBlock(other, 2))
    const prefix = active === 'zh-CN' ? '批注：' : 'Comment:'
    for (const marker of [prefix + '\n', '']) {
      // 目标没有评语行时也不能跨过下一条位置行，误删另一条的评语。
      const draft = header + '\n' + quote + '\n'.repeat(8) + marker + next + '\n' + own
      const out = cancelComposerDraft(draft, { quote, comment: '旧评语 Stale comment' })
      assert.equal(out.includes(quote), false)
      assert.ok(out.includes(other.quote))
      assert.ok(out.includes(other.comment))
      assert.ok(out.includes(own))
      assert.equal(out.split('\n').filter((line) => /^(?:批注[:：]|Comment:)/.test(line.trim())).length, 1)
      assert.match(out, /[^\n]\n$/)
    }
  }
})

test('X 取消：没有位置行时不扩大删除范围，保留不匹配的普通 Comment 文字', () => {
  const quote = '要取消的原文 Quote to remove'
  const own = 'Comment: 这是普通用户文字，不是旧评语\nKeep my question'
  const draft = quote + '\n\n' + own
  assert.equal(cancelComposerDraft(draft, { quote, comment: '旧评语 Stale comment' }), own)
})

test('输入框：批注内软换行后的退格不能误报为删除评语前缀', () => {
  for (const prefix of ['批注：', 'Comment:']) {
    for (const beforeInput of [false, true]) {
      const continuation = composerNode('#text', '')
      const comment = composerNode('P', composerNode('#text', prefix), composerNode('BR'), continuation, composerNode('BR'))
      withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), composerTextLine('原文'), composerTextLine(''), comment], ({ press }) => {
        assert.equal(press(continuation, 0, 'Backspace', beforeInput), false)
        assert.equal(press(comment, 2, 'Backspace', beforeInput), false) // 空行光标也可能落在 <p> 的子节点间。
        assert.equal(press(comment.childNodes[0], prefix.length, 'Backspace', beforeInput), true)
      })
    }
  }
})

test('输入框：评语后的额外空段落可退格，不能跳过空行误判为结构删除', () => {
  for (const beforeInput of [false, true]) {
    const empty = composerTextLine('')
    withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), composerTextLine('原文'), composerTextLine('Comment: note'), empty, composerTextLine('')], ({ press }) => {
      assert.equal(press(empty.childNodes[0], 0, 'Backspace', beforeInput), false)
    })
    const blank = composerTextLine('')
    withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), composerTextLine(''), blank], ({ press }) => {
      assert.equal(press(blank.childNodes[0], 0, 'Backspace', beforeInput), false)
    })
  }
})

test('输入框：删除引用与评语之间的空段落后仍保留批注装饰', () => {
  for (const prefix of ['批注：', 'Comment:']) {
    for (const beforeInput of [false, true]) {
      const quote = composerTextLine('Quoted text')
      const gap = composerTextLine('')
      const comment = composerTextLine(prefix + ' editable')
      withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), quote, gap, comment, composerTextLine('')], ({ root, events, press }) => {
        assert.equal(quote.classList.contains('dshq-cmp-quote'), true)
        assert.equal(press(quote.childNodes[0], quote.textContent.length, 'Delete', beforeInput), false)
        // 模拟原生 Delete 移除空段落，再运行插件实际注册的重装饰回调。
        root.childNodes.splice(2, 1)
        root.childNodes.forEach((node, i) => { node.previousSibling = root.childNodes[i - 1] || null })
        gap.parentNode = gap.parentElement = null
        events.get('selectionchange')()
        assert.equal(quote.classList.contains('dshq-cmp-quote'), true)
        assert.equal(comment.classList.contains('dshq-cmp-comment'), true)
        assert.equal(comment.classList.contains('dshq-cmp-orphan'), false)
        assert.equal(press(quote.childNodes[0], quote.textContent.length, 'Delete', beforeInput), true)
      })
    }
  }
})

test('输入框：选中末尾段落分隔再删除也不能丢掉输入行', () => {
  for (const prefix of ['批注：', 'Comment:']) {
    for (const beforeInput of [false, true]) {
      const comment = composerTextLine(prefix + ' editable')
      const tail = composerNode('P', composerNode('BR'))
      withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), composerTextLine('Quote'), composerTextLine(''), comment, tail], ({ press }) => {
        for (const key of ['Backspace', 'Delete']) {
          assert.equal(press(comment.childNodes[0], comment.textContent.length, key, beforeInput, tail, 0), true)
          assert.equal(press(comment.childNodes[0], prefix.length + 1, key, beforeInput, comment.childNodes[0], comment.textContent.length), false)
        }
      })
    }
  }
})

test('输入框：末尾输入行不能被 Backspace 或 Delete 并进最后一条批注', () => {
  for (const prefix of ['批注：', 'Comment:']) {
    for (const beforeInput of [false, true]) {
      for (const placeholder of [false, true]) {
        const comment = composerTextLine(prefix + ' editable')
        const tail = placeholder ? composerNode('P', composerNode('BR')) : composerTextLine('')
        withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), composerTextLine('原文'), composerTextLine(''), comment, tail], ({ press }) => {
          assert.equal(press(tail, 0, 'Backspace', beforeInput), true)
          assert.equal(press(comment.childNodes[0], comment.textContent.length, 'Delete', beforeInput), true)
          assert.equal(press(tail, 0, 'x'), false, '保留的尾行仍可打字')
          assert.equal(press(comment.childNodes[0], comment.textContent.length, 'Backspace', beforeInput), false, '评语正文仍可编辑')
        })
      }
    }
  }
})

test('输入框：非尾行的普通正文和额外空行仍可正常退格', () => {
  for (const beforeInput of [false, true]) {
    const extra = composerTextLine('')
    const tail = composerTextLine('')
    withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), composerTextLine('原文'), composerTextLine('Comment: note'), extra, tail], ({ press }) => {
      assert.equal(press(tail, 0, 'Backspace', beforeInput), false, '两个空段落可合并为一个')
    })
    const own = composerTextLine('My follow-up')
    const afterOwn = composerTextLine('')
    withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), composerTextLine('原文'), composerTextLine('Comment: note'), own, afterOwn], ({ press }) => {
      assert.equal(press(own.childNodes[0], own.textContent.length, 'Backspace', beforeInput), false)
      assert.equal(press(afterOwn, 0, 'Backspace', beforeInput), false, '普通正文后不需要额外保护空行')
    })
    const empty = composerNode('P', composerNode('BR'))
    withComposerLines([empty], ({ press }) => {
      assert.equal(press(empty, 0, 'Backspace', beforeInput), false, '无批注时保持原生行为')
    })
  }
})

test('输入框：DOM 拆分文本节点后按整行坐标保护前缀，正常文字仍可删除', () => {
  const text = composerNode('#text', 'editable')
  const line = composerNode('P', composerNode('SPAN', composerNode('#text', 'Comment: ')), composerNode('SPAN', text))
  withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), composerTextLine('原文'), line], ({ press }) => {
    assert.equal(press(text, 0), false)
    assert.equal(press(text, 0, 'Backspace', true), false)
    assert.equal(press(line.childNodes[0].childNodes[0], 8), true)
  })
})

test('输入框：Delete 可删软换行，但仍保护带占位 br 的行末结构', () => {
  for (const beforeInput of [false, true]) {
    const first = composerNode('#text', 'A')
    const last = composerNode('#text', 'B')
    const quote = composerNode('P', first, composerNode('BR'), last, composerNode('BR'))
    const empty = composerNode('P', composerNode('BR'))
    withComposerLines([composerTextLine('【Annotation 1 · Turn 1】'), quote, composerTextLine('Comment: note'), empty, composerTextLine('【Annotation 2 · Turn 2】')], ({ press }) => {
      assert.equal(press(first, 1, 'Delete', beforeInput), false)
      assert.equal(press(last, 1, 'Delete', beforeInput), true)
      assert.equal(press(empty, 0, 'Backspace', beforeInput), false)
      assert.equal(press(empty, 0, 'Delete', beforeInput), true)
    })
  }
})

test('输入框：仍保护位置行以及原文与评语之间的真实结构边界', () => {
  const header = composerTextLine('【Annotation 1 · Turn 1】')
  const quote = composerTextLine('原文')
  const comment = composerTextLine('Comment: note')
  withComposerLines([header, quote, comment], ({ press }) => {
    assert.equal(press(header.childNodes[0], 3), true)
    assert.equal(press(quote.childNodes[0], 0), true)
    assert.equal(press(quote.childNodes[0], 2, 'Delete'), true)
    assert.equal(press(comment.childNodes[0], 0), true)
  })
})

// Run the real selection listener and toolbar in an isolated minimal DOM.
function selectionElement(attrs = {}, ...children) {
  const matches = (node, selector) => selector.split(',').some((part) => {
    const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part.trim())
    return attr && Object.hasOwn(node.attrs, attr[1]) && (attr[2] === undefined || node.attrs[attr[1]] === attr[2])
  })
  const node = {
    nodeType: 1, attrs, children, parentElement: null,
    getAttribute(name) { return this.attrs[name] ?? null },
    closest(selector) {
      for (let el = this; el; el = el.parentElement) if (matches(el, selector)) return el
      return null
    },
    querySelector(selector) {
      for (const child of this.children) {
        if (child.nodeType !== 1) continue
        if (matches(child, selector)) return child
        const found = child.querySelector(selector)
        if (found) return found
      }
      return null
    },
  }
  for (const child of children) child.parentElement = node
  return node
}

function selectionFixture({ previewOpen = true, previewEditable = false, composerEditable = true } = {}) {
  const textNode = () => ({ nodeType: 3, parentElement: null })
  const message = textNode()
  const own = textNode()
  const quote = textNode()
  const comment = textNode()
  const preview = textNode()
  const row = selectionElement({ 'data-chat-anchor-key': 'reply-1', 'data-chat-turn': '0', 'data-chat-flow-kind': 'assistant-step' }, message)
  const composer = selectionElement({ 'data-composer-input': 'true', contenteditable: String(composerEditable) },
    selectionElement({}, own), selectionElement({}, selectionElement({}, quote)), selectionElement({}, comment))
  const documentRoot = selectionElement({ 'data-textpreview-url': 'dsh-resource://absolute/review.md' },
    selectionElement(previewEditable ? { contenteditable: 'true' } : {}, preview))
  const app = selectionElement({}, row, composer, ...(previewOpen ? [documentRoot] : []))
  const body = selectionElement({}, app)
  const events = new Map()
  const effects = new Map()
  const components = new Map()
  const frames = new Map()
  const timers = new Map()
  let sequence = 0
  let currentSelection = null
  let captured
  const document = {
    body,
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name) => events.delete(name),
  }
  const window = {
    __ModuleLoader__: { load: (spec) => { captured = spec } },
    getSelection: () => currentSelection,
    addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800,
  }
  runInNewContext(SOURCE, {
    window, document, console: { log() {} },
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id },
    cancelAnimationFrame: (id) => frames.delete(id),
  })
  const React = {
    useSyncExternalStore() {}, useEffect() {}, useState: () => [0, () => {}],
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const api = captured.factory(() => React)
  const slots = {
    inject: (_name, register) => register(),
    register: (options, component) => components.set(options.id, component),
  }
  api.apply({
    get: (name) => name === 'slots' ? slots : undefined,
    effect: (fn, name) => effects.set(name, fn),
  })
  const dispose = effects.get('dsh-quote-annotate-pro: global listeners')()
  const toolbar = () => components.get('quote-pro-selection-toolbar')({})
  return {
    message, own, quote, comment, preview, composer, app, toolbar, dispose,
    select(start, end = start, commonAncestor = start.parentElement, backward = false) {
      const range = {
        startContainer: start, endContainer: end, commonAncestorContainer: commonAncestor,
        getBoundingClientRect: () => ({ left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 }),
      }
      currentSelection = {
        rangeCount: 1, isCollapsed: false, anchorNode: backward ? end : start,
        toString: () => 'Selected text', getRangeAt: () => range,
      }
      events.get('selectionchange')()
      for (const [id, fn] of frames) { frames.delete(id); fn() }
      return toolbar()
    },
  }
}

test('chat selections still offer annotations with a preview open or closed', () => {
  for (const previewOpen of [false, true]) {
    const f = selectionFixture({ previewOpen })
    try {
      assert.equal(f.select(f.message).props.className, 'dshq-toolbar')
    } finally { f.dispose() }
  }
})

test('composer prose, inserted quotes and comments do not offer annotations', () => {
  for (const previewOpen of [false, true]) {
    const f = selectionFixture({ previewOpen })
    try {
      for (const node of [f.own, f.quote, f.comment]) {
        assert.equal(f.select(node), null)
      }
      assert.equal(f.select(f.own, f.comment, f.composer), null, 'multi-paragraph selection')
    } finally { f.dispose() }
  }
})

test('entering the composer immediately hides the previous chat toolbar', () => {
  const f = selectionFixture()
  try {
    assert.ok(f.select(f.message))
    assert.equal(f.select(f.own), null, 'do not leave a stale toolbar until the hide timer runs')
    assert.ok(f.select(f.message), 'chat annotations remain available afterward')
  } finally { f.dispose() }
})

test('selections spanning the composer boundary are ignored in either direction', () => {
  const f = selectionFixture()
  try {
    for (const backward of [false, true]) {
      assert.equal(f.select(f.message, f.own, f.app, backward), null, 'range ends in composer')
      assert.equal(f.select(f.own, f.preview, f.app, backward), null, 'range starts in composer')
    }
  } finally { f.dispose() }
})

test('the composer marker also excludes selections while the editor is disabled', () => {
  const f = selectionFixture({ composerEditable: false })
  try {
    assert.equal(f.select(f.own), null)
  } finally { f.dispose() }
})

test('read-only and editable document previews still offer annotations', () => {
  for (const previewEditable of [false, true]) {
    const f = selectionFixture({ previewEditable })
    try {
      assert.equal(f.select(f.preview).props.className, 'dshq-toolbar')
    } finally { f.dispose() }
  }
})

test('Display resources: both locales and the existing icon are exported and packaged', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './docs/images/icon-180.png')
  assert.ok(pkg.files.includes('locale'))
  assert.ok(pkg.files.includes('docs'))
  for (const language of ['en', 'zh']) {
    const dict = JSON.parse(readFileSync(new URL('../locale/' + language + '.json', import.meta.url), 'utf8'))
    assert.deepEqual(Object.keys(dict.meta).sort(), ['description', 'title'])
    assert.ok(dict.meta.title.trim())
    assert.ok(dict.meta.description.trim())
  }
  const icon = readFileSync(new URL('../docs/images/icon-180.png', import.meta.url))
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(icon.length <= 256 * 1024)
})
