#!/usr/bin/env node
// herdr App 的 tendr 看板（app/mod/main.js）要的資料：用法 node board-data.mjs <專案根目錄> [其他候選...]
//   node board-data.mjs --focus <終端機> [候選...]   選著的 agent 有回報時用它的專案資料夾，不看候選
// 從候選資料夾挑第一個有 tendr 專案設定的（App 只知道終端機的 cwd，不知道哪個是 Claude Code 的專案根目錄），
// 讀 lane 狀態檔、交接文件、記憶、主控與各 Claude 的交接狀態，印出 JSON。路徑規則與 hooks/register.js 的 expandPath 相同
//
// 看板的按鈕也走這裡（App 的 mod 不能寫檔）：
//   node board-data.mjs --lead <終端機|-> <專案代號>   指定（- 是取消）這個專案的主控
//   node board-data.mjs --handoff <終端機>             請那個終端機的 Claude 立即交接
import fs from 'node:fs'
import os from 'node:os'

const LANE_ORDER = ['blocked', 'failed', 'review', 'working', 'idle', 'done']
const SETTINGS_NAMES = ['tendr.json', 'baton.json', 'session-board.json']
const DEFAULT_MEMORY_DIR = '{config}/projects/{project}/memory'
const DEFAULT_HANDOFF_PATH = 'docs/HANDOFF.md'

const slash = (p) => String(p).replace(/\\/g, '/')
const home = slash(process.env.USERPROFILE || process.env.HOME || os.homedir())
const config = slash(process.env.CLAUDE_CONFIG_DIR || home + '/.claude')
const slug = (root) => root.replace(/[^A-Za-z0-9]/g, '-')
// 外掛與看板之間的檔案（見 hooks/register.js 的 LEAD_FILE）
const TENDR_HOME = home + '/.tendr'
const LEAD_FILE = TENDR_HOME + '/lead.json'
const SESSIONS_DIR = TENDR_HOME + '/sessions'
const REQUESTS_DIR = TENDR_HOME + '/requests'
// 專案代號：和外掛一樣，去掉結尾的分隔符號、換成 -、不分大小寫
const projectKey = (root) => slug(String(root).replace(/[\\/]+$/, '')).toLowerCase()
// 終端機位址（可能是 machine/t7）當檔名：只留安全字元
const terminalName = (t) => String(t).replace(/[^\w.-]/g, '_')
// 太久沒更新的交接狀態（關掉的終端機留下的）不列
const SESSION_MAX_AGE = 7 * 24 * 3600 * 1000

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// 先寫暫存檔再改名：外掛每 5 秒讀一次，不會讀到寫一半的
function writeJson(file, value) {
  fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

function expand(raw, rootRaw) {
  const root = slash(rootRaw)
  let p = slash(String(raw).trim())
    .replaceAll('{config}', config)
    .replaceAll('{project}', slug(rootRaw))
    .replaceAll('{root}', root)
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1)
  if (!/^([A-Za-z]:)?\//.test(p)) p = root + '/' + p
  return p.replace(/\/+$/, '')
}

// 專案設定：tendr.json，沒有就讀改名前的
function projectSettings(root) {
  for (const name of SETTINGS_NAMES) {
    const file = config + '/projects/' + slug(root) + '/' + name
    if (fs.existsSync(file)) return { file, settings: readJson(file) ?? {} }
  }
  return null
}

// /config 裡的外掛設定（settings.json 的 pluginConfigs）
function pluginOption(key) {
  const configs = readJson(config + '/settings.json')?.pluginConfigs ?? {}
  return configs['tendr@tendr']?.options?.[key]
}

function laneProgress(l) {
  const counted = l.steps.filter((s) => s.state !== 'skip')
  const done = counted.filter((s) => s.state === 'done').length
  return { done, total: counted.length, percent: counted.length ? Math.round((done * 100) / counted.length) : 0 }
}

function loadLanes(dir) {
  if (!dir) return { lanes: [], error: '' }
  if (!fs.existsSync(dir)) return { lanes: [], error: 'no-tasks-dir' }
  const lanes = []
  const bad = []
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const v = readJson(dir + '/' + name)
    if (!v || typeof v.lane !== 'string' || typeof v.title !== 'string' || !LANE_ORDER.includes(v.state) || !Array.isArray(v.steps)) {
      bad.push(name)
      continue
    }
    const step = v.steps.find((s) => s.state === 'doing') ?? v.steps.find((s) => s.state === 'todo')
    // 有些專案把 needs 寫成陣列、notes 裡放物件：看板只吃字串，在這裡攤平
    const needs = Array.isArray(v.needs) ? v.needs.map(String).join('；') : v.needs == null ? undefined : String(v.needs)
    const notes = Array.isArray(v.notes) ? v.notes.map((n) => (typeof n === 'string' ? n : JSON.stringify(n))) : undefined
    lanes.push({ ...v, needs, notes, progress: laneProgress(v), step: step ?? null })
  }
  lanes.sort((a, b) => LANE_ORDER.indexOf(a.state) - LANE_ORDER.indexOf(b.state) || a.lane.localeCompare(b.lane))
  return { lanes, error: bad.length ? 'unreadable: ' + bad.join(', ') : '' }
}

