# TASKS.md — 台灣軌道運輸碳足跡計算箱 (`tw-track-carbon`)

> **專案代號**：`tw-track-carbon`  
> **預計網域**：`https://tw-track-carbon.pages.dev/`  
> **晧脈元素庫定位**：`Fe`（26 鐵・Iron・過渡金屬第 4 週期，與 `Ti` 22 鈦空運並列移動運輸專列）  
> **技術架構**：100% 免費開放資料（免 TDX 收費 API）＋ Python 建置期靜態編譯 ＋ GitHub ＋ Cloudflare Pages 純靜態部署  
> **品牌用字鐵律**：全站文案、標題、JSON 與程式碼註解一律使用「**晧**」（Unicode `U+6667`），嚴禁出現異體字（`U+7693`）。

---

## Phase 1：專案初始化與免費資料管線 (`raw_data/` + `scripts/`)

### 1.1 建立專案目錄結構
```text
tw-track-carbon/
├── raw_data/
│   ├── thsr_carbon_matrix.json       # 高鐵起迄站官方碳足跡表（12站兩兩直查）
│   ├── tra_mile_override.json        # 台鐵營業里程整理（來源：官方 mile.pdf）
│   ├── trtc_fares.csv                # 台北捷運票價距離 CSV（data.gov.tw 128418）
│   ├── tymc_fares.xml                # 桃園捷運票價距離 XML（data.gov.tw 128436）
│   ├── krtc_stations_geo.json        # 高雄捷運紅/橘線 39 站座標與路線拓樸（OSM 校準用）
│   ├── wiki_rail_distances.json      # 台中捷運、淡海輕軌、安坑輕軌、高雄環狀輕軌站距表
│   └── emission_factors_mrv.json     # 三層級 MRV 碳排放係數主檔（含公告年份與邊界說明）
├── scripts/
│   ├── fetch_open_data.py            # 免費官方檔案抓取工具（北捷 CSV、桃捷 XML、台鐵 PDF、OSM）
│   ├── build_data.py                 # 異質資料正規化編譯器 → 產出 public/data/*.json
│   └── verify_project.py             # 資料完整性、URL 欄位與零異體字 (U+7693) 自動檢核
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── data/
│       ├── rail_network.json         # 前端統一讀取的 9 大軌道系統站點與距離表
│       └── factors_mrv.json          # 前端讀取的 MRV 係數與引用說明主檔
├── .github/workflows/
│   └── verify-and-build.yml          # CI 驗證與靜態資料建置檢查
└── README.md
```

### 1.2 九大軌道系統免費距離來源與編譯規則 (`scripts/build_data.py`)
所有系統皆不依賴收費之 TDX API，於建置期統一轉換為相同 Schema 輸出至 `public/data/rail_network.json`：

1. **台灣高鐵 (`THSR`)**
   - 模式：`direct_matrix`（兩站直接查官方碳足跡表，不以距離反推，同時保留站間營業里程作參考顯示）。
   - 來源 URL：`https://www.thsrc.com.tw/ArticleContent/5a1f4c72-b564-4706-bcdd-efbda93c3d93`
   - 官方每人每公里參考係數：`0.029 kgCO2e/pkm`。
