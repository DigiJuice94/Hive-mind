const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const TARGET_URL = String(process.env.COUNCIL_URL || "https://bot-council-production.up.railway.app").replace(/\/$/, "");
const POLL_MS = Math.max(15000, Number(process.env.HIVE_POLL_MS || 30000));
const DATA_DIR = process.env.HIVE_DATA_DIR || (fs.existsSync("/data") ? "/data/hive-auditor" : path.join(process.cwd(), "hive-audit-data"));
const BASELINE_ZIP = process.env.COUNCIL_BASELINE_ZIP || path.join(process.cwd(), "council-baseline.zip");
const AUTO_REPAIR = String(process.env.HIVE_AUTO_REPAIR || "true").toLowerCase() !== "false";
const REPAIR_COOLDOWN_MS = Math.max(60 * 60 * 1000, Number(process.env.HIVE_REPAIR_COOLDOWN_MS || 6 * 60 * 60 * 1000));
const MAX_FINDINGS = 250;
const MAX_ACTIVITY = 300;
const MAX_UPDATES = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "updates"), { recursive: true });
const STATE_FILE = path.join(DATA_DIR, "state.json");

const PROTECTED_FILES = [
  "engine.ts", "risk.ts", "alpha-engine.ts", "meme-regime.ts", "regime.ts", "debate.ts", "premeeting.ts",
  "exit-strategy.ts", "exit-strategy-bot.ts", "position-policy.ts", "runner-research.ts", "launch-velocity.ts",
  "agent-entity-runtime.ts", "agent-entity-store.ts", "claude-survival-council.ts"
];

const REPAIR_MAP = {
  STATIC_UNVERIFIED_SELL_CREDIT_PATH: ["sellability-auditor.ts", "position-manager.ts", "execution.ts", "route-feasibility.ts", "paper-wallet.ts", "types.ts"],
  UNVERIFIED_SELL_CREDIT: ["sellability-auditor.ts", "position-manager.ts", "execution.ts", "route-feasibility.ts", "paper-wallet.ts", "types.ts"],
  STATIC_ENTRY_SELLABILITY_GAP: ["autopilot.ts", "sellability-auditor.ts", "liquidity-auditor.ts", "execution.ts"],
  ZERO_LIQUIDITY_BUY: ["autopilot.ts", "liquidity-auditor.ts", "execution.ts", "sellability-auditor.ts"],
  ACCOUNTING_MISMATCH: ["paper-wallet.ts", "position-store.ts", "trade-journal.ts", "cabinet-export.ts", "types.ts"],
  UNSELLABLE_ACCOUNTING: ["paper-wallet.ts", "position-manager.ts", "position-store.ts", "types.ts"],
  EXIT_PENDING_STUCK: ["position-manager.ts", "position-store.ts", "sellability-auditor.ts", "types.ts"],
};

function freshState() {
  return {
    version: "HIVE-AUDITOR-V1",
    startedAt: new Date().toISOString(),
    targetUrl: TARGET_URL,
    scans: 0,
    lastScanAt: null,
    targetOnline: false,
    endpoints: {},
    findings: [],
    activity: [],
    updates: [],
    lastSnapshot: null,
    staticAuditComplete: false,
    repairBusy: false,
  };
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const x = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return { ...freshState(), ...x, repairBusy: false, targetUrl: TARGET_URL };
    }
  } catch (e) { console.error("[hive] state read failed", e); }
  return freshState();
}
let S = readState();

