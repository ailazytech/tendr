# tendr

[English](README.en.md) ｜ 繁體中文

Claude Code 的側邊工作看板（hooks 外掛）。在提示快取過期前**自動寫交接、再壓縮對話**，讓長時間的工作不會因為快取過期或上下文爆掉而斷線；同時把多條並行工作線（lane）、分層記憶、herdr 指揮的 agent 集中在一個面板上。

> 需要 Claude Code **2.1.287 以上**（測試版本 2.1.288）。macOS 與 Windows 共用同一份程式。

> 介面、交接指示和給 Claude 的說明會跟著使用者語言（目前支援繁體中文與英文），見設定的 `language`。

## 它解決什麼問題

用 Claude Code 做長時間的工作（一整個下午的重構、同時派好幾個 agent 跑不同的線），通常會卡在這幾件事：

- **離開一下回來，快取就過期了**：提示快取預設 1 小時。開會、吃飯回來，下一輪要把整段對話重新算一次，又慢又花錢；對話越長，耗費的 token 越驚人。
- **上下文滿了被迫壓縮，壓完不知道做到哪**：自動壓縮發生在最不方便的時候，摘要也不一定留住你在意的細節（下一步是什麼、哪個決定還在等你）。
- **開新 session 等於失憶**：要自己把交接文件貼回去，或花好幾輪重新解釋背景。
- **多條線同時跑，不知道誰在等你**：好幾個 agent 各跑一條線，有的卡在權限對話框、有的做完等驗收、有的失敗了，你得一個一個 pane 切過去看。

tendr 的做法：

- **快取剩 5 分鐘時主動交接**：叫 Claude 先把目標、進度、下一步、待決定的事寫進交接文件，再自動壓縮。交接趁快取還沒過期時做，這一輪本身很便宜；之後從乾淨的上下文接續。
- **新 session／壓縮後自動補上下文**：第一個 prompt 自動附上交接文件，不用自己貼。
- **一個面板看所有工作線**：每條 lane 一個 JSON 狀態檔，「等你」「失敗」「待審」排最前面並跳通知；點進去看即時畫面、送按鍵、直接回覆，不用切 pane。
- **記憶分層**：使用者偏好、專案事實、某條線的細節、會過期的階段資訊分開放，過期的會提醒你檢查。
- **不用重講同一件事**：你親口說的要求與糾正自動整理進記憶並記次數；講到 3 次就請 Claude 寫進專案的 CLAUDE.md／AGENTS.md，寫了還一再違反就起草成守門。
- **當下攔住常見的壞習慣**：同一個錯誤原樣重試、沒驗證就說完成、回覆語言跑掉，當下給 Claude 一句提醒。

## 快速開始

```bash
claude update                                          # 確認 2.1.287 以上
claude plugin marketplace add ailazytech/tendr   # 或本機路徑
claude plugin install tendr@tendr
```

開新的 session，輸入 `/tendr`。

- `/tendr`：開關看板。**輸入過 `/tendr` 的 session 才會啟用自動交接**（當作主控 session）。在 herdr App 裡也可以不打 `/tendr`，改在 App 的 tendr 看板指定主控（見「主控與自動交接（App）」）。
- `/handoff`：立即交接，不用開看板。非全螢幕時滑鼠點不到看板按鈕，就用這個。
- `/distill`：立即整理筆記（見「自動整理筆記」）。
- `/guard`：查看與管理守門（見「守門」）。
- 看板關著時，輸入框上方右側有一顆「🔥 工作看板」按鈕（tendr 是守著爐火的人；`/config` 的 `launcher_button` 可關）。

看板要停靠在右側，需要全螢幕版面（`CLAUDE_CODE_NO_FLICKER=1`）且終端至少 110 欄；否則放在輸入框上方。

### 從 baton 升級

tendr 原名 baton。換裝新名稱：

```bash
claude plugin uninstall baton@baton
claude plugin marketplace remove baton
claude plugin marketplace add ailazytech/tendr
claude plugin install tendr@tendr
```

- 指令 `/board` 改成 `/tendr`（不再保留 `/board`）
- 專案覆寫檔：沒有 `tendr.json` 時依序讀 `baton.json`、`session-board.json`，不用搬
- 守門檔：第一次載入時把 `baton-guards.json` 複製成 `tendr-guards.json`
- 外掛暫存（還沒整理的對話紀錄、守門命中次數等）：第一次啟動時從 baton 的暫存匯入，已有的不覆蓋

