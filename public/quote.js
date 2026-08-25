const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("hu-HU");
let quoteData = null;

function esc(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]))}
function money(value,currency="Ft"){return `${fmt.format(Number(value)||0)} ${currency}`}
function initials(value){return String(value||"K").split(/\s+/).filter(Boolean).slice(0,2).map(v=>v[0]).join("").toUpperCase()||"K"}

function quoteRequest(){
  const parts=location.pathname.split("/").filter(Boolean);
  if(parts[0]==="ajanlat-preview"&&parts[1]) return {url:`/api/admin/quotes/${encodeURIComponent(parts[1])}`,preview:true};
  if(parts[0]==="ajanlat"&&parts[1]) return {url:`/api/quote/${encodeURIComponent(parts[1])}`,preview:false};
  return null;
}

async function init(){
  const request=quoteRequest();
  if(!request){showError("Az ajánlat linkje hibás.");return}
  try{
    const res=await fetch(request.url,{credentials:"include",cache:"no-store"});
    const data=await res.json().catch(()=>({}));
    if(!res.ok||!data.ok)throw new Error(data.error||"Az ajánlat nem található.");
    quoteData=data.quote;
    render(quoteData,request.preview);
    $("loadingScreen").hidden=true;$("quoteApp").hidden=false;
    setupInteractions(request.preview);
  }catch(err){showError(err.message)}
}

function showError(message){$("loadingScreen").hidden=true;$("errorScreen").hidden=false;$("errorMessage").textContent=message||"Az ajánlat nem található."}

function render(q,preview){
  const c=q.content||{};
  document.title=`KRILIX × ${q.clientName||"Ügyfél"} — Árajánlat`;
  document.documentElement.style.setProperty("--accent",c.accent||"#D94E87");
  $("quoteEyebrow").textContent=c.eyebrow||"Személyre szabott ajánlat";
  $("heroTitle").textContent=c.projectTitle||q.clientName||"Projekt";
  $("heroAccent").textContent=c.projectAccent||"weboldal";
  $("heroDescription").textContent=c.description||"";
  $("metaProject").textContent=`${q.clientName||"Ügyfél"} ${c.projectAccent||"projekt"}`;
  $("metaDuration").textContent=c.duration||"—";
  $("metaValidity").textContent=q.isExpired?"Lejárt":`${q.validityDays||14} nap`;
  $("heroPrice").textContent=money(q.totalPrice,q.currency);
  $("heroPayment").textContent=c.payment||"—";
  $("floatingTag").textContent=`KRILIX × ${String(q.clientName||"").toUpperCase()}`;

  const logo=$("clientLogo"),fallback=$("clientInitials");
  if(c.clientLogo){logo.src=c.clientLogo;logo.hidden=false;fallback.hidden=true}else{logo.hidden=true;fallback.hidden=false;fallback.textContent=initials(q.clientName)}

  $("overviewTitle").textContent=c.overviewTitle||"Projekt áttekintése,";
  $("overviewAccent").textContent=c.overviewAccent||"röviden.";
  $("overviewDescription").textContent=c.overviewDescription||"";

  const features=Array.isArray(c.features)?c.features:[];
  $("featureGrid").innerHTML=features.map((f,i)=>`<article class="feature-card ${f.accent?"accent":""} reveal"><div class="feature-top"><span>${String(i+1).padStart(2,"0")}</span><b>${esc(String(f.title||"").toUpperCase())}</b></div><p>${esc(f.description||"")}</p><i class="card-arrow">↗</i></article>`).join("")||'<div class="feature-card reveal"><div class="feature-top"><b>PROJEKT</b></div><p>A részletes projekt tartalma egyeztetés szerint.</p></div>';

  $("totalPrice").textContent=fmt.format(q.totalPrice||0);$("currency").textContent=q.currency||"Ft";$("payment").textContent=c.payment||"—";
  const items=Array.isArray(c.items)?c.items:[];
  $("lineItems").innerHTML=items.map((item,i)=>`<div class="line-item"><span class="item-index ${item.accent?"accent":""}">${String(i+1).padStart(2,"0")}</span><div><b>${esc(item.title||"")}</b><small>${esc(item.description||"")}</small></div><strong>${esc(money(item.price,q.currency))}</strong></div>`).join("");

  const timeline=Array.isArray(c.timeline)?c.timeline:[];
  $("timeline").style.setProperty("--timeline-count",Math.max(1,timeline.length));
  $("timeline").innerHTML='<div class="timeline-line"></div>'+timeline.map((m,i)=>`<div class="milestone ${m.accent?"active":""}"><span class="dot"></span><small>${String(i+1).padStart(2,"0")}</small><b>${esc(String(m.title||"").toUpperCase())}</b><p>${esc(m.description||"")}</p></div>`).join("");

  const terms=Array.isArray(c.terms)?c.terms:[];
  $("terms").style.setProperty("--term-count",Math.max(1,terms.length));
  $("terms").innerHTML=terms.map(term=>`<div class="term"><span>${esc(String(term.label||"").toUpperCase())}</span><strong>${esc(term.title||"")}</strong><p>${esc(term.description||"")}</p></div>`).join("");

  const acceptance=c.acceptance||{};
  $("acceptTitle").textContent=acceptance.title||"Indulhat a";$("acceptAccent").textContent=acceptance.accent||"projekt.";$("acceptDescription").textContent=acceptance.description||"Az ajánlat elfogadása után egyeztetjük a következő lépéseket.";
  $("footerQuote").textContent=`${String(q.clientName||"").toUpperCase()} — ÁRAJÁNLAT`;$("footerCode").textContent=q.quoteCode||"";
  $("modalQuoteTitle").textContent=`${q.clientName||"Ajánlat"} — ${money(q.totalPrice,q.currency)}`;
  $("acceptTermsText").textContent=`Elfogadom a ${money(q.totalPrice,q.currency)} összegű ajánlatot és a fent rögzített feltételeket.`;
  if(q.clientEmail)$("acceptEmail").value=q.clientEmail;

  if(preview){$("topAcceptLink").textContent="ELŐNÉZET";$("acceptButton").disabled=true;$("acceptButton").querySelector("span").textContent="ADMIN ELŐNÉZET"}
  else if(q.status==="accepted")showAccepted(q);
  else if(q.isExpired){$("topAcceptLink").textContent="LEJÁRT";$("acceptButton").disabled=true;$("acceptButton").querySelector("span").textContent="AJÁNLAT LEJÁRT"}
  else if(acceptance.enabled===false){$("acceptButton").style.display="none";$("topAcceptLink").style.display="none"}
}

