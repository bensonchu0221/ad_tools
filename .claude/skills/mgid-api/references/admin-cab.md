# admin.mgid.com CAB 速查（2026-07-08 萃取）

## 原則：不要用截圖辨識圖示

CAB 的小圖示都是 `<img>`/`<a>` 標籤，意義在 `title` 屬性、`src` 檔名和 `href` 裡。
用 `javascript_tool` 讀 DOM 屬性（純文字、省 token），不要 screenshot。

## 圖示對照表（Publishers > Websites 頁）

| src 檔名 | title / 意義 | href 模式 |
|----------|-------------|-----------|
| `publisher-icon.svg` | **Publisher dashboard**（免密碼登入該 client 的 Broadciel client zone） | `/cab/wages/clients-publishers-link/client_id/{cid}` |
| `broadciel_s.png` | Broadciel subnet 標記 | — |
| `edit.png` | Edit 網站設定 | `/cab/wages/sites-edit/id/{wid}/...` |
| `history.png` | View history 操作記錄 | `/cab/overall-log/show-log/table_id/{id}/...` |
| `user3.png` | 回到該 Client 的列表 | `/cab/wages/clients/client_id/{cid}` |
| `dub.png` | Widgets 版位列表 | `/cab/wages/widgets/domain/{domain}/client_id/{cid}` |
| `money-out-icon-1.png` | Disable payouts（**寫入操作，勿碰**） | — |
| `del.png` | Delete site（**寫入操作，勿碰**） | — |
| `suspicion.png` | IP / 錢包 / email 重複警示 | — |
| `ghits_dfp_flag_off.svg` | 設為 GAM 網站（**寫入操作，勿碰**） | — |
| `icon_edit.png` | panel.mgid.com 端編輯 | `https://panel.mgid.com/publishers/sites/{id}` |

## 常用 URL 模式（GET，唯讀）

- 全部媒體（依 Media Buyer 過濾）：`/cab/wages/sites?media_buyers=jasper&btnsubmit=Filter`
- Publisher 客戶列表：`/cab/wages/clients?media_buyers=jasper&btnsubmit=Filter`
- 依 Client ID 過濾：加 `client_id={cid}`
- **進入某 client 的 publisher dashboard**：`/cab/wages/clients-publishers-link/client_id/{cid}`
  （會自動跳轉 pub.native.broadciel.com 並帶登入 code；進去後 Settings → API 拿 token）

## Jasper 名下媒體清單（website_id | domain | client_id）

```
Client 979759（linzhongjyun@popin.cc / Chungchun Lin）
  1098768 discovery.popin.tw
  1098784 pacplatform.net
  1103493 edh.tw
Client 980148（adgeek）
  1099299 innews.com.tw
  1099301 steachs.com
  1099302 cool-style.com.tw
  1099304 yaonews.net
Client 980310（NISSIN / wei-kin@nissin.ch）
  1099305 tw.live
  1099308 npower.heho.com.tw
  1102288 tools.heho.com.tw
  1102589 icook.tw
  1102590 technews.tw
  1102592 ccc.technews.tw
  1102593 finance.technews.tw
  1102618 ent.ebc.net.tw
Client 980329（Alex / hill@bfm.com.tw）★ 目前 mgid-mcp .env 使用中
  1099332 tsna.com（主要收益來源）
  1099333 nownews.com
  1099650 shanbao.news
  1101574 walkerland.com.tw
  1102290 rakuya.com.tw
  1102403 taipeiwalker.walkerland.com.tw
Client 983450（Mickey Wen / infotimes）尚無 publisher dashboard
  1103082 ctee.com.tw
  1103083 chinatimes.com
Client 978965（Amber / amber@popin.cc）Client API ID 859274
```

清單可能隨時間變動；重新萃取方式：開 `/cab/wages/sites?media_buyers=jasper&btnsubmit=Filter`
後用 javascript_tool 抓各 row 的 sites-edit / widgets / clients 連結參數（見本檔案的產生方式）。