function save() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(S, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function now() { return new Date().toISOString(); }
function num(v, d=0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function money(v) { return `$${num(v).toFixed(2)}`; }
function hash(v) { return crypto.createHash("sha256").update(String(v)).digest("hex"); }
function esc(v) { return String(v ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

function activity(agent, text, level="info") {
  S.activity.unshift({ at: now(), agent, text, level });
  S.activity = S.activity.slice(0, MAX_ACTIVITY);
}

const severityRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function upsertFinding(input) {
  const key = input.key || input.kind;
  const existing = S.findings.find(f => f.key === key && f.status !== "resolved");
  if (existing) {
    existing.lastSeenAt = now();
    existing.count = (existing.count || 1) + 1;
    existing.evidence = input.evidence;
    existing.severity = input.severity;
    existing.title = input.title;
    existing.source = input.source || existing.source;
    existing.repairable = Boolean(REPAIR_MAP[input.kind]);
    return existing;
  }
  const row = {
    id: `F-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    key, kind: input.kind, severity: input.severity, title: input.title,
    evidence: input.evidence, source: input.source || "live", status: "open",
    detectedAt: now(), lastSeenAt: now(), count: 1, repairable: Boolean(REPAIR_MAP[input.kind]),
    repairStatus: "not_started",
  };
  S.findings.unshift(row);
  S.findings = S.findings.slice(0, MAX_FINDINGS);
  activity("AUDITOR", `${row.severity.toUpperCase()}: ${row.title}`, row.severity);
  return row;
}

async function fetchJson(pathname) {
  const url = TARGET_URL + pathname;
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "HIVE-AUDITOR-V1" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`non-JSON response (${res.status})`); }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0,180)}`);
    return { ok: true, data, ms: Date.now() - started, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

async function collectLive() {
  const defs = [
    ["autopilot", "/api/autopilot"],
    ["tradeLog", "/api/trade-log?limit=1000"],
    ["positions", "/api/positions?light=1"],
    ["proof", "/api/cabinets/proof"],
    ["rug", "/api/cabinets/rug"],
  ];
  const results = await Promise.all(defs.map(async ([name, p]) => [name, await fetchJson(p)]));
  const map = Object.fromEntries(results);
  for (const [name, r] of results) S.endpoints[name] = { ok: r.ok, ms: r.ms, checkedAt: now(), error: r.error || null };
  const autopilot = map.autopilot.ok ? map.autopilot.data : null;
  const proof = map.proof.ok ? map.proof.data : null;
  const tradeLog = map.tradeLog.ok ? map.tradeLog.data : null;
  const positionPayload = map.positions.ok ? map.positions.data : null;
  const rug = map.rug.ok ? map.rug.data : null;

  const wallet = autopilot?.paperWallet || null;
  const positions = Array.isArray(positionPayload?.positions) ? positionPayload.positions : Array.isArray(autopilot?.positions) ? autopilot.positions : Array.isArray(proof?.positions) ? proof.positions : [];
  const fills = Array.isArray(tradeLog?.rows) ? tradeLog.rows : Array.isArray(proof?.fills) ? proof.fills : Array.isArray(wallet?.recentFills) ? wallet.recentFills : [];
  const decisions = Array.isArray(proof?.decisions) ? proof.decisions : [];
  return { map, autopilot, wallet, positions, fills, proof, rug, decisions };
}

function findPositionForFill(fill, positions) {
  if (fill.positionId) {
    const byId = positions.find(p => p.id === fill.positionId);
    if (byId) return byId;
  }
  return positions.find(p => p.chain === fill.chain && p.tokenAddress === fill.tokenAddress);
}

function auditLiveData(d) {
  const seen = [];
  const emit = x => { seen.push(x.key || x.kind); return upsertFinding(x); };
  const { wallet, positions, fills, proof, map } = d;

  const onlineCount = Object.values(map || {}).filter(x => x && x.ok).length;
  if (onlineCount === 0) emit({ kind:"TARGET_UNREACHABLE", severity:"high", title:"Council live audit feeds are unreachable", evidence:"HIVE could not read any configured Council API endpoint during this scan.", source:"live" });

  if (proof?.reconciliation) {
    const r = proof.reconciliation;
    const delta = Math.abs(num(r.equityDeltaUsd));
    if (delta > 0.01 || r.accountingVerified === false) {
      emit({ kind:"ACCOUNTING_MISMATCH", severity:"critical", title:"Council equity does not reconcile", evidence:`Reported equity ${money(r.reportedEquityUsd)} vs independently reconstructed ${money(r.independentlyReconstructedEquityUsd)}; delta ${money(r.equityDeltaUsd)}.`, source:"proof-cabinet" });
    }
  }

  const fillIds = new Set();
  for (const f of fills || []) {
    const id = String(f.id || "");
    if (id && fillIds.has(id)) emit({ kind:"DUPLICATE_FILL", key:`DUPLICATE_FILL:${id}`, severity:"high", title:`Duplicate fill ${id} detected`, evidence:`The same fill ID appears more than once in the live ledger.`, source:"trade-log" });
    if (id) fillIds.add(id);
    const side = String(f.side || "").toUpperCase();
    const p = findPositionForFill(f, positions || []);
    if (side === "BUY") {
      const snap = p?.entryContext?.snapshot;
      if (snap && (!Number.isFinite(Number(snap.liquidity)) || Number(snap.liquidity) <= 0)) {
        emit({ kind:"ZERO_LIQUIDITY_BUY", key:`ZERO_LIQUIDITY_BUY:${id||p?.id||f.tokenAddress}`, severity:"critical", title:`BUY recorded with zero entry liquidity: $${f.symbol || p?.symbol || "UNKNOWN"}`, evidence:`Entry snapshot liquidity=${String(snap.liquidity)} for fill ${id || "unknown"}.`, source:"live-ledger" });
      }
      if (snap) {
        const notes = Array.isArray(snap.dataProvenance?.notes) ? snap.dataProvenance.notes.join(" | ") : "";
        if (!/Liquidity Auditor:/i.test(notes)) {
          emit({ kind:"ENTRY_AUDIT_MISSING", key:`ENTRY_AUDIT_MISSING:${id||p?.id||f.tokenAddress}`, severity:"high", title:`BUY has no recorded independent liquidity-auditor evidence: $${f.symbol || p?.symbol || "UNKNOWN"}`, evidence:`Fill ${id || "unknown"} has an entry snapshot but no Liquidity Auditor note.`, source:"live-ledger" });
        }
      }
    }
    if (side === "SELL" && num(f.filledUsd) > 0) {
      if (f.routeVerified !== true) {
        emit({ kind:"UNVERIFIED_SELL_CREDIT", key:`UNVERIFIED_SELL_CREDIT:${id||f.tokenAddress}:${f.createdAt||""}`, severity:"critical", title:`Sale proceeds credited without a verified sell route: $${f.symbol || p?.symbol || "UNKNOWN"}`, evidence:`Fill ${id || "unknown"} credited ${money(f.filledUsd)} with routeVerified=${String(f.routeVerified)} and provider=${String(f.routeProvider || "unknown")}.`, source:"trade-log" });
      }
      if (p?.status === "unsellable" && p.unsellableAt && new Date(f.createdAt || 0).getTime() >= new Date(p.unsellableAt).getTime()) {
        emit({ kind:"SELL_AFTER_UNSELLABLE", key:`SELL_AFTER_UNSELLABLE:${id||p.id}`, severity:"critical", title:`Sale credited after position was marked unsellable: $${p.symbol}`, evidence:`Position ${p.id} became unsellable at ${p.unsellableAt}; sell fill ${id || "unknown"} was recorded at ${f.createdAt}.`, source:"trade-log" });
      }
    }
  }

  for (const p of positions || []) {
    if (p.status === "unsellable") {
      const expectedLocked = Math.max(0, num(p.entryNotionalUsd) - num(p.realizedCostUsd));
      const lockedDelta = Math.abs(expectedLocked - num(p.lockedCapitalLossUsd));
      if (num(p.markPrice) !== 0 || lockedDelta > 0.02) {
        emit({ kind:"UNSELLABLE_ACCOUNTING", key:`UNSELLABLE_ACCOUNTING:${p.id}`, severity:"critical", title:`Unsellable position accounting is inconsistent: $${p.symbol}`, evidence:`markPrice=${p.markPrice}; lockedCapitalLoss=${money(p.lockedCapitalLossUsd)}; expected locked cost=${money(expectedLocked)}.`, source:"positions" });
      }
    }
    if (p.status === "exit_pending") {
      const age = Date.now() - new Date(p.updatedAt || p.openedAt || 0).getTime();
      if (Number.isFinite(age) && age > 20 * 60 * 1000) {
        emit({ kind:"EXIT_PENDING_STUCK", key:`EXIT_PENDING_STUCK:${p.id}`, severity:"high", title:`Exit pending for more than 20 minutes: $${p.symbol}`, evidence:`Position ${p.id} has remained exit_pending for ${(age/60000).toFixed(1)} minutes.`, source:"positions" });
      }
    }
  }

  if (wallet?.storage === "memory") {
    emit({ kind:"VOLATILE_STORAGE", severity:"high", title:"Council wallet state is using process memory instead of durable Redis", evidence:"A process restart can lose live paper state and break audit continuity.", source:"autopilot" });
  }
  return seen;
}

function findFunctionBlock(src, name) {
  const idx = src.indexOf(`function ${name}(`) >= 0 ? src.indexOf(`function ${name}(`) : src.indexOf(`export function ${name}(`);
  const asyncIdx = src.indexOf(`async function ${name}(`) >= 0 ? src.indexOf(`async function ${name}(`) : src.indexOf(`export async function ${name}(`);
  let start = idx >= 0 ? idx : asyncIdx;
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0, quote = null, escp = false, template = false;
  for (let i=open;i<src.length;i++) {
    const c=src[i], prev=src[i-1];
    if (escp) { escp=false; continue; }
    if ((quote || template) && c === "\\") { escp=true; continue; }
    if (!template && (c === '"' || c === "'")) { if (quote === c) quote=null; else if (!quote) quote=c; continue; }
    if (!quote && c === '`') { template = !template; continue; }
    if (quote || template) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth===0) return src.slice(start, i+1); }
  }
  return null;
}

function baselineStaticAudit() {
  try {
    const AdmZip = require("adm-zip");
    if (!fs.existsSync(BASELINE_ZIP)) throw new Error("council-baseline.zip missing");
    const zip = new AdmZip(BASELINE_ZIP);
    const read = f => {
      const entry = zip.getEntry(`Bot-Council--main/${f}`) || zip.getEntry(f);
      return entry ? entry.getData().toString("utf8") : "";
    };
    const execution = read("execution.ts");
    const routes = read("route-feasibility.ts");
    const autopilot = read("autopilot.ts");
    const sellAudit = read("sellability-auditor.ts");

    if (/request\.chain !== "Solana" \|\| request\.side !== "BUY"/.test(routes) && /forcedPaperExit/.test(execution) && /grossFilledUsd/.test(execution)) {
      upsertFinding({
        kind:"STATIC_UNVERIFIED_SELL_CREDIT_PATH", severity:"critical", source:"baseline-code", title:"Verified code path can credit modeled SELL proceeds without a verified reverse route",
        evidence:"route-feasibility.ts only live-verifies Solana BUY routes, while execution.ts permits forced PAPER exits and computes proceeds from the liquidity model. This is an accounting/execution-verification weakness, not a Council strategy decision."
      });
    }
    if (/Pool data does not prove a token can be sold/.test(autopilot) && !/auditEntrySellability\s*\(/.test(autopilot) && /auditEntrySellability/.test(sellAudit)) {
      upsertFinding({
        kind:"STATIC_ENTRY_SELLABILITY_GAP", severity:"high", source:"baseline-code", title:"Entry pipeline verifies pool reserve but does not require an executable reverse sell route",
        evidence:"autopilot.ts explicitly records that liquidity-pool data does not prove sellability. sellability-auditor.ts contains an entry sellability verifier, but autopilot.ts does not call it before recording a PAPER buy."
      });
    }
    S.staticAuditComplete = true;
    activity("CODE AUDITOR", "Baseline Council source audit completed. Trading-strategy files remain protected.");
    save();
  } catch (e) {
    activity("CODE AUDITOR", `Baseline code audit unavailable: ${e instanceof Error ? e.message : String(e)}`, "high");
  }
}

function configuredBrains() {
  const defs = [
    ["gemini", process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || "gemini-2.5-flash"],
    ["groq", process.env.GROQ_API_KEY, process.env.GROQ_MODEL || "openai/gpt-oss-20b"],
    ["openrouter", process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_MODEL || "openrouter/free"],
    ["openai", process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL || process.env.HIVE_MODEL || "gpt-5-mini"],
  ];
  const order = String(process.env.HIVE_PROVIDER_ORDER || "gemini,groq,openrouter,openai").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  return order.map(name => { const row=defs.find(x=>x[0]===name); return row ? {name:row[0],key:row[1]||"",model:row[2]} : null; }).filter(Boolean);
}

async function callBrain(messages) {
  const errors = [];
  for (const b of configuredBrains().filter(x => x.key)) {
    try {
      let text = "";
      if (b.name === "gemini") {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(b.model)}:generateContent?key=${encodeURIComponent(b.key)}`;
        const r = await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:messages.system}]},contents:[{role:"user",parts:[{text:messages.user}]}],generationConfig:{temperature:0.1,maxOutputTokens:12000}}),signal:AbortSignal.timeout(60000)});
        const j=await r.json(); if(!r.ok) throw Error(j?.error?.message || `HTTP ${r.status}`);
        text=(j.candidates||[]).flatMap(c=>c?.content?.parts||[]).map(p=>p.text||"").join("");
      } else if (b.name === "groq" || b.name === "openrouter") {
        const url = b.name === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
        const headers={"content-type":"application/json","authorization":`Bearer ${b.key}`}; if(b.name==="openrouter") headers["X-Title"]="HIVE AUDITOR";
        const r=await fetch(url,{method:"POST",headers,body:JSON.stringify({model:b.model,messages:[{role:"system",content:messages.system},{role:"user",content:messages.user}],temperature:0.1,max_tokens:12000}),signal:AbortSignal.timeout(60000)});
        const j=await r.json(); if(!r.ok) throw Error(j?.error?.message || `HTTP ${r.status}`); text=j?.choices?.[0]?.message?.content||"";
      } else if (b.name === "openai") {
        const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${b.key}`},body:JSON.stringify({model:b.model,input:[{role:"system",content:[{type:"input_text",text:messages.system}]},{role:"user",content:[{type:"input_text",text:messages.user}]}],max_output_tokens:12000}),signal:AbortSignal.timeout(60000)});
        const j=await r.json(); if(!r.ok) throw Error(j?.error?.message || `HTTP ${r.status}`); text=j.output_text||""; if(!text&&Array.isArray(j.output))for(const item of j.output)for(const c of(item.content||[]))if(typeof c.text==="string")text+=c.text;
      }
      if (!text) throw Error("empty response");
      return { ok:true, provider:b.name, model:b.model, text };
    } catch(e) { errors.push(`${b.name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { ok:false, error: errors.length ? errors.join(" | ") : "No repair brain configured" };
}

function readBaseline(zip, file) {
  const entry = zip.getEntry(`Bot-Council--main/${file}`) || zip.getEntry(file);
  return entry ? entry.getData().toString("utf8") : null;
}

function excerpt(src, file, kind) {
  if (!src) return "";
  if (src.length <= 26000) return src;
  const needles = kind.includes("SELL") ? ["auditForLockedCapital", "executeFullExit", "executeTrim", "executePaper", "verifyPaperRoute", "applyPaperFillToWallet"] : kind.includes("ENTRY") || kind.includes("LIQUIDITY") ? ["executeRequest", "auditEntryLiquidity", "executePaper", "auditEntrySellability"] : ["calculateSnapshot", "applyPaperFillToWallet", "markUnsellable"];
  const parts=[];
  for (const n of needles) {
    const i=src.indexOf(n); if(i>=0) parts.push(src.slice(Math.max(0,i-3500), Math.min(src.length,i+8500)));
  }
  return parts.length ? [...new Set(parts)].join("\n\n/* --- EXCERPT BREAK --- */\n\n").slice(0,42000) : src.slice(0,26000);
}

function parseRepairJson(text) {
  const clean = String(text).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(clean); } catch {}
  const a=clean.indexOf("{"), b=clean.lastIndexOf("}");
  if(a>=0&&b>a) return JSON.parse(clean.slice(a,b+1));
  throw new Error("Repair brain did not return valid JSON");
}

function applyOperations(files, operations, allowed) {
  const changed = new Set();
  for (const op of operations || []) {
    if (!op || !allowed.includes(op.file)) throw new Error(`Disallowed repair file: ${op?.file}`);
    if (typeof op.search !== "string" || typeof op.replace !== "string" || !op.search.length) throw new Error(`Invalid search/replace operation for ${op.file}`);
    const src=files[op.file]; if(typeof src!=="string") throw new Error(`Baseline file missing: ${op.file}`);
    const first=src.indexOf(op.search), last=src.lastIndexOf(op.search);
    if(first<0) throw new Error(`Repair search text not found in ${op.file}`);
    if(first!==last) throw new Error(`Repair search text is not unique in ${op.file}`);
    files[op.file]=src.slice(0,first)+op.replace+src.slice(first+op.search.length);
    changed.add(op.file);
  }
  return [...changed];
}

function verifyProtectedSegments(before, after) {
  const guards = [
    ["execution.ts", "buildExecutionPlan"],
    ["position-manager.ts", "evaluatePosition"],
    ["autopilot.ts", "autoExecute"],
  ];
  for (const [file, fn] of guards) {
    if (!(file in before) || !(file in after)) continue;
    const a=findFunctionBlock(before[file],fn), b=findFunctionBlock(after[file],fn);
    if (a && b && hash(a)!==hash(b)) throw new Error(`Trading-behavior guard failed: ${file}::${fn} changed`);
  }
}

function verifyTypeScript(files, changed) {
  const ts = require("typescript");
  const errors=[];
  for (const file of changed.filter(x=>x.endsWith(".ts")||x.endsWith(".tsx"))) {
    const result=ts.transpileModule(files[file],{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true,fileName:file});
    for(const d of result.diagnostics||[]) if(d.category===ts.DiagnosticCategory.Error) errors.push(`${file}: ${ts.flattenDiagnosticMessageText(d.messageText," ")}`);
  }
  if(errors.length) throw new Error("TypeScript syntax validation failed: "+errors.slice(0,8).join(" | "));
}

async function buildRepair(finding) {
  if (S.repairBusy) return;
  const allowed=REPAIR_MAP[finding.kind]; if(!allowed) return;
  const brains=configuredBrains().filter(x=>x.key); if(!brains.length) { finding.repairStatus="waiting_for_brain"; save(); return; }
  if(!fs.existsSync(BASELINE_ZIP)) { finding.repairStatus="baseline_missing"; save(); return; }
  S.repairBusy=true; finding.repairStatus="investigating"; save();
  activity("REPAIR ENGINE", `Investigating ${finding.title}`);
  try {
    const AdmZip=require("adm-zip");
    const baseline=new AdmZip(BASELINE_ZIP);
    const before={};
    for(const file of allowed){ const x=readBaseline(baseline,file); if(x!=null) before[file]=x; }
    const fileContext=Object.entries(before).map(([f,src])=>`\n===== ${f} =====\n${excerpt(src,f,finding.kind)}`).join("\n");
    const system=`You are HIVE AUDITOR's repair engineer. Your job is infrastructure correctness only. You MUST NOT change the Council's trading strategy, Council votes, BUY/WATCH/SKIP logic, entry score thresholds, sizing rules, take-profit targets, trailing logic, stop rules, risk appetite, agent prompts, learning strategy, or which tokens the Council prefers. You may repair verification, liquidity/sellability evidence handling, accounting, persistence, stale-state handling, duplicate protection, and technical execution integrity. Preserve Council decisions: if a Council says BUY or EXIT, you may change whether the PAPER ledger is allowed to claim an executable fill when execution cannot be verified, but you may not change the Council's decision itself. Return JSON only with schema {"summary":"...","rationale":"...","operations":[{"file":"name.ts","search":"EXACT OLD TEXT","replace":"NEW TEXT"}],"tests":["..."]}. Use minimal exact search/replace operations. If a safe repair would require changing strategy, return {"summary":"No safe patch","rationale":"...","operations":[],"tests":[]}.`;
    const user=`VERIFIED FINDING\nKind: ${finding.kind}\nSeverity: ${finding.severity}\nTitle: ${finding.title}\nEvidence: ${finding.evidence}\n\nALLOWED FILES ONLY: ${allowed.join(", ")}\nPROTECTED STRATEGY FILES ARE OFF LIMITS: ${PROTECTED_FILES.join(", ")}\n\nSOURCE EXCERPTS:${fileContext}`;
    const brain=await callBrain({system,user});
    if(!brain.ok) throw new Error(brain.error);
    const plan=parseRepairJson(brain.text);
    if(!Array.isArray(plan.operations)||plan.operations.length===0){ finding.repairStatus="no_safe_patch"; finding.repairNote=plan.rationale||plan.summary||"No safe patch returned"; activity("REPAIR ENGINE", `No safe patch produced for ${finding.kind}`, "high"); return; }
    const after={...before};
    const changed=applyOperations(after,plan.operations,allowed);
    verifyProtectedSegments(before,after);
    verifyTypeScript(after,changed);

    // Create a full Council package from the exact baseline supplied by the owner.
    const outZip=new AdmZip(BASELINE_ZIP);
    for(const file of changed) outZip.updateFile(`Bot-Council--main/${file}`,Buffer.from(after[file],"utf8"));
    const updateId=`HIVE-${new Date().toISOString().replace(/[-:TZ.]/g,"").slice(0,14)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const manifest={
      updateId, createdAt:now(), finding:{id:finding.id,kind:finding.kind,severity:finding.severity,title:finding.title,evidence:finding.evidence},
      provider:brain.provider, model:brain.model, changedFiles:changed, protectedStrategyFiles:PROTECTED_FILES,
      strategyGuard:"PASS — protected strategy files were not modified; protected functions in mixed infrastructure files were hash-checked.",
      syntaxGuard:"PASS — changed TypeScript files parsed with TypeScript transpile diagnostics.",
      summary:plan.summary||finding.title, rationale:plan.rationale||"", suggestedTests:plan.tests||[],
      autoDeploy:false, note:"HIVE created this as a downloadable candidate update. It was not deployed to the live Council."
    };
    outZip.addFile("Bot-Council--main/HIVE_UPDATE_MANIFEST.json",Buffer.from(JSON.stringify(manifest,null,2)));
    outZip.addFile("Bot-Council--main/HIVE_AUDIT_UPDATE.md",Buffer.from(`# HIVE AUDITOR UPDATE\n\n${manifest.summary}\n\n## Verified issue\n${finding.evidence}\n\n## Repair rationale\n${manifest.rationale}\n\n## Changed files\n${changed.map(x=>`- ${x}`).join("\n")}\n\n## Safety boundary\nTrading-strategy files were not modified. Protected trading functions in mixed files were hash-checked. This package was generated as a candidate update and was not auto-deployed.\n`));
    const filename=`Bot-Council-${updateId}.zip`;
    const full=path.join(DATA_DIR,"updates",filename);
    outZip.writeZip(full);
    S.updates.unshift({id:updateId,createdAt:now(),filename,path:full,summary:manifest.summary,findingId:finding.id,findingKind:finding.kind,severity:finding.severity,provider:brain.provider,model:brain.model,changedFiles:changed,status:"ready"});
    S.updates=S.updates.slice(0,MAX_UPDATES);
    finding.repairStatus="update_ready"; finding.updateId=updateId;
    activity("REPAIR ENGINE", `UPDATE READY: ${updateId} · ${manifest.summary}`, "high");
  } catch(e) {
    finding.repairStatus="repair_failed"; finding.repairNote=e instanceof Error?e.message:String(e);
    activity("REPAIR ENGINE", `Repair failed for ${finding.kind}: ${finding.repairNote}`, "high");
  } finally { S.repairBusy=false; save(); }
}

async function maybeRepair() {
  if(!AUTO_REPAIR||S.repairBusy) return;
  const brains=configuredBrains().filter(x=>x.key); if(!brains.length) return;
  const nowMs=Date.now();
  const candidate=S.findings
    .filter(f=>f.status==="open"&&f.repairable&&["not_started","repair_failed","waiting_for_brain"].includes(f.repairStatus||"not_started"))
    .filter(f=>!f.lastRepairAttemptAt || nowMs-new Date(f.lastRepairAttemptAt).getTime()>=REPAIR_COOLDOWN_MS)
    .sort((a,b)=>severityRank[b.severity]-severityRank[a.severity] || new Date(a.detectedAt)-new Date(b.detectedAt))[0];
  if(!candidate) return;
  candidate.lastRepairAttemptAt=now(); save();
  await buildRepair(candidate);
}

async function scan() {
  if(scan.busy) return; scan.busy=true;
  try {
    const data=await collectLive();
    S.scans++;
    S.lastScanAt=now();
    S.targetOnline=Object.values(data.map).some(x=>x.ok);
    auditLiveData(data);
    const wallet=data.wallet||{};
    S.lastSnapshot={
      at:now(), cashUsd:num(wallet.cashUsd), equityUsd:num(wallet.equityUsd), totalPnlUsd:num(wallet.totalPnlUsd),
      realizedPnlUsd:num(wallet.realizedPnlUsd), unrealizedPnlUsd:num(wallet.unrealizedPnlUsd), openPositions:num(wallet.openPositions),
      unsellablePositions:num(wallet.unsellablePositions), lockedCapitalLossUsd:num(wallet.lockedCapitalLossUsd),
      fills:Array.isArray(data.fills)?data.fills.length:0, positions:Array.isArray(data.positions)?data.positions.length:0,
    };
    const crit=S.findings.filter(f=>f.status==="open"&&f.severity==="critical").length;
    activity("LIVE AUDITOR", `Scan ${S.scans}: ${data.positions.length} positions · ${data.fills.length} fills · ${crit} critical open finding${crit===1?"":"s"}.`);
    save();
    await maybeRepair();
  } catch(e) {
    activity("LIVE AUDITOR", `Scan failed: ${e instanceof Error?e.message:String(e)}`, "high");
    save();
  } finally { scan.busy=false; }
}
scan.busy=false;

function stateForClient() {
  return {
    ...S,
    repairBusy:Boolean(S.repairBusy),
    configuredBrains:configuredBrains().map(x=>({name:x.name,configured:Boolean(x.key),model:x.model})),
    dataPersistent:DATA_DIR.startsWith("/data/"),
    autoRepair:AUTO_REPAIR,
    strategyLock:{active:true,protectedFiles:PROTECTED_FILES},
  };
}

function html() {
  const open=S.findings.filter(f=>f.status==="open");
  const critical=open.filter(f=>f.severity==="critical");
  const ready=S.updates.filter(u=>u.status==="ready");
  const snap=S.lastSnapshot||{};
  const endpoints=Object.entries(S.endpoints).map(([k,v])=>`<div class="mini"><span>${esc(k)}</span><b class="${v.ok?"good":"bad"}">${v.ok?"LIVE":"DOWN"}</b><small>${v.ok?`${v.ms} ms`:esc(v.error||"error")}</small></div>`).join("");
  const findings=open.slice(0,35).map(f=>`<article class="finding ${esc(f.severity)}"><div class="row"><b>${esc(f.severity.toUpperCase())} · ${esc(f.title)}</b><span>${esc(f.source)}</span></div><p>${esc(f.evidence)}</p><small>Seen ${f.count||1}× · first ${esc(f.detectedAt)} · repair: ${esc(f.repairStatus||"not_started")}${f.updateId?` · ${esc(f.updateId)}`:""}</small></article>`).join("")||`<div class="empty">No open findings yet. HIVE is watching the live Council.</div>`;
  const updates=ready.slice(0,10).map(u=>`<article class="update"><div><b>${esc(u.id)}</b><p>${esc(u.summary)}</p><small>${esc(u.changedFiles.join(", "))} · ${esc(u.provider)}/${esc(u.model)}</small></div><a href="/download/${encodeURIComponent(u.id)}">DOWNLOAD UPDATE</a></article>`).join("")||`<div class="empty">No downloadable repair package is ready yet.</div>`;
  const brains=configuredBrains().map(b=>`<div class="mini"><span>${esc(b.name.toUpperCase())}</span><b class="${b.key?"good":"muted"}">${b.key?"READY":"OPTIONAL"}</b><small>${esc(b.model)}</small></div>`).join("");
  const acts=S.activity.slice(0,25).map(a=>`<div class="act"><time>${esc(new Date(a.at).toLocaleString())}</time><b>${esc(a.agent)}</b><span>${esc(a.text)}</span></div>`).join("");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>HIVE AUDITOR</title><style>
  *{box-sizing:border-box}body{margin:0;background:#050505;color:#f5f5f5;font-family:Inter,system-ui,-apple-system,sans-serif}.wrap{max-width:1180px;margin:auto;padding:18px}.hero{border:1px solid #252525;background:#0b0b0b;border-radius:22px;padding:24px;margin-bottom:14px}.eyebrow{font-size:11px;letter-spacing:.2em;color:#9b9b9b}.hero h1{margin:7px 0 3px;font-size:32px}.live{font-size:12px;color:${S.targetOnline?"#53f0a7":"#ff6b6b"}}.hero p{color:#aaa;max-width:780px;line-height:1.45}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0}.card,.sec{background:#0b0b0b;border:1px solid #222;border-radius:16px;padding:16px}.card span,.mini span,.card small,.mini small{display:block;color:#888;font-size:11px}.card b{font-size:25px;display:block;margin:4px 0}.sec{margin:12px 0}.sec h2{font-size:15px;letter-spacing:.08em;margin:0 0 12px}.mini-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.mini{border:1px solid #222;border-radius:12px;padding:10px;min-width:0}.mini b{display:block;font-size:12px;margin:5px 0}.mini small{overflow:hidden;text-overflow:ellipsis}.good{color:#53f0a7}.bad{color:#ff6b6b}.muted{color:#777}.lock{border:1px solid #23523f;background:#08150f}.lock b{color:#53f0a7}.finding{border:1px solid #252525;border-left-width:4px;border-radius:12px;padding:12px;margin:8px 0;background:#080808}.finding.critical{border-left-color:#ff4d4f}.finding.high{border-left-color:#ff9f43}.finding.medium{border-left-color:#ffd166}.finding p{color:#bbb;font-size:13px;line-height:1.45}.finding small{color:#777}.row{display:flex;justify-content:space-between;gap:12px}.row span{font-size:11px;color:#777}.update{display:flex;justify-content:space-between;gap:12px;align-items:center;border:1px solid #23523f;border-radius:12px;padding:13px;margin:8px 0;background:#07110c}.update p{margin:5px 0;color:#bbb}.update small{color:#777}.update a{background:#f5f5f5;color:#050505;text-decoration:none;padding:10px 13px;border-radius:10px;font-size:11px;font-weight:800;white-space:nowrap}.act{display:grid;grid-template-columns:150px 115px 1fr;gap:10px;border-bottom:1px solid #171717;padding:8px 0;font-size:12px}.act time{color:#666}.act b{color:#aaa}.act span{color:#ddd}.empty{color:#777;padding:16px;border:1px dashed #252525;border-radius:12px}.priority{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.priority div{border:1px solid #242424;border-radius:12px;padding:11px}.priority b{display:block;font-size:12px}.priority span{display:block;color:#8b8b8b;font-size:11px;margin-top:5px;line-height:1.35}@media(max-width:800px){.grid,.mini-grid,.priority{grid-template-columns:repeat(2,1fr)}.act{grid-template-columns:1fr}.row{display:block}.update{display:block}.update a{display:inline-block;margin-top:10px}}@media(max-width:470px){.grid{grid-template-columns:1fr 1fr}.mini-grid,.priority{grid-template-columns:1fr}.hero h1{font-size:27px}}
  </style></head><body><main class="wrap"><section class="hero"><div class="eyebrow">INDEPENDENT SYSTEMS AUDITOR · NO TRADING AUTHORITY</div><h1>HIVE AUDITOR <span class="live">● ${S.targetOnline?"MONITORING LIVE":"WAITING FOR LIVE FEED"}</span></h1><p>HIVE watches the Bot Council's live accounting, liquidity evidence, sell verification, persistence and background infrastructure. It may diagnose, code, test and package repairs. It cannot rewrite the Council's trading strategy or auto-deploy updates.</p><small>${esc(TARGET_URL)}</small></section>
  <section class="grid"><div class="card"><span>SCANS</span><b>${S.scans}</b><small>${esc(S.lastScanAt||"starting")}</small></div><div class="card"><span>OPEN FINDINGS</span><b>${open.length}</b><small>${critical.length} critical</small></div><div class="card"><span>LAST EQUITY</span><b>${money(snap.equityUsd)}</b><small>P/L ${money(snap.totalPnlUsd)}</small></div><div class="card"><span>UPDATES READY</span><b>${ready.length}</b><small>owner approval required</small></div></section>
  <section class="sec lock"><h2>STRATEGY LOCK · ACTIVE</h2><b>Trading decisions are off limits.</b><p>HIVE cannot change Council votes, BUY/WATCH/SKIP logic, sizing, entry score thresholds, take-profit targets, trailing rules, stop rules, risk appetite or learned trading strategy. Repairs are restricted to correctness and infrastructure.</p></section>
  <section class="sec"><h2>PRIORITY WATCH</h2><div class="priority"><div><b>ZERO-LIQUIDITY ENTRIES</b><span>Verify the exact entry pool and whether a PAPER buy was recorded without trustworthy executable liquidity.</span></div><div><b>FALSE / UNVERIFIED SALES</b><span>Never treat modeled proceeds as verified cash when no executable sell route was proven.</span></div><div><b>ACCOUNTING RECONCILIATION</b><span>Rebuild equity from cash + open marked positions and challenge every mismatch.</span></div><div><b>UNSELLABLE CAPITAL</b><span>Confirm locked capital is counted as loss and cannot masquerade as realized profit.</span></div></div></section>
  <section class="sec"><h2>LIVE AUDIT FEEDS</h2><div class="mini-grid">${endpoints}</div></section>
  <section class="sec"><h2>REPAIR BRAINS · OPTIONAL FOR MONITORING</h2><div class="mini-grid">${brains}</div><p style="color:#777;font-size:12px">Monitoring and deterministic audits do not require an AI API. A configured brain is only used when HIVE needs to develop a new code repair.</p></section>
  <section class="sec"><h2>OPEN FINDINGS</h2>${findings}</section>
  <section class="sec"><h2>UPDATE CENTER</h2>${updates}</section>
  <section class="sec"><h2>HIVE ACTIVITY</h2>${acts}</section>
  </main><script>setTimeout(()=>location.reload(),15000)</script></body></html>`;
}

function json(res, code, body) { const b=JSON.stringify(body); res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","content-length":Buffer.byteLength(b)}); res.end(b); }

const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,`http://${req.headers.host||"localhost"}`);
    if(u.pathname==="/"){ const b=html(); res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}); return res.end(b); }
    if(u.pathname==="/api/state") return json(res,200,stateForClient());
    if(u.pathname==="/api/scan" && (req.method==="POST"||req.method==="GET")){ await scan(); return json(res,200,{ok:true,scans:S.scans,lastScanAt:S.lastScanAt}); }
    if(u.pathname.startsWith("/download/")){
      const id=decodeURIComponent(u.pathname.slice("/download/".length)); const row=S.updates.find(x=>x.id===id&&x.status==="ready");
      if(!row||!row.path||!fs.existsSync(row.path)){res.writeHead(404);return res.end("Update not found");}
      res.writeHead(200,{"content-type":"application/zip","content-disposition":`attachment; filename="${path.basename(row.filename)}"`,"cache-control":"no-store"});
      return fs.createReadStream(row.path).pipe(res);
    }
    if(u.pathname==="/health") return json(res,200,{ok:true,version:S.version,targetOnline:S.targetOnline,lastScanAt:S.lastScanAt});
    res.writeHead(404);res.end("Not found");
  } catch(e){json(res,500,{error:e instanceof Error?e.message:String(e)});}
});