function showAccepted(q){
  $("acceptButton").disabled=true;$("acceptButton").querySelector("span").textContent="AJÁNLAT ELFOGADVA";$("topAcceptLink").textContent="ELFOGADVA";
  const meta=$("acceptedMeta");meta.hidden=false;meta.textContent=`Elfogadva${q.acceptedName?` — ${q.acceptedName}`:""}${q.acceptedAt?` · ${new Date(q.acceptedAt).toLocaleString("hu-HU")}`:""}.`;
}

function setupInteractions(preview){
  const glow=$("cursor-glow");window.addEventListener("pointermove",e=>{if(glow){glow.style.left=e.clientX+"px";glow.style.top=e.clientY+"px"}});
  const io=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting)entry.target.classList.add("visible")}),{threshold:.12});document.querySelectorAll(".reveal,.timeline").forEach(el=>io.observe(el));
  $("printButton").addEventListener("click",()=>window.print());
  const logo=$("clientLogo");logo?.addEventListener("mouseenter",()=>logo.style.animationDuration="5s");logo?.addEventListener("mouseleave",()=>logo.style.animationDuration="22s");
  if(preview)return;
  const modal=$("acceptModal");const setModal=open=>{modal.classList.toggle("open",open);modal.setAttribute("aria-hidden",String(!open));document.body.style.overflow=open?"hidden":""};
  $("acceptButton").addEventListener("click",()=>{if(!$("acceptButton").disabled)setModal(true)});document.querySelectorAll("[data-close-modal]").forEach(el=>el.addEventListener("click",()=>setModal(false)));window.addEventListener("keydown",e=>{if(e.key==="Escape")setModal(false)});
  $("acceptForm").addEventListener("submit",async e=>{e.preventDefault();const note=$("acceptFormNote");note.textContent="Elfogadás rögzítése...";note.className="form-note";const btn=e.currentTarget.querySelector("button[type=submit]");btn.disabled=true;try{const parts=location.pathname.split("/").filter(Boolean);const slug=parts[1];const res=await fetch(`/api/quote/${encodeURIComponent(slug)}/accept`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:$("acceptName").value.trim(),email:$("acceptEmail").value.trim(),acceptTerms:$("acceptTerms").checked})});const data=await res.json().catch(()=>({}));if(!res.ok||!data.ok)throw new Error(data.error||"Nem sikerült elfogadni az ajánlatot.");quoteData=data.quote;note.textContent="Az ajánlat elfogadása sikeresen rögzítve.";note.className="form-note success";showAccepted(data.quote);setTimeout(()=>setModal(false),900)}catch(err){note.textContent=err.message;note.className="form-note error"}finally{btn.disabled=false}});
}

init();
