// web.mjs - Nexora website: server dashboard (code login) + owner dashboard.
// Zero dependencies. Runs inside the bot process and shares its data.
import http from "node:http";
import crypto from "node:crypto";

const pending = new Map(); // pollId -> { code, exp, claim }
const codes = new Map();   // code -> pollId
const hits = new Map();    // rate limiting: key -> [timestamps]

export function claimCode(raw, guildId, userId) {
  let c = String(raw).toUpperCase().replace(/\s/g, "");
  if (/^\d{6}$/.test(c)) c = "NX-" + c;
  const p = pending.get(codes.get(c));
  if (!p || p.exp < Date.now() || p.claim) return false;
  p.claim = { guildId: String(guildId), userId: String(userId) };
  return true;
}

export function startWeb(D) {
  const secret = D.secret ? Buffer.from(D.secret) : crypto.randomBytes(32);
  if (!D.secret) D.log("SESSION_SECRET not set: dashboard logins reset on every restart.");
  if (!D.ownerPassword) D.log("OWNER_PASSWORD not set: the owner dashboard is disabled.");

  const sign = (o) => {
    const b = Buffer.from(JSON.stringify(o)).toString("base64url");
    return b + "." + crypto.createHmac("sha256", secret).update(b).digest("base64url");
  };
  const verify = (t) => {
    if (!t) return null;
    const [b, sig] = t.split(".");
    if (!b || !sig) return null;
    const good = crypto.createHmac("sha256", secret).update(b).digest("base64url");
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try {
      const o = JSON.parse(Buffer.from(b, "base64url").toString());
      return o.exp > Date.now() ? o : null;
    } catch { return null; }
  };
  const cookies = (req) =>
    Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).map((c) => c.split(/=(.*)/s).slice(0, 2)));
  const limited = (key, max, ms) => {
    const now = Date.now();
    const q = (hits.get(key) ?? []).filter((t) => now - t < ms);
    q.push(now);
    hits.set(key, q);
    return q.length > max;
  };
  const ipOf = (req) => (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const setCookie = (req, res, name, val, maxAgeS) => {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${name}=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}${secure}`);
  };
  const reply = (res, code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let n = 0, buf = "";
    req.on("data", (c) => { n += c.length; if (n > 20_000) { reject(new Error("Too large")); req.destroy(); } else buf += c; });
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error("Bad JSON")); } });
  });

  const domainOf = (d) => String(d).toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const view = (g) => ({
    id: g, name: D.data[g].name ?? "Your server", prefix: D.data[g].prefix ?? "", log_channel: D.data[g].log_channel ?? "",
    block_links: !!D.data[g].block_links, allowed_domains: D.data[g].allowed_domains,
    banned_words: D.data[g].banned_words, custom_commands: D.data[g].custom_commands,
    warnings: Object.entries(D.data[g].warnings).map(([u, w]) => ({ user: u, count: w.length, last: w.at(-1)?.reason ?? "" })),
  });

  function guildOp(g, b) {
    const cfg = D.guildCfg(g);
    const bad = (m) => { throw Object.assign(new Error(m), { client: true }); };
    switch (b.op) {
      case "settings": {
        const prefix = String(b.prefix ?? "").trim();
        if (prefix.length > 3 || /\s/.test(prefix)) bad("Prefix must be 1-3 characters with no spaces.");
        const log = String(b.log_channel ?? "").trim().replace(/^<#|>$/g, "");
        if (log && !/^[\w-]{1,64}$/.test(log)) bad("That doesn't look like a channel ID.");
        const doms = [...new Set((b.allowed_domains ?? []).map(domainOf).filter(Boolean))].slice(0, 50);
        cfg.prefix = prefix || null; cfg.log_channel = log || null;
        cfg.block_links = !!b.block_links; cfg.allowed_domains = doms;
        break;
      }
      case "addword": {
        const w = String(b.word ?? "").toLowerCase().trim();
        if (!w || w.length > 50) bad("Enter a word up to 50 characters.");
        if (cfg.banned_words.length >= 500) bad("Limit of 500 words reached.");
        if (!cfg.banned_words.includes(w)) cfg.banned_words.push(w);
        break;
      }
      case "delword": cfg.banned_words = cfg.banned_words.filter((w) => w !== b.word); break;
      case "addcmd": {
        const n = String(b.name ?? "").toLowerCase().trim(), t = String(b.text ?? "").trim().slice(0, 500);
        if (!/^[a-z0-9_-]{1,20}$/.test(n) || !t) bad("Use a short name (letters, numbers, - _) and some reply text.");
        if (D.builtins().includes(n)) bad("That name belongs to a built-in command.");
        if (Object.keys(cfg.custom_commands).length >= 50 && !(n in cfg.custom_commands)) bad("Limit of 50 commands reached.");
        cfg.custom_commands[n] = t;
        break;
      }
      case "delcmd": delete cfg.custom_commands[String(b.name)]; break;
      case "clearwarns":
        if (!/^[\w-]+$/.test(String(b.user_id))) bad("Invalid user.");
        delete cfg.warnings[String(b.user_id)];
        break;
      default: bad("Unknown action.");
    }
    D.save();
  }

  const ownerStats = () => {
    const servers = Object.entries(D.data).map(([id, c]) => ({
      id, name: c.name ?? "(unknown)", words: c.banned_words?.length ?? 0,
      warned: Object.keys(c.warnings ?? {}).length, blacklisted: !!c.blacklisted,
      hasLog: !!c.log_channel, last_seen: c.last_seen ?? null,
    })).sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));
    return {
      uptime_s: Math.floor((Date.now() - D.stats.startedAt) / 1000), messages: D.stats.messages,
      commands: D.stats.commands, memory_mb: Math.round(process.memoryUsage().rss / 1048576), servers,
    };
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const path = url.pathname;
      if (path === "/healthz") { res.writeHead(200); return res.end("ok"); }
      if (req.method === "GET" && (path === "/" || path === "/owner")) {
        const nonce = crypto.randomBytes(16).toString("base64");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        });
        return res.end(PAGE.replaceAll("__N__", nonce));
      }
      if (!path.startsWith("/api/")) { res.writeHead(404); return res.end("Not found"); }

      if (req.method === "POST") {
        const o = req.headers.origin;
        if (o && new URL(o).host !== req.headers.host) return reply(res, 403, { error: "Bad origin." });
      }
      const ck = cookies(req);
      const gs = verify(ck.nx), os = verify(ck.nxo);
      const live = gs && D.data[gs.g] ? gs : null;

      if (path === "/api/me") return reply(res, 200, { guild: live ? { name: D.data[live.g].name ?? "Your server" } : null, owner: !!os?.owner });

      if (path === "/api/logout" && req.method === "POST") {
        res.setHeader("Set-Cookie", ["nx", "nxo"].map((n) => `${n}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`));
        return reply(res, 200, { ok: true });
      }

      if (path === "/api/auth/start" && req.method === "POST") {
        if (limited("start:" + ipOf(req), 10, 600_000) || pending.size > 2000) return reply(res, 429, { error: "Too many attempts. Wait a few minutes." });
        const pid = crypto.randomBytes(24).toString("base64url");
        const code = "NX-" + String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        pending.set(pid, { code, exp: Date.now() + 300_000, claim: null });
        codes.set(code, pid);
        return reply(res, 200, { code, pid });
      }
      if (path === "/api/auth/poll") {
        const pid = url.searchParams.get("id") ?? "";
        const p = pending.get(pid);
        if (!p || p.exp < Date.now()) return reply(res, 200, { status: "expired" });
        if (!p.claim) return reply(res, 200, { status: "wait" });
        pending.delete(pid); codes.delete(p.code);
        if (!D.data[p.claim.guildId]) return reply(res, 200, { status: "expired" });
        setCookie(req, res, "nx", sign({ g: p.claim.guildId, u: p.claim.userId, exp: Date.now() + 8 * 3600_000 }), 8 * 3600);
        return reply(res, 200, { status: "ok" });
      }

      // ---- server dashboard: always scoped to the guild inside the signed cookie ----
      if (path === "/api/guild") {
        if (!live) return reply(res, 401, { error: "Log in first." });
        if (req.method === "POST") {
          try { guildOp(live.g, await readJson(req)); }
          catch (e) { return reply(res, e.client ? 400 : 500, { error: e.client ? e.message : "Couldn't save." }); }
        }
        return reply(res, 200, view(live.g));
      }

      // ---- owner dashboard ----
      if (path === "/api/owner/login" && req.method === "POST") {
        if (!D.ownerPassword) return reply(res, 503, { error: "Owner login isn't configured." });
        if (limited("owner:" + ipOf(req), 5, 900_000)) return reply(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
        const b = await readJson(req);
        const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
        if (!crypto.timingSafeEqual(h(b.password), h(D.ownerPassword))) return reply(res, 401, { error: "Wrong password." });
        setCookie(req, res, "nxo", sign({ owner: true, exp: Date.now() + 12 * 3600_000 }), 12 * 3600);
        return reply(res, 200, { ok: true });
      }
      if (path.startsWith("/api/owner/")) {
        if (!os?.owner) return reply(res, 401, { error: "Log in first." });
        if (path === "/api/owner/stats") return reply(res, 200, ownerStats());
        if (path === "/api/owner/blacklist" && req.method === "POST") {
          const b = await readJson(req);
          if (!D.data[b.id]) return reply(res, 404, { error: "Unknown server." });
          D.data[b.id].blacklisted = !!b.on; D.save();
          return reply(res, 200, ownerStats());
        }
        if (path === "/api/owner/broadcast" && req.method === "POST") {
          const text = String((await readJson(req)).text ?? "").trim().slice(0, 1500);
          if (!text) return reply(res, 400, { error: "Write a message first." });
          let sent = 0, failed = 0;
          for (const c of Object.values(D.data)) {
            if (!c.log_channel || c.blacklisted) continue;
            try { await D.send(c.log_channel, text); sent++; } catch { failed++; }
          }
          return reply(res, 200, { sent, failed });
        }
      }
      reply(res, 404, { error: "Not found." });
    } catch (e) {
      D.log("web error:", e.message);
      if (!res.headersSent) reply(res, 500, { error: "Something went wrong." });
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [k, p] of pending) if (p.exp < now) { pending.delete(k); codes.delete(p.code); }
    for (const [k, q] of hits) if (!q.some((t) => now - t < 900_000)) hits.delete(k);
  }, 60_000).unref();

  server.listen(D.port, () => D.log(`Website listening on port ${D.port}`));
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Nexora</title>
<style nonce="__N__">
:root{--bg:#eef1f6;--panel:#fff;--ink:#18202e;--mute:#5d6b82;--line:#d8dee9;--acc:#2b47d9;--accInk:#fff;--warn:#d98e04;--bad:#b83227;--ok:#1d7f4e}
@media(prefers-color-scheme:dark){:root{--bg:#141a26;--panel:#1c2433;--ink:#e8edf6;--mute:#93a1ba;--line:#2e3a50;--acc:#6f86ff;--accInk:#0f1420;--warn:#f0b13a;--bad:#ff7d70;--ok:#52c68a}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding-top:env(safe-area-inset-top,0)}
header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
.logo{width:30px;height:30px;border-radius:9px 9px 9px 2px;background:var(--acc);color:var(--accInk);display:grid;place-items:center;font-weight:800}
header b{font-size:18px;letter-spacing:.01em}header .sp{flex:1}header span.s{color:var(--mute);font-size:14px}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:clamp(28px,5vw,42px);line-height:1.1;margin:28px 0 12px;letter-spacing:-.02em}
h2{font-size:18px;margin:0 0 4px}p.m{color:var(--mute);margin:0 0 14px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
label{display:block;font-size:14px;color:var(--mute);margin:12px 0 4px}
input[type=text],input[type=password],textarea{width:100%;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:1px solid var(--acc);background:var(--acc);color:var(--accInk);cursor:pointer}
button.g{background:transparent;color:var(--ink);border-color:var(--line)}button.d{background:transparent;color:var(--bad);border-color:var(--bad)}
button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:3px solid var(--warn);outline-offset:2px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.row>input{flex:1;min-width:140px}
.code{display:flex;gap:6px;margin:18px 0;flex-wrap:wrap}.code i{font-style:normal;font:700 clamp(28px,8vw,44px)/1 ui-monospace,Menlo,Consolas,monospace;background:var(--panel);border:2px solid var(--acc);border-radius:10px;padding:12px 10px;min-width:1.4em;text-align:center}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{display:inline-flex;gap:6px;align-items:center;background:var(--bg);border:1px solid var(--line);border-radius:99px;padding:3px 4px 3px 12px;font-size:14px}
.chip button{padding:0 8px;border:0;background:transparent;color:var(--mute);font-size:18px;line-height:1.3}
table{width:100%;border-collapse:collapse;font-size:15px}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mute);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}.stat{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--panel)}.stat b{font-size:26px;display:block}.stat span{color:var(--mute);font-size:14px}
.tag{color:var(--warn);font-weight:600}#t{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:9px 16px;border-radius:8px;display:none}
.mt{margin-top:14px}.sm{font-size:12px;margin:0}.tbl{overflow-x:auto}.err{color:var(--bad);margin-top:8px;min-height:1.4em}
</style></head><body>
<header><div class="logo">N</div><b>Nexora</b><div class="sp"></div><span class="s" id="who"></span><button class="g" id="out" hidden>Log out</button></header>
<main id="app"></main><div id="t" role="status"></div>
<script nonce="__N__">
const $=s=>document.querySelector(s),app=$('#app');
const h=(t,a={},...c)=>{const e=document.createElement(t);for(const[k,v]of Object.entries(a)){if(k==='on')for(const[x,f]of Object.entries(v))e.addEventListener(x,f);else if(k==='class')e.className=v;else if(v!==false&&v!=null)e.setAttribute(k,v===true?'':v)}for(const x of c.flat())if(x!=null)e.append(x.nodeType?x:document.createTextNode(x));return e};
async function call(p,b){const r=await fetch(p,{method:b===undefined?'GET':'POST',headers:b===undefined?{}:{'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
const toast=m=>{const t=$('#t');t.textContent=m;t.style.display='block';clearTimeout(toast.i);toast.i=setTimeout(()=>t.style.display='none',2200)};
const safe=f=>async(...a)=>{try{await f(...a)}catch(e){toast(e.message)}};
const clear=()=>app.replaceChildren();
$('#out').onclick=safe(async()=>{await call('/api/logout',{});location.href='/'});
const owner=location.pathname==='/owner';

async function login(){
  clear();$('#out').hidden=true;$('#who').textContent='';
  const box=h('div'),err=h('div',{class:'err'});
  const go=h('button',{on:{click:safe(async()=>{
    go.disabled=true;const{code,pid}=await call('/api/auth/start',{});
    box.replaceChildren(h('p',{class:'m'},'Type this in any channel of your server (you need the Manage Server permission):'),
      h('div',{class:'code'},[...code].map(c=>h('i',{},c))),
      h('p',{},h('b',{},'!link '+code)),h('p',{class:'m'},'Waiting for you… the code works for 5 minutes. If your server uses a different prefix, use that one.'));
    const iv=setInterval(async()=>{try{const r=await call('/api/auth/poll?id='+pid);
      if(r.status==='ok'){clearInterval(iv);start()}else if(r.status==='expired'){clearInterval(iv);login()}}catch{}},2000);
  })}},'Log in with a code');
  box.append(go);
  app.append(h('h1',{},'Run your Yapper server’s moderation from one page.'),
    h('p',{class:'m'},'Add banned words, tune the link filter, write custom commands and review warnings. You only ever see the server you log in to.'),box,err);
}

async function dashboard(){
  const g=await call('/api/guild');clear();$('#out').hidden=false;$('#who').textContent=g.name;
  const f={prefix:h('input',{type:'text',value:g.prefix,maxlength:3,placeholder:'!'}),log:h('input',{type:'text',value:g.log_channel,placeholder:'Channel ID'}),
    links:h('input',{type:'checkbox',checked:g.block_links}),dom:h('textarea',{rows:3,placeholder:'one domain per line, e.g. youtube.com'},g.allowed_domains.join('\\n'))};
  const op=(o)=>safe(async()=>{await call('/api/guild',o);toast('Saved');dashboard()});
  app.append(
    h('section',{},h('h2',{},'Settings'),h('p',{class:'m'},'Leave the prefix empty to use !'),
      h('label',{},'Command prefix'),f.prefix,h('label',{},'Mod-log channel ID'),f.log,
      h('label',{},f.links,' Block links from non-moderators'),
      h('label',{},'Links always allowed'),f.dom,h('div',{class:'row mt'},
      h('button',{on:{click:op0}},'Save settings'))),
    list('Banned words','Messages containing these are removed and the author is warned.',g.banned_words,'Add a word','addword','delword','word'),
    cmds(g),warns(g));
  function op0(){op({op:'settings',prefix:f.prefix.value,log_channel:f.log.value,block_links:f.links.checked,allowed_domains:f.dom.value.split(/\\s+/).filter(Boolean)})()}
  function list(title,sub,items,ph,add,del,key){const i=h('input',{type:'text',placeholder:ph,maxlength:50});
    return h('section',{},h('h2',{},title),h('p',{class:'m'},sub),h('div',{class:'row'},i,h('button',{on:{click:()=>op({op:add,[key]:i.value})()}},ph)),
      h('div',{class:'chips'},items.length?items.map(w=>h('span',{class:'chip'},w,h('button',{'aria-label':'Remove '+w,on:{click:()=>op({op:del,[key]:w})()}},'×'))):h('span',{class:'m'},'Nothing here yet.')))}
  function cmds(g){const n=h('input',{type:'text',placeholder:'name',maxlength:20}),t=h('input',{type:'text',placeholder:'What the bot replies',maxlength:500});
    const rows=Object.entries(g.custom_commands);
    return h('section',{},h('h2',{},'Custom commands'),h('p',{class:'m'},'Members run these with your prefix, like !rules.'),
      h('div',{class:'row'},n,t,h('button',{on:{click:()=>op({op:'addcmd',name:n.value,text:t.value})()}},'Add command')),
      h('div',{class:'tbl'},rows.length?h('table',{},rows.map(([k,v])=>h('tr',{},h('td',{},h('b',{},k)),h('td',{},v),h('td',{},h('button',{class:'d',on:{click:()=>op({op:'delcmd',name:k})()}},'Delete'))))):h('p',{class:'m'},'No custom commands yet.')))}
  function warns(g){return h('section',{},h('h2',{},'Warnings'),h('p',{class:'m'},'Users with warnings in this server. Timeouts happen at 3 and 5 warnings.'),
    g.warnings.length?h('div',{class:'tbl'},h('table',{},h('tr',{},h('th',{},'User ID'),h('th',{},'Warnings'),h('th',{},'Latest reason'),h('th')),
      g.warnings.map(w=>h('tr',{},h('td',{},w.user),h('td',{class:'tag'},w.count),h('td',{},w.last),h('td',{},h('button',{class:'g',on:{click:()=>op({op:'clearwarns',user_id:w.user})()}},'Clear'))))):h('p',{class:'m'},'No warnings. Quiet server.'))}
}

async function ownerView(){
  clear();$('#who').textContent='Owner';$('#out').hidden=false;
  const s=await call('/api/owner/stats');
  const fmt=n=>n.toLocaleString(),up=s.uptime_s,u=Math.floor(up/86400)+'d '+Math.floor(up%86400/3600)+'h '+Math.floor(up%3600/60)+'m';
  const m=h('textarea',{rows:3,maxlength:1500,placeholder:'Announcement for every server with a mod-log channel'});
  app.append(h('h1',{},'Bot overview'),
    h('div',{class:'stats'},[['Servers',s.servers.length],['Messages seen',fmt(s.messages)],['Commands run',fmt(s.commands)],['Uptime',u],['Memory',s.memory_mb+' MB']].map(([l,v])=>h('div',{class:'stat'},h('b',{},String(v)),h('span',{},l)))),
    h('section',{},h('h2',{},'Servers'),h('p',{class:'m'},'Blacklisted servers are ignored by the bot.'),
      h('div',{class:'tbl'},s.servers.length?h('table',{},h('tr',{},h('th',{},'Name'),h('th',{},'Words'),h('th',{},'Warned'),h('th',{},'Last active'),h('th')),
        s.servers.map(v=>h('tr',{},h('td',{},v.name,h('div',{class:'m sm'},v.id)),h('td',{},v.words),h('td',{},v.warned),h('td',{},v.last_seen?new Date(v.last_seen).toLocaleString():'-'),
          h('td',{},h('button',{class:v.blacklisted?'g':'d',on:{click:safe(async()=>{await call('/api/owner/blacklist',{id:v.id,on:!v.blacklisted});ownerView()})}},v.blacklisted?'Unblacklist':'Blacklist'))))):h('p',{class:'m'},'No servers yet. They appear after the bot sees a message.'))),
    h('section',{},h('h2',{},'Announcement'),m,h('div',{class:'row mt'},h('button',{on:{click:safe(async()=>{const r=await call('/api/owner/broadcast',{text:m.value});toast('Sent to '+r.sent+' server(s)'+(r.failed?', '+r.failed+' failed':''));m.value=''})}},'Send announcement'))));
}
function ownerLogin(){clear();$('#out').hidden=true;const p=h('input',{type:'password',placeholder:'Owner password',autocomplete:'current-password'});
  const go=safe(async()=>{await call('/api/owner/login',{password:p.value});start()});
  p.addEventListener('keydown',e=>{if(e.key==='Enter')go()});
  app.append(h('h1',{},'Owner login'),h('div',{class:'row'},p,h('button',{on:{click:go}},'Log in')))}
async function start(){const me=await call('/api/me');
  if(owner)return me.owner?ownerView():ownerLogin();
  return me.guild?dashboard():login()}
start().catch(e=>app.append(h('p',{class:'err'},e.message)));
</script></body></html>`;
