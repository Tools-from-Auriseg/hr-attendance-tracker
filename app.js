/* ═══════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════ */
let LIMIT = 75;
let records = [];
let shiftMap = {};
let charts = {};
let file1Loaded = false, file2Loaded = false;
let wb1 = null, wb2 = null;

const SHIFTS = ['General','Morning','Afternoon','Night','Marketing/Sales'];
const SHIFT_COLORS = {General:'#2563EB',Morning:'#16A34A',Afternoon:'#D97706',Night:'#7C3AED','Marketing/Sales':'#DB2777'};
const SHIFT_BG     = {General:'#EFF6FF',Morning:'#F0FDF4',Afternoon:'#FFFBEB',Night:'#F5F3FF','Marketing/Sales':'#FDF2F8'};
const SHIFT_TXT    = {General:'#1D4ED8',Morning:'#15803D',Afternoon:'#B45309',Night:'#6D28D9','Marketing/Sales':'#BE185D'};
const SHIFT_BORDER = {General:'#BFDBFE',Morning:'#BBF7D0',Afternoon:'#FDE68A',Night:'#DDD6FE','Marketing/Sales':'#FBCFE8'};
const DEPT_PALETTE = ['#2563EB','#16A34A','#D97706','#7C3AED','#DB2777','#0D9488','#DC2626','#EA580C','#0891B2','#65A30D'];

const SHIFT_SCHED_END = {
  'General':         '18:30',
  'Morning':         '14:00',
  'Afternoon':       '23:00',
  'Night':           '06:00',
  'Marketing/Sales': '19:30',
};
const SHIFT_SCHED_START = {
  'General':         '09:00',
  'Morning':         '06:00',
  'Afternoon':       '14:00',
  'Night':           '22:00',
  'Marketing/Sales': '10:30',
};

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
function toMins(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (!s.includes(':')) return null;
  const p = s.split(':');
  const h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}
function hhmm(m) {
  m = Math.round(Math.abs(m)) % 1440;
  return String(Math.floor(m / 60)).padStart(2,'0') + ':' + String(m % 60).padStart(2,'0');
}
function fmtM(m) {
  m = Math.round(m);
  if (!m) return '0m';
  const h = Math.floor(Math.abs(m) / 60), mn = Math.abs(m) % 60;
  return (h ? h + 'h ' : '') + (mn ? mn + 'm' : '');
}
function fmtH(mins) {
  mins = Math.round(mins);
  if (!mins) return '0m';
  const h = Math.floor(Math.abs(mins) / 60), mn = Math.abs(mins) % 60;
  return (h ? h + 'h ' : '') + (mn ? mn + 'm' : '');
}
function avg(arr) { return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0; }

// BUG FIX: norm() used for loose matching — keep as-is for display, use only for comparison
function norm(s) { return String(s||'').trim().toLowerCase().replace(/\s+/g,' '); }

function shiftBadge(s) {
  return `<span class="badge" style="background:${SHIFT_BG[s]||'#F1F5F9'};color:${SHIFT_TXT[s]||'#475569'};border:1px solid ${SHIFT_BORDER[s]||'#E2E8F0'}">${s||'General'}</span>`;
}
function deptBadge(d, idx) {
  if (!d) return `<span class="badge b-gray">—</span>`;
  const c = DEPT_PALETTE[idx % DEPT_PALETTE.length];
  return `<span class="badge" style="background:${c}18;color:${c};border:1px solid ${c}44">${d}</span>`;
}

/* ═══════════════════════════════════════════════
   SHIFT DETECTION
═══════════════════════════════════════════════ */
function normalizeShiftLabel(s) {
  s = String(s||'').trim();
  if (/morning|^AM$/i.test(s))   return 'Morning';
  if (/afternoon|^PM$/i.test(s)) return 'Afternoon';
  if (/night|^NS$/i.test(s))     return 'Night';
  if (/market|sales/i.test(s))   return 'Marketing/Sales';
  if (/^GS2$/i.test(s))          return 'Marketing/Sales'; // GS2 = Marketing/Sales shift
  if (/general|^GS/i.test(s))    return 'General';
  if (/^GS\d/i.test(s))          return 'General';
  return s || 'General';
}
function detectShift(inTimeTxt, dept, shiftLabel) {
  if (shiftLabel && shiftLabel !== '—' && shiftLabel.trim()) return normalizeShiftLabel(shiftLabel);
  if (dept && /market|sales/i.test(dept)) return 'Marketing/Sales';
  const m = toMins(inTimeTxt);
  if (m === null) return 'General';
  if (m >= 360 && m < 720)  return 'Morning';
  if (m >= 720 && m < 1200) return 'Afternoon';
  if (m >= 1200 || m < 360) return 'Night';
  return 'General';
}

