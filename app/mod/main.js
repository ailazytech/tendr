// tendr 看板（herdr App 版）：主控與快取倒數（立即交接、指定主控）、lane 一覽與子頁（步驟、等你決定、即時畫面、按鍵、回覆）、交接文件、記憶
// 資料由 tendr repo 的 app/board-data.mjs 讀（路徑規則與外掛一致），這裡只負責畫面與 hc 操作。
// 由 app/install.mjs 裝到 ~/.config/herdr-app/mods/tendr-board，config.js 也是它寫的
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, hc, theme, focused, panes, spaces, settings, watchFolder, notify, nextCommand } from "herdr";
import { NODE, DATA_SCRIPT } from "./config.js";

const LOOK = {
  blocked: ["⚠", "ansi1", "等你"],
  failed: ["✖", "ansi1", "失敗"],
  review: ["✔", "ansi3", "待審"],
  working: ["◐", "ansi2", "進行中"],
  idle: ["○", "dim", "待命"],
  done: ["✓", "dim", "完成"],
};
const STEP_ICONS = { done: "✔", doing: "◐", todo: "○", skip: "–" };
const KEYS = [["enter", "Enter"], ["esc", "Esc"], ["1", "1"], ["2", "2"], ["3", "3"]];
const SCREEN_ROWS = 24;

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "剛剛";
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// 快取倒數：10 分鐘內到秒，其他到分
function left(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m >= 10) return `${m}m`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// 外掛寫的交接狀態（~/.tendr/sessions）→ 倒數文字、顏色與進度條比例
function cacheOf(s, t, now) {
  if (!s.lastRequestAt) return { text: "快取尚未建立", tone: t.dim, frac: 0 };
  const remaining = s.lastRequestAt + s.ttlMs - now;
  if (remaining <= 0) return { text: "快取已過期 " + left(-remaining), tone: t.ansi1, frac: 0 };
  const lead = s.leadMs ?? 300_000;
  const tone = remaining <= lead ? t.ansi1 : remaining <= 2 * lead ? t.ansi3 : t.ansi2;
  return { text: "快取剩 " + left(remaining), tone, frac: Math.min(1, remaining / s.ttlMs) };
}

// 主控現在在做什麼、會不會自動交接（和外掛看板底部的說法一致）
function phaseOf(s) {
  if (s.phase === "handoff") return "交接中…（寫狀態檔與記憶）";
  if (s.phase === "compacting") return "壓縮中…";
  if (!s.auto) return "自動交接已關（外掛看板可打開）";
  if (s.cacheTtl !== "1h") return `快取 ${s.cacheTtl}，不自動交接`;
  if (!s.armed) return "已交接，等新指示";
  return `剩 ${Math.round((s.leadMs ?? 300_000) / 60000)} 分鐘時自動交接`;
}

// 終端機位址（可能是 machine/t7）對到 App 裡的 pane
function paneOfTerminal(terminal) {
  if (!terminal) return null;
  return panes().find((p) => p.terminal === terminal || p.terminal?.endsWith("/" + terminal)) ?? null;
}

// 終端機在哪個分頁：給人看的名字
function terminalLabel(terminal) {
  const p = paneOfTerminal(terminal);
  const tab = p ? spaces().flatMap((sp) => sp.tabs ?? []).find((x) => x.id === p.tab) : null;
  return terminal + (tab?.name ? " · " + tab.name : "");
}

// lane 對應的終端機（pane 欄位是 hc 位址或名稱）在 App 裡的即時狀態
function paneOf(l) {
  return l.pane ? paneOfTerminal(l.pane) : null;
}
const dialogOf = (l) => paneOf(l)?.status?.state === "blocked";
const needsAttention = (l) => l.state === "blocked" || l.state === "failed" || l.state === "review" || dialogOf(l);

