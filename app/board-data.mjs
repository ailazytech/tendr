#!/usr/bin/env node
// herdr App 的 tendr 看板（app/mod/main.js）要的資料：用法 node board-data.mjs <專案根目錄> [其他候選...]
// 從候選資料夾挑第一個有 tendr 專案設定的（App 只知道終端機的 cwd，不知道哪個是 Claude Code 的專案根目錄），
// 讀 lane 狀態檔、交接文件、記憶，印出 JSON。路徑規則與 hooks/register.js 的 expandPath 相同
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
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

const candidates = process.argv.slice(2).filter(Boolean)
const root = candidates.find((c) => projectSettings(c)) ?? candidates[0] ?? ''
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

console.log(
  JSON.stringify({
    root: slash(root),
    name: slash(root).split('/').filter(Boolean).pop() ?? '',
    settingsFile: found?.file ?? '',
    selfLane: pick('tasks_self', 'architect'),
    tasksDir,
    lanes,
    lanesError: error,
    handoff,
    handoffPath: handoffFile,
    memories: root ? loadMemories(memoryDir) : [],
  }),
)