/* ═══════════════════════════════════════════════
   PUNCH PARSER — fully rewritten for correctness

   Rules:
   1. Skip tokens without explicit "in" or "out" direction (bare "(AB)")
   2. Deduplicate consecutive same-direction punches
      - consecutive outs → keep latest
      - consecutive ins  → keep earliest
   3. Handle midnight crossover by making times monotonically increasing
   4. If sequence starts with "out" → synthesise an "in" from scheduledInTxt
   5. Dangling "in" at end (no matching out):
      - Close it using actualOutTxt (real OutTime from File 1 row)
      - If gap is 0 or very small → it was a swipe on the way out, drop it
        and undo any break counted leading into this stray in
      - If gap is reasonable (> 0 and ≤ 90 min) → count as work
      - If gap is too large → stray swipe, undo the preceding break
═══════════════════════════════════════════════ */
function parsePunches(punchStr, scheduledInTxt, actualOutTxt) {
  const empty = { workMins:0, breakMins:0, firstIn:'', lastOut:'', synthIn:false, synthOut:false };
  if (!punchStr) return empty;

  // --- Step 1: Parse tokens, skip those without explicit direction ---
  const tokens = punchStr.split(',').map(s => s.trim());
  let evts = [];
  for (const t of tokens) {
    const m = t.match(/^(\d{1,2}):(\d{2}):(in|out)\(AB\)/i);
    if (m) evts.push({ time: +m[1]*60 + +m[2], dir: m[3].toLowerCase() });
    // Tokens like "13:08:(AB)" — no direction — are silently skipped
  }
  if (!evts.length) return empty;

  // --- Step 2: Deduplicate consecutive same-direction punches ---
  const deduped = [{ ...evts[0] }];
  for (let i = 1; i < evts.length; i++) {
    const prev = deduped[deduped.length - 1];
    if (evts[i].dir === prev.dir) {
      if (evts[i].dir === 'out') prev.time = Math.max(prev.time, evts[i].time); // keep latest out
      // for 'in' keep earliest (already stored) — do nothing
    } else {
      deduped.push({ ...evts[i] });
    }
  }
  evts = deduped;

  // --- Step 3: Midnight crossover — make monotonically increasing ---
  for (let i = 1; i < evts.length; i++) {
    if (evts[i].time < evts[i-1].time) {
      for (let j = i; j < evts.length; j++) evts[j].time += 1440;
    }
  }

  let synthIn = false, synthOut = false;

  // --- Step 4: First event is "out" — synthesise an "in" ---
  if (evts[0].dir === 'out') {
    const schedIn = toMins(scheduledInTxt);
    if (schedIn !== null && schedIn <= evts[0].time) {
      evts.unshift({ time: schedIn, dir: 'in' });
      synthIn = true;
    }
  }

  // --- Step 5: Walk the events, accumulate work and break ---
  let workMins = 0, breakMins = 0;
  let lastIn = null;           // minutes of last seen "in"
  let lastOutTime = null;      // minutes of last seen "out"
  let prevOutTime = null;      // minutes of the "out" just before current "in" (for undo)
  let firstInStr = '';
  let lastOutStr = '';

  for (const e of evts) {
    if (e.dir === 'in') {
      if (!firstInStr) firstInStr = hhmm(e.time);
      if (lastOutTime !== null) {
        // Gap between last out and this in = break
        const gap = e.time - lastOutTime;
        if (gap > 0 && gap <= 180) breakMins += gap; // cap at 3h (long absence ≠ break)
      }
      prevOutTime = lastOutTime; // remember in case this in is dangling
      lastIn = e.time;
      lastOutTime = null;
    } else { // 'out'
      lastOutStr = hhmm(e.time);
      if (lastIn !== null) {
        const seg = e.time - lastIn;
        if (seg > 0 && seg <= 720) workMins += seg; // cap at 12h (data anomaly guard)
        lastIn = null;
      }
      lastOutTime = e.time;
    }
  }

  // --- Step 6: Handle dangling "in" at end of punch string ---
  if (lastIn !== null) {
    // Use actualOutTxt (real OutTime from this File 1 row) as the closing boundary
    let closeTime = toMins(actualOutTxt);
    if (closeTime !== null && closeTime < lastIn) closeTime += 1440; // midnight crossover

    if (closeTime !== null) {
      const gap = closeTime - lastIn;

      if (gap <= 0) {
        // OutTime == lastIn → this was a swipe on the way out.
        // Undo any break that was counted leading into this stray in.
        if (prevOutTime !== null) {
          const spuriousBreak = lastIn - prevOutTime;
          if (spuriousBreak > 0 && spuriousBreak <= 180) {
            breakMins = Math.max(0, breakMins - spuriousBreak);
          }
        }
        // lastOutStr already set to the previous real out
      } else if (gap <= 90) {
        // Small gap — person was still working after last swipe in.
        // Count as work; use closeTime as the out.
        workMins += gap;
        lastOutStr = hhmm(closeTime);
        synthOut = true;
      } else {
        // Large gap — stray swipe (e.g. tapping card on the way out,
        // but OutTime already captured it). Undo the break leading into this in.
        if (prevOutTime !== null) {
          const spuriousBreak = lastIn - prevOutTime;
          if (spuriousBreak > 0 && spuriousBreak <= 180) {
            breakMins = Math.max(0, breakMins - spuriousBreak);
          }
        }
        // lastOutStr stays as the previous real out
      }
    }
    // If no closeTime available at all, just leave lastIn dangling (workMins unchanged)
  }

  return {
    workMins:  Math.round(workMins),
    breakMins: Math.round(breakMins),
    firstIn:   firstInStr,
    lastOut:   lastOutStr,
    synthIn,
    synthOut
  };
}

/* ═══════════════════════════════════════════════
   COLUMN FINDER — exact match first, then partial
   
   BUG FIX: The original ci() used h.includes(k) which caused
   "intime" to match "s. intime" — picking the wrong column.
   Now we do exact match first, then prefix match, then contains.
   Also: search for "s. intime" BEFORE "intime" for scheduled cols.
═══════════════════════════════════════════════ */
function findCol(headers, ...candidates) {
  // Exact match first
  for (const k of candidates) {
    const idx = headers.findIndex(h => h === norm(k));
    if (idx >= 0) return idx;
  }
  // Starts-with match
  for (const k of candidates) {
    const idx = headers.findIndex(h => h.startsWith(norm(k)));
    if (idx >= 0) return idx;
  }
  // Contains match (last resort)
  for (const k of candidates) {
    const idx = headers.findIndex(h => h.includes(norm(k)));
    if (idx >= 0) return idx;
  }
  return -1;
}

/* ═══════════════════════════════════════════════
   PARSE FILE 2 (Department-wise / shift file)
   
   File 2 format (per your sample):
     Department   [Marketing]
     SNo  E. Code  Name  Shift  InTime  OutTime  Work Dur.  OT  Tot. Dur.  Status  Remarks
     1    0344     Harini  GS2   10:24   17:32   ...
   
   BUG FIX: The department name appears as a label row ABOVE the
   column header row. We capture it when we see "Department" in a cell.
   We also handle the SNo prefix column correctly.
═══════════════════════════════════════════════ */
function parseShiftWB(wb) {
  const map = {};
  for (const sn of wb.SheetNames) {
    const ws   = wb.Sheets[sn];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
    if (!rows.length) continue;

    let currentDept = '';
    let headerIdx = -1;
    let colCode = -1, colName = -1, colShift = -1, colDept = -1;

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i].map(x => String(x).trim());
      const n   = raw.map(x => norm(x));

      // Detect department label rows like: ["Department", "Marketing", "", ...]
      // or rows where a cell says "Department" followed by the dept name
      for (let j = 0; j < raw.length - 1; j++) {
        if (/^department$/i.test(raw[j]) && raw[j+1]) {
          currentDept = raw[j+1].trim();
        }
        // Also handle "Department: Marketing" in a single cell
        const m = raw[j].match(/^department[:\s]+(.+)$/i);
        if (m) currentDept = m[1].trim();
      }

      // Detect the column header row
      // Look for E. Code (with or without spaces/dots)
      const codeIdx = n.findIndex(c =>
        c === 'e. code' || c === 'e.code' || c === 'emp code' ||
        c === 'empcode' || c === 'employee code' || c === 'e code' ||
        c === 'code'
      );
      if (codeIdx >= 0 && headerIdx < 0) {
        headerIdx = i;
        colCode  = codeIdx;
        colName  = findCol(n, 'name', 'employee name');
        colShift = findCol(n, 'shift');
        colDept  = findCol(n, 'department', 'dept');
        continue;
      }

      // Data rows
      if (headerIdx < 0) continue;
      const code = raw[colCode] ? String(raw[colCode]).trim() : '';
      if (!code || code === '0' || /^sno$/i.test(code)) continue;

      // Department: prefer inline column if present, else use captured label
      const rowDept = (colDept >= 0 && raw[colDept]) ? raw[colDept].trim() : currentDept;
      const rowShift = colShift >= 0 ? String(raw[colShift]||'').trim() : '';
      const rowName  = colName  >= 0 ? String(raw[colName] ||'').trim() : '';

      if (!map[code]) {
        map[code] = {
          name:  rowName,
          shift: normalizeShiftLabel(rowShift),
          dept:  rowDept,
        };
      }
    }
  }
  return map;
}

