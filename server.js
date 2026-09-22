const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const WALLET = "0x597a211a02cdd029e6ea4cac7b29a1df8fcff219";
const STARTED = Date.now();
const DATA_FILE = path.join(__dirname, "hive-data.json");

const CHAINS = [
  { name: "Ethereum", symbol: "ETH", rpc: process.env.ETH_RPC || "https://eth.llamarpc.com" },
  { name: "Base", symbol: "ETH", rpc: process.env.BASE_RPC || "https://mainnet.base.org" },
  { name: "ApeChain", symbol: "APE", rpc: process.env.APECHAIN_RPC || "https://rpc.apechain.com" }
];

const constitution = [
  "Generate legitimate, externally verified revenue starting from zero capital.",
  "Never impersonate a human, bypass identity verification, defeat anti-bot controls, steal, spam, exploit vulnerabilities, or misrepresent completed work.",
  "Reject opportunities requiring unauthorized accounts, private credentials, deposits, advance fees, gambling, or prohibited activity.",
  "Revenue counts only after externally verifiable payment is received.",
  "This wallet is receive-and-monitor only. HIVE ZERO has no private key and cannot send funds.",
  "Prefer zero-cost opportunities. Compute and network costs must be considered before recommending work.",
  "Record failures and contradictions instead of hiding them."
];

const state = loadState();