function selfTest() {
  const old=S; S=freshState();
  const fixture={map:{autopilot:{ok:true}},wallet:{storage:"redis"},proof:{reconciliation:{reportedEquityUsd:1700,independentlyReconstructedEquityUsd:1695,equityDeltaUsd:5,accountingVerified:false}},positions:[{id:"P1",symbol:"ZERO",chain:"Solana",tokenAddress:"T1",status:"unsellable",entryNotionalUsd:100,realizedCostUsd:0,lockedCapitalLossUsd:50,markPrice:2,entryContext:{snapshot:{liquidity:0,dataProvenance:{notes:[]}}},unsellableAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"}],fills:[{id:"B1",positionId:"P1",side:"BUY",symbol:"ZERO",filledUsd:100,createdAt:"2026-01-01T00:00:00Z"},{id:"S1",positionId:"P1",side:"SELL",symbol:"ZERO",filledUsd:80,routeVerified:false,routeProvider:"liquidity-model",createdAt:"2026-01-01T00:01:00Z"}]};
  auditLiveData(fixture);
  const kinds=new Set(S.findings.map(x=>x.kind));
  const need=["ACCOUNTING_MISMATCH","ZERO_LIQUIDITY_BUY","UNVERIFIED_SELL_CREDIT","UNSELLABLE_ACCOUNTING"];
  const missing=need.filter(x=>!kinds.has(x));
  S=old;
  if(missing.length) { console.error("SELF TEST FAIL",missing); process.exit(1); }
  console.log("HIVE AUDITOR SELF TEST: PASS",need.join(", ")); process.exit(0);
}

if(process.argv.includes("--self-test")) selfTest();
server.listen(PORT,()=>{
  console.log(`HIVE AUDITOR V1 listening on ${PORT}`);
  console.log(`Target Council: ${TARGET_URL}`);
  if(!S.staticAuditComplete) baselineStaticAudit();
  scan();
  setInterval(scan,POLL_MS);
});