function standing(l) {
  if (dialogOf(l) && l.state !== "blocked") return "對話框等確認";
  if (l.state === "blocked") return "等你：" + (l.needs ?? "");
  if (l.state === "failed") return "失敗：" + (l.needs || (l.step ? l.step.id + " " + l.step.title : ""));
  if (l.state === "review") return "做完待審" + (l.head ? " · HEAD " + l.head : "");
  if (l.state === "working") return l.step ? l.step.id + " " + l.step.title : "";
  if (l.state === "idle") return l.needs || "待命";
  return "已驗收";
}

// 目前在哪個 space 的哪個分頁：變了就該換專案
function whereNow() {
  const f = focused();
  return (f?.space ?? "") + "/" + (f?.tab ?? "");
}

// App 只知道終端機的資料夾：依序給 focused、同一個分頁、同一個 space 的，board-data 挑第一個有 tendr 設定的
function candidates() {
  const f = focused();
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  add(f?.cwd);
  const all = panes();
  for (const p of all) if (p.tab === f?.tab) add(p.cwd);
  const space = spaces().find((s) => s.id === f?.space);
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  for (const p of all) if (tabs.has(p.tab)) add(p.cwd);
  return out;
}

export default class TendrBoard extends View {
  init(_props, cx) {
    this.data = null;
    this.error = "";
    // 正在看的 lane：依專案各記一條，資料載入、知道是哪個專案後才還原（見 load）
    this.root = null;
    this.route = null;
    this.loadSeq = 0;
    this.where = whereNow();
    this.quietOpen = false;
    this.memOpen = false;
    this.leadOpen = false; // 「換主控」的清單
    this.screen = null; // { lane, lines, at, error }
    this.reading = false;
    this.watching = "";
    this.reply = InputState.new({ placeholder: "回覆這條 lane…" });
    this.reply.on("submit", (_e, cx) => this.send(cx));
    this.load(cx);
    // lane 在別的 session 寫狀態檔：資料夾有變就重讀，另外 10 秒保底（timer 在面板收起時也會跑，別太勤）
    cx.timer.every(10_000, (cx) => this.load(cx));
    cx.timer.every(3_000, (cx) => {
      if (this.route) this.readScreen(cx);
      // 主控在交接或壓縮：跟著看進度
      if (this.leadSession()?.phase && this.leadSession().phase !== "idle") this.load(cx);
    });
    // 換了 space 或分頁就馬上換專案：focused() 變動只會重畫，不會自己重讀資料
    cx.timer.every(1_000, (cx) => {
      const where = whereNow();
      if (where === this.where) {
        // 快取倒數每秒走（只有列表上看得到）
        if (!this.route && this.leadSession()?.lastRequestAt) cx.notify();
        return;
      }
      this.where = where;
      this.load(cx);
    });
    // keys.json 或 herdr-app do tendr-board.<指令>：urgent 跳到最需要處理的 lane，next／prev 照列表順序換，back 回列表
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const order = this.order();
        const i = order.findIndex((l) => l.lane === this.route);
        if (c === "urgent" && order.length) this.open(order[0].lane, cx);
        if (c === "next" && order.length) this.open(order[(i + 1) % order.length].lane, cx);
        if (c === "prev" && order.length) this.open(order[(i - 1 + order.length) % order.length].lane, cx);
        if (c === "back") this.go(null);
        cx.notify();
      }
    });
  }

  // 列表的順序：要處理的、進行中、待命與完成
  order() {
    const lanes = this.data?.lanes ?? [];
    const rest = lanes.filter((l) => !needsAttention(l));
    return [...lanes.filter(needsAttention), ...rest.filter((l) => l.state === "working"), ...rest.filter((l) => l.state !== "working")];
  }

  load(cx) {
    // 連續切換時舊的那次可能比較晚回來：只收最後一次
    const seq = ++this.loadSeq;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(NODE, [DATA_SCRIPT, ...candidates()]);
        if (seq !== this.loadSeq) return;
        if (r.code !== 0) throw new Error(r.stderr || "exit " + r.code);
        const data = JSON.parse(r.stdout);
        if (data.root !== this.root) {
          this.root = data.root;
          this.route = localStorage.getItem("route:" + data.root) || null;
          this.screen = null;
        }
        this.data = data;
        this.error = "";
        this.watch(cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // 換專案時改看新的 tasks_dir；舊的那圈發現不是自己的就停
  watch(cx) {
    const dir = this.data?.tasksDir;
    if (!dir || dir === this.watching) return;
    this.watching = dir;
    cx.spawn(async (cx) => {
      while (this.watching === dir) {
        await watchFolder(dir);
        if (this.watching !== dir) break;
        this.load(cx);
      }
    });
  }

  lane() {
    return this.data?.lanes?.find((l) => l.lane === this.route) ?? null;
  }

  // 這個專案的主控（看板指定的終端機）和它的交接狀態；主控還沒回報時 session 是 null
  leadSession() {
    const lead = this.data?.lead?.terminal;
    return lead ? (this.data.sessions ?? []).find((s) => s.terminal === lead) ?? null : null;
  }

  // 按鈕都交給 board-data.mjs 寫檔（mod 不能寫檔），寫完重讀；外掛 2～5 秒內會看到
  act(args, done, cx) {
    cx.spawn(async (cx) => {
      const r = await exec(NODE, [DATA_SCRIPT, ...args]);
      if (r.code === 0) notify({ title: done, level: "info", timeout: 4000 });
      else notify({ title: "tendr 看板寫不進去", body: (r.stderr || r.stdout || "exit " + r.code).slice(0, 160), level: "error" });
      this.load(cx);
      cx.timer.after(3000, (cx) => this.load(cx));
      cx.timer.after(6000, (cx) => this.load(cx));
    });
  }

  setLead(s, cx) {
    this.leadOpen = false;
    this.act(["--lead", s.terminal, s.project], `${s.terminal} 設為主控：快取快過期時會自動交接`, cx);
  }

  clearLead(cx) {
    this.leadOpen = false;
    this.act(["--lead", "-", this.data.projectKey], "已取消主控：不會自動交接", cx);
  }

  handoffNow(s, cx) {
    this.act(["--handoff", s.terminal], `已請 ${s.terminal} 交接：寫完狀態檔與記憶後壓縮`, cx);
  }

  // 列表最上面：主控、快取倒數、交接狀態、立即交接；沒有主控時列出這個專案的 Claude 讓人挑
  leadView(t, now) {
    const d = this.data;
    const sessions = d?.sessions ?? [];
    const leadTerminal = d?.lead?.terminal;
    const s = this.leadSession();
    const rows = [div().px(10).pt(10).pb(2).text_size(11).text_color(t.dim).child("交接")];
    const button = (id, label, on, solid) => div().id(id).px(8).py(2).rounded(4)
      .bg(solid ? t.solid : t.raised).text_color(solid ? t.solid_foreground : t.muted).hover((x) => x.bg(solid ? t.solid : t.hover))
      .text_size(11.5).on_click((_e, cx) => on(cx)).child(label);
    const pick = (x) => h_flex().id("pick-" + x.terminal).px(10).py(3).gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(paneOfTerminal(x.terminal) ? t.muted : t.dim)
        .child(terminalLabel(x.terminal) + " · " + cacheOf(x, t, now).text))
      .child(button("lead-" + x.terminal, "設為主控", (cx) => this.setLead(x, cx)));

    if (!leadTerminal) {
      rows.push(div().px(10).text_size(11.5).text_color(t.ansi3).child("還沒指定主控：快取快過期時不會自動交接"));
      if (!sessions.length) rows.push(div().px(10).pt(2).text_size(11).text_color(t.dim).child("這個專案的 Claude 還沒回報（tendr 0.12 以上，重開 Claude Code 後出現）"));
      rows.push(...sessions.map(pick));
      return rows;
    }

    const alive = Boolean(paneOfTerminal(leadTerminal));
    rows.push(h_flex().px(10).gap(6).items_center()
      .child(div().text_color(t.ansi4 ?? t.foreground).child("★"))
      .child(div().flex_1().min_w(0).truncate().text_color(alive ? t.foreground : t.dim)
        .child("主控 " + terminalLabel(leadTerminal) + (alive ? "" : "（不在視窗裡）")))
      .child(s && s.phase === "idle" ? button("handoff-now", "立即交接", (cx) => this.handoffNow(s, cx), true) : div()));
    if (!s) {
      rows.push(div().px(10).pt(2).text_size(11).text_color(t.dim).child("這個終端機的 Claude 還沒回報；重開 Claude Code 後出現"));
    } else {
      const c = cacheOf(s, t, now);
      const bar = div().w(64).h(6).rounded(3).bg(t.border).child(div().h_full().w(Math.round(64 * c.frac)).rounded(3).bg(c.tone));
      rows.push(h_flex().px(10).pt(4).gap(6).items_center()
        .child(bar)
        .child(div().text_size(11.5).text_color(c.tone).child(c.text))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(s.phase === "idle" ? t.dim : t.ansi3).child("· " + phaseOf(s))));
      if (s.lastRequestAt && s.contextPercent < (s.minContextPercent ?? 20) && s.phase === "idle")
        rows.push(div().px(10).text_size(11).text_color(t.dim).child(`上下文只有 ${s.contextPercent}%，到時會略過自動交接`));
      if (s.note) rows.push(div().px(10).text_size(11).text_color(t.dim).truncate().child(String(s.note)));
    }
    const others = sessions.filter((x) => x.terminal !== leadTerminal);
    rows.push(h_flex().px(10).pt(4).gap(10).items_center()
      .child(others.length
        ? div().id("toggle-lead").text_size(11).text_color(t.dim).hover((x) => x.text_color(t.foreground))
          .on_click((_e, cx) => { this.leadOpen = !this.leadOpen; cx.notify(); })
          .child(`${this.leadOpen ? "▾" : "▸"} 換主控（還有 ${others.length} 個 Claude）`)
        : div())
      .child(div().flex_1())
      .child(div().id("clear-lead").text_size(11).text_color(t.dim).hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => this.clearLead(cx)).child("取消主控")));
    if (this.leadOpen) rows.push(...others.map(pick));
    return rows;
  }

  // hc read 一次要 2～3 秒：上一次還沒回來就不再疊一個
  readScreen(cx) {
    const l = this.lane();
    if (!l?.pane || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      const at = Date.now();
      try {
        const r = await hc(["read", l.pane, "--lines", String(SCREEN_ROWS + 15)]);
        if (r.code !== 0) throw new Error(r.stderr || "exit " + r.code);
        const lines = r.stdout.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        this.screen = { lane: l.lane, lines: lines.slice(-SCREEN_ROWS), at, error: "" };
      } catch (e) {
        this.screen = { lane: l.lane, lines: [], at, error: String(e?.message ?? e) };
      }
      this.reading = false;
      cx.notify();
    });
  }

  go(lane) {
    this.route = lane;
    this.screen = null;
    if (lane) localStorage.setItem("route:" + this.root, lane);
    else localStorage.removeItem("route:" + this.root);
  }

  open(lane, cx) {
    this.go(lane);
    this.readScreen(cx);
    cx.notify();
  }

  send(cx) {
    const l = this.lane();
    const text = this.reply.value().trim();
    if (!l?.pane || !text) return;
    cx.spawn(async (cx) => {
      // 停在對話框時 hc 不送（不加 --force），留給使用者自己按
      const r = await hc(["send", l.pane, text]);
      if (r.code === 0) {
        this.reply.set_value("");
        notify({ title: "已送給 " + l.lane, level: "info", timeout: 3000 });
      } else {
        notify({ title: "送不出去", body: (r.stderr || r.stdout || "exit " + r.code).slice(0, 120), level: "error" });
      }
      cx.timer.after(1500, (cx) => this.readScreen(cx));
      cx.notify();
    });
  }

  key(k, cx) {
    const l = this.lane();
    if (!l?.pane) return;
    cx.spawn(async (cx) => {
      const r = await hc(["keys", l.pane, k]);
      if (r.code !== 0) notify({ title: "按鍵送不出去", body: (r.stderr || "exit " + r.code).slice(0, 120), level: "error" });
      cx.timer.after(800, (cx) => this.readScreen(cx));
    });
  }

  // ---- 畫面 ----

  laneRow(l, t, now) {
    const [icon, color] = LOOK[l.state];
    const tone = t[color] ?? t.muted;
    const dialog = dialogOf(l);
    return v_flex().id("lane-" + l.lane).px(10).py(5).gap(1).rounded(6).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(l.lane, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().text_color(dialog ? t.ansi1 : tone).child(dialog ? "⚠" : icon))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(l.lane))
        .child(div().text_color(tone).child(`${l.progress.percent}%`)))
      .child(div().pl(18).truncate().text_size(11.5).text_color(dialog || l.state === "blocked" ? t.ansi1 : t.dim).child(standing(l)));
  }

  listView(t, now) {
    const d = this.data;
    const lanes = d?.lanes ?? [];
    const rows = [];
    const section = (text) => div().px(10).pt(10).pb(2).text_size(11).text_color(t.dim).child(text);
    const order = this.order();
    const urgent = order.filter(needsAttention);
    const active = order.filter((l) => !needsAttention(l) && l.state === "working");
    const quiet = order.filter((l) => !needsAttention(l) && l.state !== "working");
    rows.push(...this.leadView(t, now));
    rows.push(div().mx(10).mt(10).h(1).bg(t.border));
    if (!d?.tasksDir) rows.push(div().p(10).text_color(t.dim).child("這個專案沒有設 tasks_dir，任務分頁沒有內容。"));
    if (d?.lanesError) rows.push(div().px(10).text_color(t.ansi3).child(d.lanesError === "no-tasks-dir" ? "找不到 tasks_dir 資料夾" : d.lanesError));
    if (urgent.length) rows.push(section(`需要處理 ${urgent.length}`), ...urgent.map((l) => this.laneRow(l, t, now)));
    if (active.length) rows.push(section(`進行中 ${active.length}`), ...active.map((l) => this.laneRow(l, t, now)));
    if (quiet.length) {
      rows.push(div().id("toggle-quiet").px(10).pt(10).pb(2).text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.quietOpen = !this.quietOpen; cx.notify(); })
        .child(`${this.quietOpen ? "▾" : "▸"} 待命與完成 ${quiet.length}`));
      if (this.quietOpen) rows.push(...quiet.map((l) => this.laneRow(l, t, now)));
    }
    rows.push(div().mx(10).my(10).h(1).bg(t.border));
    rows.push(div().px(10).text_size(11.5).text_color(t.dim).truncate()
      .child(d?.handoff ? `交接：${d.handoff.path.split("/").pop()} · ${ago(now - d.handoff.mtimeMs)}` : "交接：還沒寫交接文件"));
    const mems = d?.memories ?? [];
    rows.push(div().id("toggle-mem").px(10).pt(4).text_size(11.5).text_color(t.dim).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.memOpen = !this.memOpen; cx.notify(); })
      .child(`${this.memOpen ? "▾" : "▸"} 記憶 ${mems.length} 則`));
    if (this.memOpen) {
      for (const m of mems) {
        rows.push(v_flex().px(10).pl(22).py(2)
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(m.name + (m.layer ? ` · ${m.layer}` : m.type ? ` · ${m.type}` : "")))
          .child(div().truncate().text_size(11).text_color(t.dim).child(m.description)));
      }
    }
    return rows;
  }

  laneView(l, t, now) {
    const [icon, color] = LOOK[l.state];
    const tone = t[color] ?? t.muted;
    const updated = Date.parse(l.updated);
    const pane = paneOf(l);
    const rows = [
      div().id("nav-back").px(10).pt(6).text_size(11.5).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.go(null); cx.notify(); }).child("← 任務 › " + l.lane),
      h_flex().px(10).pt(6).gap(8).items_start()
        .child(div().flex_1().min_w(0).text_color(t.foreground).font_semibold().child(String(l.title)))
        .child(div().text_color(tone).child(`${l.progress.percent}% ${l.progress.done}/${l.progress.total}`)),
      div().px(10).text_size(11.5).text_color(tone).truncate().child(
        `${icon} ${LOOK[l.state][2]}` + (pane?.status ? ` · App ${pane.status.state}` : "") + (updated ? ` · 更新 ${ago(now - updated)}` : "")),
    ];
    rows.push(div().h(6));
    for (const s of l.steps) {
      rows.push(div().px(10).text_size(12).truncate()
        .text_color(s.state === "doing" ? t.ansi3 : s.state === "done" || s.state === "skip" ? t.dim : t.muted)
        .child(`${STEP_ICONS[s.state] ?? "?"} ${s.id} ${s.title}`));
    }
    // child() 只吃字串或元素：狀態檔是別人寫的，一律轉字串
    if (l.needs) rows.push(div().px(10).pt(8).text_color(t.ansi1).font_semibold().child("等你決定"), div().px(10).text_color(t.foreground).child(String(l.needs)));
    if (l.notes?.length) {
      rows.push(div().px(10).pt(8).text_color(t.muted).font_semibold().child("備註"));
      for (const n of l.notes) rows.push(div().px(10).text_size(11.5).text_color(t.dim).child("• " + String(n)));
    }
    if (l.pane) {
      const sc = this.screen?.lane === l.lane ? this.screen : null;
      rows.push(h_flex().px(10).pt(10).gap(8).items_center()
        .child(div().text_color(t.muted).font_semibold().child("即時畫面"))
        .child(div().text_size(11).text_color(t.dim).child(sc ? ago(now - sc.at) : "讀取中…"))
        .child(div().flex_1())
        .child(div().id("screen-refresh").text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => this.readScreen(cx)).child("↻")));
      if (sc?.error) rows.push(div().px(10).text_size(11).text_color(t.ansi1).child(sc.error.slice(0, 200)));
      rows.push(v_flex().mx(10).mt(4).p(8).rounded(6).bg(t.background).border_1().border_color(t.border)
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(10.5).text_color(t.foreground)
        .children((sc?.lines ?? []).map((line) => div().truncate().child(line || " "))));
      rows.push(h_flex().px(10).pt(8).gap(6).items_center()
        .child(div().text_size(11).text_color(t.dim).child("按鍵"))
        .children(KEYS.map(([k, label]) => div().id("key-" + k).px(8).py(2).rounded(4).bg(t.raised).hover((s) => s.bg(t.hover))
          .text_size(11.5).text_color(t.muted).on_click((_e, cx) => this.key(k, cx)).child(label))));
      rows.push(h_flex().px(10).pt(8).pb(10).gap(6).items_center()
        .child(div().flex_1().min_w(0).child(Input.new(this.reply).h(30).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground)))
        .child(div().id("reply-send").px(10).h(30).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(12)
          .on_click((_e, cx) => this.send(cx)).child("送出")));
    }
    return rows;
  }

  render() {
    const t = theme();
    const now = Date.now();
    const l = this.lane();
    // tendr：守著爐火、不讓它熄滅的人。這個專案有主控在顧（會自動交接）時火是亮的
    const header = h_flex().px(10).h(34).gap(6).items_center().border_b(1).border_color(t.border)
      .child(svg("mods/tendr-board/flame.svg").size(14).text_color(this.leadSession() ? t.ansi3 : t.dim))
      .child(div().text_color(t.foreground).font_semibold().child("tendr"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.data?.name ? "· " + this.data.name : ""))
      .child(div().id("board-refresh").text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.load(cx)).child("↻"));
    const body = this.error && !this.data
      ? [div().p(10).text_color(t.ansi1).child("讀不到看板資料：" + this.error.slice(0, 300))]
      : !this.data
        ? [div().p(10).text_color(t.dim).child("載入中…")]
        : this.route && l
          ? this.laneView(l, t, now)
          : this.listView(t, now);
    return v_flex().size_full().bg(t.surface).text_size(12.5).text_color(t.muted)
      .child(header)
      .child(v_flex().id("board-body").flex_1().min_h(0).overflow_y_scrollbar().pb(10).children(body));
  }
}
