
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ORIGIN = "https://tu-semana-sandos.gluck-yanina.chatgpt.site";
const HOST = new URL(ORIGIN).host;
const DIST = path.resolve("dist");
const START = "2026-08-20";
const END = "2027-08-31";
const PORTAL_MARGIN = 1000;
const HOTFIX_VERSION = "5.1.0";
const FETCH_TIMEOUT_MS = 15000;
const EXTERNAL_FETCH_CONCURRENCY = 8;

const queue=[ORIGIN+"/"], seen=new Set(), rewrite=new Map(), copied=[], failures=[], externalCopied=[];
await fs.rm(DIST,{recursive:true,force:true});
await fs.mkdir(path.join(DIST,"_local","external"),{recursive:true});

const textTypes=/(?:text\/|javascript|json|xml|svg)/i;
const mediaExt=/\.(?:png|jpe?g|webp|gif|svg|ico|avif|mp4|webm|mov|woff2?|ttf|otf)(?:\?.*)?$/i;

function hash(s){return crypto.createHash("sha1").update(s).digest("hex").slice(0,16)}
function extFor(url,ct=""){
  let e=path.extname(new URL(url).pathname).toLowerCase();
  if(e&&e.length<8)return e;
  if(/jpeg/.test(ct))return ".jpg";
  if(/png/.test(ct))return ".png";
  if(/webp/.test(ct))return ".webp";
  if(/svg/.test(ct))return ".svg";
  if(/mp4/.test(ct))return ".mp4";
  if(/woff2/.test(ct))return ".woff2";
  if(/woff/.test(ct))return ".woff";
  if(/css/.test(ct))return ".css";
  if(/javascript/.test(ct))return ".js";
  if(/json/.test(ct))return ".json";
  if(/html/.test(ct))return ".html";
  return ".bin";
}
function abs(raw,base){
  try{
    if(!raw||/^(?:data:|blob:|mailto:|tel:|javascript:|#)/i.test(raw))return null;
    const resolved=new URL(raw,base);
    // Some minified strings are rediscovered with a spurious trailing slash.
    // Normalize file-like paths so the crawler does not wait on guaranteed 404s.
    if(/\.[a-z0-9]{1,6}\/$/i.test(resolved.pathname))resolved.pathname=resolved.pathname.slice(0,-1);
    return resolved.href;
  }catch{return null}
}
function outPath(url,ct=""){
  const u=new URL(url); let p=decodeURIComponent(u.pathname);
  if(p==="/"||p.endsWith("/"))p+="index.html";
  if(!path.extname(p)&&/html/i.test(ct))p+=".html";
  if(u.search){
    const e=path.extname(p); const s=e?p.slice(0,-e.length):p;
    p=s+"__"+hash(u.search)+(e||extFor(url,ct));
  }
  return path.join(DIST,p.replace(/^\/+/,""));
}
function localURL(url,ct=""){
  const u=new URL(url);
  if(u.host===HOST){
    let p=decodeURIComponent(u.pathname);
    if(p==="/")return "/";
    if(p.endsWith("/"))return p;
    return p+(u.search?"__"+hash(u.search):"");
  }
  return "/_local/external/"+hash(url)+extFor(url,ct);
}
function refs(text,base){
  const found=new Set();
  const regexes=[
    /(?:src|href|poster|data-src|data-lazy-src)=["']([^"'<>]+)["']/gi,
    /(?:srcset|data-srcset)=["']([^"']+)["']/gi,
    /url\(\s*["']?([^)"']+)["']?\s*\)/gi,
    /["'`](https?:\/\/[^"'`\s<>]+)["'`]/gi,
    /["'`](\/[^"'`\s<>]+)["'`]/gi
  ];
  for(const re of regexes){
    let m;
    while((m=re.exec(text))){
      const raw=m[1];
      if(!raw)continue;
      const parts=re.source.includes("srcset")?raw.split(",").map(x=>x.trim().split(/\s+/)[0]):[raw];
      for(const p of parts){const a=abs(p,base);if(a)found.add(a)}
    }
  }
  return [...found];
}
async function fetchBuf(url){
  const r=await fetch(url,{redirect:"follow",headers:{"user-agent":"Mozilla/5.0 PortalCaribeV5"},signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
  if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
  return {buf:Buffer.from(await r.arrayBuffer()),ct:r.headers.get("content-type")||""};
}
async function external(url){
  if(rewrite.has(url))return rewrite.get(url);
  try{
    const {buf,ct}=await fetchBuf(url);
    if(!mediaExt.test(new URL(url).pathname)&&!/(?:image|video|font)\//i.test(ct))return null;
    const rel=localURL(url,ct), out=path.join(DIST,rel.replace(/^\//,""));
    await fs.mkdir(path.dirname(out),{recursive:true});
    await fs.writeFile(out,buf);
    rewrite.set(url,rel); externalCopied.push({url,rel,bytes:buf.length});
    return rel;
  }catch(e){failures.push({url,error:e.message,kind:"external"});return null}
}
async function mapLimit(items,limit,fn){
  let cursor=0;
  const workers=Array.from({length:Math.min(limit,items.length)},async()=>{
    while(cursor<items.length){
      const item=items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
async function crawl(url){
  if(seen.has(url))return; seen.add(url);
  try{
    const r=await fetch(url,{redirect:"follow",headers:{"user-agent":"Mozilla/5.0 PortalCaribeV5"},signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
    if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
    const ct=r.headers.get("content-type")||"";
    let payload;
    if(textTypes.test(ct)){
      let text=await r.text();
      const externalRefs=[];
      for(const ref of refs(text,url)){
        const u=new URL(ref);
        if(u.host===HOST){
          // API routes belong to the original dynamic site and cannot be
          // mirrored as static files. Netlify serves the local replacement.
          if(u.pathname.startsWith("/api/"))continue;
          const decodedPath=decodeURIComponent(u.pathname);
          // The broad reference scanner can encounter code fragments inside
          // minified JavaScript. Only crawl real files or explicit directories.
          if(/[${}`(),]/.test(decodedPath))continue;
          if(!decodedPath.endsWith("/")&&!/\.[a-z0-9]{1,6}$/i.test(decodedPath))continue;
          if(!seen.has(ref))queue.push(ref);
        }else if(mediaExt.test(u.pathname+u.search)){externalRefs.push(ref)}
      }
      await mapLimit(externalRefs,EXTERNAL_FETCH_CONCURRENCY,external);
      text=text.replaceAll(ORIGIN,"");
      for(const [from,to] of rewrite)text=text.split(from).join(to);
      payload=Buffer.from(text,"utf8");
    }else payload=Buffer.from(await r.arrayBuffer());
    const out=outPath(url,ct);
    await fs.mkdir(path.dirname(out),{recursive:true});
    await fs.writeFile(out,payload);
    copied.push({url,file:path.relative(DIST,out),ct,bytes:payload.length});
  }catch(e){failures.push({url,error:e.message,kind:"same-origin"})}
}
while(queue.length){
  const next=queue.shift();
  if(process.env.DEBUG_CRAWL)console.log(`[crawl ${seen.size+1}] ${next}`);
  await crawl(next);
}

async function walk(dir){
  let out=[]; for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name); out.push(...(e.isDirectory()?await walk(p):[p]))}
  return out;
}
let files=await walk(DIST);

// second rewrite pass
let pricingFeePatchCount=0;
let exactTotalPatchCount=0;
let teenRatePatchCount=0;
let teenCopyPatchCount=0;
let dateDefaultsPatchCount=0;
let dateInputPatchCount=0;
for(const f of files){
  if(/\.(?:html?|css|js|mjs|json|xml|svg|txt)$/i.test(f)){
    let t=await fs.readFile(f,"utf8").catch(()=>null); if(!t)continue;
    t=t.replaceAll(ORIGIN,""); for(const [from,to] of rewrite)t=t.split(from).join(to);

    if(/TripCalculator-[^/]+\.js$/i.test(f)){
      const feePattern=/function ([A-Za-z_$][\w$]*)\(e\)\{return e<7\?0:450\+Math\.max\(0,e-7\)\*60\}/g;
      t=t.replace(feePattern,(_match,functionName)=>{
        pricingFeePatchCount+=1;
        return `function ${functionName}(e){return 0}`;
      });

      const exactTotalPattern=/total:([A-Za-z_$][\w$]*),low:([A-Za-z_$][\w$]*),high:([A-Za-z_$][\w$]*),publicMid:[A-Za-z_$][\w$]*\(\1,`up`\)/g;
      t=t.replace(exactTotalPattern,(_match,total,low,high)=>{
        exactTotalPatchCount+=1;
        return `total:${total},low:${low},high:${high},publicMid:${total}`;
      });

      const teenRatePattern=/n>=13&&n<=17\?e===`playacar`&&[A-Za-z_$][\w$]*\(t,`2026-08-20`,`2026-10-31`\)\?\.5:\.85:1/g;
      t=t.replace(teenRatePattern,()=>{
        teenRatePatchCount+=1;
        return "n>=13&&n<=17?.7:1";
      });

      const teenCopyFrom="el descuento depende del hotel y de la fecha confirmada.";
      const teenCopyMatches=t.split(teenCopyFrom).length-1;
      if(teenCopyMatches){
        teenCopyPatchCount+=teenCopyMatches;
        t=t.split(teenCopyFrom).join("abonan el 70% de la tarifa.");
      }

      const dateDefaultsPattern=/,\[i,a\]=\(0,N\.useState\)\(`\d{4}-\d{2}-\d{2}`\),\[o,s\]=\(0,N\.useState\)\(`\d{4}-\d{2}-\d{2}`\),/g;
      t=t.replace(dateDefaultsPattern,()=>{
        dateDefaultsPatchCount+=1;
        return ',[i,a]=(0,N.useState)(()=>bi(yi(new Date),1)),[o,s]=(0,N.useState)(()=>bi(yi(new Date),8)),';
      });

      const checkInField='type:`date`,value:i,onChange:e=>ue(e.target.value)';
      const checkOutField='type:`date`,min:i?bi(i,7):void 0,value:o,onChange:e=>s(e.target.value)';
      const checkInMatches=t.split(checkInField).length-1;
      const checkOutMatches=t.split(checkOutField).length-1;
      dateInputPatchCount+=checkInMatches+checkOutMatches;
      t=t.split(checkInField).join('type:`date`,min:yi(new Date),value:i,onInput:e=>ue(e.target.value)');
      t=t.split(checkOutField).join('type:`date`,min:i?bi(i,7):void 0,value:o,onInput:e=>s(e.target.value)');
    }

    await fs.writeFile(f,t);
  }
}

if(pricingFeePatchCount!==1){
  throw new Error(`Pricing hotfix expected 1 usage-fee match, found ${pricingFeePatchCount}`);
}
if(exactTotalPatchCount!==1){
  throw new Error(`Pricing hotfix expected 1 rounded-total match, found ${exactTotalPatchCount}`);
}
if(teenRatePatchCount!==1){
  throw new Error(`Teen-rate hotfix expected 1 pricing match, found ${teenRatePatchCount}`);
}
if(teenCopyPatchCount!==1){
  throw new Error(`Teen-rate hotfix expected 1 copy match, found ${teenCopyPatchCount}`);
}
if(dateDefaultsPatchCount!==1){
  throw new Error(`Date hotfix expected 1 default-date match, found ${dateDefaultsPatchCount}`);
}
if(dateInputPatchCount!==2){
  throw new Error(`Date hotfix expected 2 input matches, found ${dateInputPatchCount}`);
}

// Mobile and scrolling hotfixes are kept separate from the mirrored CSS so
// they remain easy to audit and do not depend on a generated asset hash.
const hotfixCSS=`
html {
  scroll-behavior: auto !important;
  overscroll-behavior-y: none;
}
body {
  overflow-x: clip !important;
  overscroll-behavior-y: none;
}
.quote-shell input[type="date"],
.quote-shell input[type="number"],
.quote-shell button[role="combobox"] {
  position: relative;
  z-index: 1;
  min-height: 48px;
  pointer-events: auto !important;
  touch-action: manipulation;
}
.photo-gallery-viewport,
.photo-gallery-slide,
.photo-gallery-image-button {
  touch-action: pan-y pinch-zoom;
}
@media (max-width: 760px) {
  body {
    width: 100%;
    max-width: 100vw;
    overflow-anchor: none;
  }
  .quote-section {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 32px !important;
    padding: 80px 15px !important;
  }
  .quote-intro {
    position: static !important;
    top: auto !important;
    padding-top: 0 !important;
  }
  .quote-shell {
    width: 100% !important;
    min-width: 0 !important;
    padding: 22px 16px !important;
  }
  .quote-fields,
  .contact-fields {
    grid-template-columns: minmax(0, 1fr) !important;
  }
  .quote-shell input,
  .quote-shell button[role="combobox"] {
    max-width: 100% !important;
  }
  .request-actions {
    flex-direction: column !important;
  }
  .request-actions button {
    width: 100%;
  }
  .hero-portal {
    transform: none !important;
    transition: none !important;
  }
}
`;
await fs.writeFile(path.join(DIST,"portal-hotfix.css"),hotfixCSS);

for(const f of files.filter(f=>/\.html?$/i.test(f))){
  let html=await fs.readFile(f,"utf8").catch(()=>null); if(!html)continue;
  if(!html.includes("/portal-hotfix.css")){
    html=html.replace("</head>",`<link rel="stylesheet" href="/portal-hotfix.css?v=${HOTFIX_VERSION}"></head>`);
    await fs.writeFile(f,html);
  }
}

// Extract explicit dates, but continuity is checked month-by-month.
const explicitDates=new Set(), dateSources={};
for(const f of files){
  if(!/\.(?:html?|css|js|mjs|json|txt|xml)$/i.test(f))continue;
  const t=await fs.readFile(f,"utf8").catch(()=>null); if(!t)continue;
  const local=new Set(); let m;
  const iso=/\b(20\d{2})-([01]\d)-([0-3]\d)\b/g;
  while((m=iso.exec(t))){const d=`${m[1]}-${m[2]}-${m[3]}`;local.add(d);explicitDates.add(d)}
  const dmy=/\b([0-3]\d)\/([01]\d)\/(20\d{2})\b/g;
  while((m=dmy.exec(t))){const d=`${m[3]}-${m[2]}-${m[1]}`;local.add(d);explicitDates.add(d)}
  if(local.size)dateSources[path.relative(DIST,f)]=[...local].sort();
}
function daysInMonth(ym){
  const [y,m]=ym.split("-").map(Number);
  const n=new Date(Date.UTC(y,m,0)).getUTCDate();
  return Array.from({length:n},(_,i)=>`${ym}-${String(i+1).padStart(2,"0")}`);
}
function monthRange(a,b){
  const out=[]; let d=new Date(a.slice(0,7)+"-01T12:00:00Z"), end=new Date(b.slice(0,7)+"-01T12:00:00Z");
  while(d<=end){out.push(d.toISOString().slice(0,7));d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1,12))}
  return out;
}
const monthly=monthRange(START,END).map(ym=>{
  let expected=daysInMonth(ym);
  if(ym===START.slice(0,7))expected=expected.filter(d=>d>=START);
  if(ym===END.slice(0,7))expected=expected.filter(d=>d<=END);
  const present=expected.filter(d=>explicitDates.has(d));
  const missing=expected.filter(d=>!explicitDates.has(d));
  return {
    month:ym,
    expected_days:expected.length,
    detected_days:present.length,
    missing_days:missing.length,
    status:present.length===0?"FALTANTE":(missing.length===0?"COMPLETO":"INCOMPLETO"),
    first_missing:missing[0]||null,
    last_missing:missing.at(-1)||null
  };
});
const independenceRemaining=[];
for(const f of files){
  if(/\.(?:html?|css|js|mjs|json|txt|xml|svg)$/i.test(f)){
    const t=await fs.readFile(f,"utf8").catch(()=>null);
    if(t&&/chatgpt\.site/i.test(t))independenceRemaining.push(path.relative(DIST,f));
  }
}

const audit={
  generated_at:new Date().toISOString(),
  source_copied_once:ORIGIN,
  source_files_copied:copied.length,
  external_media_localized:externalCopied.length,
  failures,
  required_start:START,
  required_end:END,
  pricing_rule:{
    description:"Total Portal Caribe = suma real de noches Royal Elite + USD 1.000",
    portal_margin_usd:PORTAL_MARGIN,
    margin_frequency:"una sola vez por operación, NO por noche"
  },
  monthly_coverage:monthly,
  all_months_complete:monthly.every(x=>x.status==="COMPLETO"),
  date_sources:Object.keys(dateSources),
  chatgpt_runtime_references_remaining:independenceRemaining
};
await fs.writeFile(path.join(DIST,"AUDITORIA_V5.json"),JSON.stringify(audit,null,2));

// Public/private audit page
const rows=monthly.map(x=>`<tr><td>${x.month}</td><td>${x.expected_days}</td><td>${x.detected_days}</td><td>${x.missing_days}</td><td class="${x.status==='COMPLETO'?'ok':'bad'}">${x.status}</td><td>${x.first_missing||'-'}</td></tr>`).join("");
const auditHTML=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Auditoría V5 - Portal Caribe</title>
<style>body{font-family:Arial;margin:0;background:#f5eee5;color:#173b41}.w{max-width:1100px;margin:40px auto;padding:0 20px}h1{font-family:Georgia;font-size:48px}.card{background:white;padding:24px;border-radius:20px;margin:18px 0}.ok{color:#18764b;font-weight:700}.bad{color:#b03a2e;font-weight:700}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left;font-size:14px}code{background:#eee;padding:2px 5px;border-radius:5px}</style></head><body><div class="w">
<h1>Auditoría Portal Caribe V5</h1>
<div class="card"><h2>Regla comercial</h2><p><b>Total Portal Caribe = suma real de todas las noches Royal Elite + USD 1.000.</b></p><p>El USD 1.000 se suma <b>una sola vez por operación</b>, no por noche.</p></div>
<div class="card"><h2>Independencia</h2><p class="${independenceRemaining.length?'bad':'ok'}">${independenceRemaining.length?'⚠ Hay referencias pendientes':'✓ Sin referencias de ejecución a chatgpt.site'}</p></div>
<div class="card"><h2>Cobertura real por mes</h2><table><thead><tr><th>Mes</th><th>Días esperados</th><th>Días detectados</th><th>Faltan</th><th>Estado</th><th>Primer faltante</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="card"><h2>Control</h2><p class="${monthly.every(x=>x.status==='COMPLETO')?'ok':'bad'}">${monthly.every(x=>x.status==='COMPLETO')?'✓ Cobertura completa hasta agosto 2027':'⚠ No se debe cotizar automáticamente en meses/días faltantes.'}</p><p>Detalle técnico: <a href="/AUDITORIA_V5.json">AUDITORIA_V5.json</a></p></div>
</div></body></html>`;
await fs.writeFile(path.join(DIST,"auditoria-v5.html"),auditHTML);

console.log("V5 build complete");
