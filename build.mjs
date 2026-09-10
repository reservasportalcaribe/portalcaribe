import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ORIGIN = "https://tu-semana-sandos.gluck-yanina.chatgpt.site";
const HOST = new URL(ORIGIN).host;
const DIST = path.resolve("dist");
const ASSETDIR = path.join(DIST,"_local");
const START = ORIGIN + "/";
const seen = new Set();
const queue = [START];
const rewrite = new Map();
const failures = [];
const copied = [];
const externalCopied = [];

await fs.rm(DIST,{recursive:true,force:true});
await fs.mkdir(ASSETDIR,{recursive:true});

const textTypes = /(?:text\/|javascript|json|xml|svg|application\/.*(?:javascript|json))/i;
const mediaExt = /\.(?:png|jpe?g|webp|gif|svg|ico|avif|mp4|webm|mov|m4v|woff2?|ttf|otf)(?:\?.*)?$/i;
const localAssetExt = /\.(?:html?|css|js|mjs|json|xml|txt|png|jpe?g|webp|gif|svg|ico|avif|mp4|webm|mov|m4v|woff2?|ttf|otf)(?:\?.*)?$/i;

function hash(s){ return crypto.createHash("sha1").update(s).digest("hex").slice(0,16); }
function cleanExt(url,ct=""){
  let ext=path.extname(new URL(url).pathname).toLowerCase();
  if(ext && ext.length<8) return ext;
  if(/image\/jpeg/i.test(ct)) return ".jpg";
  if(/image\/png/i.test(ct)) return ".png";
  if(/image\/webp/i.test(ct)) return ".webp";
  if(/image\/gif/i.test(ct)) return ".gif";
  if(/image\/svg/i.test(ct)) return ".svg";
  if(/video\/mp4/i.test(ct)) return ".mp4";
  if(/font\/woff2/i.test(ct)) return ".woff2";
  if(/font\/woff/i.test(ct)) return ".woff";
  if(/text\/css/i.test(ct)) return ".css";
  if(/javascript/i.test(ct)) return ".js";
  if(/json/i.test(ct)) return ".json";
  if(/html/i.test(ct)) return ".html";
  return ".bin";
}
function outputFor(url,ct=""){
  const u=new URL(url);
  let p=decodeURIComponent(u.pathname);
  if(p==="/" || p.endsWith("/")) p += "index.html";
  if(!path.extname(p) && /html/i.test(ct)) p += ".html";
  if(u.search) {
    const ext=path.extname(p);
    const stem=ext?p.slice(0,-ext.length):p;
    p=stem+"__"+hash(u.search)+(ext||cleanExt(url,ct));
  }
  return path.join(DIST,p.replace(/^\/+/,""));
}
function localURL(url,ct=""){
  const u=new URL(url);
  if(u.host===HOST){
    let p=decodeURIComponent(u.pathname);
    if(p==="/") return "/";
    if(p.endsWith("/")) return p;
    if(!path.extname(p) && /html/i.test(ct)) return p+".html";
    return p + (u.search ? "__"+hash(u.search) : "");
  }
  const ext=cleanExt(url,ct);
  return "/_local/external/"+hash(url)+ext;
}
function absolute(raw,base){
  try{
    if(!raw || /^(?:data:|blob:|mailto:|tel:|javascript:|#)/i.test(raw)) return null;
    return new URL(raw,base).href;
  }catch{return null}
}
function candidates(text,base){
  const found=new Set();
  const regexes=[
    /(?:src|href|poster|data-src|data-lazy-src)=["']([^"'<>]+)["']/gi,
    /(?:srcset|data-srcset)=["']([^"']+)["']/gi,
    /url\(\s*["']?([^)"']+)["']?\s*\)/gi,
    /["'`](\/[^"'`\s<>]+\.(?:css|js|mjs|json|xml|png|jpe?g|webp|gif|svg|ico|avif|mp4|webm|mov|m4v|woff2?|ttf|otf)(?:\?[^"'`\s<>]*)?)["'`]/gi,
    /["'`](https?:\/\/[^"'`\s<>]+)["'`]/gi
  ];
  for(const re of regexes){
    let m;
    while((m=re.exec(text))){
      let raws=[];
      if(re.source.includes("srcset")){
        raws=(m[1]||"").split(",").map(x=>x.trim().split(/\s+/)[0]);
      } else raws=[m[1]];
      for(const raw of raws){
        const a=absolute(raw,base);
        if(a) found.add(a);
      }
    }
  }
  return [...found];
}
async function fetchBuffer(url){
  const r=await fetch(url,{redirect:"follow",headers:{"user-agent":"Mozilla/5.0 PortalCaribeIndependent/4.0"}});
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return {buf:Buffer.from(await r.arrayBuffer()),ct:r.headers.get("content-type")||"",final:r.url};
}
async function localizeExternal(url){
  if(rewrite.has(url)) return rewrite.get(url);
  try{
    const {buf,ct}=await fetchBuffer(url);
    if(!mediaExt.test(new URL(url).pathname) && !/(?:image|video|font)\//i.test(ct)) return null;
    const rel=localURL(url,ct);
    const out=path.join(DIST,rel.replace(/^\//,""));
    await fs.mkdir(path.dirname(out),{recursive:true});
    await fs.writeFile(out,buf);
    rewrite.set(url,rel);
    externalCopied.push({url,rel,bytes:buf.length});
    return rel;
  }catch(e){
    failures.push({url,error:String(e.message),kind:"external"});
    return null;
  }
}
async function crawl(url){
  if(seen.has(url)) return;
  seen.add(url);
  try{
    const r=await fetch(url,{redirect:"follow",headers:{"user-agent":"Mozilla/5.0 PortalCaribeIndependent/4.0"}});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const ct=r.headers.get("content-type")||"";
    const isText=textTypes.test(ct);
    let payload;
    if(isText){
      let text=await r.text();
      const refs=candidates(text,url);

      // Queue every same-origin resource. Localize external images/video/fonts.
      for(const ref of refs){
        const u=new URL(ref);
        if(u.host===HOST){
          if(localAssetExt.test(u.pathname+u.search) || u.pathname==="/" || u.pathname.endsWith("/")){
            if(!seen.has(ref)) queue.push(ref);
          }
        } else if(mediaExt.test(u.pathname+u.search)){
          await localizeExternal(ref);
        }
      }

      // Rewrite absolute origin links to local paths while preserving anchors.
      text=text.replaceAll(ORIGIN,"");
      for(const [from,to] of rewrite) text=text.split(from).join(to);
      payload=Buffer.from(text,"utf8");
    }else{
      payload=Buffer.from(await r.arrayBuffer());
    }
    const out=outputFor(url,ct);
    await fs.mkdir(path.dirname(out),{recursive:true});
    await fs.writeFile(out,payload);
    copied.push({url,file:path.relative(DIST,out),ct,bytes:payload.length});
  }catch(e){
    failures.push({url,error:String(e.message),kind:"same-origin"});
  }
}

while(queue.length){
  const u=queue.shift();
  await crawl(u);
}

// Second pass: rewrite external media URLs that were discovered after parent files were written.
async function walk(dir){
  const out=[];
  for(const e of await fs.readdir(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}
let files=await walk(DIST);
for(const f of files){
  if(/\.(?:html?|css|js|mjs|json|xml|svg|txt)$/i.test(f)){
    let t=await fs.readFile(f,"utf8").catch(()=>null);
    if(!t) continue;
    t=t.replaceAll(ORIGIN,"");
    for(const [from,to] of rewrite) t=t.split(from).join(to);
    await fs.writeFile(f,t);
  }
}

// Detect tariff coverage in every copied text resource.
// We accept dd/mm/yyyy and yyyy-mm-dd. This audit is intentionally strict.
files=await walk(DIST);
const dateSet=new Set();
const rateFiles=[];
for(const f of files){
  if(/\.(?:html?|css|js|mjs|json|txt|xml)$/i.test(f)){
    const t=await fs.readFile(f,"utf8").catch(()=>null);
    if(!t) continue;
    const before=dateSet.size;
    let m;
    const dmy=/\b([0-3]\d)\/([01]\d)\/(20\d{2})\b/g;
    while((m=dmy.exec(t))) dateSet.add(`${m[3]}-${m[2]}-${m[1]}`);
    const iso=/\b(20\d{2})-([01]\d)-([0-3]\d)\b/g;
    while((m=iso.exec(t))) dateSet.add(`${m[1]}-${m[2]}-${m[3]}`);
    if(dateSet.size>before) rateFiles.push(path.relative(DIST,f));
  }
}
const dates=[...dateSet].sort();
const maxDate=dates.length?dates[dates.length-1]:null;
const minDate=dates.length?dates[0]:null;
const requiredEnd="2027-08-31";
const coverageOK=!!maxDate && maxDate>=requiredEnd;

// Detect remaining runtime dependencies on chatgpt.site.
const remaining=[];
for(const f of files){
  if(/\.(?:html?|css|js|mjs|json|txt|xml|svg)$/i.test(f)){
    const t=await fs.readFile(f,"utf8").catch(()=>null);
    if(t && /chatgpt\.site/i.test(t)) remaining.push(path.relative(DIST,f));
  }
}

const audit={
  generated_at:new Date().toISOString(),
  source_copied_once:ORIGIN,
  source_files_copied:copied.length,
  external_media_localized:externalCopied.length,
  failures,
  tariff_date_min:minDate,
  tariff_date_max:maxDate,
  required_tariff_end:requiredEnd,
  tariff_coverage_ok:coverageOK,
  files_with_dates:[...new Set(rateFiles)],
  chatgpt_runtime_references_remaining:remaining
};
await fs.writeFile(path.join(DIST,"AUDITORIA.json"),JSON.stringify(audit,null,2));

// Human-readable private audit page.
const auditHTML=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Auditoría Portal Caribe</title>
<style>body{font:16px Arial;margin:0;background:#f6efe6;color:#173b41}.w{max-width:1000px;margin:40px auto;padding:0 20px}
h1{font:48px Georgia;margin-bottom:10px}.card{background:white;border-radius:20px;padding:24px;margin:16px 0}
.ok{color:#18764b}.bad{color:#a6382a}code{background:#eee;padding:2px 5px;border-radius:5px}
table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}</style></head>
<body><div class="w"><h1>Auditoría Portal Caribe</h1>
<div class="card"><h2>Independencia</h2><p class="${remaining.length?'bad':'ok'}">${remaining.length?'⚠ Quedaron referencias al dominio anterior':'✓ Sin referencias de ejecución a chatgpt.site'}</p>
<p>Archivos copiados: <b>${copied.length}</b> · Medios externos guardados localmente: <b>${externalCopied.length}</b></p></div>
<div class="card"><h2>Tarifario encontrado dentro del sitio copiado</h2>
<p>Primera fecha detectada: <b>${minDate||'No detectada'}</b><br>Última fecha detectada: <b>${maxDate||'No detectada'}</b><br>Objetivo: <b>${requiredEnd}</b></p>
<p class="${coverageOK?'ok':'bad'}">${coverageOK?'✓ El material copiado llega al menos hasta agosto de 2027.':'⚠ El material copiado NO demuestra todavía cobertura hasta agosto de 2027. No se debe mostrar una tarifa inventada fuera del rango detectado.'}</p>
<p>Archivos que contienen fechas: ${[...new Set(rateFiles)].map(x=>`<code>${x}</code>`).join(" ")||"ninguno"}</p></div>
<div class="card"><h2>Control técnico</h2><p>El sitio público conserva su cotizador original y sus propias reglas/tarifas. Esta página solo audita lo que Netlify copió.</p><p>Archivo detallado: <a href="/AUDITORIA.json">AUDITORIA.json</a></p></div>
</div></body></html>`;
await fs.writeFile(path.join(DIST,"auditoria-tarifas.html"),auditHTML);

// Netlify SPA fallback only if source had its own routing; keep real assets first.
await fs.writeFile(path.join(DIST,"_headers"),`/*\n  X-Content-Type-Options: nosniff\n`);
console.log(JSON.stringify(audit,null,2));

// IMPORTANT: don't silently publish a bad tariff range.
// We don't fail the build, because some apps encode rates without literal dates in minified bundles.
// The audit page makes it explicit and the original app itself remains responsible for blocking dates outside its tariff.
