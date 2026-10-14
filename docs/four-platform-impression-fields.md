# 四平台曝光／可視曝光欄位對照（D／R／M／P）

> 2026-10-13 整理。每一條都附實測來源；「未驗證」的地方有標出來。
> 樣本期間：比例統計用 nexus BQ 9/14–10/12 或 10/5–10/11；公式驗算用 10/8 單日真 API。

---

## 1. 總覽

| | **D**（Discovery） | **R**（Rixbee） | **M**（MGID） | **P**（Prism） |
|---|---|---|---|---|
| 有沒有分「一般／可視」 | ❌ 只有一種 | ✅ 有 | ✅ 有（但分母是請求數，見下） | ✅ 有 |
| API 的曝光欄位 | `imp` | `impression` | **同一個數字、三支端點各自命名**：`impressions`（statistics-reports，會少 0.05–0.13%）／`shows`（teaser-stat，＝後台）／`imps`（campaigns-stat，＝後台） | `impressions` |
| API 的可視曝光欄位 | — | `exposure_report` | **就是上一列那個**（MGID 的曝光本身就是可視曝光） | `viewable_impressions` |
| 「總量」欄位（可視率分母） | — | `impression` | `adRequests`（＝Redash `Impressions (Total)`） | `impressions` |
| API 的可視率欄位 | — | `exposure_rate` | `viewability`（＝Redash `Viewability, %`） | `viewability` |
| **後台顯示的「曝光」是哪個** | `imp` | ❓ 未驗證（要請 AM 看 RixDesk 一個帳戶一天） | 可視曝光（Redash Viewable＝teaser-stat＝後台，825 格全等） | ❓ 未驗證 |
| nexus 統一 view 用哪個當 `impressions` | `imp` | `impression`（一般） | `imp`（可視） | `impressions`（一般） |
| nexus 有另外存可視曝光嗎 | — | ✅ 素材表 `exposure_report` | 不需要（imp 本身就是） | ✅ 素材表 `viewable_impressions` |
| 實測可視率 | — | **51.1%**（非影音；9/14–10/12） | **9.84%**（Viewable÷Total；10/5–10/11） | **85.1%**（10/5–10/11） |

**結論：跨平台的「曝光」不是同一種東西**——D、R、P 的統一 view 欄位是一般曝光，M 是可視曝光；三種可視率的分母也不同（R／P 除以「曝光」，M 除以「廣告請求」），**不能並排比可視率**。

---

## 2. D 平台（Discovery）

### 2.1 API 欄位
| 端點 | 曝光 | 其他相關 |
|---|---|---|
| ad 層 `date_reporting`（per-ad／bulk） | `imp` | `click, ctr, cpc, cpm, charge, cv, cvr, mcv` |
| campaign 層 `date_reporting?platform_cv=1` | `imp`（總數）＋ `pc_imp`／`mobile_imp`（裝置） | 平板等平台不給 base 指標 |
| `site/day/list`（媒體） | `imp` | 實測比素材層少約 0.2%（原因未查） |

- **沒有可視曝光欄位**：discovery-api skill 與報表端點回傳欄位都沒有 viewable／exposure。
- `imp` 怎麼計數：lib6 讀碼是「版位 **inView → 送 imp log**」（`recommend-system` skill `media-frontend-lib6.md`），也就是進入畫面才算曝光；**inView 的門檻（露出多少比例、幾秒）未查**。走 DSP／MSN 等外部供給的 imp 是否同一套計數，也未驗證。

### 2.2 比率欄公式（10/8 實測，帳戶 32635 campaign 5165101）
| 欄位 | 公式 | 單位 | 驗算 |
|---|---|---|---|
| `ctr` | click ÷ imp | **百分比數字**、兩位小數 | 2,493 ÷ 1,164,953 = 0.214% → API `0.21` ✓ |
| `cpm` | charge ÷ imp × 1000 | 帳戶幣別 | 12,465 ÷ 1,164,953 × 1000 = 10.70 ✓ |
| `cpc` | charge ÷ click | 帳戶幣別 | 12,465 ÷ 2,493 = 5.00 ✓ |