/* ═══════════════════════════════════════════════
   PARSE FILE 1 (Attendance / punch file)
   
   File 1 format (per your sample):
     Emp Code: 0359   Employee Name: Lakshitha
     Att. Date  InTime  OutTime  Shift  S. InTime  S. OutTime  Work Dur.  OT  Tot. Dur.  LateBy  EarlyGoingBy  Status  Punch Records
     02-May-2026  09:04  17:30  GS  09:00  18:30  ...  WeeklyOff Present  09:04:in(AB),...
   
   BUG FIX: Column detection now uses exact-first findCol() to correctly
   distinguish InTime vs S. InTime vs S. OutTime vs OutTime.
   We pass the ACTUAL OutTime (not scheduled) as the dangling-in boundary,
   because OutTime in File 1 represents the last device swipe out.
═══════════════════════════════════════════════ */
function processAttWB(wb) {
  const out = [];

  for (const sn of wb.SheetNames) {
    const ws   = wb.Sheets[sn];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });

    let code = '', name = '', dept = '';
    let colDate=-1, colActualIn=-1, colActualOut=-1, colStatus=-1;
    let colPunch=-1, colSIn=-1, colSOut=-1, colShift=-1;

    for (const row of rows) {
      const c  = row.map(x => String(x).trim());
      const cn = c.map(x => norm(x));

      // ── Employee header rows ──
      // "Emp Code:" followed by the code value in the next cell
      for (let i = 0; i < c.length - 1; i++) {
        if (/^emp[\s.]*code[:\s]*$/i.test(c[i]) && c[i+1]) {
          code = c[i+1].trim();
        }
        if (/employee[\s]*name\s*[:\s]*/i.test(c[i])) {
          for (let j = i+1; j < Math.min(i+6, c.length); j++) {
            if (c[j]) { name = c[j].trim(); break; }
          }
        }
        if (/^department[:\s]/i.test(c[i]) && c[i+1]) dept = c[i+1].trim();
        // Handle "Emp Code: 0359" in same cell
        const empM = c[i].match(/^emp[\s.]*code[:\s]+(\S+)/i);
        if (empM) code = empM[1].trim();
      }

      // ── Date-level column header row ──
      // Identified by having "Att. Date" or "Att Date" or "Date" as a cell
      const dateHdrIdx = cn.findIndex(x =>
        x === 'att. date' || x === 'att date' || x === 'att.date' ||
        x === 'date' || x === 'attendance date'
      );
      if (dateHdrIdx >= 0) {
        colDate = dateHdrIdx;

        // BUG FIX: Use exact/prefix matching to avoid "intime" matching "s. intime"
        // Search for scheduled times first (more specific) before actual times
        colSIn  = findCol(cn, 's. intime', 's.intime', 's. in time', 's intime');
        colSOut = findCol(cn, 's. outtime', 's.outtime', 's. out time', 's outtime');

        // For actual InTime/OutTime: avoid the S. variants by excluding their indices
        // We do this by temporarily removing them
        const cnCopy = [...cn];
        if (colSIn  >= 0) cnCopy[colSIn]  = '__skip__';
        if (colSOut >= 0) cnCopy[colSOut] = '__skip__';
        colActualIn  = findCol(cnCopy, 'intime', 'in time', 'in-time');
        colActualOut = findCol(cnCopy, 'outtime', 'out time', 'out-time');

        colStatus = findCol(cn, 'status');
        colShift  = findCol(cn, 'shift');
        colPunch  = findCol(cn, 'punch records', 'punch');
        continue;
      }

      // ── Data rows ──
      if (colDate < 0) continue;
      const dateVal = c[colDate] || '';
      // Accept formats: 02-May-2026, 02/05/2026, 2026-05-02, etc.
      if (!/\d/.test(dateVal) || dateVal.length < 8) continue;

      // Must be Present
      const statusVal = colStatus >= 0 ? c[colStatus] : '';
      const fullRow   = c.join(' ');
      const isPresent = /present/i.test(statusVal) || /present/i.test(fullRow);
      if (!isPresent) continue;

      // Must have punch records
      const punchVal = colPunch >= 0
        ? c[colPunch]
        : c.find(x => /:in\(AB\)|:out\(AB\)/i.test(x)) || '';
      if (!punchVal || !/:(?:in|out)\(AB\)/i.test(punchVal)) continue;

      // ── Get times ──
      const actualInTime  = (colActualIn  >= 0 && c[colActualIn]  && c[colActualIn]  !== '00:00') ? c[colActualIn]  : '';
      const actualOutTime = (colActualOut >= 0 && c[colActualOut] && c[colActualOut] !== '00:00') ? c[colActualOut] : '';
      const sInTime       = (colSIn       >= 0 && c[colSIn]       && c[colSIn]       !== '00:00') ? c[colSIn]       : '';
      const sOutTime      = (colSOut      >= 0 && c[colSOut]      && c[colSOut]      !== '00:00') ? c[colSOut]      : '';

      // ── Determine shift ──
      const sf         = shiftMap[code] || {};
      const finalDept  = sf.dept || dept || '';
      const shiftLabel = colShift >= 0 ? c[colShift] : (sf.shift || '');
      const shift      = detectShift(actualInTime || sInTime, finalDept, shiftLabel);

      // ── Boundaries for parsePunches ──
      // scheduledIn: for synthesising a missing first punch-in
      const scheduledIn = sInTime || SHIFT_SCHED_START[shift] || '09:00';
      // actualOut: ACTUAL device OutTime — used as boundary for dangling in.
      // If missing, fall back to S. OutTime, then shift schedule end.
      const boundaryOut = actualOutTime || sOutTime || SHIFT_SCHED_END[shift] || '18:30';

      const { workMins, breakMins, firstIn, lastOut, synthIn, synthOut } =
        parsePunches(punchVal, scheduledIn, boundaryOut);

      const exceeded = breakMins > LIMIT;

      out.push({
        code,
        name:     name || sf.name || code,
        dept:     finalDept,
        date:     dateVal,
        inTime:   firstIn || actualInTime,
        outTime:  lastOut || actualOutTime,
        workMins,
        breakMins,
        exceeded,
        excess:   Math.max(0, breakMins - LIMIT),
        shift,
        punches:  punchVal,
        synthIn,
        synthOut
      });
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════
   GROUP / UTIL
═══════════════════════════════════════════════ */
function groupByEmp(recs) {
  const m = {};
  for (const r of recs) {
    const k = r.code + '__' + r.name;
    if (!m[k]) m[k] = { code:r.code, name:r.name, dept:r.dept, shift:r.shift, days:[] };
    m[k].days.push(r);
  }
  return Object.values(m).sort((a,b) =>
    b.days.filter(d=>d.exceeded).length - a.days.filter(d=>d.exceeded).length ||
    a.name.localeCompare(b.name)
  );
}
function getAllDepts() {
  return [...new Set(records.map(r=>r.dept).filter(Boolean))].sort();
}

/* ═══════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════ */
function goto(pg, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + pg).classList.add('active');
  if (el) el.classList.add('active');
  if (pg === 'overview')   renderOverview();
  if (pg === 'employees')  renderEmpList();
  if (pg === 'department') renderDeptPage();
  if (pg === 'charts')     renderCharts();
}

