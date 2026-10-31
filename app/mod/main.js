// tendr 看板（herdr App 版）：lane 一覽與子頁（步驟、等你決定、即時畫面、按鍵、回覆）、交接文件、記憶
// 資料由 tendr repo 的 app/board-data.mjs 讀（路徑規則與外掛一致），這裡只負責畫面與 hc 操作。
// 由 app/install.mjs 裝到 ~/.config/herdr-app/mods/tendr-board，config.js 也是它寫的
import { View, div } from "gpui-kit";
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

// lane 對應的終端機（pane 欄位是 hc 位址或名稱）在 App 裡的即時狀態
function paneOf(l) {
  if (!l.pane) return null;
  return panes().find((p) => p.terminal === l.pane || p.terminal?.endsWith("/" + l.pane)) ?? null;
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
    // 正在看的 lane；重載（存檔、換 layout 回來）後停在原本那條
    this.route = localStorage.getItem("route") || null;
    this.quietOpen = false;
    this.memOpen = false;
    this.screen = null; // { lane, lines, at, error }
    this.reading = false;
    this.watching = "";
    this.reply = InputState.new({ placeholder: "回覆這條 lane…" });
    this.reply.on("submit", (_e, cx) => this.send(cx));
    this.load(cx);
    // lane 在別的 session 寫狀態檔：資料夾有變就重讀，另外 10 秒保底（timer 在面板收起時也會跑，別太勤）
    cx.timer.every(10_000, (cx) => this.load(cx));
    cx.timer.every(3_000, (cx) => { if (this.route) this.readScreen(cx); });
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
    cx.spawn(async (cx) => {
      try {
        const r = await exec(NODE, [DATA_SCRIPT, ...candidates()]);
        if (r.code !== 0) throw new Error(r.stderr || "exit " + r.code);
        this.data = JSON.parse(r.stdout);
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
    if (lane) localStorage.setItem("route", lane);
    else localStorage.removeItem("route");
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
    const header = h_flex().px(10).h(34).gap(6).items_center().border_b(1).border_color(t.border)
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
