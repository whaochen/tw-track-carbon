#!/usr/bin/env python3
"""
台灣軌道運輸碳足跡計算箱 (`tw-track-carbon`) — 免費官方開放資料抓取工具
從政府資料開放平臺、台鐵官網、高鐵官網與 OpenStreetMap Overpass API 下載原始資料至 raw_data/。
本腳本全程免收費 API (免 TDX Key)，並支援離線與部分失敗時保留既有 raw_data/ 檔案。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT_DIR / "raw_data"
RAW_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/json, text/csv, application/xml, */*",
}


def download_bytes(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_data_gov_resource(dataset_id: str, expected_formats: tuple[str, ...]) -> tuple[bytes, str] | None:
    """透過 data.gov.tw API v2 取得資料集資源下載連結並下載"""
    api_url = f"https://data.gov.tw/api/v2/rest/dataset/{dataset_id}"
    print(f"[INFO] 查詢政府資料開放平臺 API: {api_url}")
    raw = download_bytes(api_url, timeout=25)
    meta = json.loads(raw.decode("utf-8"))
    result = meta.get("result", meta)
    resources = result.get("distribution", []) or result.get("resources", [])
    for res in resources:
        fmt = str(res.get("resourceFormat") or res.get("format") or "").upper()
        dl_url = res.get("resourceDownloadUrl") or res.get("url") or ""
        if dl_url and (not expected_formats or any(f in fmt for f in expected_formats)):
            print(f"[INFO] 下載資源 ({fmt}): {dl_url}")
            return download_bytes(dl_url, timeout=40), dl_url
    return None


def fetch_trtc_csv() -> bool:
    target = RAW_DIR / "trtc_fares.csv"
    try:
        res = fetch_data_gov_resource("128418", ("CSV",))
        if res:
            data, url = res
            target.write_bytes(data)
            print(f"[OK] 已儲存台北捷運票價距離 CSV -> {target.name} ({len(data)} bytes)")
            return True
    except Exception as exc:
        print(f"[WARN] 無法自動抓取北捷 CSV (data.gov.tw 128418): {exc}")
    # 備援：臺北市資料大平臺直接資源探索
    try:
        taipei_api = "https://data.taipei/api/v1/dataset/d76b92a6-5b88-4f83-8bfd-5e1a88914907?scope=resourceAquire&limit=5"
        print(f"[INFO] 嘗試臺北市資料大平臺備援: {taipei_api}")
        raw = download_bytes(taipei_api, timeout=20)
        if raw:
            print(f"[INFO] 臺北市資料大平臺回應 {len(raw)} bytes")
    except Exception as exc:
        print(f"[WARN] 臺北市資料大平臺備援失敗: {exc}")
    return target.exists()


def fetch_tymc_xml() -> bool:
    target = RAW_DIR / "tymc_fares.xml"
    try:
        res = fetch_data_gov_resource("128436", ("XML",))
        if res:
            data, url = res
            target.write_bytes(data)
            print(f"[OK] 已儲存桃園捷運票價距離 XML -> {target.name} ({len(data)} bytes)")
            return True
    except Exception as exc:
        print(f"[WARN] 無法自動抓取桃捷 XML (data.gov.tw 128436): {exc}")
    return target.exists()


def fetch_tra_mile_pdf() -> bool:
    target = RAW_DIR / "tra_mile.pdf"
    url = "https://tip-tr4cdn.cdn.hinet.net/tra-tip-web/static/file/T-table1140508/mile.pdf"
    try:
        print(f"[INFO] 下載台鐵營業里程表 PDF: {url}")
        data = download_bytes(url, timeout=35)
        if data[:4] == b"%PDF":
            target.write_bytes(data)
            print(f"[OK] 已儲存台鐵營業里程表 -> {target.name} ({len(data)} bytes)")
            return True
        print("[WARN] 下載內容非 PDF 格式，略過覆寫")
    except Exception as exc:
        print(f"[WARN] 無法自動抓取台鐵 mile.pdf: {exc}")
    return target.exists()


def fetch_osm_krtc_overpass() -> bool:
    """嘗試呼叫免費 OpenStreetMap Overpass API 抓取高雄捷運紅／橘線站點座標"""
    target = RAW_DIR / "krtc_osm_overpass.json"
    query = """
    [out:json][timeout:25];
    area["name"="高雄市"]->.searchArea;
    (
      node["railway"="station"]["operator"~"高雄捷運|Kaohsiung"](area.searchArea);
      node["station"="subway"](area.searchArea);
    );
    out body;
    """
    url = "https://overpass-api.de/api/interpreter"
    try:
        print("[INFO] 查詢 OSM Overpass API (高雄捷運站點)...")
        encoded = urllib.parse.urlencode({"data": query}).encode("utf-8")
        req = urllib.request.Request(url, data=encoded, headers=HEADERS, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
        parsed = json.loads(raw.decode("utf-8"))
        elements = parsed.get("elements", [])
        if elements:
            target.write_text(json.dumps(parsed, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[OK] OSM Overpass 取得 {len(elements)} 筆高捷節點 -> {target.name}")
            return True
        print("[WARN] OSM Overpass 回傳空清單")
    except Exception as exc:
        print(f"[WARN] OSM Overpass API 查詢失敗 (將使用本地 krtc_stations_geo.json): {exc}")
    return target.exists()


def main() -> int:
    print("=== tw-track-carbon 免費官方開放資料抓取工具 ===")
    results = {
        "trtc_csv": fetch_trtc_csv(),
        "tymc_xml": fetch_tymc_xml(),
        "tra_mile_pdf": fetch_tra_mile_pdf(),
        "krtc_osm": fetch_osm_krtc_overpass(),
    }
    print("\n=== 抓取結果摘要 ===")
    for k, ok in results.items():
        print(f"  - {k}: {'OK' if ok else 'FALLBACK_LOCAL'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