## 功能

### 分頁

- **任務**（專案設了 `tasks_dir` 才出現，見「lane 狀態檔」）：每條 lane 一到兩行＋百分比，要處理的（等你、失敗、待審、對話框等確認）排最前，待命與完成的收起來
  - 點一條 lane 進子頁：步驟、等你決定的事、備註、即時畫面（`herdr pane read`／App 是 `hc read`，每 3 秒更新）、按鍵（Enter／Esc／1／2／3）、回覆輸入框（`herdr agent prompt`／App 是 `hc send`）、報告、這條線的記憶
  - 報告是再下一層子頁；「← 返回」一層層退回，回到列表時捲回剛才那一列
  - 別的 lane 變成等你、待審、失敗時跳通知
- **記憶**：依 frontmatter 的 `metadata.layer` 分成使用者／專案／工作線／階段；工作線的記憶用 `metadata.lane` 掛到 lane 子頁，階段記憶過了 `metadata.review_by` 會標「該檢查了」；沒標 layer 的歸「未分層」，依類型分組
- **進度**（有任務分頁時叫「交接」）：執行狀態、任務、上下文用量、交接文件
- **Herdr**（在 herdr 或 herdr App 裡、且沒有任務分頁時才出現）：這個 session 透過 herdr（App 是 `hc`）指揮過的 agent／pane 與即時狀態，blocked 或 done 時跳通知
- **底部**：目前模型、快取倒數、自動交接開關

### 自動交接的流程

1. 主控 session 每次送出請求，快取就重新計時。
2. 快取剩 5 分鐘、且符合以下條件時，外掛送出一則以 `[自動交接]`（英文介面是 `[auto-handoff]`）開頭的指示，要 Claude 更新交接文件（或自己的 lane 狀態檔）與記憶：
   - 這個 session 輸入過 `/tendr`（herdr App 裡也可以在看板指定為主控），且自動交接開著
   - `cache_ttl` 是 `1h`（5 分鐘的快取不自動交接，否則一直被打斷）
   - 上下文用量至少 20%（太小不值得壓縮）
   - 最後一次輸入在 `away_hours` 以內，或 Claude 還在跑
3. 交接那一輪結束後自動壓縮對話；摘要存到交接文件旁的 `*.compact.md`，看板「壓縮後保留」可展開。
4. 壓縮後的第一個 prompt，再把交接文件附給 Claude（`/config` 的 `brief_on_start` 可關）。還沒設 `tasks_dir` 的專案會多附一段，請 Claude 遇到多條並行工作時問你要不要開「任務」分頁。

### 防呆提醒