2. **國營臺灣鐵路 (`TRA`)**
   - 模式：`distance_x_factor`（支援車種切換：自強號 `0.036`、莒光號 `0.050`、區間／區間快 `0.055 kgCO2e/pkm`）。
   - 距離來源：解析官方營業里程表 `https://tip-tr4cdn.cdn.hinet.net/tra-tip-web/static/file/T-table1140508/mile.pdf` 存入 `raw_data/tra_mile_override.json`。
   - 係數來源：`https://www.trc.com.tw/tra-tip-web/adr/AdrI190/AdrI190/view?grandParentTitle=13&parentTitle=14`（搭配 [央廣報導](https://www.rti.org.tw/news?uid=3&pid=157157) 查核車種數值）。
3. **台北捷運 (`TRTC`)**
   - 模式：`distance_x_factor`，係數 `0.075 kgCO2e/pkm`（113 年盤查公告，含運具行駛 `0.030` + 車站服務 `0.045`）。
   - 距離來源：下載並解析政府資料開放平臺 `https://data.gov.tw/dataset/128418` CSV 票價距離表。
   - 係數來源：`https://www.metro.taipei/cp.aspx?n=5B7ACD566D2CB1DD` 與 `https://www.easycard.com.tw/new?cls=2&id=1767166545`。
4. **桃園機場捷運 (`TYMC`)**
   - 模式：`distance_x_factor`，預設套用環境部通用捷運係數（Tier 2/3，前端開放顧問覆寫）。
   - 距離來源：下載並解析政府資料開放平臺 `https://data.gov.tw/dataset/128436` XML 起迄站票價距離表。
   - 係數來源：`https://data.moenv.gov.tw/dataset/detail/CFP_P_02`。
5. **高雄捷運紅／橘線 (`KRTC`)**
   - 模式：`distance_x_factor`，係數 `0.220 kgCO2e/pkm`（2026 年公告碳標籤值，含全車站營運分攤）。
   - 距離免費解法：腳本優先呼叫免費 OpenStreetMap Overpass API 取得軌道折線投影站距；若離線或逾時則自動 fallback 至 `raw_data/krtc_stations_geo.json` 39 站經緯度計算相鄰 Haversine 距離，並依官方營運長度（紅線 `29.76 km`、橘線 `14.4 km`）等比縮放校準。跨紅橘線於 `O5/R10 美麗島` 自動加總。
   - 距離來源註記：`https://www.openstreetmap.org/` 搭配 `https://zh.wikipedia.org/zh-tw/%E9%AB%98%E9%9B%84%E6%8D%B7%E9%81%8B%E8%BB%8A%E7%AB%99%E5%88%97%E8%A1%A8`。
   - 係數來源：`https://cfp.moenv.gov.tw/Carbon/WebPage/visitors/FLProductinfoView.aspx?SerialNo=71433BCB57E5EFAB960C3268B75EDB2D` 與 `https://www.easycard.com.tw/new?cls=2&id=1767166545`。
6. **高雄環狀輕軌 (`KLRT`)、台中捷運 (`TMRT`)、淡海輕軌 (`NTDLRT`)、安坑輕軌 (`NTALRT`)**
   - 模式：`distance_x_factor`，預設套用環境部通用捷運係數（Tier 2/3，前端開放顧問切換為北捷值或自訂值）。
   - 距離來源：收錄維基百科各線車站列表之相鄰站距與累計里程於 `raw_data/wiki_rail_distances.json`（高雄環狀輕軌全長 `22.1 km` 自動取順／逆時針較短路徑）：
     - 台中捷運：`https://zh.wikipedia.org/zh-tw/%E8%87%BA%E4%B8%AD%E6%8D%B7%E9%81%8B%E8%BB%8A%E7%AB%99%E5%88%97%E8%A1%A8`
     - 安坑輕軌：`https://zh.wikipedia.org/zh-tw/%E5%AE%89%E5%9D%91%E8%BC%95%E8%BB%8C`
     - 淡海輕軌：`https://zh.wikipedia.org/zh-tw/%E6%B7%A1%E6%B5%B7%E8%BC%95%E8%BB%8C`
     - 高雄環狀輕軌：`https://zh.wikipedia.org/zh-tw/%E9%AB%98%E9%9B%84%E7%92%B0%E7%8B%80%E8%BC%95%E8%BB%8C`

### 1.3 統一資料 Schema 規範
每一個軌道系統在 `rail_network.json` 中必須包含以下 Metadata，確保前端引用說明完全由資料驅動：
```json
{
  "system_id": "TRTC",
  "name_zh": "台北捷運",
  "calc_mode": "distance_x_factor",
  "distance_source": {
    "level": "official_fare_table",
    "label": "政府資料開放平臺票價里程換算",
    "url": "https://data.gov.tw/dataset/128418",
    "updated_at": "2026-11",
    "note": "依臺北捷運系統票價資料 CSV 對應兩站最短營業里程。"
  },
  "factor_source": {
    "tier": "Tier 1",
    "tier_label": "官方碳足跡標籤",
    "value_kg_per_pkm": 0.075,
    "breakdown": { "vehicle_kg": 0.030, "station_kg": 0.045 },
    "announcement_year": "2026 (113年盤查)",
    "boundary_note": "已包含列車行駛階段 (30g) 與車站空調、照明等服務階段 (45g)，不可與未含車站服務之舊通用係數直接混比。",
    "url": "https://www.metro.taipei/cp.aspx?n=5B7ACD566D2CB1DD"
  }
}
```

---

## Phase 2：工具箱介面 (UI/UX) 與 MRV 引用說明設計

### 2.1 整體視覺與版面架構
- 採乾淨專業的科技工具風格（高對比淺色為主，支援 RWD 手機與桌機檢視）。
- **頂部導覽列**：
  - 左側：子站獨立主 Logo 與站名「台灣軌道運輸碳足跡計算箱｜Taiwan Track Carbon」。
  - **最右側與頁尾品牌列**：嵌入晧脈元素庫中央共用 3D 旋轉回航徽章（**嚴禁遮擋或取代子站主 Logo**）：
    ```html
    <script src="https://hao-element-matrix.pages.dev/badge.js" defer></script>
    <hao-element-badge symbol="Fe" theme="light"></hao-element-badge>
    ```
- **四大主分頁（Tabs）**：
  1. `單趟精算`
  2. `多段轉乘行程`
  3. `CSV 批次試算`
  4. `係數與引用總表`

### 2.2 核心互動功能
1. **單趟精算**：
   - 運具選擇膠囊（高鐵、台鐵、北捷、桃捷、中捷、高捷、淡海輕軌、安坑輕軌、高雄輕軌）。
   - 起站／迄站支援模糊搜尋（輸入中文站名、路線編號或站碼如 `R16`、`A12`、`板橋` 皆可秒搜），附「起迄對調」按鈕。
   - 選台鐵時自動顯示「車種選擇」（自強號 / 莒光號 / 區間・區間快）。
   - 支援「單程 / 來回（×2）」與「乘客人數」調整，即時顯示總碳排（同時標示 `kgCO2e` 與 `gCO2e`）及總里程（`km`）。
2. **多段轉乘行程**：
   - 可將每次計算加入行程清單，或直接新增多段不同運具（例：北捷 → 高鐵 → 高捷），自動加總全程總碳排與總距離，並以堆疊橫條圖顯示各運具碳排佔比。
   - 內建 2 組「示範案例一鍵載入」（例如：台北至高雄高鐵轉乘出差、雙北捷運輕軌通勤）。
3. **CSV 批次試算（企業範疇三差旅盤查專用）**：
   - 提供「下載標準 CSV 範本」按鈕（欄位：`日期,運具代碼,起站,迄站,車種,是否來回,人數,備註`）。
   - 支援拖曳或選取 CSV 上傳，純前端解析計算，逐列標示成功或站名異常。
   - 一鍵匯出 **MRV 查證底稿 CSV**（自動附加：`計算里程_km`、`採用係數_kgCO2e_pkm`、`總碳排_kgCO2e`、`距離來源等級`、`係數等級`、`資料來源網址`）。

### 2.3 「引用說明（MRV 佐證抽屜）」必備設計
每筆計算結果下方必須清楚呈現以下五個區塊，確保查證員可一秒核對：
1. **透明公式列**：完整顯示 `距離 (km) × 係數 (kgCO2e/pkm) × 趟數 × 人數 = 結果`；高鐵採直查表時明確標註「直接引用高鐵起迄站官方碳足跡對照表」。
2. **雙重等級徽章**：並排顯示「距離來源等級」（如：官方營業里程／票價換算／OSM 校準／維基整理）與「係數等級」（`Tier 1 官方碳標籤` 綠標、`Tier 2 環境部通用` 藍標、`Tier 3 近似替代` 灰標）。
3. **雙來源直連卡**：分欄列出「里程來源（含日期與可點擊官方網址）」與「係數來源（含公告年份與可點擊官方網址）」。
4. **盤查邊界警示條**：
   - 選用**台北捷運**時顯示：75g 拆解為「運具行駛 30g ＋ 車站服務 45g」。
   - 選用**高雄捷運**時顯示：220g 依 2026 年碳標籤公告包含全車站營運分攤，數值較高係因盤查邊界完整且運量基數不同，並非系統誤算（可附 [玉山銀行 2026 支付碳帳戶說明](https://event.esunbank.com.tw/credit/1121101esg_c/index.html) 佐證）。
   - 選用**桃捷／中捷／輕軌**時顯示：尚無專屬碳標籤，目前採環境部通用係數，並提供「進階係數覆寫選單」（可切換通用值／北捷值／自訂數值，切換後自動標註「使用者自訂」並同步更新引用文字）。
5. **一鍵複製報告書引用文字**：點擊後複製完整繁體中文引用句，例如：
   > 本次台灣高鐵（板橋－左營，往返 1 人）碳排放量依台灣高鐵官網公告之起迄站碳足跡對照表計算，計為 XX.XX kgCO2e（來源：台灣高鐵旅客運輸服務碳足跡專區，https://www.thsrc.com.tw/ArticleContent/5a1f4c72-b564-4706-bcdd-efbda93c3d93）。

---

## Phase 3：自動驗證與 Cloudflare Pages 部署

1. 實作 `scripts/verify_project.py`，執行以下強制檢核：
   - 確認 `public/data/rail_network.json` 與 `public/data/factors_mrv.json` 存在且 JSON 格式合法。
   - 確認 9 大軌道系統皆有站點清單、距離資料與有效 `https://` 來源連結。
   - 掃描全倉庫文字檔確認**零異體字 `U+7693`**（一律使用 `晧` `U+6667`）。
   - 確認 `public/index.html` 已正確引入 `https://hao-element-matrix.pages.dev/badge.js` 與 `<hao-element-badge symbol="Fe" ...>`。
2. 設定 `.github/workflows/verify-and-build.yml`：每次 Push 自動執行 `python scripts/build_data.py` 與 `python scripts/verify_project.py`。
3. 推送至 GitHub 倉庫 `whaochen/tw-track-carbon`，並連結 Cloudflare Pages（Build output directory 設為 `public`，免伺服器、免環境變數金鑰）。

---

## 附錄：晧脈元素庫 (`hao-element-matrix`) 雙向對接指令

> 執行前請先於主站倉庫核對最新 `data/projects.json`，確認 `Fe` 未被占用。

### 指令 A-1（開工期間｜新增 `Fe` 挖礦預告礦脈）
請於主站 `whaochen/hao-element-matrix` 的 `data/mining_veins.json` 新增一筆探勘礦脈（不佔正式元素格）：
```json
{
  "id": "tw-track-carbon",
  "codename": "Fe · 台灣軌道運輸碳足跡計算箱",
  "stage": "資料管線與介面建置中",
  "progress": 25,
  "color": "#29b6f6",
  "sector": "過渡金屬｜工程計算",
  "hint": "串聯高鐵、台鐵、北高桃中捷運與三大輕軌，免付費 API 純靜態精算並附完整 MRV 查證引用。",
  "baseEnergy": 72
}
```
完成後執行 `python scripts/verify_project.py` 確認零異體字與 JSON 正確後 commit 並 push。

### 指令 A-2（上線點亮時｜正式寫入 `Fe` 並畢業移除礦脈）
待 `https://tw-track-carbon.pages.dev/` 測試上線後，於主站 `data/projects.json` 寫入以下資料，並從 `data/mining_veins.json` 移除 `id: "tw-track-carbon"`：
```json
"Fe": {
  "shortName": "軌道碳算",
  "title": "台灣軌道運輸碳足跡計算箱",
  "subtitle": "Taiwan Track Carbon",
  "description": "整合高鐵、台鐵、北高桃中捷運與輕軌免費里程資料，依官方碳標籤精算碳排並附完整查證引用。",
  "whyElement": "鐵為鐵道之本，串聯高鐵台鐵與捷運輕軌，與航太鈦 Ti 並列海陸空碳排雙璧。",
  "url": "https://tw-track-carbon.pages.dev/",
  "domainLabel": "tw-track-carbon.pages.dev",
  "status": "beta",
  "statusLabel": "BETA 測試中",
  "tags": ["軌道碳排", "範疇三差旅", "MRV引用"],
  "emblemType": "default"
}
```
完成後執行 `python scripts/verify_project.py` 確認通過後 commit 並 push。
