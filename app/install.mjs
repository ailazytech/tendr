#!/usr/bin/env node
// 把 tendr 看板裝進 herdr App：node app/install.mjs [--layout <名稱>]
// - 複製 app/mod 到 ~/.config/herdr-app/mods/tendr-board，寫 config.js（node 與 board-data.mjs 的絕對路徑）
// - 寫 ~/.tendr/install.json（repo、resume.mjs、看板的位置），別的 mod 靠它找到 tendr
// - --layout：在那個 layout 的右側面板（stack "panel-body"）加一個 tendr 區塊。
//   App 內建的 layout 是唯讀的（每次啟動會被換回去），請先 Duplicate layout 再裝到複製的那份
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const slash = (p) => p.replace(/\\/g, '/')
const appHome = process.env.HERDR_APP_HOME || path.join(os.homedir(), '.config', 'herdr-app')
const target = path.join(appHome, 'mods', 'tendr-board')

if (!fs.existsSync(appHome)) {
  console.error('找不到 herdr App 的資料夾：' + appHome)
  process.exit(1)
}

fs.mkdirSync(target, { recursive: true })
for (const name of fs.readdirSync(path.join(here, 'mod'))) fs.copyFileSync(path.join(here, 'mod', name), path.join(target, name))
fs.writeFileSync(
  path.join(target, 'config.js'),
  '// 由 tendr 的 app/install.mjs 產生\n' +
    'export const NODE = ' + JSON.stringify(slash(process.execPath)) + ';\n' +
    'export const DATA_SCRIPT = ' + JSON.stringify(slash(path.join(here, 'board-data.mjs'))) + ';\n',
)
console.log('已安裝 mod：' + target)

// 讓別的 App mod（例如 herdr-quota 的狀態列）找得到 tendr：重開機後接回要跑 resume.mjs
const installInfo = path.join(os.homedir(), '.tendr', 'install.json')
fs.mkdirSync(path.dirname(installInfo), { recursive: true })
fs.writeFileSync(
  installInfo,
  JSON.stringify({ repo: slash(path.dirname(here)), resume: slash(path.join(here, 'resume.mjs')), board: slash(target) }, null, 2) + '\n',
)
console.log('已記下 tendr 的位置：' + installInfo)

const i = process.argv.indexOf('--layout')
if (i >= 0) {
  const name = process.argv[i + 1]
  const file = path.join(appHome, 'layouts', name + '.json')
  const layout = JSON.parse(fs.readFileSync(file, 'utf8'))
  const find = (node, id) => {
    if (node?.id === id) return node
    for (const child of node?.children ?? []) {
      const found = find(child, id)
      if (found) return found
    }
    return null
  }
  const stack = find(layout.root ?? layout, 'panel-body')
  if (!stack) {
    console.error(name + ' 沒有 id 是 panel-body 的 stack，請自己把 { "mod": "tendr-board" } 區塊放進 layout')
    process.exit(1)
  }
  if (find(stack, 'tendr')) {
    console.log(name + ' 已經有 tendr 區塊')
  } else {
    stack.children.push({ id: 'tendr', type: 'block', content: { mod: 'tendr-board' } })
    fs.writeFileSync(file, JSON.stringify(layout, null, 2) + '\n')
    console.log('已加進 ' + name + ' 的右側面板（id: tendr）')
  }
}