### 2.3 nexus 存法
| 表 | 欄位 | 來源 |
|---|---|---|
| `nexus_d_ad_daily` | `imp` | per-ad／bulk `date_reporting` |
| `nexus_device_daily`（platform='D'） | `imp` | campaign 層 `pc_imp`／`mobile_imp`；**Others＝總數 − PC − Mobile** |
| `nexus_media_daily`（platform='D'） | `imp` | `site/day/list` |
| `nexus_integrated_daily` | `impressions` ← `imp` | |

- 10/5–10/11 合計 `imp` = **78,465,092**。

---

## 3. R 平台（Rixbee）

### 3.1 API 欄位（報表 API，metrics 白名單 41 個）
| 欄位 | 語意 | 單位 |
|---|---|---|
| `impression` | **一般曝光** | 整數 |
| `exposure_report` | **可視曝光** | 整數 |
| `exposure_rate` | 可視率＝exposure_report ÷ impression | **百分比數字**（70.22 就是 70.22%） |
| `exposure_click_rate` | click ÷ exposure_report | 百分比數字 |
| `click_rate` | click ÷ impression | 百分比數字 |
| `thousand_imp_cost` | 千次曝光成本（分母推測是 impression） | ⚠️ 未驗算 |
| `thousand_req_cost` | 千次請求成本 | ⚠️ 未驗算 |

- **`metrics: []`（預設全部）拿不到 `exposure_*`**，一定要指名。nexus 有指名；**AdStream、週報傳空陣列，所以都沒有可視曝光**。
- 欄名不能用 viewable／viewability，送出去會回 1002 被白名單擋掉。
- 公式驗算（2026-08-25，cpg 182664）：52,219 ÷ 74,363 = 70.22 = `exposure_rate` ✓；274 ÷ 52,219 = 0.525 = `exposure_click_rate` ✓；274 ÷ 74,363 = 0.368 = `click_rate` ✓。

### 3.2 實測比例（nexus BQ 9/14–10/12）
| 切法 | 可視率 |
|---|---|
| 全平台非影音（34 帳戶、2.26 億曝光） | **51.1%** |
| 每日 | 44.5%–59.9%（週末偏高，例 9/19–9/20 約 59%） |
| 各帳戶（曝光 ≥ 1 萬） | 28.9%（覺亞髮品）～72.1%（大新禮品） |
| **影音素材**（2 帳戶、24 萬曝光，例 9235 三得利 TADAS） | **一律 0%**：R 不算影音的可視曝光，算可視率要排除 |
| 可視 > 曝光的異常列 | 29 天 23 列、合計多 86 次，可忽略 |

- **跟 API 對帳**：10/8、10/11 全平台 `impression` 8,531,445／4,819,094、`exposure_report` 3,901,145／2,416,609，**與 BQ 一字不差**。

### 3.3 nexus 存法
| 表 | 一般曝光 | 可視曝光 |
|---|---|---|
| `nexus_r_cr_daily` | `impression` | **`exposure_report`** |
| `nexus_device_daily`（platform='R'） | `imp` ← `impression` | ❌ 沒抓 |
| `nexus_media_daily`（platform='R'） | `imp` ← `impression` | ❌ 沒抓 |
| `nexus_integrated_daily` | `impressions` ← `impression` | ❌ 不在 view 裡 |

---

## 4. M 平台（MGID）

### 4.1 API 與 Redash 欄位對照
| 意思 | statistics-reports | teaser-stat | campaigns-stat | Redash 13252 |
|---|---|---|---|---|
| **可視曝光（＝後台曝光）** | `impressions` | `shows` | `imps` | `Impressions (Viewable)` |
| 總量（廣告請求數，widget 每個格位算一次） | `adRequests` | — | — | `Impressions (Total)` |
| 可視率 | `viewability`（％數字） | — | — | `Viewability, %` |
| 點擊 | `clicks` | `clicks` | `clicks` | `Clicks` |