都是給 Claude 的一句話，你看不到，也不會擋你的工具。預設全開，`/config` 可以個別關。邏輯移植自 [ctx-handoff-mod](https://github.com/cablate/ctx-handoff-mod)（MIT）。

- **重複失敗**（`retry_nudge`）：同一個工具連續兩次因同樣原因失敗，請 Claude 先找原因、換做法；看起來是暫時性錯誤（逾時、還在載入）就稍等再試一次
- **說完成卻沒驗證**（`done_check`）：這一輪改過程式檔、之後沒跑過通過的測試／建置／檢查（或跑了沒過）就說完成，擋下這次停止，請它先驗證或誠實說明。只改文件（`.md` 等）、`scratchpad/`、`.review/` 不算。Claude Code 會顯示成「Stop hook feedback」，那就是這個提醒
- **回覆語言**（`reply_language`）：說明大部分不是目標語言時提醒一次。`auto` 跟著 Claude Code 的 `language` 設定（認得繁中、簡中、英文、日文）。程式碼、指令、路徑和很短的句子不算，中文夾英文術語不會觸發

### 自動整理筆記

把你親口說的要求、偏好與糾正，整理進記憶資料夾（就是「記憶」分頁讀的那個）。

- **什麼時候**：你送出 `distill_every` 則訊息後（預設 30）、交接前、`/distill`，或按記憶分頁的「立即整理」
- **送什麼**：上次整理之後你打的訊息和 Claude 的回答（斜線指令不算），交給 `notes_model`（預設 Sonnet，effort low）。每次整理是一個背景請求，不佔主對話。對話紀錄依專案存在外掛的 store，換 session 後沒整理到的會接著整理
- **寫什麼**：只記 `feedback`（要求與糾正）和 `user`（你的背景）。新的寫成一則一檔、加進 `MEMORY.md`；講過的在 frontmatter 的 `metadata.count` 加一、更新 `last_seen`
- **防亂記**：每一條都要附你的原話，程式會拿去比對你實際打過的訊息，對不上就丟掉；像金鑰或密碼的也丟掉。失敗（模型沒回應等）時對話留著，下次再整理
- **講到 3 次**：新 session 開頭請 Claude 在做完你交代的事之後，把 `layer: project` 的放進專案的 CLAUDE.md／AGENTS.md（不 commit），`layer: user` 的先問你要不要加進全域 `~/.claude/CLAUDE.md`；放好後在記憶檔標 `promoted`
- 記憶分頁會顯示 `×次數`、`✓專案` 與上次整理的結果；`distill` 可以整個關掉

### 守門

寫下來也擋不住的要求，改成工具呼叫前的檢查。移植自 ctx-handoff-mod。

- **什麼時候起草**：整理筆記後，某則要求放進專案之後次數又變多（又被糾正），或你不讓它放進專案（`promoted: declined`）卻講了 3 次。也可以 `/guard suggest`
- **草稿**：模型寫出工具名稱與正規表達式（`match`／`unless`），附一個違規範例和一個正確範例，程式實際比對過才收。存在 `{config}/projects/{project}/tendr-guards.json`（不進 repo）
- **你同意之前不會生效**：新 session 開頭請 Claude 做完你交代的事後問你；你說要，Claude 直接把檔裡那條的 `state` 改成 `on`（不要就 `off`）。也可以 `/guard on N`
- **生效後**：`deny` 在執行前擋下並跳通知，`remind` 照常執行、在結果後面提醒 Claude。檢查本身出錯就放行
- `/guard` 列出全部與命中次數；`/guard off N`、`/guard drop N`、`/guard mode N deny|remind`

## 設定

在 `/config` 可以改：

| 設定 | 說明 | 預設 |
| --- | --- | --- |
| `memory_dir` | 記憶資料夾 | `{config}/projects/{project}/memory` |
| `handoff_path` | 交接文件 | `docs/HANDOFF.md` |
| `brief_on_start` | 新 session／壓縮後自動附上交接文件 | 開 |
| `launcher_button` | 輸入框上方的看板按鈕 | 開 |
| `cache_ttl` | 提示快取時效 `1h`／`5m`；切換模型時以引擎告知的值為準 | `1h` |
| `away_hours` | 最後一次輸入超過幾小時就不再自動交接（`24`／`8`／`2`） | `24` |
| `language` | 介面語言 `auto`／`zh-TW`／`en`。`auto` 先看 Claude Code 的 `language` 設定，沒設再看 `LANG`；任何中文都用繁體中文，其他語言用英文 | `auto` |
| `retry_nudge` | 重複失敗提醒 | 開 |
| `done_check` | 沒驗證就說完成時擋下 | 開 |
| `reply_language` | 回覆語言提醒 `auto`／`off`／`zh-TW`／`zh-CN`／`en`／`ja` | `auto` |
| `distill` | 自動整理筆記（也關掉講 3 次放進專案與起草守門） | 開 |
| `distill_every` | 每幾則訊息整理一次（`30`／`50`／`15`） | `30` |
| `notes_model` | 整理筆記與起草守門用的模型（`sonnet`／`haiku`／`opus`） | `sonnet` |

路徑可用 `{config}`（`~/.claude` 或 `CLAUDE_CONFIG_DIR`）、`{project}`（專案代號）、`{root}`（專案根目錄）、`~`；相對路徑以專案根目錄為準。

### 個別專案覆寫

在 `{config}/projects/{project}/tendr.json`（不放進專案 repo）覆寫這個專案的設定，存檔後自動重讀。沒有 `tendr.json` 時，依序讀改名前的 `baton.json`、`session-board.json`：

```json
{
  "handoff_path": "docs/migration/PROGRESS.md",
  "handoff_section": "## 交接"
}
```

- `handoff_path`、`memory_dir`：同上
- `handoff_section`：交接文件是專案自己的文件時設定。看板與新 session 只讀第一個以此開頭的標題那一節；自動交接只要求更新那一節，不整份覆寫
- `compact_path`：壓縮摘要位置，預設放在全域 `handoff_path` 旁邊（不會因為改用專案文件而寫進 repo）
- `tasks_dir`：lane 狀態檔資料夾，設了就有「任務」分頁
- `tasks_self`：主控 session 自己的狀態檔名（預設 `architect`）。`pane` 填某個 session 自己終端機的 lane 就是那個 session 的；herdr App 裡同一個資料夾的主控是別的終端機時，其他 Claude 不會被叫去覆寫 `tasks_self`，而是新增自己的 lane（`pane` 填自己）
- `sync_command`：同步 lane 用的指令，寫成陣列（第一個是執行檔），`{tasks_dir}` 會換成 lane 資料夾。每次壓縮對話前（自動交接或手動 `/compact`）一定跑，成功或失敗都跳通知；主控每一輪結束時，lane 檔（檔名或修改時間）跟上次同步時不一樣也會跑，這種成功不跳通知、失敗才跳。都不等它跑完、不擋壓縮。例如把 lane 同步進紙間：`"sync_command": ["C:\\…\\zjnote-mcp.exe", "pm-sync", "{tasks_dir}", "--project", "官網改版"]`

### lane 狀態檔

`tasks_dir` 裡每條 lane 一個 `<lane>.json`：

```json
{
  "lane": "api",
  "title": "把 REST API 改成分頁回傳",
  "state": "working",
  "steps": [
    { "id": "S1", "title": "盤點現有端點", "state": "done" },
    { "id": "S2", "title": "加上 cursor 參數", "state": "doing" },
    { "id": "S3", "title": "補測試", "state": "todo" }
  ],
  "updated": "2026-10-16T09:30:00Z",
  "notes": ["舊 client 仍用 offset，先保留相容"]
}
```

- 必填：`lane`、`title`（一行）、`state`（`blocked`／`failed`／`review`／`working`／`idle`／`done`）、`steps`（`{ id, title, state: todo|doing|done|skip }`）、`updated`
- 選填：`needs`（等使用者決定的事）、`pane`（herdr pane id；herdr App 是終端機位址如 `t7` 或名稱）、`agent`（顯示名稱，例如「主線」）、`spec`、`head`、`report`（報告檔路徑）、`notes`、`group`／`group_title`（同一批的 lane 在紙間看板疊在一起）、`archived`／`archive_reason`（在紙間封存）。tendr 只檢查必填欄位，其他欄位原樣留給同步的工具
- 使用者在紙間回答 lane 的「等你決定」時，紙間的 `pm-sync` 會把回答寫進同一個資料夾的 `answers.jsonl`（一行一筆：`lane`、`question`、`answer`、`at`、`machine`；副檔名不是 `.json`，不會被當成 lane）。tendr 在下一則使用者訊息附給 Claude：一般 session 只看自己那條 lane 的、主控看全部，每筆在同一個 session 說一次（壓縮後再說一次）；那條 lane 的 `needs` 已經沒有這題就不提。agent 處理完把題目從 `needs` 拿掉，紙間下次同步就把那一行清掉
- 百分比＝完成步驟 ÷（總數 − 跳過）
- 專案自己的規則與驗證工具寫在該資料夾的 README

有 `tasks_dir` 時，交接改成「狀態檔」模式：

- 新 session 或壓縮後的第一個 prompt 只附任務一覽與主控自己的步驟、備註；詳細交接文件只給路徑，需要時再讀
- 自動交接要求更新主控自己的狀態檔（steps、needs、notes），不再重寫交接文件

### 記憶檔格式

記憶資料夾裡每個 `.md` 一則（`MEMORY.md` 是索引，不列出）：

```markdown
---
name: no-hotkeys
description: 看板不要用快捷鍵
metadata:
  type: feedback        # user / feedback / project / reference
  layer: user           # user / project / workstream / phase
  lane: api             # layer 是 workstream 時，掛到哪條 lane
  review_by: 2026-11-01 # layer 是 phase 時，過了這天標「該檢查了」
  count: 2              # 自動整理筆記記的：你講過幾次
  last_seen: 2026-10-19 # 最後一次講是哪天
  promoted: AGENTS.md   # 已放進專案的位置；你不要放就是 declined
  promoted_count: 3     # 放進專案時的次數（之後又變多就會起草守門）
---

不要幫我用快捷鍵。
```

`count` 以下是自動整理筆記與守門用的，手寫的記憶不用填（沒寫就當成 1 次）。

## 讓 AI agent 接手

這個 repo 根目錄的 [AGENTS.md](AGENTS.md)（英文 [AGENTS.en.md](AGENTS.en.md)）是給 coding agent 的說明：架構、慣例、測試、改動時要注意的地方。Claude Code 會透過 `CLAUDE.md` 自動讀到。

可以直接貼給 agent 的提示：

**改這個外掛**

```text
先讀 AGENTS.md，再讀 hooks/register.js 裡跟這次要改的功能相關的段落。
我要改：<描述>。
改完跑 `claude plugin test`，全部通過再回報；行為有變就同步更新 README.md 與 README.en.md。
```

**在自己的專案開「任務」分頁**

```text
我想用 tendr 的任務分頁管理這個專案的並行工作。
請在 ~/.claude/projects/<專案代號>/tendr.json 設定 tasks_dir 指向 <資料夾>，
在那個資料夾建一份 README 寫清楚 lane 狀態檔的格式與更新規則，
再為目前進行中的工作各建一個 <lane>.json，主控自己的叫 architect.json。
```

**接續別人留下的交接**

```text
讀 <交接文件路徑>（和 tasks_dir 裡的狀態檔，如果有的話），
用三到五行告訴我目前的目標、做到哪、下一步，以及有沒有在等我決定的事。先不要動手。
```

## macOS 與 Windows

外掛內部的路徑一律轉成 `/` 分隔，兩邊用同一份程式。

### 路徑與資料夾

| 項目 | macOS | Windows |
| --- | --- | --- |
| 家目錄（`~`） | `HOME`，例如 `/Users/<名稱>` | `USERPROFILE`，例如 `C:\Users\<名稱>` |
| `{config}` 預設 | `/Users/<名稱>/.claude` | `C:\Users\<名稱>\.claude` |
| 絕對路徑 | 從 `/` 開始 | 從磁碟代號開始（`D:/...`） |
| `{project}` 代號 | `/Users/<名稱>/Projects/app` → `-Users-<名稱>-Projects-app` | `D:\work\app` → `D--work-app` |
| 檔名大小寫 | APFS 預設不分（外掛比對路徑時不分大小寫） | NTFS 不分 |

- **專案設定寫相對路徑**：`tendr.json` 裡的 `handoff_path`、`tasks_dir`、`compact_path`，以及 lane 狀態檔的 `report`、`spec`，都寫相對於專案根目錄的路徑，兩邊都能用
- **要寫絕對路徑時**：macOS 用 `~/...`；Windows 用 `/` 分隔（`D:/notes`）。JSON 裡的反斜線要跳脫成 `D:\\notes`，用 `/` 比較不會出錯
- **換電腦時搬專案資料**：`{project}` 代號跟著專案路徑變。舊電腦 `{config}/projects/<舊代號>/` 底下的 `tendr.json` 和 `memory/` 要複製到新代號的資料夾，否則記憶分頁是空的、專案覆寫也不會生效
- **換設定資料夾**：兩邊都可以用 `CLAUDE_CONFIG_DIR` 改 `{config}`
- **換行字元**：CRLF 讀得懂，不用轉

### 全螢幕版面

- macOS（zsh）：`echo 'export CLAUDE_CODE_NO_FLICKER=1' >> ~/.zshrc`，開新的終端分頁後生效
- Windows（PowerShell）：`setx CLAUDE_CODE_NO_FLICKER 1`，開新的終端視窗後生效

### 滑鼠點按鈕

- macOS Terminal.app：View 選單的「Allow Mouse Reporting」（⌘R）要打開
- macOS iTerm2：Settings → Profiles → Terminal 的「Enable mouse reporting」要打開
- Windows Terminal：預設就會傳
- 點不到的時候改用 `/tendr`、`/handoff`

### herdr

- macOS：herdr 通常裝在 `~/.local/bin/herdr`。在 herdr 裡開的 session 會用 `HERDR_BIN_PATH`，不靠 PATH；不是在 herdr 裡開的，要確認 `~/.local/bin` 在 PATH 上
- Windows：`herdr.exe` 要在 PATH 上

### herdr App

在 herdr 桌面 App（herdr-core）的終端機裡開的 session 也有 Herdr 分頁與 lane 即時畫面：App 不設 `HERDR_*`，tendr 看到 `HC_TERMINAL_ID` 就改用 `hc`（`hc ls --json`、`hc read`、`hc send`、`hc keys`），`hc` 要在 PATH 上（App 安裝時會加）。

- agent 清單只列有回報狀態（OSC 7501）的終端機；hc 不認 agent 品牌，不回報的程式（例如 Windows 上的 Claude Code）不會出現在清單裡，但 lane 的即時畫面、回覆、按鍵照常能用
- 「同工作區」以 App 的 space 為準
- Bash 裡的 `hc send`／`keys`／`run`／`interrupt`… 會記成這個 session 指揮的目標；`hc run` 沒給 `--name` 時從回傳的位址記

#### 在 App 裡開 tendr 看板

App 的右側面板也可以放一份 tendr 看板（lane 一覽與子頁、即時畫面、按鍵、回覆、交接文件、記憶），不用切到 Claude Code 的 session：

```bash
node app/install.mjs --layout my-main   # my-main 換成你的 layout
```

- App 內建的 layout 是唯讀的（每次啟動會換回原版）：先在命令面板 Duplicate layout，再裝到複製的那份。`--layout` 會在它的右側面板（stack `panel-body`）加一個 `tendr` 區塊；沒有這個 stack 的 layout 要自己放 `{ "mod": "tendr-board" }`
- 打開：`herdr-app do layout.select '{"stack":"panel-body","child":"tendr"}'` 再 `herdr-app do layout.show '{"id":"panel"}'`，或自己做個按鈕／快捷鍵。要讓 tab 列依 space 記住開關，把 `tendr` 加進 shared 的 `workspace.panels`
- 看哪個專案：聚焦的終端機資料夾（依序是聚焦的、同一個分頁、同一個 space 的），第一個有 `tendr.json`（或改名前的檔名）的
- 指令（`herdr-app do tendr-board.<指令>` 或 `keys.json` 綁 `tendr-board:<指令>`）：`urgent` 跳到最需要處理的 lane、`next`／`prev` 照列表順序換、`back` 回列表
- 資料由 `app/board-data.mjs` 讀，路徑規則與外掛相同；安裝時記下 node 與這支腳本的絕對路徑，搬了 repo 要重裝。安裝也會寫 `~/.tendr/install.json`（repo、`resume.mjs`、看板的位置），讓別的 mod 找得到 tendr
- lane 的 `pane` 寫 hc 位址（`t7`）或名稱，才有即時畫面；`hc read` 一次約 2～3 秒

#### 主控與自動交接（App）

在 App 裡通常是看右側的 tendr 看板，不會在 Claude 裡打 `/tendr`，所以主控改在看板上指定。列表最上面的「交接」區塊講的是**選著的那格 Claude**（在左邊的 agent 清單點哪個就是哪個；選著的不是 Claude 時，找同一個分頁、同一個 space 的）：

- 終端機位址與「space / 分頁」名稱（分頁常常都叫 Claude Code，只看分頁名分不出是哪一格）、快取倒數條（綠 → 剩 10 分鐘黃 → 剩 5 分鐘紅，10 分鐘內到秒）、現在的狀態（剩 5 分鐘時自動交接／不是主控，不會自動交接／交接中（寫狀態檔與記憶）／壓縮中／已交接，等新指示），以及「立即交接」按鈕——只送給這一格
- 下面一行是它的專案資料夾與狀態檔；同一個資料夾還有別的 Claude 時用黃字提醒：lane 資料夾、記憶、交接文件都共用，不同專案的工作請在各自的資料夾開 Claude
- 主控是別格時另外列「★ 主控是 t16 · space / 分頁」與它的快取倒數；還沒指定主控時提醒不會自動交接。「設這格為主控」「取消主控」「其他 N 個 Claude」（可挑一個設為主控）在最下面
- 看板用選著的 Claude 自己回報的專案資料夾（`~/.tendr/sessions`），不看終端機目前的 cwd——cwd 可能早就換了，旁邊那格的資料夾也可能是別的專案、別的主控
- 主控記在 `~/.tendr/lead.json`（`{ 專案代號: { terminal } }`，專案代號是 session 根目錄換成 `-` 的小寫），依終端機記，App 重開機、接回對話後仍是主控。外掛 5 秒內看到
- 自動交接的條件和流程跟上面「自動交接的流程」一樣（`1h` 快取、上下文至少 20%、`away_hours` 以內）：剩 5 分鐘時送出交接指示，Claude 更新自己的 lane 狀態檔（或交接文件）與記憶，寫完自動壓縮
- 每個 Claude 把快取倒數與交接狀態寫在 `~/.tendr/sessions/<終端機>.json`（有變才寫），看板 10 秒讀一次、交接中每 3 秒；「立即交接」寫 `~/.tendr/requests/<終端機>.json`，外掛 2 秒內接手，處理完標上 `done`，放超過 2 分鐘的不算
- 需要外掛 0.12 以上；更新後要重開 Claude Code，看板上才會出現它
- 看板標題前的火焰：tendr 是守著爐火、不讓它熄滅的人。這個專案有主控在顧（會自動交接）時火是亮的，沒有主控時是暗的

#### 重開機後接回 Claude

herdr App 關掉視窗、更新都不會中斷終端機；但重開機或登出後，core 只會在原本的資料夾給一個新的 shell，不會重新執行 Claude（官方要等 OSC 7501 能帶 session id 才支援）。tendr 補上這段：

- 外掛在 App 的終端機裡，每輪開始時把「終端機 ↔ 對話」記在 `~/.tendr/resume/<位址>.json`：終端機的建立時間與 shell 的 pid、session id、專案資料夾、`CLAUDE_CONFIG_DIR`
- 自己離開（`/exit`、ctrl+c、登出）的標成已結束，不接回；關機、重開機（SIGHUP／SIGTERM）的留著
- `node app/resume.mjs`：終端機還在、建立時間對得上、但 pid 變了（被恢復成新的 shell）的，在那個 shell 送 `claude --resume <id>`。PowerShell、cmd、bash 系各有對應寫法，會先回到專案資料夾、帶上原本的 `CLAUDE_CONFIG_DIR`。可以重複跑，送過的不會再送；`--dry-run` 只列出會做什麼
- 要在 App 啟動時自動跑：從一個一直顯示的 mod（例如狀態列）`exec("node", ["<repo>/app/resume.mjs"])`，前幾分鐘每分鐘再跑一次（core 恢復終端機可能晚一點）。[herdr-quota](https://github.com/ailazytech/herdr-quota) 的狀態列已經內建：讀 `~/.tendr/install.json` 找到 `resume.mjs`
- 只接回 Claude Code；啟動時給的參數（例如 `--model`、`--dangerously-skip-permissions`）不會帶上

#### App 側邊欄顯示 Claude 在不在忙（Windows）

herdr App 只認程式自己用 OSC 7501（Program Status Protocol）回報的狀態。Claude Code 2.1.295 起會回報，但要先送 `OSC 7501 ; ?` 問到終端機支援；Windows 的 ConPTY 把終端機的回覆濾掉，Claude Code 就當成不支援、一直不報，側邊欄看不到它在工作、等你或完成。

tendr 在 **Windows 的 herdr App** 裡替它報：一輪開始 `working`、跳出權限確認或提問 `blocked`、答完 `done`、被中斷 `idle`、一輪外的壓縮（自動交接、手動 `/compact`）`working` 壓完回到 `done`、離開時清掉。外掛起的子程式沒接在終端機的主控台上，所以 `hooks/osc7501.ps1` 用 `AttachConsole` 掛到終端機裡 shell 的主控台寫進去（每次約 0.4 秒，依序送、只留最新的）。macOS／Linux 上 Claude Code 自己會報，tendr 不插手。

## 開發

從本機資料夾加入的 marketplace，安裝版直接讀這個資料夾，存檔後執行中的 session 會自動重載，不用改版本號或跑 update。不要再同時用 `--plugin-dir` 載入同一個資料夾，否則會載入兩份。

```bash
claude plugin test
```

測試裡的使用者、專案與路徑都是虛構的（`/Users/user/Projects/example-app`、`D:\work\example-app`）。預設用 macOS 的路徑與 `HOME`，`setup(on, { windows: true })` 改用 Windows 的路徑與 `USERPROFILE`。macOS 與 Windows 都實測過。

架構與貢獻須知見 [AGENTS.md](AGENTS.md)。

## 授權

[MIT](LICENSE)
