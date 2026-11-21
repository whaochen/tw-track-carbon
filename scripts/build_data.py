#!/usr/bin/env python3
"""
台灣軌道運輸碳足跡計算箱 (`tw-track-carbon`) — 異質資料正規化編譯器
讀取 raw_data/ 各軌道系統原始資料，編譯為前端統一讀取之靜態 JSON：
  - public/data/rail_network.json
  - public/data/factors_mrv.json
"""

from __future__ import annotations

import csv
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT_DIR / "raw_data"
OUT_DIR = ROOT_DIR / "public" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

UPDATED_AT = "2026-11"

TYMC_STATION_NAMES = {
    "A1": "台北車站",
    "A2": "三重",
    "A3": "新北產業園區",
    "A4": "新莊副都心",
    "A5": "泰山",
    "A6": "泰山貴和",
    "A7": "體育大學",
    "A8": "長庚醫院",
    "A9": "林口",
    "A10": "山鼻",
    "A11": "坑口",
    "A12": "機場第一航廈",
    "A13": "機場第二航廈",
    "A14a": "機場旅館",
    "A15": "大園",
    "A16": "橫山",
    "A17": "領航",
    "A18": "高鐵桃園站",
    "A19": "桃園體育園區",
    "A20": "興南",
    "A21": "環北",
    "A22": "老街溪",
}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2.0 * r * math.asin(math.sqrt(h))


def make_aliases(name: str, code: str = "") -> list[str]:
    aliases = []
    if "臺" in name:
        aliases.append(name.replace("臺", "台"))
    if "台" in name:
        aliases.append(name.replace("台", "臺"))
    if code:
        aliases.append(code)
    return list(dict.fromkeys(aliases))


def load_factors() -> dict:
    return json.loads((RAW_DIR / "emission_factors_mrv.json").read_text(encoding="utf-8"))


def build_thsr(factors: dict) -> dict:
    raw = json.loads((RAW_DIR / "thsr_carbon_matrix.json").read_text(encoding="utf-8"))
    stations = [
        {
            "id": st["name_zh"],
            "code": st["code"],
            "name_zh": st["name_zh"],
            "mile_km": st["mile_km"],
            "aliases": make_aliases(st["name_zh"], st["code"]),
        }
        for st in raw["stations"]
    ]
    # 補齊對稱矩陣
    full_matrix: dict[str, dict[str, float]] = {s["name_zh"]: {} for s in stations}
    for o, targets in raw["matrix_kg_co2e"].items():
        for d, val in targets.items():
            full_matrix[o][d] = val
            full_matrix[d][o] = val

    return {
        "system_id": "THSR",
        "name_zh": "台灣高鐵",
        "short_name": "高鐵",
        "calc_mode": "direct_matrix",
        "distance_source": {
            "level": "official_operating_mileage",
            "label": "高鐵官方營運里程與起迄站對照表",
            "url": raw["metadata"]["source_url"],
            "updated_at": UPDATED_AT,
            "note": "碳排放量直接查詢台灣高鐵官方公告起迄站碳足跡對照表，里程僅供參考顯示。",
        },
        "factor_source": factors["systems"]["THSR"],
        "stations": stations,
        "matrix_kg_co2e": full_matrix,
    }


def build_tra(factors: dict) -> dict:
    raw = json.loads((RAW_DIR / "tra_mile_override.json").read_text(encoding="utf-8"))
    station_index: dict[str, int] = {}
    stations: list[dict] = []
    station_lines: dict[str, list[str]] = {}
    edge_map: dict[tuple[int, int], float] = {}

    for line_name, items in raw["lines"].items():
        for item in items:
            name = item["name_zh"]
            if name not in station_index:
                station_index[name] = len(stations)
                stations.append({
                    "id": name,
                    "code": "",
                    "name_zh": name,
                    "aliases": make_aliases(name),
                    "lines": [],
                })
            station_lines.setdefault(name, [])
            if line_name not in station_lines[name]:
                station_lines[name].append(line_name)

        for i in range(len(items) - 1):
            u_name, u_km = items[i]["name_zh"], float(items[i]["mile_km"])
            v_name, v_km = items[i + 1]["name_zh"], float(items[i + 1]["mile_km"])
            u, v = station_index[u_name], station_index[v_name]
            seg = round(abs(v_km - u_km), 2)
            key = (min(u, v), max(u, v))
            if key not in edge_map or seg < edge_map[key]:
                edge_map[key] = seg

    for st in stations:
        st["lines"] = station_lines.get(st["name_zh"], [])

    edges = [[u, v, km] for (u, v), km in sorted(edge_map.items())]

    return {
        "system_id": "TRA",
        "name_zh": "國營臺灣鐵路",
        "short_name": "台鐵",
        "calc_mode": "distance_x_factor",
        "distance_source": {
            "level": "official_operating_mileage",
            "label": "臺鐵官方營業里程表 (mile.pdf)",
            "url": raw["metadata"]["source_pdf"],
            "updated_at": UPDATED_AT,
            "note": "解析自國營臺灣鐵路官方營業里程表 PDF（含 15 條幹線與支線，共 240 站），以最短路徑計算站間營業里程。",
        },
        "factor_source": factors["systems"]["TRA"],
        "stations": stations,
        "graph_edges": edges,
    }