- **MGID 沒有叫「viewable」的 API 欄位**；它的 `impressions` 本身就是可視曝光（real_shows）。

### 4.2 比率欄公式（10/8 實測，帳戶 872519）
**statistics-reports**（campaign 12504390：adRequests 183,117／impressions 123,292／clicks 313）
| 欄位 | 公式 | 單位 | 驗算 |
|---|---|---|---|
| `viewability` | impressions ÷ adRequests × 100 | ％數字 | 123,292 ÷ 183,117 = 67.33 ✓ |
| `ctr` | clicks ÷ **adRequests** | ％數字 | 313 ÷ 183,117 = 0.171% → `0.17` ✓ |
| `vCtr` | clicks ÷ **impressions** | ％數字 | 313 ÷ 123,292 = 0.254% → `0.25` ✓ |
| `cpm` | spent ÷ **adRequests** × 1000 | `{amount,currency}` | campaign 12506894：6 ÷ 42,961 × 1000 = 0.1397 ✓ |
| `vCpm` | spent ÷ **impressions** × 1000 | `{amount,currency}` | 6 ÷ 605 × 1000 = 9.917 ✓ |

⇒ **不帶 v 的指標分母是請求數，帶 v 的分母才是曝光**。後台習慣的 CTR＝`vCtr`。

**teaser-stat**（teaser 28073862：shows 85,558／clicks 192）
| 欄位 | 公式 | 驗算 |
|---|---|---|
| `ctr` | clicks ÷ **shows** | 192 ÷ 85,558 = 0.2244% → `0.224409` ✓（％數字、六位小數） |

### 4.3 實測數字（10/5–10/11，台北時區）
| 比較 | 數字 | 結果 |
|---|---|---|
| 後台曝光（nexus `imp`，teaser-stat） vs Redash Viewable | 11,049,594 vs 11,049,594 | **825 格（日×campaign）全等** |
| Redash Total vs API `adRequests` | 112,245,743 vs 112,104,152 | Redash 多 0.13% |
| statistics-reports `impressions` vs 後台 | — | 少 0.05–0.13%（已知；nexus 用 teaser-stat 校正） |
| Redash `Viewability, %` ＝ Viewable ÷ Total | 931 列 | **全部吻合** |
| 可視率（Viewable ÷ Total） | 整體 **9.84%**／desktop 27.7%／tablet 12.1%／mobile **5.5%** | mobile 占 Total 的 79% |

### 4.4 nexus 存法
| 表 | 曝光（可視） | 總量 | 來源 |
|---|---|---|---|
| `nexus_m_teaser_daily` | `imp` | `ad_requests` | imp 用 teaser-stat `shows` 蓋掉；ad_requests 沿用 statistics-reports |
| `nexus_device_daily`（platform='M'） | `imp` | ❌ | Redash `Impressions (Viewable)` |
| `nexus_media_daily`（platform='M'） | `imp` | ❌ | statistics-reports（source 維度）`impressions`，比素材層少約 0.11% |
| `nexus_integrated_daily` | `impressions` ← `imp` | ❌ | |
| Redash 墊底列（`client:` 開頭帳戶） | `imp` ← Viewable | `ad_requests` ← Total | |

---

## 5. P 平台（Prism）

### 5.1 API 欄位（來源：`popIn_Audience_Center` `generate_report_data` 的 `metric_map`）
P 的每個指標都是 BQ `prism_events` 裡**各自獨立的事件計數**：

| 欄位 | SQL 定義 | 單位 |
|---|---|---|
| `impressions` | `COUNTIF(event_name='impression')` | 整數 |
| `viewable_impressions` | `COUNTIF(event_name='viewable')` | 整數 |
| `viewability` | viewable ÷ impression | **小數**（0.85 = 85%） |
| `ctr` | click ÷ impression | 小數 |
| `vctr` | click ÷ viewable | 小數 |
| `vtr` | 100%view ÷ impression | 小數 |

