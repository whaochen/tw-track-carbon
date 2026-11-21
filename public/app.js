(() => {
  "use strict";

  const DIST_LEVEL_LABELS = {
    official_operating_mileage: "官方營業里程",
    official_fare_table: "官方票價里程換算",
    osm_calibrated: "OSM 座標與官方長度校準",
    wiki_station_distances: "維基車站站距整理",
  };

  const SYSTEM_COLORS = {
    THSR: "#f97316",
    TRA: "#0284c7",
    TRTC: "#0ea5e9",
    TYMC: "#8b5cf6",
    KRTC: "#ef4444",
    TMRT: "#22c55e",
    NTDLRT: "#14b8a6",
    NTALRT: "#eab308",
    KLRT: "#10b981",
  };

  const state = {
    network: null,
    factors: null,
    systemsById: new Map(),
    adjCache: new Map(),
    currentSysId: "THSR",
    originIdx: 2, // 預設板橋
    destIdx: 11,  // 預設左營
    traTrainType: "tze_chiang",
    roundTrip: false,
    pax: 1,
    overrideMode: "generic", // generic | trtc | custom
    overrideCustomVal: 0.04,
    multiSegments: [],
    csvRows: [],
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function showToast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      el.hidden = true;
    }, 2400);
  }

  function normText(s) {
    return String(s || "").trim().toLowerCase().replace(/臺/g, "台");
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- 距離與碳排核心計算引擎 ----------
  function getUpperDist(sys, i, j) {
    if (i === j) return 0;
    const n = sys.stations.length;
    if (i > j) [i, j] = [j, i];
    const pos = i * n - (i * (i + 1)) / 2 + (j - i - 1);
    return sys.upper_distances_km[pos] ?? null;
  }

  function getAdjList(sys) {
    if (state.adjCache.has(sys.system_id)) {
      return state.adjCache.get(sys.system_id);
    }
    const n = sys.stations.length;
    const adj = Array.from({ length: n }, () => []);
    for (const [u, v, w] of sys.graph_edges || []) {
      adj[u].push([v, w]);
      adj[v].push([u, w]);
    }
    state.adjCache.set(sys.system_id, adj);
    return adj;
  }

  function shortestPathKm(sys, src, dst) {
    if (src === dst) return 0;
    const adj = getAdjList(sys);
    const n = adj.length;
    const dist = new Float64Array(n).fill(Infinity);
    const visited = new Uint8Array(n);
    dist[src] = 0;

    for (let iter = 0; iter < n; iter++) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        if (!visited[i] && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      }
      if (u === -1 || u === dst) break;
      visited[u] = 1;
      for (const [v, w] of adj[u]) {
        const nd = best + w;
        if (nd < dist[v]) dist[v] = nd;
      }
    }
    return Number.isFinite(dist[dst]) ? Number(dist[dst].toFixed(3)) : null;
  }

  function getDistanceKm(sys, i, j) {
    if (i === j) return 0;
    if (sys.calc_mode === "direct_matrix") {
      const m1 = sys.stations[i]?.mile_km ?? 0;
      const m2 = sys.stations[j]?.mile_km ?? 0;
      return Number(Math.abs(m2 - m1).toFixed(2));
    }
    if (sys.upper_distances_km) {
      return getUpperDist(sys, i, j);
    }
    if (sys.graph_edges) {
      return shortestPathKm(sys, i, j);
    }
    return null;
  }

  function resolveEffectiveFactor(sys, options = {}) {
    const base = sys.factor_source;
    if (sys.system_id === "TRA") {
      const tType = options.traTrainType || "tze_chiang";
      const info = base.train_types?.[tType] || base.train_types?.tze_chiang;
      return {
        value: info.value_kg_per_pkm,
        tier: base.tier,
        tierLabel: base.tier_label,
        trainLabel: info.label,
        isOverridden: false,
        url: base.url,
        year: base.announcement_year,
      };
    }

    if (sys.allow_factor_override && options.overrideMode && options.overrideMode !== "generic") {
      if (options.overrideMode === "trtc") {
        return {
          value: 0.075,
          tier: "Tier 3",
          tierLabel: "使用者自訂 (比照北捷)",
          isOverridden: true,
          url: "https://www.metro.taipei/cp.aspx?n=5B7ACD566D2CB1DD",
          year: "使用者覆寫（比照北捷 113 年盤查）",
        };
      }
      const customVal = Math.max(0.001, Number(options.overrideCustomVal) || 0.04);
      return {
        value: customVal,
        tier: "Tier 3",
        tierLabel: "使用者自訂",
        isOverridden: true,
        url: base.url,
        year: "使用者自訂係數",
      };
    }

    return {
      value: base.value_kg_per_pkm,
      tier: base.tier,
      tierLabel: base.tier_label,
      isOverridden: false,
      url: base.url,
      year: base.announcement_year,
    };
  }

  function calculateTrip(sysId, originIdx, destIdx, opts = {}) {
    const sys = state.systemsById.get(sysId);
    if (!sys) return null;
    const oSt = sys.stations[originIdx];
    const dSt = sys.stations[destIdx];
    if (!oSt || !dSt) return null;

    const oneWayKm = getDistanceKm(sys, originIdx, destIdx);
    if (oneWayKm === null) return null;

    const roundTrip = Boolean(opts.roundTrip);
    const trips = roundTrip ? 2 : 1;
    const pax = Math.max(1, parseInt(opts.pax || 1, 10) || 1);
    const factorInfo = resolveEffectiveFactor(sys, opts);

    let oneWayKg = 0;
    let totalKg = 0;
    if (sys.calc_mode === "direct_matrix") {
      oneWayKg = oSt.name_zh === dSt.name_zh ? 0 : (sys.matrix_kg_co2e?.[oSt.name_zh]?.[dSt.name_zh] ?? 0);
      totalKg = oneWayKg * trips * pax;
    } else {
      oneWayKg = oneWayKm * factorInfo.value;
      totalKg = oneWayKg * trips * pax;
    }

    return {
      sys,
      oSt,
      dSt,
      oneWayKm,
      totalKm: Number((oneWayKm * trips * pax).toFixed(2)),
      trips,
      roundTrip,
      pax,
      oneWayKg,
      totalKg,
      factorInfo,
    };
  }

  function findStationIndex(sys, query) {
    const q = normText(query);
    if (!q) return -1;
    // 1. 精準比對站碼或站名
    let idx = sys.stations.findIndex(
      (s) => normText(s.code) === q || normText(s.name_zh) === q || (s.aliases || []).some((a) => normText(a) === q)
    );
    if (idx !== -1) return idx;
    // 2. 前綴或包含
    idx = sys.stations.findIndex(
      (s) =>
        normText(s.name_zh).includes(q) ||
        normText(s.code).includes(q) ||
        (s.aliases || []).some((a) => normText(a).includes(q))
    );
    return idx;
  }

  function buildCitationText(res) {
    const tripLabel = res.roundTrip ? "往返" : "單程";
    const paxLabel = `${res.pax} 人`;
    const kgStr = res.totalKg.toFixed(2);
    if (res.sys.calc_mode === "direct_matrix") {
      return `本次${res.sys.name_zh}（${res.oSt.name_zh}－${res.dSt.name_zh}，${tripLabel} ${paxLabel}）碳排放量依台灣高鐵官網公告之起迄站碳足跡對照表計算，計為 ${kgStr} kgCO2e（來源：台灣高鐵旅客運輸服務碳足跡專區，${res.factorInfo.url}）。`;
    }
    const trainNote = res.factorInfo.trainLabel ? `〔${res.factorInfo.trainLabel.split("（")[0]}〕` : "";
    const overrideNote = res.factorInfo.isOverridden ? `（${res.factorInfo.tierLabel}）` : "";
    return `本次${res.sys.name_zh}${trainNote}（${res.oSt.name_zh}－${res.dSt.name_zh}，${tripLabel} ${paxLabel}，營業里程合計 ${res.totalKm.toFixed(2)} km）採係數 ${res.factorInfo.value.toFixed(3)} kgCO2e/pkm${overrideNote} 計算，總碳排放量為 ${kgStr} kgCO2e（距離來源：${res.sys.distance_source.label} ${res.sys.distance_source.url}；係數來源：${res.factorInfo.year} ${res.factorInfo.url}）。`;
  }

  // ---------- 模糊搜尋下拉元件 ----------
  function setupCombobox(inputSel, listSel, getIdx, setIdx) {
    const input = $(inputSel);
    const list = $(listSel);

    function renderList(filterText) {
      const sys = state.systemsById.get(state.currentSysId);
      if (!sys) return;
      const q = normText(filterText);
      const matches = sys.stations
        .map((st, idx) => ({ st, idx }))
        .filter(({ st }) => {
          if (!q) return true;
          return (
            normText(st.name_zh).includes(q) ||
            normText(st.code).includes(q) ||
            (st.aliases || []).some((a) => normText(a).includes(q))
          );
        })
        .slice(0, 40);

      list.innerHTML = matches
        .map(({ st, idx }) => {
          const codePart = st.code ? `<span class="st-code">${escapeHtml(st.code)}</span>` : "";
          return `<li data-idx="${idx}"><span>${escapeHtml(st.name_zh)}</span>${codePart}</li>`;
        })
        .join("");
      list.hidden = matches.length === 0;
    }

    input.addEventListener("focus", () => {
      input.select();
      renderList("");
    });

    input.addEventListener("input", () => {
      renderList(input.value);
    });

    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-idx]");
      if (!li) return;
      const idx = Number(li.dataset.idx);
      setIdx(idx);
      const sys = state.systemsById.get(state.currentSysId);
      input.value = formatStationLabel(sys.stations[idx]);
      list.hidden = true;
      renderSingleResult();
    });

    input.addEventListener("blur", () => {
      setTimeout(() => {
        list.hidden = true;
        const sys = state.systemsById.get(state.currentSysId);
        if (sys && sys.stations[getIdx()]) {
          input.value = formatStationLabel(sys.stations[getIdx()]);
        }
      }, 160);
    });
  }

  function formatStationLabel(st) {
    if (!st) return "";
    return st.code ? `${st.code} ${st.name_zh}` : st.name_zh;
  }

  // ---------- UI 渲染 ----------
  function renderSystemPills() {
    const container = $("#system-pills");
    container.innerHTML = state.network.systems
      .map(
        (s) =>
          `<button type="button" class="sys-pill ${s.system_id === state.currentSysId ? "active" : ""}" data-sys="${s.system_id}">${escapeHtml(s.short_name)}｜${escapeHtml(s.name_zh)}</button>`
      )
      .join("");
  }

  function selectSystem(sysId) {
    state.currentSysId = sysId;
    const sys = state.systemsById.get(sysId);
    if (!sys) return;

    renderSystemPills();
    state.originIdx = 0;
    state.destIdx = Math.min(sys.stations.length - 1, sysId === "THSR" ? 11 : 4);
    if (sysId === "THSR") {
      state.originIdx = 2; // 板橋
      state.destIdx = 11;  // 左營
    }

    $("#origin-input").value = formatStationLabel(sys.stations[state.originIdx]);
    $("#dest-input").value = formatStationLabel(sys.stations[state.destIdx]);
    $("#tra-train-group").hidden = sysId !== "TRA";
    state.overrideMode = "generic";
    $("#override-mode").value = "generic";
    $("#override-custom-val").hidden = true;

    renderSingleResult();
  }

  function renderSingleResult() {
    const res = calculateTrip(state.currentSysId, state.originIdx, state.destIdx, {
      traTrainType: state.traTrainType,
      roundTrip: state.roundTrip,
      pax: state.pax,
      overrideMode: state.overrideMode,
      overrideCustomVal: state.overrideCustomVal,
    });
    if (!res) return;

    $("#res-kg").textContent = res.totalKg.toFixed(2);
    $("#res-g").textContent = `${Math.round(res.totalKg * 1000).toLocaleString()} gCO2e`;
    $("#res-km").textContent = res.totalKm.toFixed(2);
    $("#res-route-summary").textContent = `${res.sys.name_zh}｜${res.oSt.name_zh} → ${res.dSt.name_zh}（${res.roundTrip ? "來回" : "單程"} ${res.pax} 人）`;

    // 1. 透明公式列
    if (res.sys.calc_mode === "direct_matrix") {
      $("#mrv-formula").textContent = `直接引用高鐵起迄站官方碳足跡對照表：${res.oneWayKg.toFixed(2)} kgCO2e/趟 × ${res.trips} 趟 × ${res.pax} 人 = ${res.totalKg.toFixed(2)} kgCO2e（參考里程 ${res.oneWayKm.toFixed(2)} km/趟）`;
    } else {
      $("#mrv-formula").textContent = `${res.oneWayKm.toFixed(2)} km × ${res.factorInfo.value.toFixed(3)} kgCO2e/pkm × ${res.trips} 趟 × ${res.pax} 人 = ${res.totalKg.toFixed(2)} kgCO2e`;
    }

    // 2. 雙重等級徽章
    const distLevelText = DIST_LEVEL_LABELS[res.sys.distance_source.level] || res.sys.distance_source.level;
    const tierClass = res.factorInfo.tier === "Tier 1" ? "tier-1" : res.factorInfo.tier === "Tier 2" ? "tier-2" : "tier-3";
    $("#mrv-badges").innerHTML = `
      <span class="badge dist">距離來源：${escapeHtml(distLevelText)}</span>
      <span class="badge ${tierClass}">${escapeHtml(res.factorInfo.tier)}｜${escapeHtml(res.factorInfo.tierLabel)}</span>
    `;

    // 3. 雙來源直連卡
    const ds = res.sys.distance_source;
    const fs = res.sys.factor_source;
    $("#mrv-dist-source").innerHTML = `
      <div><strong>${escapeHtml(ds.label)}</strong>（更新：${escapeHtml(ds.updated_at)}）</div>
      <div>${escapeHtml(ds.note)}</div>
      <div><a href="${escapeHtml(ds.url)}" target="_blank" rel="noopener">${escapeHtml(ds.url)}</a></div>
    `;
    $("#mrv-factor-source").innerHTML = `
      <div><strong>${escapeHtml(res.factorInfo.year)}</strong>（${res.factorInfo.value.toFixed(3)} kgCO2e/pkm）</div>
      <div>${escapeHtml(fs.boundary_note)}</div>
      <div><a href="${escapeHtml(res.factorInfo.url)}" target="_blank" rel="noopener">${escapeHtml(res.factorInfo.url)}</a></div>
    `;

    // 4. 盤查邊界警示條
    const bBox = $("#mrv-boundary-box");
    const bText = $("#mrv-boundary-text");
    const ovCtrl = $("#mrv-override-controls");
    ovCtrl.hidden = !res.sys.allow_factor_override;

    if (res.sys.system_id === "TRTC") {
      bBox.hidden = false;
      bText.innerHTML = `<strong>台北捷運盤查邊界說明：</strong>每延人公里 75g 拆解為「運具行駛階段 30g ＋ 車站服務階段 45g」（113 年盤查公告），不可與未含車站服務之舊通用係數混比。`;
    } else if (res.sys.system_id === "KRTC") {
      bBox.hidden = false;
      bText.innerHTML = `<strong>高雄捷運盤查邊界說明：</strong>220g 依 2026 年碳標籤公告包含全車站營運分攤，數值較高係因盤查邊界完整且運量基數不同，並非系統誤算（可參考 <a href="https://event.esunbank.com.tw/credit/1121101esg_c/index.html" target="_blank" rel="noopener">玉山銀行 2026 支付碳帳戶說明</a> 佐證）。`;
    } else if (res.sys.allow_factor_override) {
      bBox.hidden = false;
      bText.innerHTML = `<strong>係數覆寫提示：</strong>${escapeHtml(res.sys.name_zh)}尚無專屬碳標籤，目前採「${escapeHtml(res.factorInfo.tierLabel)}（${res.factorInfo.value.toFixed(3)} kgCO2e/pkm）」，顧問可於下方切換為北捷值或自訂數值。`;
    } else {
      bBox.hidden = true;
    }

    // 5. 引用文字預覽
    $("#mrv-citation-preview").textContent = buildCitationText(res);
  }

  // ---------- 多段轉乘行程 ----------
  function addSegment(seg) {
    if (!seg) return;
    state.multiSegments.push(seg);
    renderMultiSegments();
    showToast(`已加入：${seg.sys.short_name} ${seg.oSt.name_zh}→${seg.dSt.name_zh}`);
  }

  function renderMultiSegments() {
    $("#multi-count-badge").textContent = String(state.multiSegments.length);
    const totalKg = state.multiSegments.reduce((s, x) => s + x.totalKg, 0);
    const totalKm = state.multiSegments.reduce((s, x) => s + x.totalKm, 0);
    $("#multi-total-kg").textContent = totalKg.toFixed(2);
    $("#multi-total-km").textContent = totalKm.toFixed(2);

    const bar = $("#multi-stacked-bar");
    const legend = $("#multi-legend");
    if (totalKg <= 0) {
      bar.innerHTML = "";
      legend.innerHTML = "";
    } else {
      const bySys = new Map();
      for (const seg of state.multiSegments) {
        const prev = bySys.get(seg.sys.system_id) || { name: seg.sys.short_name, kg: 0 };
        prev.kg += seg.totalKg;
        bySys.set(seg.sys.system_id, prev);
      }
      bar.innerHTML = Array.from(bySys.entries())
        .map(([id, info]) => {
          const pct = (info.kg / totalKg) * 100;
          return `<div class="stacked-seg" style="width:${pct.toFixed(2)}%;background:${SYSTEM_COLORS[id] || "#64748b"}" title="${escapeHtml(info.name)} ${pct.toFixed(1)}%"></div>`;
        })
        .join("");
      legend.innerHTML = Array.from(bySys.entries())
        .map(([id, info]) => {
          const pct = (info.kg / totalKg) * 100;
          return `<span class="legend-item"><span class="legend-dot" style="background:${SYSTEM_COLORS[id] || "#64748b"}"></span>${escapeHtml(info.name)}：${info.kg.toFixed(2)} kg (${pct.toFixed(1)}%)</span>`;
        })
        .join("");
    }

    const list = $("#multi-segments-list");
    if (state.multiSegments.length === 0) {
      list.innerHTML = `<p class="empty-hint">目前尚無行程段落，請由「單趟精算」加入或點擊上方示範案例。</p>`;
      return;
    }
    list.innerHTML = state.multiSegments
      .map(
        (seg, idx) => `
      <div class="seg-row">
        <div>
          <strong>${idx + 1}. ${escapeHtml(seg.sys.name_zh)}</strong>｜${escapeHtml(seg.oSt.name_zh)} → ${escapeHtml(seg.dSt.name_zh)}
          <div class="sub-hint">${seg.roundTrip ? "來回" : "單程"} ${seg.pax} 人・${seg.totalKm.toFixed(2)} km・係數 ${seg.factorInfo.value.toFixed(3)} (${escapeHtml(seg.factorInfo.tier)})</div>
        </div>
        <div class="header-actions">
          <strong>${seg.totalKg.toFixed(2)} kgCO2e</strong>
          <button type="button" class="btn-ghost btn-sm" data-del-seg="${idx}">移除</button>
        </div>
      </div>`
      )
      .join("");
  }

  function loadDemoScenario(kind) {
    state.multiSegments = [];
    if (kind === "thsr") {
      const s1 = calculateTrip("TRTC", findStationIndex(state.systemsById.get("TRTC"), "台北車站"), findStationIndex(state.systemsById.get("TRTC"), "板橋"), { roundTrip: true, pax: 1 });
      const s2 = calculateTrip("THSR", findStationIndex(state.systemsById.get("THSR"), "板橋"), findStationIndex(state.systemsById.get("THSR"), "左營"), { roundTrip: true, pax: 1 });
      const s3 = calculateTrip("KRTC", findStationIndex(state.systemsById.get("KRTC"), "R16"), findStationIndex(state.systemsById.get("KRTC"), "R8"), { roundTrip: true, pax: 1 });
      [s1, s2, s3].forEach((x) => x && state.multiSegments.push(x));
    } else {
      const s1 = calculateTrip("NTALRT", findStationIndex(state.systemsById.get("NTALRT"), "K06"), findStationIndex(state.systemsById.get("NTALRT"), "K09"), { roundTrip: true, pax: 1 });
      const s2 = calculateTrip("TRTC", findStationIndex(state.systemsById.get("TRTC"), "十四張"), findStationIndex(state.systemsById.get("TRTC"), "台北101/世貿"), { roundTrip: true, pax: 1 });
      [s1, s2].forEach((x) => x && state.multiSegments.push(x));
    }
    renderMultiSegments();
    showToast("已載入示範轉乘行程");
  }

  // ---------- CSV 批次試算 ----------
  function parseCsvText(text) {
    const clean = text.replace(/^\uFEFF/, "").trim();
    const lines = clean.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const splitLine = (line) => {
      const out = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQ = !inQ;
        } else if (ch === "," && !inQ) {
          out.push(cur.trim());
          cur = "";
        } else {
          cur += ch;
        }
      }
      out.push(cur.trim());
      return out;
    };

    const headers = splitLine(lines[0]);
    return lines.slice(1).map((line) => {
      const cols = splitLine(line);
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = cols[idx] ?? "";
      });
      return obj;
    });
  }

  function processBatchCsv(text) {
    const records = parseCsvText(text);
    const results = records.map((rec, idx) => {
      const date = rec["日期"] || "";
      const sysId = (rec["運具代碼"] || "").trim().toUpperCase();
      const oName = rec["起站"] || "";
      const dName = rec["迄站"] || "";
      const trainRaw = rec["車種"] || "";
      const rtRaw = (rec["是否來回"] || "").trim();
      const roundTrip = ["是", "來回", "true", "1", "y", "yes"].includes(rtRaw.toLowerCase());
      const pax = Math.max(1, parseInt(rec["人數"] || "1", 10) || 1);
      const note = rec["備註"] || "";

      const sys = state.systemsById.get(sysId);
      if (!sys) {
        return { idx: idx + 1, date, sysId, oName, dName, roundTrip, pax, note, ok: false, error: `未知運具代碼 ${sysId}` };
      }
      const oIdx = findStationIndex(sys, oName);
      const dIdx = findStationIndex(sys, dName);
      if (oIdx === -1 || dIdx === -1) {
        return {
          idx: idx + 1,
          date,
          sysId,
          oName,
          dName,
          roundTrip,
          pax,
          note,
          ok: false,
          error: oIdx === -1 ? `找不到起站「${oName}」` : `找不到迄站「${dName}」`,
        };
      }

      let traTrainType = "tze_chiang";
      if (trainRaw.includes("莒光")) traTrainType = "chu_kuang";
      else if (trainRaw.includes("區間")) traTrainType = "local";

      const res = calculateTrip(sysId, oIdx, dIdx, { traTrainType, roundTrip, pax });
      return {
        idx: idx + 1,
        date,
        sysId,
        oName: res.oSt.name_zh,
        dName: res.dSt.name_zh,
        trainRaw,
        roundTrip,
        pax,
        note,
        ok: true,
        res,
      };
    });

    state.csvRows = results;
    renderCsvTable();
  }

  function renderCsvTable() {
    const rows = state.csvRows;
    const table = $("#csv-result-table");
    const tbody = table.querySelector("tbody");
    const bar = $("#csv-summary-bar");
    if (rows.length === 0) {
      table.hidden = true;
      bar.hidden = true;
      return;
    }

    const okRows = rows.filter((r) => r.ok);
    const totalKg = okRows.reduce((s, r) => s + r.res.totalKg, 0);
    $("#csv-stats").textContent = `共 ${rows.length} 筆（成功 ${okRows.length} 筆、異常 ${rows.length - okRows.length} 筆），合計碳排 ${totalKg.toFixed(2)} kgCO2e`;
    bar.hidden = false;
    table.hidden = false;

    tbody.innerHTML = rows
      .map((r) => {
        if (!r.ok) {
          return `<tr>
            <td>${r.idx}</td>
            <td>${escapeHtml(r.date)}</td>
            <td>${escapeHtml(r.sysId)}</td>
            <td>${escapeHtml(r.oName)} → ${escapeHtml(r.dName)}</td>
            <td>${r.roundTrip ? "來回" : "單程"} / ${r.pax}</td>
            <td>—</td>
            <td>—</td>
            <td>—</td>
            <td class="status-err">${escapeHtml(r.error)}</td>
          </tr>`;
        }
        return `<tr>
          <td>${r.idx}</td>
          <td>${escapeHtml(r.date)}</td>
          <td>${escapeHtml(r.res.sys.short_name)}</td>
          <td>${escapeHtml(r.oName)} → ${escapeHtml(r.dName)}</td>
          <td>${r.roundTrip ? "來回" : "單程"} / ${r.pax}</td>
          <td>${r.res.totalKm.toFixed(2)}</td>
          <td>${r.res.factorInfo.value.toFixed(3)}</td>
          <td><strong>${r.res.totalKg.toFixed(2)}</strong></td>
          <td class="status-ok">成功</td>
        </tr>`;
      })
      .join("");
  }

  function downloadFile(filename, content) {
    const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- 係數與引用總表 ----------
  function renderFactorsTable() {
    const tbody = $("#factors-table tbody");
    tbody.innerHTML = state.network.systems
      .map((s) => {
        const distLevel = DIST_LEVEL_LABELS[s.distance_source.level] || s.distance_source.level;
        const tierClass = s.factor_source.tier === "Tier 1" ? "tier-1" : "tier-2";
        const factorVal =
          s.system_id === "TRA"
            ? "自強 0.036 / 莒光 0.050 / 區間 0.055"
            : s.factor_source.value_kg_per_pkm.toFixed(3);
        return `<tr>
          <td><strong>${escapeHtml(s.name_zh)}</strong><div class="sub-hint">${escapeHtml(s.system_id)}（${s.stations.length} 站）</div></td>
          <td><code>${escapeHtml(s.calc_mode)}</code></td>
          <td><div>${escapeHtml(distLevel)}</div><a href="${escapeHtml(s.distance_source.url)}" target="_blank" rel="noopener">${escapeHtml(s.distance_source.label)}</a></td>
          <td><span class="badge ${tierClass}">${escapeHtml(s.factor_source.tier)}</span></td>
          <td><strong>${escapeHtml(factorVal)}</strong></td>
          <td><div>${escapeHtml(s.factor_source.announcement_year)}</div><div class="sub-hint">${escapeHtml(s.factor_source.boundary_note)}</div><a href="${escapeHtml(s.factor_source.url)}" target="_blank" rel="noopener">官方來源</a></td>
        </tr>`;
      })
      .join("");
  }

  // ---------- 事件綁定與初始化 ----------
  function bindEvents() {
    $$(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.tab;
        $$(".tab-btn").forEach((b) => {
          const active = b.dataset.tab === target;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", String(active));
        });
        $$(".tab-panel").forEach((p) => {
          p.hidden = p.id !== `tab-${target}`;
        });
      });
    });

    $("#system-pills").addEventListener("click", (e) => {
      const btn = e.target.closest(".sys-pill[data-sys]");
      if (btn) selectSystem(btn.dataset.sys);
    });

    setupCombobox("#origin-input", "#origin-list", () => state.originIdx, (v) => (state.originIdx = v));
    setupCombobox("#dest-input", "#dest-list", () => state.destIdx, (v) => (state.destIdx = v));

    $("#swap-btn").addEventListener("click", () => {
      [state.originIdx, state.destIdx] = [state.destIdx, state.originIdx];
      const sys = state.systemsById.get(state.currentSysId);
      $("#origin-input").value = formatStationLabel(sys.stations[state.originIdx]);
      $("#dest-input").value = formatStationLabel(sys.stations[state.destIdx]);
      renderSingleResult();
    });

    $("#tra-train-select").addEventListener("change", (e) => {
      state.traTrainType = e.target.value;
      renderSingleResult();
    });

    $$(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.roundTrip = btn.dataset.rt === "true";
        $$(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
        renderSingleResult();
      });
    });

    $("#pax-input").addEventListener("input", (e) => {
      state.pax = Math.max(1, parseInt(e.target.value || "1", 10) || 1);
      renderSingleResult();
    });

    $("#override-mode").addEventListener("change", (e) => {
      state.overrideMode = e.target.value;
      $("#override-custom-val").hidden = state.overrideMode !== "custom";
      renderSingleResult();
    });

    $("#override-custom-val").addEventListener("input", (e) => {
      state.overrideCustomVal = Number(e.target.value) || 0.04;
      renderSingleResult();
    });

    $("#copy-citation-btn").addEventListener("click", async () => {
      const txt = $("#mrv-citation-preview").textContent;
      try {
        await navigator.clipboard.writeText(txt);
        showToast("已複製報告書引用文字");
      } catch {
        showToast("請手動選取引用文字複製");
      }
    });

    $("#add-to-multi-btn").addEventListener("click", () => {
      const res = calculateTrip(state.currentSysId, state.originIdx, state.destIdx, {
        traTrainType: state.traTrainType,
        roundTrip: state.roundTrip,
        pax: state.pax,
        overrideMode: state.overrideMode,
        overrideCustomVal: state.overrideCustomVal,
      });
      addSegment(res);
    });

    $("#demo-thsr-btn").addEventListener("click", () => loadDemoScenario("thsr"));
    $("#demo-commute-btn").addEventListener("click", () => loadDemoScenario("commute"));
    $("#clear-multi-btn").addEventListener("click", () => {
      state.multiSegments = [];
      renderMultiSegments();
    });

    $("#multi-segments-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-del-seg]");
      if (!btn) return;
      state.multiSegments.splice(Number(btn.dataset.delSeg), 1);
      renderMultiSegments();
    });

    $("#copy-multi-citation-btn").addEventListener("click", async () => {
      if (state.multiSegments.length === 0) return showToast("尚無行程段落");
      const totalKg = state.multiSegments.reduce((s, x) => s + x.totalKg, 0).toFixed(2);
      const totalKm = state.multiSegments.reduce((s, x) => s + x.totalKm, 0).toFixed(2);
      const details = state.multiSegments.map((s) => `${s.sys.short_name}(${s.oSt.name_zh}→${s.dSt.name_zh} ${s.totalKg.toFixed(2)} kg)`).join("＋");
      const text = `本次多段軌道轉乘行程（${details}，總里程 ${totalKm} km）依各系統官方碳標籤與環境部係數精算，合計碳排放量為 ${totalKg} kgCO2e。`;
      try {
        await navigator.clipboard.writeText(text);
        showToast("已複製全程引用文字");
      } catch {
        showToast("請手動複製");
      }
    });

    // CSV 批次試算
    $("#download-template-btn").addEventListener("click", () => {
      const sample = [
        "日期,運具代碼,起站,迄站,車種,是否來回,人數,備註",
        "2026-11-10,THSR,板橋,左營,,是,1,高雄出差",
        "2026-11-12,TRA,台北,花蓮,自強號,否,2,花蓮會議",
        "2026-11-15,TRTC,台北車站,南港,,是,1,市區洽公",
        "2026-11-18,KRTC,R16,R8,,否,1,高捷轉乘",
      ].join("\n");
      downloadFile("tw-track-carbon-template.csv", sample);
    });

    const dz = $("#csv-dropzone");
    const fi = $("#csv-file-input");
    $("#csv-browse-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      fi.click();
    });
    dz.addEventListener("click", () => fi.click());
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      const file = e.dataTransfer.files?.[0];
      if (file) file.text().then(processBatchCsv);
    });
    fi.addEventListener("change", () => {
      const file = fi.files?.[0];
      if (file) file.text().then(processBatchCsv);
    });

    $("#export-mrv-csv-btn").addEventListener("click", () => {
      if (state.csvRows.length === 0) return;
      const header = "日期,運具代碼,起站,迄站,車種,是否來回,人數,備註,計算里程_km,採用係數_kgCO2e_pkm,總碳排_kgCO2e,距離來源等級,係數等級,資料來源網址,狀態";
      const lines = state.csvRows.map((r) => {
        if (!r.ok) {
          return [r.date, r.sysId, r.oName, r.dName, "", r.roundTrip ? "是" : "否", r.pax, r.note, "", "", "", "", "", "", r.error]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(",");
        }
        const dsLevel = DIST_LEVEL_LABELS[r.res.sys.distance_source.level] || r.res.sys.distance_source.level;
        return [
          r.date,
          r.sysId,
          r.oName,
          r.dName,
          r.trainRaw,
          r.roundTrip ? "是" : "否",
          r.pax,
          r.note,
          r.res.totalKm.toFixed(2),
          r.res.factorInfo.value.toFixed(3),
          r.res.totalKg.toFixed(2),
          dsLevel,
          r.res.factorInfo.tier,
          r.res.factorInfo.url,
          "成功",
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",");
      });
      downloadFile("tw-track-carbon-mrv-report.csv", [header, ...lines].join("\n"));
    });
  }

  async function init() {
    bindEvents();
    try {
      const [netRes, facRes] = await Promise.all([
        fetch("data/rail_network.json"),
        fetch("data/factors_mrv.json"),
      ]);
      if (!netRes.ok || !facRes.ok) throw new Error("無法載入靜態軌道資料");
      state.network = await netRes.json();
      state.factors = await facRes.json();
      state.network.systems.forEach((s) => state.systemsById.set(s.system_id, s));

      const totalStations = state.network.systems.reduce((sum, s) => sum + s.stations.length, 0);
      $("#stat-systems").textContent = `${state.network.systems.length} 大系統`;
      $("#stat-stations").textContent = `${totalStations} 站`;
      $("#stat-updated").textContent = (state.network.updated_at || "2026-11").replace("-", "/");

      selectSystem("THSR");
      renderFactorsTable();
      renderMultiSegments();
    } catch (err) {
      const banner = $("#app-status");
      banner.textContent = `資料載入失敗：${err.message}`;
      banner.hidden = false;
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
