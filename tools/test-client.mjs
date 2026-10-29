// 客户端 bundle 的纯函数自检（不依赖浏览器 DOM / 网络）
// 运行：npm test   （node tools/test-client.mjs）
//
// 做法：给 client.js 提供最小化的 window/document/localStorage/fetch 桩，
// 捕获 window.__ModuleLoader__.load(...) 注册的工厂，再调用工厂拿到 exports，
// 然后断言 exports.__test 里的纯函数。这些函数是消息解析与编号的核心，回归风险最高。
import { readFileSync } from 'node:fs'
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
  stripQuoteBlocks, renderAnnotationBlock, renderAnnotationSection, sortAnnotations, draftHasAnnotation,
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
  // 没有评语时不留空的「批注：」行；没有位置信息时只剩编号
  assert.equal(renderAnnotationBlock({ quote: 'Q' }, 3), '【批注 3】\nQ')
})

test('renderAnnotationSection：重编号 1..N，只有首条带指令', () => {
  assert.equal(renderAnnotationSection([]), '')
  const out = renderAnnotationSection([
    { turn: 0, kind: 'user', quote: 'A', comment: 'a' },
    { turn: 2, kind: 'assistant-step', quote: 'B', comment: '' },
  ])
  const blocks = out.split('\n\n【批注')
  assert.equal(blocks.length, 2)
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
    + '\n\n【批注 2 · 文件 · ' + path + ':L12】\n第二段原文'
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