// 記憶只要 frontmatter 的名稱、說明、分層
function loadMemories(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'MEMORY.md')) {
    let text = ''
    try {
      text = fs.readFileSync(dir + '/' + name, 'utf8').replace(/\r/g, '')
    } catch {
      continue
    }
    const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
    const field = (key) => fm.match(new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm'))?.[1]?.trim() ?? ''
    out.push({ file: name, name: field('name') || name.replace(/\.md$/, ''), description: field('description'), type: field('type'), layer: field('layer'), lane: field('lane') })
  }
  return out
}

// 這個專案的 Claude（外掛寫的交接狀態）：已結束的、太久沒更新的不列；主控排第一個
function loadSessions(key, leadTerminal) {
  if (!fs.existsSync(SESSIONS_DIR)) return []
  const now = Date.now()
  const out = []
  for (const name of fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json'))) {
    const s = readJson(SESSIONS_DIR + '/' + name)
    if (!s || s.ended || s.project !== key || typeof s.terminal !== 'string') continue
    if (!(now - Date.parse(s.updated) < SESSION_MAX_AGE)) continue
    out.push(s)
  }
  const rank = (s) => (s.terminal === leadTerminal ? 0 : 1)
  return out.sort((a, b) => rank(a) - rank(b) || Date.parse(b.updated) - Date.parse(a.updated))
}

const args = process.argv.slice(2)

if (args[0] === '--lead') {
  const [, terminal, key] = args
  if (!terminal || !key) {
    console.error('usage: board-data.mjs --lead <terminal|-> <project key>')
    process.exit(2)
  }
  const leads = readJson(LEAD_FILE) ?? {}
  if (terminal === '-') delete leads[key]
  else leads[key] = { terminal, at: new Date().toISOString() }
  writeJson(LEAD_FILE, leads)
  console.log(JSON.stringify({ ok: true, lead: leads[key] ?? null }))
  process.exit(0)
}

if (args[0] === '--handoff') {
  const terminal = args[1]
  if (!terminal) {
    console.error('usage: board-data.mjs --handoff <terminal>')
    process.exit(2)
  }
  writeJson(REQUESTS_DIR + '/' + terminalName(terminal) + '.json', { action: 'handoff', at: Date.now() })
  console.log(JSON.stringify({ ok: true }))
  process.exit(0)
}

// --focus <終端機>：看板選著的 agent。它的 Claude 有回報時就用它自己的專案資料夾——
// 終端機的 cwd 可能早就換了，而且不能退回去挑「旁邊那格有 tendr 設定的」，那會變成別人的專案、別人的主控
let focusSession = null
if (args[0] === '--focus') {
  const s = readJson(SESSIONS_DIR + '/' + terminalName(args[1] ?? '') + '.json')
  if (s && !s.ended && typeof s.root === 'string' && s.root && Date.now() - Date.parse(s.updated) < SESSION_MAX_AGE) focusSession = s
  args.splice(0, 2)
}
const candidates = args.filter(Boolean)
const root = focusSession ? focusSession.root : (candidates.find((c) => projectSettings(c)) ?? candidates[0] ?? '')
const found = root ? projectSettings(root) : null
const settings = found?.settings ?? {}
const pick = (key, fallback) => (typeof settings[key] === 'string' && settings[key].trim() ? settings[key] : fallback)

const tasksDir = root && pick('tasks_dir', '') ? expand(settings.tasks_dir, root) : ''
const handoffFile = root ? expand(pick('handoff_path', pluginOption('handoff_path') || DEFAULT_HANDOFF_PATH), root) : ''
const memoryDir = root ? expand(pick('memory_dir', pluginOption('memory_dir') || DEFAULT_MEMORY_DIR), root) : ''
const { lanes, error } = loadLanes(tasksDir)
let handoff = null
try {
  if (handoffFile && fs.existsSync(handoffFile)) handoff = { path: handoffFile, mtimeMs: fs.statSync(handoffFile).mtimeMs }
} catch {
  handoff = null
}
const key = root ? projectKey(root) : ''
const lead = key ? ((readJson(LEAD_FILE) ?? {})[key] ?? null) : null

console.log(
  JSON.stringify({
    root: slash(root),
    name: slash(root).split('/').filter(Boolean).pop() ?? '',
    projectKey: key,
    settingsFile: found?.file ?? '',
    selfLane: pick('tasks_self', 'architect'),
    tasksDir,
    lanes,
    lanesError: error,
    handoff,
    handoffPath: handoffFile,
    memoryDir,
    memories: root ? loadMemories(memoryDir) : [],
    lead,
    sessions: key ? loadSessions(key, lead?.terminal) : [],
    now: Date.now(),
  }),
)
