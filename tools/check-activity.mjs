#!/usr/bin/env node
/**
 * 一眼看完仓库的所有「需要我动手」的信号：
 *   1. open PR（含 draft、mergeable 状态、改动行数）
 *   2. 四个 fork 的 compare —— 有人只推 fork 不开 PR 时，只有靠这里才能发现
 *   3. open issue（含评论数，判断是不是等回复）
 *   4. 仓库热度 + 最近一次 push
 *   5. npm 上最新版本
 *
 * 用法：
 *   node tools/check-activity.mjs                 # 默认仓库 zhao-guang-ai/dsh-quote-annotate-pro
 *   node tools/check-activity.mjs owner/repo      # 查别的仓库
 *
 * 需要本机 gh 已登录（`gh auth status` 通）。只读，不发任何写请求。
 */
import { execFileSync } from 'node:child_process'

const REPO = process.argv[2] || 'zhao-guang-ai/dsh-quote-annotate-pro'
const PKG = 'dsh-quote-annotate-pro'

function gh(args) {
  let lastErr = null
  for (let i = 0; i < 2; i++) {
    try {
      return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim()
    } catch (e) {
      lastErr = e
      // 网络抖动重试一次
    }
  }
  const msg = String((lastErr && (lastErr.stderr || lastErr.message)) || 'gh 调用失败').trim()
  throw new Error(msg.split('\n')[0])
}

function ghJson(args) {
  const out = gh(args)
  return out === '' ? null : JSON.parse(out)
}

function tryGh(args) {
  try {
    return ghJson(args)
  } catch {
    return null
  }
}

function line(s = '') {
  console.log(s)
}

