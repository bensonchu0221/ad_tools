# MGID 媒體報表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新工具 `/tools/mgidsource`：排程把 MGID `day×source` raw 寫進 Cloud SQL，頁面讀庫組成 MSN 合併、折線／堆積、合計表、每日鑽取。

**Architecture:** 三層。`compose.ts` 純函式（raw → 畫面模型）；`ingest.ts` 決定視窗、打 `fetchMgidSourceReport`、視窗取代寫庫；`page.ts`+`route.ts` 走 Slot Board `sbPage()`，圖用頁內 SVG。不即時打 MGID。

**Tech Stack:** Node + TypeScript ESM、Fastify、mysql2、既有 `core/mgid.ts`／`store.ts`／`sbui.ts`。無 Chart.js、無 daisyUI。

**Spec:** `docs/superpowers/specs/2026-08-24-mgid-source-report-design.md`

## Global Constraints

- UI 一律 `sbPage()` Slot Board 語彙（`--paper/--ink/--accent`、`.card` `.combo` `.qtable` `.src-m`）；頁寬 `1200px`；NAV label `MGID 媒體`
- Raw 粒度 `(api_client_id, dt, source)`，source＝API 原名；MSN 只在讀時 `trim` 後 case-insensitive `startsWith('MSN')` 合併
- 指標：imp／click／spend／三階次數；CTR／CPC／CPA 加總後重算，分母 0 → `null`（畫面 `—`）
- CPA = spend ÷ buy；Y 軸圖只做 spend
- 折線＝合計 spend 前 5（無「其他」）；堆積＝同 5 名＋「其他」（每日柱高＝當日總 spend）；點「其他」不選中
- ingest：帳戶 IANA timezone 的昨天為 `ed`；無 raw → 含頭尾 90 日；有 raw → 含頭尾 7 日視窗取代
- 不救 0 click campaign 的 source；不引 Chart.js／daisyUI
- token 清單排除 api_client_id 以 `98` 開頭
- cron 需 DIAG_KEY；`path.endsWith('/cron')` 已在 auth 白名單
- 驗證風格：`poc/verify_*.mts` 的 `eq`／變異測試，不新增測試框架

---

### Task 1: compose 純函式

**Files:**
- Create: `src/tools/mgidsource/compose.ts`
- Test: `poc/verify_mgid_source_compose.mts`

**Produces:** `SourceRawRow`, `compose()`, `applyWindow()`, `mediaName()`, `addDaysYmd()`, `ymdInTz()`, `yesterdayYmd()`

- [ ] Write failing tests then implement（TDD）

---

### Task 2: MGID 抓取薄封裝

**Files:**
- Modify: `src/core/mgid.ts` — 匯出 `getClientTimezone`；新增 `fetchMgidSourceReport`

**Produces:** `fetchMgidSourceReport(client, sd, ed): Promise<SourceRawRow[]>`（內部 `day+source`、攤平金額、`normDay`）

---

### Task 3: store raw + jobs

**Files:**
- Modify: `src/core/store.ts` — `mgid_source_raw`／`mgid_source_jobs` CRUD、claim、視窗取代

---

### Task 4: ingest

**Files:**
- Create: `src/tools/mgidsource/ingest.ts` — 決定視窗、抓取、寫庫、跑一帳 job

---

### Task 5: 頁面 + 路由 + 導覽

**Files:**
- Create: `src/tools/mgidsource/page.ts`, `src/tools/mgidsource/route.ts`
- Modify: `src/core/sbui.ts` NAV、`src/server.ts` TOOLS + register
- Modify: `CLAUDE.md` 加 tool#5 一段

Scheduler 鐘點（11:00／每分鐘 worker）寫在 CLAUDE／spec，本 task 只做 HTTP 入口；Cloud Scheduler 需另建（實作後註明）。