- 因為是獨立事件，**可能出現 viewable > impression、clicks > impressions**，照原值存、不修正。分母 0 時比率是 `null`。
- `viewable` 事件的判定標準（是否 IAB 50%×1 秒）要看打點端，未查。

### 5.2 實測比例（nexus BQ 9/14–10/12）
| 群組 | 可視率 |
|---|---|
| 一般 campaign（國泰航空、安達人壽、蜜得絲中時錨底、固力伸影音…） | **82–93%** |
| News AI Ads 類（里山、juliArt、漢堡王、蜜得絲） | 17–18% |
| Coupang Reco Ads（9/14–9/30 每天約 150 萬曝光，10/1 起幾乎停） | **6.1%**（CTR 0.01%，按點擊計價所以不多花錢） |
| 全平台 10/5–10/11 | 85.1% |

- 9/30 → 10/1 全平台可視率從 16% 跳到 78%，是 campaign 組成改變（上面兩群低可視率的停了），**不是資料問題**。
- **10/9–10/11 全平台每天只有約 1,750 曝光**，來源事件表也一樣，原因未查（國慶連假暫停？收集端異常？要問 P 平台）。
- **跟來源對帳**：直接對 `prism_events` 重算 9/28–10/12，逐日與 BQ 一致，只有 10/5 可視曝光差 2 次。

### 5.3 nexus 存法
| 表 | 一般曝光 | 可視曝光 |
|---|---|---|
| `nexus_p_creative_daily` | `impressions` | **`viewable_impressions`** |
| `nexus_device_daily`（platform='P'） | `imp` ← `impressions` | ❌ 沒抓 |
| `nexus_media_daily`（platform='P'） | `imp` ← `impressions` | ❌ 沒抓 |
| `nexus_integrated_daily` | `impressions` ← `impressions` | ❌ 不在 view 裡 |

---

## 6. nexus 各表 × 平台：曝光欄位一覽

| 表 | D | R | M | P |
|---|---|---|---|---|
| 素材表（各平台一張） | `imp` | `impression`＋`exposure_report` | `imp`（可視）＋`ad_requests` | `impressions`＋`viewable_impressions` |
| `nexus_device_daily.imp` | 一般 | 一般 | **可視** | 一般 |
| `nexus_media_daily.imp` | 一般 | 一般 | **可視** | 一般 |
| `nexus_integrated_daily.impressions` | 一般 | 一般 | **可視** | 一般 |

> 「一般」對 D 而言是 D 唯一的那個 `imp`（lib6 inView 才送，門檻未查）。

---

## 7. 其他工具的曝光欄位

| 工具 | D | R | M | P |
|---|---|---|---|---|
| AdStream Sheet | `imp`、`ctr`（click÷imp） | `impression`，**沒有 exposure**（metrics 空陣列） | `imp`（可視）、`ad_requests`；**`ctr`／`cpm` 直接拿 API 的值，分母是 adRequests** | `impressions`、`viewable_impressions`、`viewability`、`ctr` |
| 整合週報 | `imp` | `impression`，沒有 exposure | `imp`；CTR 自己用 click÷imp 算（`adjust.ts`） | — |
| MGID 媒體報表（tool#5） | — | — | `imp`；CTR 自己算（`compose.ts`） | — |

- AdStream M 分頁裡用 teaser-stat 補回的列都是零點擊 campaign，`ctr` 一定是 0，所以實際上沒有混到兩種口徑。

---

## 8. 待確認
1. R、P 後台畫面上的「曝光」是一般還是可視（請 AM 各看一個帳戶一天）。
2. D `imp` 的 inView 門檻；外部供給（MSN／DSP）的 imp 是否同一套計數。
3. P `viewable` 事件的判定標準。
4. P 10/9–10/11 幾乎沒有曝光的原因。
5. 要不要把 AdStream M 分頁的 `ctr`／`cpm` 改成以 `imp` 為分母。