function head(title) {
  line('')
  line(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

// 本地 main 的提交标题（用于判断 fork 上的提交内容是否已经上游化）
let cachedSubjects = null
function mainSubjects() {
  if (cachedSubjects) return cachedSubjects
  try {
    const out = execFileSync('git', ['log', '--format=%s', '-n', '400', 'HEAD'], { encoding: 'utf8', timeout: 30000 })
    cachedSubjects = out.split('\n').map((x) => x.trim()).filter(Boolean)
  } catch {
    cachedSubjects = []
  }
  return cachedSubjects
}

/** 去掉版本号后缀再比较，避免 `fix: x (0.3.12)` 与 `fix: x（上游化 0.3.12）` 对不上 */
function normalizeSubject(s) {
  return String(s || '')
    .replace(/[（(]\s*[0-9]+\.[0-9]+(?:\.[0-9]+)?\s*[)）]\s*$/,'')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从标题里切出够长的中文片段（>= 6 个字），用来做「是否已上游」的模糊比对 */
function cjkChunks(s) {
  const out = []
  const re = /[\u4e00-\u9fff]{6,}/g
  let m
  while ((m = re.exec(String(s || ''))) !== null) {
    // 长片段再按 6 字滑窗切开，迁就标题被改写过的情况
    const t = m[0]
    for (let i = 0; i + 6 <= t.length; i += 3) out.push(t.slice(i, i + 6))
  }
  return out
}

function isPorted(subject, subjects) {
  const mine = normalizeSubject(subject)
  if (mine === '') return true
  const chunks = cjkChunks(mine)
  if (chunks.length === 0) {
    const key = mine.slice(0, 24).toLowerCase()
    return subjects.some((s) => normalizeSubject(s).toLowerCase().indexOf(key) !== -1)
  }
  const haystack = subjects.map((s) => String(s).replace(/\s+/g, '')).join('\u0000')
  return chunks.some((c) => haystack.indexOf(c) !== -1)
}

/** 手工登记的「已上游」fork 提交（标题被改写、模糊比对认不出来时就靠它） */
let cachedRegistry = null
function upstreamedShas() {
  if (cachedRegistry) return cachedRegistry
  cachedRegistry = new Set()
  try {
    const fsmod = execFileSync('node', ['-p', "require('fs').readFileSync('tools/upstreamed-forks.json','utf8')"], { encoding: 'utf8', timeout: 15000 })
    const data = JSON.parse(fsmod)
    for (const sha of data.shas || []) cachedRegistry.add(String(sha).slice(0, 7))
  } catch {
    /* 没有登记文件就只靠标题比对 */
  }
  return cachedRegistry
}

const problems = []

// ---------- 1. open PR ----------
head(`open PR（${REPO}）`)
const prs = tryGh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '30', '--json',
  'number,title,author,headRefName,createdAt,isDraft,additions,deletions,changedFiles,mergeable,reviewDecision'])
if (!prs) {
  line('  (查询失败，跳过)')
  problems.push('open PR 查询失败')
} else if (prs.length === 0) {
  line('  没有待审 PR。')
} else {
  for (const p of prs) {
    const flags = [p.isDraft ? 'draft' : null, p.mergeable === 'CONFLICTING' ? 'CONFLICT' : null,
      p.reviewDecision ? `review=${p.reviewDecision}` : null].filter(Boolean).join(' ')
    line(`  #${p.number} ${p.title}`)
    line(`      @${p.author.login} · ${p.headRefName} · ${p.changedFiles} 文件 +${p.additions}/-${p.deletions} · ${p.createdAt} ${flags}`)
  }
  problems.push(`${prs.length} 个 PR 待审`)
}

// ---------- 2. fork compare ----------
head('fork 活动（重点：有人只推 fork 不开 PR）')
const forks = tryGh(['api', `repos/${REPO}/forks?per_page=100&sort=newest`])
if (!forks) {
  line('  (查询失败，跳过)')
  problems.push('fork 列表查询失败')
} else if (forks.length === 0) {
  line('  还没有 fork。')
} else {
  for (const f of forks) {
    const owner = f.owner.login
    const cmp = tryGh(['api', `repos/${REPO}/compare/main...${owner}:main`])
    if (!cmp) {
      line(`  ${owner.padEnd(14)} compare 失败`)
      continue
    }
    const ahead = cmp.ahead_by
    const commits = (cmp.commits || []).map((c) => ({
      sha: c.sha.slice(0, 7),
      subject: String(c.commit && c.commit.message ? c.commit.message.split(String.fromCharCode(10))[0] : ''),
    }))
    const upstreamSubjects = mainSubjects()
    const registry = upstreamedShas()
    const portedOf = (c) => registry.has(c.sha) || isPorted(c.subject, upstreamSubjects)
    const missing = commits.filter((c) => !portedOf(c))
    line(`  ${owner.padEnd(14)} ahead=${ahead} behind=${cmp.behind_by} pushed=${f.pushed_at}`)
    for (const c of commits.slice(0, 8)) {
      line(`      · ${c.sha} ${c.subject}${portedOf(c) ? '  [已上游]' : '  ← 未上游'}`)
    }
    if (missing.length > 0) {
      problems.push(`${owner} 有 ${missing.length} 个未上游的 commit：${missing.map((c) => c.sha).join(', ')}`)
    }
  }
}

// ---------- 3. open issue ----------
head('open issue')
const issues = tryGh(['issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '30', '--json',
  'number,title,author,createdAt,comments'])
if (!issues) {
  line('  (查询失败，跳过)')
} else if (issues.length === 0) {
  line('  没有 open issue。')
} else {
  for (const it of issues) {
    const n = Array.isArray(it.comments) ? it.comments.length : it.comments
    line(`  #${it.number} ${it.title}`)
    line(`      @${it.author.login} · ${it.createdAt} · ${n} 条评论`)
  }
}

// ---------- 4. 仓库热度 ----------
head('仓库')
const repo = tryGh(['api', `repos/${REPO}`])
if (repo) {
  line(`  stars ${repo.stargazers_count} · forks ${repo.forks_count} · open issues ${repo.open_issues_count} · pushed ${repo.pushed_at}`)
}
const defaultBranch = repo ? repo.default_branch : 'main'
const latestCommit = tryGh(['api', `repos/${REPO}/commits/${defaultBranch}`, '--jq', '.sha[0:7] + " " + (.commit.message | split("\n")[0])'])
if (latestCommit) line(`  ${defaultBranch} 最新： ${latestCommit}`)

// ---------- 5. npm ----------
head(`npm（${PKG}）`)
try {
  let r = null
  let lastErr = null
  for (let i = 0; i < 3; i++) {
    try {
      r = await fetch(`https://registry.npmjs.org/${PKG}?t=${Date.now()}`, { signal: AbortSignal.timeout(20000) })
      if (r.ok) break
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (e) {
      lastErr = e
    }
    r = null
    await new Promise((res) => setTimeout(res, 1200))
  }
  if (!r) throw lastErr || new Error('fetch failed')
  const pkg = await r.json()
  const latest = pkg['dist-tags'] && pkg['dist-tags'].latest
  line(`  latest ${latest} · 发布时间 ${(pkg.time && pkg.time[latest]) || '?'}`)
  const local = tryLocalVersion()
  if (local) {
    line(`  本地 package.json ${local}${local === latest ? '（与 npm 一致）' : `（npm 上是 ${latest}，本地未发版）`}`)
    if (local !== latest) problems.push(`本地 ${local} 还没发版（npm latest 是 ${latest}）`)
  }
} catch (e) {
  line(`  查询失败：${String(e.message).split('\n')[0]}`)
}

function tryLocalVersion() {
  try {
    const fs = execFileSync('node', ['-p', 'require("./package.json").version'], { encoding: 'utf8' })
    return fs.trim()
  } catch {
    return ''
  }
}

// ---------- 汇总 ----------
head('要做的事')
if (problems.length === 0) {
  line('  没有需要动手的：没有 open PR、fork 没有未上游提交、没有本地未发版。')
} else {
  for (const p of problems) line(`  · ${p}`)
}
line('')
