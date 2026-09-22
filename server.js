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
const MAX_LESSONS = 160;
const MAX_PROMPTS = 40;

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


const PROMPT_PROFILES = {
  UNVERIFIED_SELL_CREDIT: {
    label: "Stop unverified PAPER sales from becoming realized cash",
    suspectedRootCause: "The live ledger is crediting SELL proceeds when routeVerified is not true, including fills whose provider is liquidity-model. The infrastructure appears to be allowing modeled exit proceeds to reach cash/realized P&L without independently verified sell-route evidence.",
    goal: "Repair the SELL execution/accounting boundary so a Council EXIT decision can still exist, but the PAPER wallet cannot claim realized proceeds unless the existing sellability/route-verification infrastructure has actually verified an executable exit route.",
    acceptance: [
      "A SELL with routeVerified !== true must not increase cashUsd, realizedPnlUsd, realized proceeds, or verified sale totals.",
      "A liquidity-model price or modeled proceeds calculation alone must never qualify as proof of an executable SELL route.",
      "When an EXIT is requested but a route cannot be verified, preserve the Council's EXIT decision while recording the execution as blocked/pending/unsellable using existing infrastructure semantics instead of inventing realized cash.",
      "Successful SELL fills must persist routeVerified=true plus the provider/evidence used to verify the route.",
      "Cash + independently marked open value - locked/unsellable capital must reconcile to reported equity after the fix.",
      "Existing BUY/SELL/EXIT strategy decisions must remain byte-for-byte behaviorally equivalent for identical inputs; only execution verification and accounting may change."
    ],
    tests: [
      "Regression: routeVerified=false + filledUsd>0 must produce $0 newly realized cash/profit.",
      "Regression: routeVerified=true must preserve the existing successful SELL accounting path.",
      "Regression: provider=liquidity-model without independent route proof must not be treated as a verified sale.",
      "Regression: repeated processing of the same failed/blocked exit must not create duplicate cash or fills.",
      "Run the Council's existing paper-wallet/equity reconciliation checks before and after the patch."
    ]
  },
  ZERO_LIQUIDITY_BUY: {
    label: "Close the zero-liquidity PAPER fill verification gap",
    suspectedRootCause: "The live Council has recorded BUY fills whose entry snapshot has zero or invalid liquidity, which means execution/liquidity evidence is being accepted or bypassed incorrectly somewhere between the Council decision and PAPER fill/accounting.",
    goal: "Repair the execution verification layer so a Council BUY decision is preserved, but a PAPER fill is not credited when the existing infrastructure cannot verify usable liquidity/execution evidence.",
    acceptance: [
      "A recorded entry snapshot with zero, negative, invalid, or explicitly unavailable liquidity cannot become a successful PAPER BUY fill.",
      "Do not change which tokens the Council decides to BUY, WATCH, or SKIP.",
      "A failed execution-verification check must be recorded distinctly from a strategy rejection.",
      "No fake position value or realized/unrealized P&L may originate from an execution that never passed the existing liquidity/sellability evidence gates.",
      "Existing valid-liquid BUY behavior must remain unchanged."
    ],
    tests: [
      "Regression: zero-liquidity snapshot + BUY decision => no credited PAPER fill.",
      "Regression: valid liquidity + identical BUY decision => existing fill path still works.",
      "Regression: missing/invalid liquidity must fail closed rather than defaulting to tradable.",
      "Verify that the strategy decision record remains unchanged while the execution result changes only when verification fails."
    ]
  },
  ACCOUNTING_MISMATCH: {
    label: "Repair Council equity reconciliation",
    suspectedRootCause: "The proof feed reports a mismatch between reported equity and independently reconstructed equity, indicating that one or more cash, open-value, realized P/L, locked-capital, or state-persistence components are being double-counted, omitted, or valued inconsistently.",
    goal: "Make reported paper-wallet totals reconcile exactly to the independently reconstructable ledger without changing any trading decision or exit/entry policy.",
    acceptance: [
      "Reported equity must match independently reconstructed equity within $0.01.",
      "Realized P/L must be derived only from valid credited execution events.",
      "Unsellable/locked capital must not remain in positive liquid mark value.",
      "No open position may be counted twice across active/closed/unsellable state.",
      "Trading strategy and decision outputs must remain unchanged."
    ],
    tests: [
      "Reconcile cash, realized P/L, unrealized P/L, open marked value, unsellable/locked capital, and final equity from raw ledger rows.",
      "Run duplicate-fill/idempotency regression tests.",
      "Restart/reload persisted state and confirm the exact same reconstructed totals."
    ]
  },
  UNSELLABLE_ACCOUNTING: {
    label: "Make unsellable positions impossible to count as positive paper profit",
    suspectedRootCause: "The live position state contains unsellable positions whose mark/locked-capital treatment is inconsistent, which can inflate equity or profit even though the position cannot be exited.",
    goal: "Correct only the accounting/state representation of unsellable positions so blocked capital is treated consistently and cannot masquerade as liquid profit.",
    acceptance: [
      "Unsellable positions must not contribute positive liquid mark value after being classified unsellable.",
      "Locked-capital loss must reconcile to remaining unrecovered cost basis.",
      "A later verified executable SELL may move funds only through the normal verified execution path.",
      "Do not change the Council's exit strategy or the rule that caused it to request an exit."
    ],
    tests: [
      "Unsellable position with no verified exit => no positive liquid mark contribution.",
      "Locked-capital loss equals unrecovered cost basis within cents.",
      "Verified later recovery/SELL updates accounting exactly once."
    ]
  },
  EXIT_PENDING_STUCK: {
    label: "Repair stuck exit_pending infrastructure state",
    suspectedRootCause: "Positions are remaining in exit_pending beyond the expected execution lifecycle, suggesting stale-state, persistence, retry, or failure-transition handling is not completing.",
    goal: "Repair the technical state machine/retry bookkeeping so exit attempts resolve cleanly without changing why or when the Council decided to exit.",
    acceptance: [
      "No exit_pending position remains indefinitely because of stale technical state.",
      "Retries must be idempotent and may not duplicate fills or proceeds.",
      "Failure/unsellable outcomes must be explicit and auditable.",
      "Exit strategy rules and Council decisions remain unchanged."
    ],
    tests: [
      "Simulate route failure/timeouts and verify deterministic terminal/retry state.",
      "Repeat the same retry event and confirm no duplicate fill/cash mutation.",
      "Verify successful exit path is unchanged."
    ]
  }
};