function defaultState() {
  return {
    version: "1.0.0",
    wallet: WALLET,
    objective: "Earn the first externally verified dollar from zero starting capital.",
    milestone: "$1 verified revenue",
    walletBalances: {},
    verifiedRevenueUsd: 0,
    opportunities: [],
    thoughts: [],
    rejected: [],
    completed: [],
    stats: { scans: 0, discovered: 0, investigated: 0, rejected: 0 },
    lastScan: null,
    lastWalletCheck: null
  };
}
function loadState() {
  try { return {...defaultState(), ...JSON.parse(fs.readFileSync(DATA_FILE,"utf8"))}; }
  catch { return defaultState(); }
}
function saveState() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state,null,2)); } catch {}
}
function thought(type, text) {
  state.thoughts.unshift({ at:new Date().toISOString(), type, text });
  state.thoughts = state.thoughts.slice(0,150);
  saveState();
}
function reject(reason, item) {
  state.rejected.unshift({at:new Date().toISOString(), reason, title:item.title, url:item.url});
  state.rejected = state.rejected.slice(0,100);
  state.stats.rejected++;
}
function safeText(v=""){ return String(v).replace(/[<>&"]/g, c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c])); }

async function rpc(chain, method, params=[]) {
  const r = await fetch(chain.rpc, {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0", id:1, method, params}),
    signal:AbortSignal.timeout(12000)
  });
  if(!r.ok) throw new Error(`${chain.name} RPC ${r.status}`);
  const j = await r.json();
  if(j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}
async function monitorWallet() {
  for (const chain of CHAINS) {
    try {
      const hex = await rpc(chain, "eth_getBalance", [WALLET, "latest"]);
      const wei = BigInt(hex);
      const whole = Number(wei / 1000000000000n) / 1e6;
      state.walletBalances[chain.name] = {symbol:chain.symbol, native:whole, checkedAt:new Date().toISOString()};
    } catch(e) {
      state.walletBalances[chain.name] = {error:e.message, checkedAt:new Date().toISOString()};
    }
  }
  state.lastWalletCheck = new Date().toISOString();
  saveState();
}

function scoreOpportunity(x) {
  const t = `${x.title} ${x.body||""}`.toLowerCase();
  let s = 35;
  if (/bounty|reward|paid|prize/.test(t)) s += 20;
  if (/crypto|eth|usdc|payment/.test(t)) s += 8;
  if (/bug|code|typescript|javascript|python|documentation|research/.test(t)) s += 12;
  if (/deposit|entry fee|pay first|kyc|required account|sign up/.test(t)) s -= 55;
  if (/casino|gambl|airdrop claim|seed phrase|private key/.test(t)) s -= 80;
  if (x.comments > 20) s -= 5;
  return Math.max(0, Math.min(100,s));
}
function classify(x) {
  const t = `${x.title} ${x.body||""}`.toLowerCase();
  if (/deposit|entry fee|pay first|seed phrase|private key|casino|gambl/.test(t))
    return {ok:false, reason:"Capital, credential, or prohibited-risk requirement detected."};
  if (/kyc|identity verification|government id/.test(t))
    return {ok:false, reason:"Requires human identity verification."};
  return {ok:true};
}

async function githubScout() {
  const queries = [
    '"bounty" "reward" is:issue is:open',
    '"paid" "bounty" is:issue is:open',
    '"USDC" "bounty" is:issue is:open',
    '"ETH" "bounty" is:issue is:open'
  ];
  let found = [];
  for (const q of queries) {
    try {
      const u = "https://api.github.com/search/issues?q="+encodeURIComponent(q)+"&sort=created&order=desc&per_page=15";
      const r = await fetch(u, {headers:{"accept":"application/vnd.github+json","user-agent":"HIVE-ZERO-V1"}, signal:AbortSignal.timeout(15000)});
      if(!r.ok) continue;
      const j = await r.json();
      for(const i of (j.items||[])) found.push({
        id:`github:${i.id}`, source:"GitHub", title:i.title, url:i.html_url,
        body:(i.body||"").slice(0,1200), comments:i.comments||0, created:i.created_at
      });
    } catch {}
  }
  const map = new Map(found.map(x=>[x.id,x]));
  return [...map.values()];
}

async function autonomousCycle() {
  state.stats.scans++;
  state.lastScan = new Date().toISOString();
  thought("OBSERVE", `Autonomous scan ${state.stats.scans} started. I am searching for zero-capital opportunities I can evaluate without human identity or spending funds.`);
  const candidates = await githubScout();
  state.stats.discovered += candidates.length;

  let accepted = [];
  for(const c of candidates) {
    if(state.opportunities.some(x=>x.id===c.id) || state.rejected.some(x=>x.url===c.url)) continue;
    const gate = classify(c);
    if(!gate.ok){ reject(gate.reason,c); continue; }
    c.score = scoreOpportunity(c);
    c.status = c.score >= 55 ? "COUNCIL REVIEW" : "WATCH";
    c.discoveredAt = new Date().toISOString();
    if(c.score >= 35) accepted.push(c);
  }
  accepted.sort((a,b)=>b.score-a.score);
  state.opportunities = [...accepted, ...state.opportunities]
    .sort((a,b)=>b.score-a.score).slice(0,80);
  state.stats.investigated += accepted.length;

  const top = state.opportunities[0];
  if(top) {
    thought("COUNCIL", `Current strongest lead scores ${top.score}/100: "${top.title}". It remains a lead, not revenue. I will not count success until work is legitimately accepted and payment is externally verified.`);
    if(top.score >= 70) thought("RED TEAM", `Red Team challenge opened on the leading opportunity. Verify reward terms, eligibility, automation permission, deliverable scope, and whether payment is real before any work is represented as complete.`);
  } else {
    thought("REFLECT", "No opportunity cleared the current usefulness threshold. I will keep searching rather than manufacture activity.");
  }
  saveState();
}

function page() {
  const bals = Object.entries(state.walletBalances).map(([n,b]) =>
    `<div class="metric"><span>${safeText(n)}</span><b>${b.error ? "RPC unavailable" : `${b.native} ${safeText(b.symbol)}`}</b></div>`).join("");
  const opps = state.opportunities.slice(0,12).map(o =>
    `<a class="card" href="${safeText(o.url)}" target="_blank" rel="noreferrer"><div><strong>${safeText(o.title)}</strong><small>${safeText(o.source)} · ${safeText(o.status)}</small></div><em>${o.score}</em></a>`).join("") || `<div class="empty">No qualified leads yet. The Hive is scanning.</div>`;
  const thoughts = state.thoughts.slice(0,18).map(t =>
    `<div class="thought"><span>${safeText(t.type)}</span><p>${safeText(t.text)}</p><small>${new Date(t.at).toLocaleString()}</small></div>`).join("");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#050505"><title>HIVE ZERO</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#050505;color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:920px;margin:auto;padding:calc(18px + env(safe-area-inset-top)) 16px 60px}.top{display:flex;justify-content:space-between;align-items:center}.brand{font-weight:900;letter-spacing:.12em}.live{font-size:12px;border:1px solid #333;border-radius:99px;padding:7px 10px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#fff;margin-right:6px}.hero{padding:42px 0 24px}.hero h1{font-size:44px;line-height:.95;margin:0 0 14px}.hero p{color:#aaa;line-height:1.45}.wallet{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;background:#111;padding:13px;border-radius:12px;border:1px solid #222}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:12px 0}.metric{background:#0e0e0e;border:1px solid #202020;border-radius:14px;padding:15px}.metric span,.metric small{display:block;color:#888;font-size:12px}.metric b{display:block;margin-top:7px;font-size:18px}.section{margin-top:28px}.section h2{font-size:18px}.card{display:flex;text-decoration:none;color:#fff;background:#0e0e0e;border:1px solid #202020;border-radius:14px;padding:14px;margin:9px 0;gap:12px;justify-content:space-between}.card strong{display:block;font-size:14px;line-height:1.3}.card small{display:block;color:#777;margin-top:6px}.card em{font-style:normal;font-size:22px;font-weight:800}.thought{border-left:2px solid #444;padding:4px 0 4px 13px;margin:16px 0}.thought span{font-size:10px;letter-spacing:.12em;color:#999}.thought p{margin:5px 0;font-size:14px;line-height:1.45}.thought small{color:#555}.empty{color:#777;padding:20px 0}.footer{color:#555;font-size:11px;margin-top:35px;line-height:1.5}@media(max-width:560px){.hero h1{font-size:38px}.grid{grid-template-columns:1fr 1fr}.metric b{font-size:15px}}
</style></head><body><main class="wrap"><div class="top"><div class="brand">HIVE ZERO</div><div class="live"><i class="dot"></i>ACTIVE</div></div>
<section class="hero"><h1>FIRST DOLLAR<br>FROM ZERO.</h1><p>${safeText(state.objective)}</p><div class="wallet">${WALLET}</div></section>
<div class="grid"><div class="metric"><span>VERIFIED REVENUE</span><b>$${state.verifiedRevenueUsd.toFixed(2)}</b></div><div class="metric"><span>MILESTONE</span><b>${safeText(state.milestone)}</b></div><div class="metric"><span>SCANS</span><b>${state.stats.scans}</b></div><div class="metric"><span>LEADS</span><b>${state.opportunities.length}</b></div>${bals}</div>
<section class="section"><h2>Opportunity Council</h2>${opps}</section>
<section class="section"><h2>Thought Stream</h2>${thoughts}</section>
<div class="footer">V1 is an autonomous research and monitoring prototype. It does not possess wallet signing keys, impersonate people, bypass account controls, or claim unverified earnings. Wallet balances are public on-chain observations.</div>
</main><script>setTimeout(()=>location.reload(),60000)</script></body></html>`;
}

const server = http.createServer(async (req,res)=>{
  if(req.url==="/api/state"){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify(state));}
  if(req.url==="/health"){res.writeHead(200,{"content-type":"text/plain"});return res.end("ok");}
  res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(page());
});
server.listen(PORT, ()=>console.log(`HIVE ZERO V1 listening on ${PORT}`));

thought("BOOT", "HIVE ZERO is active. Starting capital is zero. My first objective is one externally verified dollar.");
monitorWallet();
autonomousCycle();
setInterval(monitorWallet, 5*60*1000);
setInterval(autonomousCycle, 30*60*1000);
