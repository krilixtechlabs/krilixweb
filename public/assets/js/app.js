
const dict={
  en:{
    "nav.work":"Work","nav.services":"Services","nav.about":"About","nav.process":"Process","nav.contact":"Contact","nav.start":"Start a project","btn.explore":"EXPLORE","footer.studio":"Independent digital studio · Hungary",
    "hero.tag":"Digital systems for businesses that refuse to look <em>ordinary.</em>",
    "statement":"We don't want Krilix to be recognizable on every project. We want <span class='serif'>every client to be recognizable on their own.</span>",
    "word.copy":"Websites, booking systems, admin interfaces and automations — designed as one coherent digital system.",
    "work.title":"SELECTED<br>WORK.",
    "services.title":"WHAT WE<br>BUILD.",
    "about.title":"BUILT<br>DIFFERENT.",
    "process.title":"FROM IDEA<br>TO LIVE.",
    "contact.title":"START<br><span class='serif'>something new.</span>"
  },
  de:{
    "nav.work":"Projekte","nav.services":"Leistungen","nav.about":"Über uns","nav.process":"Ablauf","nav.contact":"Kontakt","nav.start":"Projekt starten","btn.explore":"ENTDECKEN","footer.studio":"Unabhängiges digitales Studio · Ungarn",
    "hero.tag":"Digitale Systeme für Unternehmen, die nicht <em>gewöhnlich</em> aussehen wollen.",
    "statement":"Krilix soll nicht in jedem Projekt erkennbar sein. <span class='serif'>Jeder Kunde soll in seinem eigenen Auftritt erkennbar sein.</span>",
    "word.copy":"Websites, Buchungssysteme, Adminbereiche und Automatisierungen — als ein zusammenhängendes digitales System.",
    "work.title":"AUSGEWÄHLTE<br>PROJEKTE.",
    "services.title":"WAS WIR<br>BAUEN.",
    "about.title":"ANDERS<br>GEBAUT.",
    "process.title":"VON DER IDEE<br>BIS LIVE.",
    "contact.title":"START<br><span class='serif'>something new.</span>"
  }
};
const hu={};
document.querySelectorAll("[data-i18n]").forEach(el=>hu[el.dataset.i18n]=el.innerHTML);

function setLang(lang){
  localStorage.setItem("krilix-v5-lang",lang);
  document.documentElement.lang=lang;
  document.querySelectorAll("[data-i18n]").forEach(el=>{
    const key=el.dataset.i18n;
    if(lang==="hu") el.innerHTML=hu[key]??el.innerHTML;
    else if(dict[lang]?.[key]) el.innerHTML=dict[lang][key];
  });
  document.querySelectorAll("[data-lang]").forEach(b=>b.classList.toggle("active",b.dataset.lang===lang));
}
setLang(localStorage.getItem("krilix-v5-lang")||"hu");
document.querySelectorAll("[data-lang]").forEach(b=>b.addEventListener("click",()=>setLang(b.dataset.lang)));

const floatbar=document.querySelector(".floatbar");
const homeHero=document.querySelector(".home-hero");
function handleFloat(){
  if(!floatbar) return;
  if(homeHero){
    const threshold=Math.max(420,homeHero.offsetHeight*.72);
    floatbar.classList.toggle("visible",scrollY>threshold);
  }else{
    floatbar.classList.add("visible");
  }
}
handleFloat();
addEventListener("scroll",handleFloat,{passive:true});
addEventListener("resize",handleFloat);

function openMenu(){document.body.classList.add("menu-open")}
function closeMenu(){document.body.classList.remove("menu-open")}
document.querySelectorAll(".menu-trigger,.inner-menu-btn,.case-menu-btn").forEach(b=>b.addEventListener("click",openMenu));
document.querySelector(".close-menu")?.addEventListener("click",closeMenu);
document.querySelectorAll(".menu-overlay a").forEach(a=>a.addEventListener("click",closeMenu));
addEventListener("keydown",e=>{if(e.key==="Escape")closeMenu()});

const io=new IntersectionObserver(entries=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}})
},{threshold:.12});
document.querySelectorAll(".reveal").forEach(el=>io.observe(el));
document.querySelectorAll("[data-year]").forEach(el=>el.textContent=new Date().getFullYear());