function freshState() {
  return {
    version: "HIVE-AUDITOR-V1.2",
    startedAt: new Date().toISOString(),
    targetUrl: TARGET_URL,
    scans: 0,
    lastScanAt: null,
    targetOnline: false,
    endpoints: {},
    findings: [],
    activity: [],
    updates: [],
    updatePrompts: [],
    lastSnapshot: null,
    staticAuditComplete: false,
    repairBusy: false,
    learning: {
      initialized: false,
      lessons: [],
      seenFillIds: [],
      lastLedgerSignature: null,
      lastReconSignature: null,
      metrics: { fillsObserved: 0, buysObserved: 0, sellsObserved: 0, verifiedSells: 0, verifiedSellRate: 0, zeroLiquidityBuys: 0, unsellablePositions: 0, lockedCapitalLossUsd: 0, endpointCoverage: 0 },
    },
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


function ensureLearning() {
  if (!S.learning || typeof S.learning !== "object") S.learning = freshState().learning;
  if (!Array.isArray(S.learning.lessons)) S.learning.lessons = [];
  if (!Array.isArray(S.learning.seenFillIds)) S.learning.seenFillIds = [];
  if (!S.learning.metrics || typeof S.learning.metrics !== "object") S.learning.metrics = freshState().learning.metrics;
  return S.learning;
}

function learn(input) {
  const L = ensureLearning();
  const evidence = String(input.evidence || "");
  const key = input.key || `${input.kind || "OBSERVATION"}:${hash(`${input.title}|${evidence}`)}`;
  const existing = L.lessons.find(x => x.key === key);
  if (existing) {
    existing.lastSeenAt = now();
    existing.count = (existing.count || 1) + 1;
    existing.evidence = evidence;
    existing.confidence = input.confidence || existing.confidence || "observed";
    return existing;
  }
  const row = {
    id: `L-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    key,
    kind: input.kind || "OBSERVATION",
    title: String(input.title || "Council observation"),
    evidence,
    source: input.source || "live-council",
    confidence: input.confidence || "observed",
    firstSeenAt: now(),
    lastSeenAt: now(),
    count: 1,
  };
  L.lessons.unshift(row);
  L.lessons = L.lessons.slice(0, MAX_LESSONS);
  activity("LEARNING ENGINE", row.title);
  return row;
}

function deriveLearning(d) {
  const L = ensureLearning();
  const positions = Array.isArray(d.positions) ? d.positions : [];
  const fills = Array.isArray(d.fills) ? d.fills : [];
  const buys = fills.filter(f => String(f.side || "").toUpperCase() === "BUY");
  const sells = fills.filter(f => String(f.side || "").toUpperCase() === "SELL");
  const verifiedSells = sells.filter(f => f.routeVerified === true);
  const zeroLiquidityBuys = buys.filter(f => {
    const p = findPositionForFill(f, positions);
    const liq = p?.entryContext?.snapshot?.liquidity;
    return liq !== undefined && (!Number.isFinite(Number(liq)) || Number(liq) <= 0);
  });
  const unsellable = positions.filter(p => p.status === "unsellable");
  const lockedCapitalLossUsd = unsellable.reduce((a,p)=>a+num(p.lockedCapitalLossUsd),0);
  const endpointRows = Object.values(d.map || {});
  const endpointCoverage = endpointRows.length ? Math.round(endpointRows.filter(x=>x?.ok).length / endpointRows.length * 100) : 0;
  const verifiedSellRate = sells.length ? Math.round(verifiedSells.length / sells.length * 1000) / 10 : 100;

  L.metrics = {
    fillsObserved: fills.length,
    buysObserved: buys.length,
    sellsObserved: sells.length,
    verifiedSells: verifiedSells.length,
    verifiedSellRate,
    zeroLiquidityBuys: zeroLiquidityBuys.length,
    unsellablePositions: unsellable.length,
    lockedCapitalLossUsd,
    endpointCoverage,
  };

  const ledgerSig = hash(JSON.stringify([fills.length, buys.length, sells.length, verifiedSells.length, zeroLiquidityBuys.length, unsellable.length, Math.round(lockedCapitalLossUsd*100)]));
  if (ledgerSig !== L.lastLedgerSignature) {
    learn({
      key:`LEDGER_SNAPSHOT:${ledgerSig}`,
      kind:"LEDGER_SNAPSHOT",
      title:`Council ledger learned: ${fills.length} fills observed`,
      evidence:`${buys.length} BUY fills · ${sells.length} SELL fills · ${verifiedSells.length}/${sells.length || 0} SELL routes verified · ${zeroLiquidityBuys.length} zero-liquidity BUY records · ${unsellable.length} unsellable positions · ${money(lockedCapitalLossUsd)} locked-capital loss.`,
      confidence:"measured",
      source:"trade-log + positions"
    });
    L.lastLedgerSignature = ledgerSig;
  }

  if (d.proof?.reconciliation) {
    const r=d.proof.reconciliation;
    const sig=hash(JSON.stringify([num(r.reportedEquityUsd),num(r.independentlyReconstructedEquityUsd),num(r.equityDeltaUsd),r.accountingVerified]));
    if(sig!==L.lastReconSignature){
      const ok=Math.abs(num(r.equityDeltaUsd))<=0.01 && r.accountingVerified!==false;
      learn({
        key:`RECON:${sig}`,
        kind:ok?"VERIFIED_ACCOUNTING":"ACCOUNTING_WEAKNESS",
        title:ok?"Latest Council equity reconciles":"HIVE learned that reported equity does not reconcile",
        evidence:`Reported ${money(r.reportedEquityUsd)} · independently reconstructed ${money(r.independentlyReconstructedEquityUsd)} · delta ${money(r.equityDeltaUsd)} · accountingVerified=${String(r.accountingVerified)}.`,
        confidence:"verified",
        source:"proof-cabinet"
      });
      L.lastReconSignature=sig;
    }
  }

  if (zeroLiquidityBuys.length) {
    learn({
      key:"PATTERN:ZERO_LIQUIDITY_BUYS",
      kind:"WEAK_POINT",
      title:"Zero-liquidity entry protection has been bypassed in live records",
      evidence:`HIVE currently sees ${zeroLiquidityBuys.length} BUY fill${zeroLiquidityBuys.length===1?"":"s"} whose recorded entry snapshot has zero or invalid liquidity. This is treated as an infrastructure weakness to trace, not a strategy change.`,
      confidence:"verified",
      source:"entry snapshots"
    });
  }

  if (sells.length && verifiedSells.length < sells.length) {
    learn({
      key:"PATTERN:UNVERIFIED_SELLS",
      kind:"WEAK_POINT",
      title:"Not every credited SELL has independent route verification",
      evidence:`Verified SELL coverage is ${verifiedSellRate.toFixed(1)}% (${verifiedSells.length}/${sells.length}). HIVE will trace any credited sale that lacks routeVerified=true so modeled proceeds cannot masquerade as verified cash.`,
      confidence:"verified",
      source:"trade-log"
    });
  }

  if (unsellable.length) {
    learn({
      key:"PATTERN:UNSELLABLE_CAPITAL",
      kind:"ACCOUNTING_LESSON",
      title:"Unsellable capital is being tracked as a separate audit class",
      evidence:`${unsellable.length} unsellable position${unsellable.length===1?" is":"s are"} currently visible with ${money(lockedCapitalLossUsd)} total locked-capital loss. HIVE checks that this cannot inflate realized profit or equity.`,
      confidence:"measured",
      source:"positions"
    });
  }

  const currentIds = fills.map(f=>String(f.id||"")).filter(Boolean);
  const seen = new Set(L.seenFillIds);
  if (!L.initialized) {
    L.seenFillIds = currentIds.slice(-1500);
    L.initialized = true;
    learn({
      key:"BASELINE:LIVE_COUNCIL_CONNECTED",
      kind:"BASELINE",
      title:"Live Bot Council baseline captured",
      evidence:`HIVE connected to ${endpointCoverage}% of configured read-only audit feeds and established a baseline of ${fills.length} fills and ${positions.length} positions. New changes will now be learned incrementally.`,
      confidence:"measured",
      source:"live-council"
    });
  } else {
    const newFills = fills.filter(f=>f.id && !seen.has(String(f.id))).slice(-20);
    for (const f of newFills) {
      const p=findPositionForFill(f,positions);
      const side=String(f.side||"").toUpperCase();
      const route = side === "SELL" ? ` · route verified: ${String(f.routeVerified===true)}` : "";
      learn({
        key:`FILL:${f.id}`,
        kind:"NEW_COUNCIL_EVENT",
        title:`New Council ${side || "FILL"} observed: $${f.symbol || p?.symbol || "UNKNOWN"}`,
        evidence:`Fill ${f.id} · ${money(f.filledUsd)}${route} · ${f.createdAt || "time unavailable"}.`,
        confidence:"observed",
        source:"trade-log"
      });
    }
    L.seenFillIds = [...new Set([...L.seenFillIds, ...currentIds])].slice(-1500);
  }
}


function baselineFingerprint() {
  try { return fs.existsSync(BASELINE_ZIP) ? hash(fs.readFileSync(BASELINE_ZIP)).slice(0,16) : "baseline-unavailable"; }
  catch { return "baseline-unavailable"; }
}

function promptIdFor(kind) { return `PROMPT-${String(kind).replace(/[^A-Z0-9_]/gi,"-")}`; }

function buildUpdatePrompt(kind, findings) {
  const profile = PROMPT_PROFILES[kind];
  if (!profile || !findings.length) return null;
  const distinctIncidents = findings.length;
  const repeatedObservations = findings.reduce((n,f)=>n+num(f.count,1),0);
  const firstSeen = findings.map(f=>new Date(f.detectedAt||0).getTime()).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  const lastSeen = findings.map(f=>new Date(f.lastSeenAt||f.detectedAt||0).getTime()).filter(Number.isFinite).sort((a,b)=>b-a)[0];
  const evidence = findings.slice(0,12).map((f,i)=>`${i+1}. ${f.title}\n   ${f.evidence}\n   source=${f.source} · first=${f.detectedAt} · last=${f.lastSeenAt} · seen=${f.count||1}x`).join("\n");
  const allowed = REPAIR_MAP[kind] || [];
  const acceptance = profile.acceptance.map((x,i)=>`${i+1}. ${x}`).join("\n");
  const tests = profile.tests.map((x,i)=>`${i+1}. ${x}`).join("\n");
  const prompt = `UPDATE THE ATTACHED CURRENT BOT COUNCIL BUILD\n\nYou are updating the owner's CURRENT Bot Council package using a verified HIVE Auditor infrastructure finding. Treat the attached Council ZIP as the source of truth for the code you edit. The live deployment HIVE monitored is ${TARGET_URL}.\n\nHIVE AUDITOR FINDING\nKind: ${kind}\nRecommendation: ${profile.label}\nSeverity: ${findings[0].severity}\nDistinct live incidents currently open: ${distinctIncidents}\nRepeated scan observations: ${repeatedObservations}\nFirst observed: ${firstSeen ? new Date(firstSeen).toISOString() : "unknown"}\nLast observed: ${lastSeen ? new Date(lastSeen).toISOString() : "unknown"}\nAuditor baseline fingerprint: ${baselineFingerprint()}\n\nWHAT HIVE VERIFIED LIVE\n${evidence}\n\nHIVE'S CURRENT ROOT-CAUSE HYPOTHESIS\n${profile.suspectedRootCause}\n\nREQUIRED REPAIR\n${profile.goal}\n\nLIKELY INFRASTRUCTURE FILES TO INSPECT\n${allowed.length ? allowed.map(x=>`- ${x}`).join("\n") : "- Trace the relevant infrastructure path in the attached current build."}\n\nHARD STRATEGY LOCK — DO NOT CHANGE ANY OF THIS\n- Council votes or agent opinions\n- token selection or opportunity ranking\n- BUY / WATCH / SKIP decisions\n- entry thresholds or scoring\n- position sizing\n- take-profit targets\n- trailing logic\n- stop rules\n- exit strategy / reason for exiting\n- risk appetite\n- agent prompts or learned trading behavior\n\nThe purpose of this update is ONLY to repair infrastructure correctness, execution verification, accounting, persistence, idempotency, or state handling. A Council BUY/EXIT decision may remain exactly the same while the execution/accounting layer refuses to claim a fill or proceeds that cannot be verified.\n\nACCEPTANCE CRITERIA\n${acceptance}\n\nREGRESSION TESTS THAT MUST PASS\n${tests}\n\nIMPLEMENTATION REQUIREMENTS\n1. Inspect the attached current build before editing; do not assume HIVE's baseline is still identical to the current package.\n2. Trace the actual root cause in the current code and explain it before changing anything.\n3. Make the smallest safe fix that solves the verified infrastructure issue.\n4. Preserve all unrelated working functionality.\n5. Do not create fake paper profit, fake realized proceeds, or fake execution evidence.\n6. Add or update regression tests where possible.\n7. Verify the project still builds/parses and that protected trading behavior is unchanged for identical inputs.\n8. Return ONE clean downloadable Bot Council ZIP/folder as the new candidate base, plus a short changelog listing root cause, changed files, tests run, and results.\n9. Do not auto-deploy or connect private keys.\n\nIf the evidence points to a different technical root cause than HIVE's hypothesis, fix the proven root cause instead — but stay inside the hard strategy lock.`;
  return {
    id: promptIdFor(kind), kind, title: profile.label, severity: findings[0].severity,
    distinctIncidents, repeatedObservations,
    firstSeenAt: firstSeen ? new Date(firstSeen).toISOString() : null,
    lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    generatedAt: now(), baselineFingerprint: baselineFingerprint(), prompt,
    evidencePreview: findings.slice(0,4).map(f=>f.evidence),
    status: "ready"
  };
}

function refreshUpdatePrompts() {
  if (!Array.isArray(S.updatePrompts)) S.updatePrompts = [];
  const groups = new Map();
  for (const f of S.findings.filter(x=>x.status==="open" && PROMPT_PROFILES[x.kind])) {
    if (!groups.has(f.kind)) groups.set(f.kind, []);
    groups.get(f.kind).push(f);
  }
  const next=[];
  for (const [kind, rows] of groups.entries()) {
    rows.sort((a,b)=>severityRank[b.severity]-severityRank[a.severity] || new Date(b.lastSeenAt)-new Date(a.lastSeenAt));
    const built=buildUpdatePrompt(kind,rows);
    if (built) next.push(built);
  }
  next.sort((a,b)=>severityRank[b.severity]-severityRank[a.severity] || b.distinctIncidents-a.distinctIncidents || new Date(b.lastSeenAt)-new Date(a.lastSeenAt));
  S.updatePrompts=next.slice(0,MAX_PROMPTS);
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
    deriveLearning(data);
    refreshUpdatePrompts();
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
    updatePromptCount:Array.isArray(S.updatePrompts)?S.updatePrompts.length:0,
    strategyLock:{active:true,protectedFiles:PROTECTED_FILES},
  };
}

function html() {
  const open=S.findings.filter(f=>f.status==="open");
  const critical=open.filter(f=>f.severity==="critical");
  const ready=S.updates.filter(u=>u.status==="ready");
  const prompts=Array.isArray(S.updatePrompts)?S.updatePrompts.filter(x=>x.status==="ready"):[];
  const snap=S.lastSnapshot||{};
  const L=ensureLearning();
  const m=L.metrics||{};
  const endpoints=Object.entries(S.endpoints).map(([k,v])=>`<div class="mini"><span>${esc(k)}</span><b class="${v.ok?"good":"bad"}">${v.ok?"LIVE":"DOWN"}</b><small>${v.ok?`${v.ms} ms`:esc(v.error||"error")}</small></div>`).join("");
  const findings=open.slice(0,28).map(f=>`<article class="finding ${esc(f.severity)}"><div class="row"><b>${esc(f.severity.toUpperCase())} · ${esc(f.title)}</b><span>${esc(f.source)}</span></div><p>${esc(f.evidence)}</p><small>Seen ${f.count||1}× · first ${esc(f.detectedAt)} · repair: ${esc(f.repairStatus||"not_started")}${f.updateId?` · ${esc(f.updateId)}`:""}</small></article>`).join("")||`<div class="empty">No open findings yet. HIVE is watching the live Council.</div>`;
  const updates=ready.slice(0,10).map(u=>`<article class="update"><div><b>${esc(u.id)}</b><p>${esc(u.summary)}</p><small>${esc(u.changedFiles.join(", "))} · ${esc(u.provider)}/${esc(u.model)}</small></div><a href="/download/${encodeURIComponent(u.id)}">DOWNLOAD UPDATE</a></article>`).join("")||`<div class="empty">No downloadable repair package is ready yet.</div>`;
  const promptCards=prompts.slice(0,10).map(p=>`<article class="prompt-card"><div class="prompt-main"><div class="prompt-top"><b>${esc(p.severity.toUpperCase())} · ${esc(p.title)}</b><span>${p.distinctIncidents} LIVE INCIDENT${p.distinctIncidents===1?"":"S"}</span></div><p>${esc(p.evidencePreview?.[0]||"")}</p><small>${esc(p.kind)} · generated ${esc(new Date(p.generatedAt).toLocaleString())} · baseline ${esc(p.baselineFingerprint)}</small></div><div class="prompt-actions"><button onclick="copyPrompt('${encodeURIComponent(p.id)}',this)">COPY PROMPT</button><a href="/prompt/${encodeURIComponent(p.id)}?download=1">DOWNLOAD .TXT</a></div></article>`).join("")||`<div class="empty">No update prompt is ready yet. HIVE creates one automatically when a repairable live weakness is verified.</div>`;

  const brains=configuredBrains().map(b=>`<div class="mini"><span>${esc(b.name.toUpperCase())}</span><b class="${b.key?"good":"muted"}">${b.key?"READY":"OPTIONAL"}</b><small>${esc(b.model)}</small></div>`).join("");
  const acts=S.activity.slice(0,22).map(a=>`<div class="act"><time>${esc(new Date(a.at).toLocaleString())}</time><b>${esc(a.agent)}</b><span>${esc(a.text)}</span></div>`).join("");
  const lessons=L.lessons.slice(0,18).map((x,i)=>`<article class="lesson"><div class="lesson-num">${String(i+1).padStart(2,"0")}</div><div><div class="lesson-head"><b>${esc(x.title)}</b><span>${esc(String(x.confidence||"observed").toUpperCase())}</span></div><p>${esc(x.evidence)}</p><small>${esc(x.source)} · learned ${esc(new Date(x.firstSeenAt).toLocaleString())}${x.count>1?` · reconfirmed ${x.count}×`:""}</small></div></article>`).join("")||`<div class="empty">HIVE is connected and waiting for enough live Council evidence to form its first learning record.</div>`;
  const studies=[
    ["01","ZERO-LIQUIDITY BUY PATH","Trace exactly where recorded liquidity becomes zero/invalid and why the infrastructure still permits a PAPER fill."],
    ["02","SELL PROOF VS. MODELED PROCEEDS","Separate an actual verified exit route from a price model so fake PAPER cash cannot be credited."],
    ["03","EQUITY RECONCILIATION","Rebuild cash + marked open value − locked capital independently and compare it with every reported total."],
    ["04","UNSELLABLE STATE","Verify that blocked exits become losses/locked capital and never remain positive marked profit."],
  ].map(x=>`<div class="study"><span>${x[0]}</span><b>${x[1]}</b><p>${x[2]}</p></div>`).join("");
  const verifiedRate=Number.isFinite(Number(m.verifiedSellRate))?Number(m.verifiedSellRate):0;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>HIVE AUDITOR</title><style>
  *{box-sizing:border-box}html{background:#030303}body{margin:0;background:#030303;color:#f4f4f2;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1240px;margin:auto;padding:22px 20px 48px}.top{display:flex;justify-content:space-between;align-items:center;padding:3px 1px 18px}.brand{font-weight:900;letter-spacing:.16em;font-size:15px}.pill{border:1px solid #2b2b2b;border-radius:999px;padding:7px 10px;font-size:10px;letter-spacing:.08em}.pill.live{color:#69efae}.pill.off{color:#ff7777}.hero{padding:34px 0 22px;border-top:1px solid #151515}.hero .kicker{font-size:11px;color:#808080;letter-spacing:.2em}.hero h1{font-size:clamp(42px,7vw,78px);letter-spacing:-.055em;line-height:.88;margin:15px 0 18px;max-width:880px}.hero h1 em{font-style:normal;color:#8a8a8a}.hero p{color:#999;max-width:790px;font-size:15px;line-height:1.55;margin:0}.target{margin-top:18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#777}.metric-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:22px 0}.metric{border:1px solid #202020;background:#080808;border-radius:14px;padding:14px;min-height:90px}.metric span{display:block;color:#6f6f6f;font-size:10px;letter-spacing:.08em}.metric b{display:block;font-size:24px;margin:8px 0 3px;letter-spacing:-.04em}.metric small{color:#777;font-size:10px}.sec{border-top:1px solid #191919;padding:27px 0}.sec-title{display:flex;justify-content:space-between;gap:12px;align-items:end;margin-bottom:14px}.sec h2{margin:0;font-size:18px;letter-spacing:-.02em}.sec-title p{margin:0;color:#666;font-size:11px;text-align:right}.learning-banner{border:1px solid #223e31;background:#07110c;border-radius:16px;padding:15px 16px;margin-bottom:12px;color:#a7d7bd;font-size:12px;line-height:1.5}.lesson{display:grid;grid-template-columns:42px 1fr;gap:12px;border-bottom:1px solid #151515;padding:14px 0}.lesson-num{color:#494949;font:700 11px ui-monospace,monospace;padding-top:3px}.lesson-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.lesson-head b{font-size:13px}.lesson-head span{font-size:9px;letter-spacing:.1em;color:#70dca4;border:1px solid #24523b;border-radius:999px;padding:4px 6px}.lesson p{color:#a6a6a6;font-size:12px;line-height:1.5;margin:6px 0}.lesson small{color:#595959;font-size:10px}.study-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.study{border:1px solid #1f1f1f;background:#070707;border-radius:14px;padding:14px}.study span{color:#505050;font:700 10px ui-monospace,monospace}.study b{display:block;margin:14px 0 6px;font-size:11px;letter-spacing:.04em}.study p{color:#777;font-size:11px;line-height:1.45;margin:0}.mini-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.mini{border:1px solid #1f1f1f;border-radius:12px;padding:11px;min-width:0}.mini span,.mini small{display:block;color:#686868;font-size:10px}.mini b{display:block;font-size:11px;margin:6px 0}.good{color:#65e9a6}.bad{color:#ff7272}.muted{color:#666}.lock{border:1px solid #223e31;background:#06100b;border-radius:14px;padding:14px}.lock b{color:#66e8a6;font-size:12px}.lock p{color:#789285;font-size:11px;line-height:1.5;margin:6px 0 0}.finding{border:1px solid #1d1d1d;border-left-width:3px;border-radius:11px;padding:12px;margin:7px 0;background:#060606}.finding.critical{border-left-color:#ff5558}.finding.high{border-left-color:#f6a648}.finding.medium{border-left-color:#e8cc6a}.finding p{color:#999;font-size:11px;line-height:1.5}.finding small{color:#555;font-size:10px}.row{display:flex;justify-content:space-between;gap:12px}.row b{font-size:11px}.row span{font-size:9px;color:#5e5e5e}.update{display:flex;justify-content:space-between;gap:12px;align-items:center;border:1px solid #244635;border-radius:12px;padding:13px;margin:7px 0;background:#06100b}.update p{margin:5px 0;color:#999;font-size:11px}.update small{color:#5f6f66;font-size:9px}.update a{background:#f1f1ed;color:#050505;text-decoration:none;padding:10px 13px;border-radius:9px;font-size:10px;font-weight:900;white-space:nowrap}.prompt-card{display:flex;justify-content:space-between;gap:14px;align-items:center;border:1px solid #3b2f1b;border-radius:12px;padding:14px;margin:8px 0;background:#100b04}.prompt-main{min-width:0}.prompt-top{display:flex;justify-content:space-between;gap:12px;align-items:center}.prompt-top b{font-size:12px}.prompt-top span{font-size:9px;letter-spacing:.08em;color:#ffc766;border:1px solid #59411f;border-radius:999px;padding:4px 7px;white-space:nowrap}.prompt-card p{margin:7px 0;color:#aaa;font-size:11px;line-height:1.45}.prompt-card small{color:#6c604c;font-size:9px}.prompt-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.prompt-actions button,.prompt-actions a{border:0;background:#f1f1ed;color:#050505;text-decoration:none;padding:10px 12px;border-radius:9px;font-size:10px;font-weight:900;white-space:nowrap;cursor:pointer}.prompt-actions a{background:#211a10;color:#f2d99b;border:1px solid #4b3b21}.act{display:grid;grid-template-columns:145px 115px 1fr;gap:10px;border-bottom:1px solid #121212;padding:8px 0;font-size:10px}.act time{color:#4e4e4e}.act b{color:#777}.act span{color:#aaa}.empty{color:#606060;padding:15px;border:1px dashed #202020;border-radius:11px;font-size:11px}.two{display:grid;grid-template-columns:1.2fr .8fr;gap:18px}@media(max-width:950px){.metric-grid{grid-template-columns:repeat(3,1fr)}.study-grid{grid-template-columns:repeat(2,1fr)}.two{grid-template-columns:1fr}.mini-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:620px){.wrap{padding:16px 14px 38px}.metric-grid{grid-template-columns:repeat(2,1fr)}.study-grid,.mini-grid{grid-template-columns:1fr 1fr}.hero h1{font-size:48px}.sec-title{display:block}.sec-title p{text-align:left;margin-top:5px}.act{grid-template-columns:1fr}.row{display:block}.update{display:block}.update a{display:inline-block;margin-top:10px}.prompt-card{display:block}.prompt-actions{justify-content:flex-start;margin-top:10px}.prompt-top{display:block}.prompt-top span{display:inline-block;margin-top:7px}}@media(max-width:420px){.study-grid,.mini-grid{grid-template-columns:1fr}.hero h1{font-size:43px}}
  </style></head><body><main class="wrap"><header class="top"><div class="brand">HIVE AUDITOR</div><div class="pill ${S.targetOnline?"live":"off"}">● ${S.targetOnline?"LEARNING LIVE":"WAITING FOR COUNCIL"}</div></header>
  <section class="hero"><div class="kicker">INDEPENDENT AUDITOR · REPAIR ENGINEER · NO TRADING AUTHORITY</div><h1>WATCH THE COUNCIL.<br><em>LEARN WHAT BREAKS.</em></h1><p>HIVE continuously reads the live Bot Council, learns how its accounting and execution infrastructure behave, verifies weak points, traces root causes, and packages technical repairs without changing a single trading decision.</p><div class="target">LIVE SOURCE · ${esc(TARGET_URL)}</div></section>
  <section class="metric-grid"><div class="metric"><span>LIVE SCANS</span><b>${S.scans}</b><small>${esc(S.lastScanAt||"starting")}</small></div><div class="metric"><span>FILLS LEARNED</span><b>${num(m.fillsObserved)}</b><small>${num(m.buysObserved)} buys · ${num(m.sellsObserved)} sells</small></div><div class="metric"><span>SELL PROOF RATE</span><b>${verifiedRate.toFixed(1)}%</b><small>${num(m.verifiedSells)}/${num(m.sellsObserved)} verified</small></div><div class="metric"><span>OPEN FINDINGS</span><b>${open.length}</b><small>${critical.length} critical</small></div><div class="metric"><span>LESSONS FILED</span><b>${L.lessons.length}</b><small>persistent audit memory</small></div><div class="metric"><span>UPDATE PROMPTS</span><b>${prompts.length}</b><small>copy-ready for current build</small></div></section>
  <section class="sec"><div class="sec-title"><div><h2>WHAT HIVE IS LEARNING FROM BOT COUNCIL</h2></div><p>Evidence from live trades, positions, reconciliation and proof feeds.</p></div><div class="learning-banner">HIVE does not learn trading strategy here. It learns whether the infrastructure underneath the Council is truthful: whether BUY liquidity was real, SELL proceeds were verifiable, equity reconciles, and unsellable capital is accounted for correctly.</div>${lessons}</section>
  <section class="sec"><div class="sec-title"><h2>WHAT HIVE IS STUDYING RIGHT NOW</h2><p>Current audit mission.</p></div><div class="study-grid">${studies}</div></section>
  <section class="sec"><div class="lock"><b>STRATEGY LOCK · ACTIVE</b><p>HIVE cannot alter Council votes, token selection, BUY/WATCH/SKIP logic, entry thresholds, sizing, profit targets, trailing logic, stop rules, risk appetite, agent prompts or learned trading strategy. Any repair that changes those areas fails the guard.</p></div></section>
  <div class="two"><div><section class="sec"><div class="sec-title"><h2>VERIFIED WEAK POINTS</h2><p>Problems HIVE can prove.</p></div>${findings}</section><section class="sec"><div class="sec-title"><h2>UPDATE PROMPTS</h2><p>HIVE turns verified live weaknesses into copy-ready repair instructions for the current Council build.</p></div><div class="learning-banner">Use <b>COPY PROMPT</b>, attach your latest Bot Council ZIP, and paste the prompt into ChatGPT. HIVE includes live evidence, suspected root cause, protected trading boundaries, acceptance criteria, and regression tests.</div>${promptCards}</section><section class="sec"><div class="sec-title"><h2>UPDATE CENTER</h2><p>Optional AI-built candidate repair packages.</p></div>${updates}</section></div><div><section class="sec"><div class="sec-title"><h2>LIVE COUNCIL FEEDS</h2><p>${num(m.endpointCoverage)}% coverage</p></div><div class="mini-grid">${endpoints}</div></section><section class="sec"><div class="sec-title"><h2>REPAIR BRAINS</h2><p>Optional for code generation.</p></div><div class="mini-grid">${brains}</div></section></div></div>
  <section class="sec"><div class="sec-title"><h2>HIVE ACTIVITY</h2><p>Audit and learning events.</p></div>${acts}</section>
  </main><script>
  async function copyPrompt(id,btn){
    try{
      const r=await fetch('/api/prompt/'+id,{cache:'no-store'}); const j=await r.json();
      if(!r.ok||!j.prompt) throw new Error(j.error||'prompt unavailable');
      await navigator.clipboard.writeText(j.prompt);
      const old=btn.textContent; btn.textContent='COPIED'; setTimeout(()=>btn.textContent=old,1800);
    }catch(e){ alert('Could not copy prompt: '+e.message); }
  }
  setTimeout(()=>location.reload(),15000)
  </script></body></html>`;
}

function json(res, code, body) { const b=JSON.stringify(body); res.writeHead(code,{"content-type":"application/json","cache-control":"no-store","content-length":Buffer.byteLength(b)}); res.end(b); }

const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,`http://${req.headers.host||"localhost"}`);
    if(u.pathname==="/"){ const b=html(); res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}); return res.end(b); }
    if(u.pathname==="/api/state") return json(res,200,stateForClient());
    if(u.pathname==="/api/learning") { const L=ensureLearning(); return json(res,200,{ok:true,metrics:L.metrics,lessons:L.lessons,lastScanAt:S.lastScanAt,targetOnline:S.targetOnline}); }
    if(u.pathname==="/api/scan" && (req.method==="POST"||req.method==="GET")){ await scan(); return json(res,200,{ok:true,scans:S.scans,lastScanAt:S.lastScanAt}); }
    if(u.pathname.startsWith("/api/prompt/")) {
      const id=decodeURIComponent(u.pathname.slice("/api/prompt/".length));
      const row=(S.updatePrompts||[]).find(x=>x.id===id&&x.status==="ready");
      if(!row) return json(res,404,{error:"Prompt not found"});
      return json(res,200,{ok:true,id:row.id,kind:row.kind,title:row.title,generatedAt:row.generatedAt,prompt:row.prompt});
    }
    if(u.pathname.startsWith("/prompt/")) {
      const id=decodeURIComponent(u.pathname.slice("/prompt/".length));
      const row=(S.updatePrompts||[]).find(x=>x.id===id&&x.status==="ready");
      if(!row){res.writeHead(404);return res.end("Prompt not found");}
      const body=row.prompt;
      const headers={"content-type":"text/plain; charset=utf-8","cache-control":"no-store"};
      if(u.searchParams.get("download")==="1") headers["content-disposition"]=`attachment; filename="${row.id}.txt"`;
      res.writeHead(200,headers);return res.end(body);
    }
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
  deriveLearning(fixture);
  refreshUpdatePrompts();
  const kinds=new Set(S.findings.map(x=>x.kind));
  const need=["ACCOUNTING_MISMATCH","ZERO_LIQUIDITY_BUY","UNVERIFIED_SELL_CREDIT","UNSELLABLE_ACCOUNTING"];
  const missing=need.filter(x=>!kinds.has(x));
  const lessonCount=S.learning?.lessons?.length||0;
  const sellPrompt=(S.updatePrompts||[]).find(x=>x.kind==="UNVERIFIED_SELL_CREDIT");
  const promptOk=Boolean(sellPrompt && /CURRENT Bot Council package/i.test(sellPrompt.prompt) && /routeVerified/i.test(sellPrompt.prompt) && /DO NOT CHANGE/i.test(sellPrompt.prompt));
  S=old;
  if(missing.length) { console.error("SELF TEST FAIL",missing); process.exit(1); }
  if(!lessonCount) { console.error("SELF TEST FAIL: learning engine produced no lessons"); process.exit(1); }
  if(!promptOk) { console.error("SELF TEST FAIL: update prompt engine did not create a protected UNVERIFIED_SELL_CREDIT prompt"); process.exit(1); }
  console.log("HIVE AUDITOR SELF TEST: PASS",need.join(", "),"| learning lessons:",lessonCount,"| update prompt: PASS"); process.exit(0);
}

if(process.argv.includes("--self-test")) selfTest();
server.listen(PORT,()=>{
  console.log(`HIVE AUDITOR V1.2 listening on ${PORT}`);
  console.log(`Target Council: ${TARGET_URL}`);
  if(!S.staticAuditComplete) baselineStaticAudit();
  scan();
  setInterval(scan,POLL_MS);
});
