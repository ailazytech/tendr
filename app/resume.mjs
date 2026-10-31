#!/usr/bin/env node
// herdr App 重開機後接回 Claude Code：node app/resume.mjs [--dry-run]
// tendr 外掛在每輪開始時把「終端機 ↔ 對話」記在 ~/.tendr/resume/<位址>.json（hooks/register.js 的 rememberTerminal）。
// 終端機還在、建立時間對得上、但 pid 變了（core 把遺失的程式換成新的 shell），就在那個 shell 送 claude --resume。
// 可以重複跑：送過之後紀錄的 pid 換成新 shell 的，下次就不再送；自己離開（/exit）的紀錄外掛會標成已結束，這裡清掉
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const slash = (p) => String(p).replace(/\\/g, '/')
const DIR = slash(os.homedir()) + '/.tendr/resume'
const dry = process.argv.includes('--dry-run')
// 紀錄的終端機一直不在（core 還沒恢復，或被關掉了）超過這麼久才清掉
const GONE_MS = 7 * 24 * 3600 * 1000
// 剛送過就先別再送（shell 還在載入、claude 還沒起來）
const COOLDOWN_MS = 3 * 60 * 1000
const SHELLS = ['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh', 'fish', 'nu']

function hc(args) {
  return JSON.parse(execFileSync('hc', [...args, '--json'], { encoding: 'utf8', timeout: 15000 }))
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// 前景程式是哪種 shell：powershell.exe → powershell；不是 shell 回 ''
function shellKind(foreground) {
  const name = slash(foreground?.name ?? foreground?.argv?.[0] ?? '').split('/').pop().toLowerCase().replace(/\.exe$/, '')
  return SHELLS.includes(name) ? name : ''
}

// 在那個 shell 裡要打的指令：先回到專案資料夾（恢復的 shell 通常已經在那裡，保險起見），帶上原本的 CLAUDE_CONFIG_DIR
function resumeCommand(kind, r) {
  const resume = 'claude --resume ' + r.sessionId
  if (kind === 'powershell' || kind === 'pwsh') {
    const q = (s) => "'" + s.replace(/'/g, "''") + "'"
    return [r.configDir ? '$env:CLAUDE_CONFIG_DIR=' + q(r.configDir) : '', 'Set-Location -LiteralPath ' + q(r.root), resume].filter(Boolean).join('; ')
  }
  if (kind === 'cmd') {
    const win = (s) => s.replace(/\//g, '\\')
    return [r.configDir ? 'set "CLAUDE_CONFIG_DIR=' + win(r.configDir) + '"' : '', 'cd /d "' + win(r.root) + '"', resume].filter(Boolean).join(' && ')
  }
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'"
  return 'cd ' + q(r.root) + ' && ' + (r.configDir ? 'CLAUDE_CONFIG_DIR=' + q(r.configDir) + ' ' : '') + resume
}

const out = { resumed: [], waiting: [], skipped: [], cleared: [], errors: [] }
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((n) => n.endsWith('.json')) : []
if (files.length) {
  let terminals = []
  try {
    terminals = hc(['ls', '--all']).terminals ?? []
  } catch (err) {
    out.errors.push('hc ls: ' + String(err.message ?? err).split('\n')[0])
    console.log(JSON.stringify(out))
    process.exit(1)
  }
  const now = Date.now()
  for (const name of files) {
    const file = DIR + '/' + name
    const r = readJson(file)
    if (!r?.terminal) continue
    const clear = (why) => {
      out.cleared.push({ terminal: r.terminal, why })
      if (!dry) fs.rmSync(file, { force: true })
    }
    if (r.ended) {
      clear('ended: ' + r.ended)
      continue
    }
    // 只接受 uuid 這類 id，路徑不能有換行：要原樣打進 shell
    if (!/^[\w-]+$/.test(String(r.sessionId)) || /[\r\n]/.test(String(r.root) + String(r.configDir ?? ''))) {
      clear('bad record')
      continue
    }
    const t = terminals.find((x) => x.address === r.terminal)
    if (!t) {
      if (now - Date.parse(r.updated) > GONE_MS) clear('gone')
      else out.waiting.push(r.terminal)
      continue
    }
    if (t.state === 'finished') {
      clear('finished')
      continue
    }
    try {
      const info = hc(['get', r.terminal])
      // 位址被別的終端機拿去用了（例如 core 資料重建）：不是原本那個
      if (r.created && info.created_ms !== r.created) {
        clear('different terminal')
        continue
      }
      // 原本的程式還在（claude 或使用者自己留下的 shell）
      if (info.pid === r.pid) {
        out.skipped.push({ terminal: r.terminal, why: 'still running' })
        continue
      }
      if (r.resumedAt && now - Date.parse(r.resumedAt) < COOLDOWN_MS) {
        out.skipped.push({ terminal: r.terminal, why: 'just resumed' })
        continue
      }
      const kind = shellKind(info.foreground)
      if (!kind) {
        out.skipped.push({ terminal: r.terminal, why: 'not at a shell: ' + (info.foreground?.name ?? '?') })
        continue
      }
      const command = resumeCommand(kind, r)
      if (!dry) {
        execFileSync('hc', ['send', r.terminal, command], { encoding: 'utf8', timeout: 30000 })
        fs.writeFileSync(file, JSON.stringify({ ...r, pid: info.pid, resumedAt: new Date(now).toISOString() }, null, 2) + '\n')
      }
      out.resumed.push({ terminal: r.terminal, sessionId: r.sessionId, command })
    } catch (err) {
      out.errors.push(r.terminal + ': ' + String(err.message ?? err).split('\n')[0])
    }
  }
}
console.log(JSON.stringify(out))
