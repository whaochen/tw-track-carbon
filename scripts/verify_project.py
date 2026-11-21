#!/usr/bin/env python3
"""
台灣軌道運輸碳足跡計算箱 (`tw-track-carbon`) — 自動驗證腳本
檢核項目：
  1. public/data/rail_network.json 與 factors_mrv.json 存在且 JSON 格式合法
  2. 9 大軌道系統皆有站點清單、距離/矩陣資料與有效 https:// 來源連結
  3. 全倉庫文字檔零異體字 U+7693（一律使用「晧」U+6667）
  4. public/index.html 正確引入 https://hao-element-matrix.pages.dev/badge.js 與 <hao-element-badge symbol="Fe" ...>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
EXPECTED_SYSTEMS = {"THSR", "TRA", "TRTC", "TYMC", "KRTC", "TMRT", "NTDLRT", "NTALRT", "KLRT"}
FORBIDDEN_CHAR = "\u7693"  # 嚴禁出現之異體字
TEXT_EXTENSIONS = {
    ".md", ".py", ".json", ".html", ".css", ".js", ".yml", ".yaml", ".txt", ".xml", ".csv",
}


def check_json_files(errors: list[str]) -> None:
    net_path = ROOT_DIR / "public" / "data" / "rail_network.json"
    fac_path = ROOT_DIR / "public" / "data" / "factors_mrv.json"

    for p in (net_path, fac_path):
        if not p.exists():
            errors.append(f"缺少必要檔案: {p.relative_to(ROOT_DIR)}")
            return

    try:
        net = json.loads(net_path.read_text(encoding="utf-8"))
        json.loads(fac_path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"JSON 解析失敗: {exc}")
        return

    systems = net.get("systems", [])
    found_ids = {s.get("system_id") for s in systems}
    missing = EXPECTED_SYSTEMS - found_ids
    if missing:
        errors.append(f"rail_network.json 缺少系統: {sorted(missing)}")

    for s in systems:
        sid = s.get("system_id", "UNKNOWN")
        stations = s.get("stations", [])
        if len(stations) < 2:
            errors.append(f"{sid} 站點數量不足 ({len(stations)})")

        has_dist = bool(
            s.get("matrix_kg_co2e") or s.get("upper_distances_km") or s.get("graph_edges")
        )
        if not has_dist:
            errors.append(f"{sid} 缺少距離或碳排矩陣資料")

        ds_url = str(s.get("distance_source", {}).get("url", ""))
        fs_url = str(s.get("factor_source", {}).get("url", ""))
        if not ds_url.startswith("https://"):
            errors.append(f"{sid} distance_source.url 非 https:// ({ds_url})")
        if not fs_url.startswith("https://"):
            errors.append(f"{sid} factor_source.url 非 https:// ({fs_url})")


def check_forbidden_variant_char(errors: list[str]) -> None:
    for path in ROOT_DIR.rglob("*"):
        if not path.is_file():
            continue
        if any(part in {".git", "node_modules", "__pycache__"} for part in path.parts):
            continue
        if path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if FORBIDDEN_CHAR in text:
            errors.append(f"發現禁用異體字 U+7693 於: {path.relative_to(ROOT_DIR)}")


def check_index_html(errors: list[str]) -> None:
    idx_path = ROOT_DIR / "public" / "index.html"
    if not idx_path.exists():
        errors.append("缺少 public/index.html")
        return
    html = idx_path.read_text(encoding="utf-8")
    if "https://hao-element-matrix.pages.dev/badge.js" not in html:
        errors.append("public/index.html 未引入 https://hao-element-matrix.pages.dev/badge.js")
    if not re.search(r'<hao-element-badge[^>]*symbol=["\']Fe["\']', html):
        errors.append('public/index.html 未包含 <hao-element-badge symbol="Fe" ...>')


def main() -> int:
    errors: list[str] = []
    check_json_files(errors)
    check_forbidden_variant_char(errors)
    check_index_html(errors)

    if errors:
        print("[FAIL] verify_project.py 檢核失敗：")
        for err in errors:
            print(f"  - {err}")
        return 1

    print("[PASS] verify_project.py 所有檢核項目全數通過！")
    return 0


if __name__ == "__main__":
    sys.exit(main())