/* ═══════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════ */
function applySettings() {
  LIMIT = parseInt(document.getElementById('set-limit').value) || 75;
  document.getElementById('qs-limit').textContent = LIMIT + ' min';
  records.forEach(r => { r.exceeded = r.breakMins > LIMIT; r.excess = Math.max(0, r.breakMins - LIMIT); });
}
function clearData() {
  records=[]; shiftMap={}; file1Loaded=false; file2Loaded=false; wb1=null; wb2=null;
  ['nb-badge','side-vcount','shift-sidebar','quick-stats-side'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.getElementById('nb-file').textContent = 'No files loaded';
  document.getElementById('dz1').classList.remove('loaded');
  document.getElementById('dz2').classList.remove('loaded');
  document.getElementById('fs1').style.display = 'none';
  document.getElementById('fs2').style.display = 'none';
  document.getElementById('process-btn').style.display = 'none';
  document.getElementById('fi1').value = '';
  document.getElementById('fi2').value = '';
  goto('upload', document.querySelector('.nav-item'));
}

/* ═══════════════════════════════════════════════
   FILE UPLOAD
═══════════════════════════════════════════════ */
function checkBothLoaded() {
  const hint = document.getElementById('upload-hint');
  const btn  = document.getElementById('process-btn');
  if (file1Loaded && file2Loaded) {
    btn.style.display = 'inline-flex';
    hint.textContent = 'Both files ready — click to process';
    hint.style.color = 'var(--green)';
  } else if (file1Loaded) {
    btn.style.display = 'none';
    hint.textContent = 'Now upload File 2 (department-wise) to continue';
    hint.style.color = 'var(--amber)';
  } else if (file2Loaded) {
    btn.style.display = 'none';
    hint.textContent = 'Now upload File 1 (attendance / punch file) to continue';
    hint.style.color = 'var(--amber)';
  } else {
    btn.style.display = 'none';
    hint.textContent = '';
  }
}

function setupFileInput(inputId, dzId, fsId, fsNameId, slot) {
  const fi = document.getElementById(inputId);
  const dz = document.getElementById(dzId);

  fi.addEventListener('change', function(e) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      const wb = XLSX.read(new Uint8Array(ev.target.result), { type:'array' });
      if (slot === 1) { wb1 = wb; file1Loaded = true; }
      else            { wb2 = wb; file2Loaded = true; }
      dz.classList.add('loaded');
      document.getElementById(fsId).style.display = '';
      document.getElementById(fsNameId).textContent = f.name;
      checkBothLoaded();
    };
    r.readAsArrayBuffer(f);
  });

  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) { fi.files = e.dataTransfer.files; fi.dispatchEvent(new Event('change')); }
  });
}

function processFiles() {
  if (!wb1 || !wb2) { alert('Please upload both files first.'); return; }
  shiftMap = parseShiftWB(wb2);
  records  = processAttWB(wb1);
  if (!records.length) {
    alert('No Present records with punch data found in File 1. Please check the format.');
    return;
  }
  afterLoad();
}

function afterLoad() {
  const groups   = groupByEmp(records);
  const empViol  = groups.filter(g => g.days.some(d => d.exceeded)).length;
  const viol     = records.filter(r => r.exceeded).length;
  const complPct = records.length ? Math.round((records.length - viol) / records.length * 100) : 0;
  const depts    = getAllDepts();

  document.getElementById('nb-file').textContent = `${groups.length} employees · ${depts.length} depts`;
  const badge = document.getElementById('nb-badge');
  badge.textContent = viol + ' violations'; badge.style.display = '';
  document.getElementById('side-vcount').textContent = empViol;
  document.getElementById('side-vcount').style.display = '';
  document.getElementById('shift-sidebar').style.display = '';
  document.getElementById('quick-stats-side').style.display = '';
  document.getElementById('qs-limit').textContent = LIMIT + ' min';
  document.getElementById('qs-emp').textContent   = groups.length;
  document.getElementById('qs-dept').textContent  = depts.length || '—';
  document.getElementById('qs-viol').textContent  = empViol;
  document.getElementById('qs-comp').textContent  = complPct + '%';

  const deptSel = document.getElementById('emp-dept');
  deptSel.innerHTML = '<option value="">All departments</option>' +
    depts.map(d => `<option>${d}</option>`).join('');

  const dates = [...new Set(records.map(r=>r.date))].sort();
  document.getElementById('emp-date').innerHTML = '<option value="">All dates</option>' +
    dates.map(d => `<option>${d}</option>`).join('');

  goto('overview', document.querySelectorAll('.nav-item')[1]);
}

