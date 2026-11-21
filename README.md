# 台灣軌道運輸碳足跡計算箱 (`tw-track-carbon`)

> **晧脈元素庫定位**：`Fe`（26 鐵・Iron）  
> **技術架構**：100% 免費開放資料（免 TDX 收費 API）＋ Python 建置期靜態編譯 ＋ Cloudflare Pages 純靜態部署

## 支援九大軌道系統

1. **台灣高鐵 (`THSR`)**：直接查詢官方起迄站旅客運輸服務碳足跡對照表（`direct_matrix`），並附營業里程參考。
2. **國營臺灣鐵路 (`TRA`)**：解析官方營業里程表 `mile.pdf`（15 條幹線與支線、240 站），支援自強號 (`0.036`)、莒光號 (`0.050`)、區間／區間快 (`0.055 kgCO2e/pkm`)。
3. **台北捷運 (`TRTC`)**：採用政府資料開放平臺 `128418` 票價距離表（119 站），套用 113 年盤查碳足跡標籤 `0.075 kgCO2e/pkm`（含運具 `30g`＋車站 `45g`）。
4. **桃園機場捷運 (`TYMC`)**：採用政府資料開放平臺 `128436` 起迄站距離 XML（22 站），預設採環境部通用係數（支援前端顧問覆寫）。
5. **高雄捷運紅／橘線 (`KRTC`)**：OSM 站點座標依紅線 `29.76 km`、橘線 `14.40 km` 等比校準（38 站，於 `O5/R10 美麗島` 轉乘），套用 2026 年官方碳標籤 `0.220 kgCO2e/pkm`。
6. **台中捷運 (`TMRT`)**、**淡海輕軌 (`NTDLRT`)**、**安坑輕軌 (`NTALRT`)**、**高雄環狀輕軌 (`KLRT`)**：收錄維基百科站距與 OSM 校準（環狀輕軌 `22.1 km` 自動取較短路徑），支援前端係數覆寫。

## 本機建置與驗證

```bash
# 1. (選用) 更新免費官方開放資料至 raw_data/
python scripts/fetch_open_data.py

# 2. 編譯 raw_data/ 為前端靜態 JSON (public/data/*.json)
python scripts/build_data.py

# 3. 執行自動化檢核（JSON 完整性、9 大系統、https 來源、零異體字 U+7693、徽章標籤）
python scripts/verify_project.py
```

## Cloudflare Pages 部署設定

- **Framework preset**：None（純靜態）
- **Build command**：`python scripts/build_data.py && python scripts/verify_project.py`
- **Build output directory**：`public`