def build_trtc(factors: dict) -> dict:
    csv_path = RAW_DIR / "trtc_fares.csv"
    station_names_order: list[str] = []
    seen: set[str] = set()
    rows: list[tuple[str, str, float]] = []

    with csv_path.open("r", encoding="big5", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            o = row["起站"].strip()
            d = row["訖站"].strip()
            dist = float(row["距離"].strip())
            if o not in seen:
                seen.add(o)
                station_names_order.append(o)
            if d not in seen:
                seen.add(d)
                station_names_order.append(d)
            rows.append((o, d, dist))

    idx_map = {name: i for i, name in enumerate(station_names_order)}
    n = len(station_names_order)
    # 建立壓縮上三角距離表 (扁平陣列，僅存 i < j)
    upper = [0.0] * (n * (n - 1) // 2)
    for o, d, dist in rows:
        i, j = idx_map[o], idx_map[d]
        if i == j:
            continue
        if i > j:
            i, j = j, i
        # 上三角索引公式: i * n - i * (i + 1) // 2 + (j - i - 1)
        pos = i * n - i * (i + 1) // 2 + (j - i - 1)
        upper[pos] = round(dist, 2)

    stations = [
        {
            "id": name,
            "code": "",
            "name_zh": name,
            "aliases": make_aliases(name),
        }
        for name in station_names_order
    ]

    return {
        "system_id": "TRTC",
        "name_zh": "台北捷運",
        "short_name": "北捷",
        "calc_mode": "distance_x_factor",
        "distance_source": {
            "level": "official_fare_table",
            "label": "政府資料開放平臺票價里程換算",
            "url": "https://data.gov.tw/dataset/128418",
            "updated_at": UPDATED_AT,
            "note": "依臺北捷運系統票價資料 CSV 對應兩站最短營業里程。",
        },
        "factor_source": factors["systems"]["TRTC"],
        "stations": stations,
        "upper_distances_km": upper,
    }


def build_tymc(factors: dict) -> dict:
    xml_path = RAW_DIR / "tymc_fares.xml"
    tree = ET.parse(xml_path)
    root = tree.getroot()

    def sort_key(code: str) -> tuple[int, str]:
        digits = "".join(ch for ch in code if ch.isdigit())
        return (int(digits) if digits else 999, code)

    codes_set: set[str] = set()
    pairs: list[tuple[str, str, float]] = []
    for elem in root.findall("ODFare"):
        o = (elem.findtext("OriginStationID") or "").strip()
        d = (elem.findtext("DestinationStationID") or "").strip()
        dist_txt = (elem.findtext("TravelDistance") or "0").strip()
        if o and d:
            codes_set.add(o)
            codes_set.add(d)
            pairs.append((o, d, float(dist_txt)))

    ordered_codes = sorted(codes_set, key=sort_key)
    idx_map = {c: i for i, c in enumerate(ordered_codes)}
    n = len(ordered_codes)
    upper = [0.0] * (n * (n - 1) // 2)
    for o, d, dist in pairs:
        i, j = idx_map[o], idx_map[d]
        if i == j:
            continue
        if i > j:
            i, j = j, i
        pos = i * n - i * (i + 1) // 2 + (j - i - 1)
        upper[pos] = round(dist, 3)

    stations = [
        {
            "id": code,
            "code": code,
            "name_zh": TYMC_STATION_NAMES.get(code, code),
            "aliases": make_aliases(TYMC_STATION_NAMES.get(code, code), code),
        }
        for code in ordered_codes
    ]

    return {
        "system_id": "TYMC",
        "name_zh": "桃園機場捷運",
        "short_name": "桃捷",
        "calc_mode": "distance_x_factor",
        "allow_factor_override": True,
        "distance_source": {
            "level": "official_fare_table",
            "label": "政府資料開放平臺起迄站行駛距離",
            "url": "https://data.gov.tw/dataset/128436",
            "updated_at": UPDATED_AT,
            "note": "依桃園捷運起迄站間票價資料 XML 之 TravelDistance 欄位直接換算。",
        },
        "factor_source": factors["systems"]["TYMC"],
        "stations": stations,
        "upper_distances_km": upper,
    }


def build_krtc(factors: dict) -> dict:
    raw = json.loads((RAW_DIR / "krtc_stations_geo.json").read_text(encoding="utf-8"))
    station_index: dict[str, int] = {}
    stations: list[dict] = []
    edges: list[list] = []

    for line_code, line_data in raw["lines"].items():
        sts = line_data["stations"]
        official_km = float(line_data["official_length_km"])
        raw_segs = [
            haversine_km(sts[i]["lat"], sts[i]["lon"], sts[i + 1]["lat"], sts[i + 1]["lon"])
            for i in range(len(sts) - 1)
        ]
        scale = official_km / sum(raw_segs)

        for st in sts:
            code = st["code"]
            if code not in station_index:
                station_index[code] = len(stations)
                stations.append({
                    "id": code,
                    "code": code,
                    "name_zh": st["name_zh"],
                    "aliases": make_aliases(st["name_zh"], code),
                })

        for i, seg in enumerate(raw_segs):
            u = station_index[sts[i]["code"]]
            v = station_index[sts[i + 1]["code"]]
            edges.append([u, v, round(seg * scale, 3)])

    return {
        "system_id": "KRTC",
        "name_zh": "高雄捷運紅／橘線",
        "short_name": "高捷",
        "calc_mode": "distance_x_factor",
        "distance_source": {
            "level": "osm_calibrated",
            "label": "OSM 座標與官方路線長度校準",
            "url": "https://www.openstreetmap.org/",
            "secondary_url": "https://zh.wikipedia.org/zh-tw/%E9%AB%98%E9%9B%84%E6%8D%B7%E9%81%8B%E8%BB%8A%E7%AB%99%E5%88%97%E8%A1%A8",
            "updated_at": UPDATED_AT,
            "note": "依 OpenStreetMap 站點經緯度計算相鄰 Haversine 距離，並依紅線 29.76 km、橘線 14.40 km 官方營運長度等比校準；跨線於 O5/R10 美麗島自動轉乘加總。",
        },
        "factor_source": factors["systems"]["KRTC"],
        "stations": stations,
        "graph_edges": edges,
    }


def build_wiki_systems(factors: dict) -> list[dict]:
    raw = json.loads((RAW_DIR / "wiki_rail_distances.json").read_text(encoding="utf-8"))
    order = [
        ("TMRT", "中捷"),
        ("NTDLRT", "淡海輕軌"),
        ("NTALRT", "安坑輕軌"),
        ("KLRT", "高雄輕軌"),
    ]
    result = []
    for sys_id, short_name in order:
        info = raw[sys_id]
        station_index: dict[str, int] = {}
        stations: list[dict] = []
        edges: list[list] = []

        for branch in info["branches"]:
            sts = branch["stations"]
            for st in sts:
                code = st["code"]
                if code not in station_index:
                    station_index[code] = len(stations)
                    stations.append({
                        "id": code,
                        "code": code,
                        "name_zh": st["name_zh"],
                        "aliases": make_aliases(st["name_zh"], code),
                    })
            for i in range(len(sts) - 1):
                u = station_index[sts[i]["code"]]
                v = station_index[sts[i + 1]["code"]]
                seg = round(abs(float(sts[i + 1]["cumulative_km"]) - float(sts[i]["cumulative_km"])), 3)
                edges.append([u, v, seg])

        if info.get("loop") and info.get("close_segment_km"):
            first_code = info["branches"][0]["stations"][0]["code"]
            last_code = info["branches"][0]["stations"][-1]["code"]
            edges.append([station_index[last_code], station_index[first_code], float(info["close_segment_km"])])

        result.append({
            "system_id": sys_id,
            "name_zh": info["name_zh"],
            "short_name": short_name,
            "calc_mode": "distance_x_factor",
            "allow_factor_override": True,
            "distance_source": {
                "level": "wiki_station_distances",
                "label": "維基百科車站列表站距整理",
                "url": info["source_url"],
                "updated_at": UPDATED_AT,
                "note": f"收錄{info['name_zh']}（{info['line_name']}）官方公告累計里程與相鄰站距"
                + ("；環狀線自動取順／逆時針較短路徑。" if info.get("loop") else "。"),
            },
            "factor_source": factors["systems"][sys_id],
            "stations": stations,
            "graph_edges": edges,
        })
    return result


def main() -> int:
    factors = load_factors()
    systems = [
        build_thsr(factors),
        build_tra(factors),
        build_trtc(factors),
        build_tymc(factors),
        build_krtc(factors),
        *build_wiki_systems(factors),
    ]

    network_payload = {
        "schema_version": "1.0.0",
        "updated_at": UPDATED_AT,
        "systems": systems,
    }

    (OUT_DIR / "rail_network.json").write_text(
        json.dumps(network_payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (OUT_DIR / "factors_mrv.json").write_text(
        json.dumps(factors, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("=== build_data.py 編譯完成 ===")
    for s in systems:
        print(f"  - {s['system_id']:6s} ({s['name_zh']}): {len(s['stations'])} 站 | mode={s['calc_mode']}")
    size_kb = (OUT_DIR / "rail_network.json").stat().st_size / 1024
    print(f"  -> public/data/rail_network.json ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