/* ═══════════════════════════════════════════════
   OVERVIEW
═══════════════════════════════════════════════ */
function renderOverview() {
  const groups        = groupByEmp(records);
  const total         = groups.length;
  const violated      = groups.filter(g => g.days.some(d => d.exceeded)).length;
  const compliantEmps = groups.filter(g => g.days.every(d => !d.exceeded)).length;
  const complPct      = total ? Math.round(compliantEmps / total * 100) : 0;
  const avgBreak      = records.length ? Math.round(avg(records.map(r => r.breakMins))) : 0;
  const depts         = getAllDepts();

  document.getElementById('ov-stats').innerHTML = `
    <div class="stat-card">
      <div class="sc-icon" style="background:var(--accent-light)"><svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="#2563EB" stroke-width="1.8"/><path d="M10 6v4l2.5 2.5" stroke="#2563EB" stroke-width="1.6" stroke-linecap="round"/></svg></div>
      <div class="sc-lbl">Total employees</div>
      <div class="sc-val">${total}</div>
      <div class="sc-sub">${depts.length} department${depts.length!==1?'s':''}</div>
      <div class="sc-bar" style="background:var(--accent-mid)"></div>
    </div>
    <div class="stat-card">
      <div class="sc-icon" style="background:var(--red-light)"><svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 3l7 14H3L10 3z" stroke="#DC2626" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 9v4M10 14.5v.5" stroke="#DC2626" stroke-width="1.6" stroke-linecap="round"/></svg></div>
      <div class="sc-lbl">Exceeded break limit</div>
      <div class="sc-val" style="color:var(--red)">${violated} <span style="font-size:16px;color:var(--text3)">/ ${total}</span></div>
      <div class="sc-sub">${complPct}% of staff within limit</div>
      <div class="sc-bar" style="background:var(--red-mid)"></div>
    </div>
    <div class="stat-card">
      <div class="sc-icon" style="background:var(--green-light)"><svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M4 10l4 4 8-8" stroke="#16A34A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="sc-lbl">Compliance rate</div>
      <div class="sc-val" style="color:var(--green)">${complPct}%</div>
      <div class="sc-sub">${compliantEmps} of ${total} within limit</div>
      <div class="sc-bar" style="background:var(--green-mid)"></div>
    </div>
    <div class="stat-card">
      <div class="sc-icon" style="background:var(--amber-light)"><svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="#D97706" stroke-width="1.6"/><path d="M10 7v3.5l2 2" stroke="#D97706" stroke-width="1.5" stroke-linecap="round"/></svg></div>
      <div class="sc-lbl">Avg break / employee</div>
      <div class="sc-val" style="color:${avgBreak>LIMIT?'var(--red)':'var(--green)'}">${fmtM(avgBreak)}</div>
      <div class="sc-sub">Limit is ${LIMIT} min</div>
      <div class="sc-bar" style="background:var(--amber-mid)"></div>
    </div>`;

  const top = groups.filter(g => g.days.some(d => d.exceeded)).slice(0, 10);
  document.getElementById('viol-count-badge').textContent = violated + ' employees';
  document.getElementById('top-viol-body').innerHTML = top.length ? top.map((g,i) => {
    const excD      = g.days.filter(d => d.exceeded).length;
    const totalExc  = g.days.reduce((s,d) => s+d.excess, 0);
    const totalWork = g.days.reduce((s,d) => s+d.workMins, 0);
    const pct       = Math.min(100, totalExc/300*100).toFixed(0);
    const rankCls   = i===0?'rank-1':i===1?'rank-2':i===2?'rank-3':'rank';
    const deptIdx   = depts.indexOf(g.dept);
    return `<tr>
      <td><span class="${rankCls}">${i+1}</span></td>
      <td><span style="font-weight:600">${g.name}</span><br><span style="font-size:10px;color:var(--text3)">#${g.code}</span></td>
      <td>${deptBadge(g.dept,deptIdx)}</td>
      <td>${shiftBadge(g.shift)}</td>
      <td>${excD}/${g.days.length}</td>
      <td>+${fmtM(totalExc)}<span class="pbar-wrap"><span class="pbar" style="width:${pct}%;background:var(--red)"></span></span></td>
      <td><span class="badge b-blue">${fmtH(totalWork)}</span></td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">No violations found</td></tr>';

  const okGroups = groups.filter(g => g.days.length>0 && g.days.every(d=>!d.exceeded));
  document.getElementById('ok-count-badge').textContent = okGroups.length + ' employees';
  document.getElementById('ok-body').innerHTML = okGroups.length ? okGroups.map(g => {
    const deptIdx = depts.indexOf(g.dept);
    return `<tr class="ok-row">
      <td><span style="font-weight:600">${g.name}</span> <span style="font-size:10px;color:var(--text3)">#${g.code}</span></td>
      <td>${deptBadge(g.dept,deptIdx)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="2" class="empty">—</td></tr>';

  document.getElementById('monthly-body').innerHTML = groups.map(g => {
    const excD    = g.days.filter(d => d.exceeded).length;
    const avgB    = Math.round(avg(g.days.map(d => d.breakMins)));
    const avgWork = Math.round(avg(g.days.map(d => d.workMins)));
    const deptIdx = depts.indexOf(g.dept);
    return `<tr class="${excD>0?'exceeded-row':'ok-row'}">
      <td><span style="font-weight:600">${g.name}</span> <span style="font-size:10px;color:var(--text3)">#${g.code}</span></td>
      <td>${deptBadge(g.dept,deptIdx)}</td>
      <td>${shiftBadge(g.shift)}</td>
      <td>${g.days.length}</td>
      <td><span class="badge ${avgB>LIMIT?'b-red':avgB>LIMIT*.8?'b-amber':'b-green'}">${fmtM(avgB)}</span></td>
      <td><span class="badge b-blue">${fmtH(avgWork)}</span></td>
      <td>${excD>0?`<span style="color:var(--red);font-weight:600">${excD}</span>`:`<span style="color:var(--green)">0</span>`}</td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   DEPARTMENT PAGE
═══════════════════════════════════════════════ */
let activeDept = 'ALL';
function renderDeptPage() {
  const depts  = getAllDepts();
  const tabRow = document.getElementById('dept-tab-row');
  tabRow.innerHTML = `<span class="dept-tab ${activeDept==='ALL'?'active':''}" onclick="setActiveDept('ALL')">All departments</span>`
    + depts.map(d => `<span class="dept-tab ${activeDept===d?'active':''}" onclick="setActiveDept('${d.replace(/'/g,"\\'")}'">${d}</span>`).join('');
  renderDeptContent();
}
function setActiveDept(d) { activeDept = d; renderDeptPage(); }
function renderDeptContent() {
  const depts     = getAllDepts();
  const content   = document.getElementById('dept-content');
  const showDepts = activeDept === 'ALL' ? depts : [activeDept];
  if (!depts.length) {
    content.innerHTML = '<div class="empty">No department data found.</div>';
    return;
  }
  content.innerHTML = showDepts.map(dept => {
    const deptRecs   = records.filter(r => r.dept === dept);
    const deptGroups = groupByEmp(deptRecs);
    const violated   = deptGroups.filter(g => g.days.some(d => d.exceeded)).length;
    const compliant  = deptGroups.filter(g => g.days.every(d => !d.exceeded)).length;
    const compPct    = deptGroups.length ? Math.round(compliant/deptGroups.length*100) : 0;
    const avgB       = deptRecs.length ? Math.round(avg(deptRecs.map(r => r.breakMins))) : 0;
    const deptIdx    = depts.indexOf(dept);
    const color      = DEPT_PALETTE[deptIdx % DEPT_PALETTE.length];
    return `<div class="card" style="border-left:4px solid ${color}">
      <div class="card-head"><span>${dept}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge b-gray">${deptGroups.length} employees</span>
          ${violated>0?`<span class="badge b-red">${violated} violations</span>`:`<span class="badge b-green">No violations</span>`}
          <span class="badge b-blue">${compPct}% compliant</span>
        </div>
      </div>
      <div class="card-body" style="padding:.75rem 1.25rem">
        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:1rem">
          <div class="mini-stat"><div class="ms-val">${deptGroups.length}</div><div class="ms-lbl">Employees</div></div>
          <div class="mini-stat"><div class="ms-val" style="color:${violated>0?'var(--red)':'var(--green)'}">${violated}</div><div class="ms-lbl">Violated</div></div>
          <div class="mini-stat"><div class="ms-val" style="color:var(--green)">${compPct}%</div><div class="ms-lbl">Compliance</div></div>
          <div class="mini-stat"><div class="ms-val" style="color:${avgB>LIMIT?'var(--red)':'var(--text)'}">${fmtM(avgB)}</div><div class="ms-lbl">Avg break</div></div>
        </div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Employee</th><th>Shift</th><th>Days present</th><th>Avg break/day</th><th>Avg work hrs/day</th><th>Days exceeded</th></tr></thead>
          <tbody>${deptGroups.map(g => {
            const excD  = g.days.filter(d => d.exceeded).length;
            const avgBr = Math.round(avg(g.days.map(d => d.breakMins)));
            const avgWk = Math.round(avg(g.days.map(d => d.workMins)));
            return `<tr class="${excD>0?'exceeded-row':'ok-row'}">
              <td><span style="font-weight:600">${g.name}</span> <span style="font-size:10px;color:var(--text3)">#${g.code}</span></td>
              <td>${shiftBadge(g.shift)}</td>
              <td>${g.days.length}</td>
              <td><span class="badge ${avgBr>LIMIT?'b-red':avgBr>LIMIT*.8?'b-amber':'b-green'}">${fmtM(avgBr)}</span></td>
              <td><span class="badge b-blue">${fmtH(avgWk)}</span></td>
              <td>${excD>0?`<span style="color:var(--red);font-weight:600">${excD}</span>`:`<span style="color:var(--green)">0</span>`}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   EMPLOYEES
═══════════════════════════════════════════════ */
function renderEmpList() {
  const q       = document.getElementById('emp-search').value.toLowerCase();
  const df_dept = document.getElementById('emp-dept').value;
  const sf      = document.getElementById('emp-shift').value;
  const st      = document.getElementById('emp-status').value;
  const df      = document.getElementById('emp-date').value;
  const depts   = getAllDepts();
  let groups    = groupByEmp(records);
  if (q)       groups = groups.filter(g => g.name.toLowerCase().includes(q)||g.code.toLowerCase().includes(q));
  if (df_dept) groups = groups.filter(g => g.dept === df_dept);
  if (sf)      groups = groups.filter(g => g.shift === sf);
  if (df)      groups = groups.map(g=>({...g,days:g.days.filter(d=>d.date===df)})).filter(g=>g.days.length);
  if (st==='exceeded') groups = groups.filter(g => g.days.some(d=>d.exceeded));
  if (st==='ok')       groups = groups.filter(g => g.days.every(d=>!d.exceeded));

  document.getElementById('emp-count-label').textContent = `${groups.length} employee${groups.length!==1?'s':''}`;
  const el = document.getElementById('emp-list');
  if (!groups.length) { el.innerHTML='<div class="empty">No employees match the filters</div>'; return; }

  el.innerHTML = groups.map((g,i) => {
    const excD      = g.days.filter(d=>d.exceeded).length;
    const totalExc  = g.days.reduce((s,d)=>s+d.excess,0);
    const totalWork = g.days.reduce((s,d)=>s+d.workMins,0);
    const avgB      = Math.round(avg(g.days.map(d=>d.breakMins)));
    const badge     = excD>0
      ? `<span class="badge b-red">${excD} day${excD>1?'s':''} exceeded</span>`
      : `<span class="badge b-green">No violations</span>`;
    const initials  = (g.name||'?').split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
    const deptIdx   = depts.indexOf(g.dept);

    const dayRows = g.days.map(d => {
      const pct     = Math.min(100, d.breakMins/(LIMIT*2)*100).toFixed(0);
      const inDisp  = d.inTime  ? (d.synthIn  ? `${d.inTime}<span class="synth-tag">SCHED</span>`  : d.inTime)  : '—';
      const outDisp = d.outTime ? (d.synthOut ? `${d.outTime}<span class="synth-tag">SCHED</span>` : d.outTime) : '—';
      return `<tr class="${d.exceeded?'exceeded-row':'ok-row'}">
        <td style="font-size:11px">${d.date}</td>
        <td>${inDisp}</td><td>${outDisp}</td>
        <td>${shiftBadge(d.shift)}</td>
        <td>${fmtM(d.workMins)}</td>
        <td>${fmtM(d.breakMins)}<span class="pbar-wrap"><span class="pbar" style="width:${pct}%;background:${d.exceeded?'var(--red)':'var(--green)'}"></span></span></td>
        <td>${d.exceeded?`<span style="color:var(--red);font-weight:600">+${fmtM(d.excess)}</span>`:`<span style="color:var(--text3)">—</span>`}</td>
        <td>${d.exceeded?`<span class="badge b-red">Exceeded</span>`:`<span class="badge b-green">OK</span>`}</td>
      </tr>`;
    }).join('');

    return `<div class="emp-card">
      <div class="emp-hdr" id="eh${i}" onclick="toggleEmp(${i})">
        <div class="emp-left">
          <div class="emp-avatar" style="background:${SHIFT_BG[g.shift]||'#F1F5F9'};color:${SHIFT_TXT[g.shift]||'#475569'};border-color:${SHIFT_BORDER[g.shift]||'#E2E8F0'}">${initials}</div>
          <div>
            <div class="emp-name">${g.name} <span style="font-size:10px;color:var(--text3);font-weight:400">#${g.code}</span></div>
            <div class="emp-meta">
              <span>${g.days.length} days</span><span style="color:var(--border)">·</span>
              ${deptBadge(g.dept,deptIdx)}<span style="color:var(--border)">·</span>
              ${shiftBadge(g.shift)}<span style="color:var(--border)">·</span>
              <span>Avg break: <strong style="color:${avgB>LIMIT?'var(--red)':'var(--text)'}">${fmtM(avgB)}</strong></span>
              <span style="color:var(--border)">·</span>
              <span>Work: <strong style="color:var(--accent)">${fmtH(totalWork)}</strong></span>
            </div>
          </div>
        </div>
        <div class="emp-right">
          ${badge}
          <button onclick="event.stopPropagation();downloadEmpCSV('${g.code}','${g.name.replace(/'/g,"\\'")}');" style="font-size:11px;padding:4px 10px;display:flex;align-items:center;gap:4px">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="2" y="11" width="12" height="1.5" rx="1" fill="currentColor"/></svg>CSV
          </button>
          <svg class="chev" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </div>
      <div class="emp-detail" id="ed${i}">
        <div class="emp-detail-inner">
          <div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:1rem">
            <div class="mini-stat"><div class="ms-val">${g.days.length}</div><div class="ms-lbl">Days present</div></div>
            <div class="mini-stat"><div class="ms-val" style="color:${avgB>LIMIT?'var(--red)':'var(--green)'}">${fmtM(avgB)}</div><div class="ms-lbl">Avg break</div></div>
            <div class="mini-stat"><div class="ms-val" style="color:${excD>0?'var(--red)':'var(--green)'}">${excD}</div><div class="ms-lbl">Days exceeded</div></div>
            <div class="mini-stat"><div class="ms-val" style="color:${excD>0?'var(--red)':'var(--text3)'}">${excD>0?'+'+fmtM(totalExc):'—'}</div><div class="ms-lbl">Total excess</div></div>
            <div class="mini-stat"><div class="ms-val" style="color:var(--accent)">${fmtH(totalWork)}</div><div class="ms-lbl">Total work hrs</div></div>
          </div>
          <div class="tbl-wrap"><table>
            <thead><tr><th>Date</th><th>In</th><th>Out</th><th>Shift</th><th>Work dur.</th><th>Break time</th><th>Exceeded by</th><th>Status</th></tr></thead>
            <tbody>${dayRows}</tbody>
          </table></div>
          <div style="font-size:10px;color:var(--text3);margin-top:.5rem">
            Break limit: ${LIMIT} min · Bare (AB) punches excluded · <span style="color:var(--amber);font-weight:600">SCHED</span> = synthesised from scheduled time
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleEmp(i) {
  const d = document.getElementById('ed'+i), h = document.getElementById('eh'+i);
  const open = d.style.display === 'block';
  d.style.display = open ? 'none' : 'block';
  h.classList.toggle('open', !open);
}

/* ═══════════════════════════════════════════════
   CSV EXPORT
═══════════════════════════════════════════════ */
function buildCSVRows(days, empCode, empName, dept) {
  const hdr = ['Emp Code','Employee Name','Department','Date','In Time','Out Time','Synth In','Synth Out','Shift','Work (min)','Break (min)','Break','Exceeded','Excess (min)','Excess','Status'];
  const rows = days.map(d => [
    empCode, empName, dept||'', d.date,
    d.inTime||'', d.outTime||'',
    d.synthIn?'YES':'', d.synthOut?'YES':'',
    d.shift, Math.round(d.workMins), Math.round(d.breakMins), fmtM(d.breakMins),
    d.exceeded?'YES':'NO',
    d.exceeded?Math.round(d.excess):'',
    d.exceeded?'+'+fmtM(d.excess):'',
    d.exceeded?'Exceeded':'OK'
  ]);
  return [hdr, ...rows];
}
function rowsToCSV(rows) {
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
}
function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function downloadEmpCSV(code, name) {
  const g = groupByEmp(records).find(g => g.code===code && g.name===name);
  if (!g) return;
  downloadCSV(rowsToCSV(buildCSVRows(g.days,g.code,g.name,g.dept)),
    `break_${(name||code).replace(/[^a-z0-9]/gi,'_')}.csv`);
}
function downloadAllCSV() {
  const df_dept = document.getElementById('emp-dept').value;
  const sf      = document.getElementById('emp-shift').value;
  const st      = document.getElementById('emp-status').value;
  const df      = document.getElementById('emp-date').value;
  let groups    = groupByEmp(records);
  if (df_dept) groups = groups.filter(g=>g.dept===df_dept);
  if (sf)      groups = groups.filter(g=>g.shift===sf);
  if (df)      groups = groups.map(g=>({...g,days:g.days.filter(d=>d.date===df)})).filter(g=>g.days.length);
  if (st==='exceeded') groups = groups.filter(g=>g.days.some(d=>d.exceeded));
  if (st==='ok')       groups = groups.filter(g=>g.days.every(d=>!d.exceeded));
  if (!groups.length) { alert('No data to export.'); return; }
  const hdr     = buildCSVRows([],'',' ','')[0];
  const allRows = [hdr];
  for (const g of groups) allRows.push(...buildCSVRows(g.days,g.code,g.name,g.dept).slice(1));
  downloadCSV(rowsToCSV(allRows), 'break_report_all.csv');
}

/* ═══════════════════════════════════════════════
   CHARTS
═══════════════════════════════════════════════ */
function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

function renderCharts() {
  ['c2','c5','c6','c7'].forEach(destroyChart);

  const dateMap = {};
  records.forEach(r => { if (!dateMap[r.date]) dateMap[r.date]=0; if (r.exceeded) dateMap[r.date]++; });
  const sortedDates = Object.keys(dateMap).sort();
  const excCounts   = sortedDates.map(d => dateMap[d]);
  charts.c2 = new Chart(document.getElementById('c2'), {
    type:'bar',
    data:{ labels:sortedDates.map(d=>d.replace(/-\d{4}$/,'')), datasets:[{ label:'Exceeded', data:excCounts, backgroundColor:excCounts.map(v=>v===0?'#E2E8F0':'#DC2626'), borderRadius:4, borderSkipped:false }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{ticks:{autoSkip:true,maxRotation:45,font:{size:9}},grid:{display:false}}, y:{ticks:{font:{size:10},stepSize:1},beginAtZero:true} } }
  });

  const groups    = groupByEmp(records);
  const top20     = groups.slice(0,20).sort((a,b)=>avg(b.days.map(d=>d.breakMins))-avg(a.days.map(d=>d.breakMins)));
  const avgBreaks = top20.map(g=>Math.round(avg(g.days.map(d=>d.breakMins))));
  charts.c5 = new Chart(document.getElementById('c5'), {
    type:'bar',
    data:{ labels:top20.map(g=>g.name.split(' ')[0]), datasets:[{ data:avgBreaks, backgroundColor:avgBreaks.map(v=>v>LIMIT?'#DC2626':'#60A5FA'), borderRadius:5, borderSkipped:false }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{ x:{ticks:{font:{size:10},maxRotation:45},grid:{display:false}}, y:{ticks:{font:{size:10}},beginAtZero:true,afterDataLimits(s){s.max=Math.max(s.max,LIMIT+20);}} } },
    plugins:[{id:'ll',afterDraw(chart){const{ctx,scales:{y,x}}=chart;const yp=y.getPixelForValue(LIMIT);ctx.save();ctx.strokeStyle='#DC2626';ctx.lineWidth=1.5;ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(x.left,yp);ctx.lineTo(x.right,yp);ctx.stroke();ctx.fillStyle='#DC2626';ctx.font='bold 10px sans-serif';ctx.fillText(`Limit ${LIMIT}m`,x.right+4,yp+4);ctx.restore();}}]
  });

  const depts    = getAllDepts();
  const deptViol = {}, deptOk = {};
  depts.forEach(d=>{deptViol[d]=new Set();deptOk[d]=new Set();});
  groups.forEach(g=>{
    if(!g.dept)return;
    if(g.days.some(d=>d.exceeded))deptViol[g.dept].add(g.code);
    else deptOk[g.dept].add(g.code);
  });
  const activeDepts = depts.filter(d=>deptViol[d].size+deptOk[d].size>0);
  document.getElementById('leg-dept').innerHTML = `<span><span class="legend-dot" style="background:#DC2626"></span>Exceeded</span><span><span class="legend-dot" style="background:#CBD5E1"></span>Within limit</span>`;
  charts.c6 = new Chart(document.getElementById('c6'),{
    type:'bar',
    data:{labels:activeDepts,datasets:[
      {label:'Exceeded',data:activeDepts.map(d=>deptViol[d].size),backgroundColor:activeDepts.map((d,i)=>DEPT_PALETTE[i%DEPT_PALETTE.length]),borderRadius:5,borderSkipped:false},
      {label:'Within limit',data:activeDepts.map(d=>deptOk[d].size),backgroundColor:'#CBD5E1',borderRadius:5,borderSkipped:false}
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{font:{size:10},maxRotation:30},grid:{display:false}},y:{ticks:{font:{size:10},stepSize:1},beginAtZero:true}}}
  });

  const shiftEmpViol={},shiftEmpOk={};
  SHIFTS.forEach(s=>{shiftEmpViol[s]=new Set();shiftEmpOk[s]=new Set();});
  groups.forEach(g=>{
    if(g.days.some(d=>d.exceeded))shiftEmpViol[g.shift].add(g.code+'__'+g.name);
    else shiftEmpOk[g.shift].add(g.code+'__'+g.name);
  });
  const activeShifts = SHIFTS.filter(s=>shiftEmpViol[s].size+shiftEmpOk[s].size>0);
  const excVals  = activeShifts.map(s=>shiftEmpViol[s].size);
  const okVals   = activeShifts.map(s=>shiftEmpOk[s].size);
  const totals   = activeShifts.map(s=>shiftEmpViol[s].size+shiftEmpOk[s].size);
  const pctVals  = activeShifts.map((s,i)=>totals[i]?Math.round(shiftEmpViol[s].size/totals[i]*100):0);
  document.getElementById('leg-shift').innerHTML = `<span><span class="legend-dot" style="background:#DC2626"></span>Exceeded</span><span><span class="legend-dot" style="background:#CBD5E1"></span>Within limit</span>`;
  charts.c7 = new Chart(document.getElementById('c7'),{
    type:'bar',
    data:{labels:activeShifts,datasets:[
      {label:'Exceeded',data:excVals,backgroundColor:activeShifts.map(s=>SHIFT_COLORS[s]||'#888'),borderRadius:5,borderSkipped:false},
      {label:'Within limit',data:okVals,backgroundColor:'#CBD5E1',borderRadius:5,borderSkipped:false}
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{font:{size:11}},grid:{display:false}},y:{ticks:{font:{size:10},stepSize:1},beginAtZero:true}}},
    plugins:[{id:'pct',afterDatasetsDraw(chart){const{ctx}=chart;const meta=chart.getDatasetMeta(0);meta.data.forEach((bar,i)=>{const val=excVals[i];if(!val)return;ctx.save();ctx.fillStyle=SHIFT_COLORS[activeShifts[i]]||'#555';ctx.font='bold 11px sans-serif';ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillText(`${pctVals[i]}%`,bar.x,bar.y-4);ctx.restore();});}}]
  });
}

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  setupFileInput('fi1','dz1','fs1','fs1-name',1);
  setupFileInput('fi2','dz2','fs2','fs2-name',2);
});