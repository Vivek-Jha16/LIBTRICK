/* ============================================================
   STACKROOM
   A PDF library that files itself.

   Everything runs on-device:
   - pdf.js pulls text out of each PDF
   - a small keyword model guesses the subject + tags
   - IndexedDB stores the file bytes + metadata in the browser
   No network calls, no server, no accounts.
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ---------- "AI" subject model -------------------------------
   A tiny, transparent classifier: score the extracted text
   against per-subject keyword sets, pick the highest scorer.
   No black box — you can read exactly why a doc landed where it did. */

const SUBJECTS = {
  Technology: { code:"TEC", words:["algorithm","software","code","api","database","network","server","cloud","programming","javascript","python","hardware","computer","interface","framework","repository","encryption","machine learning","artificial intelligence","application"] },
  Finance:    { code:"FIN", words:["invoice","budget","revenue","tax","investment","expense","financial","accounting","payment","balance","income","audit","dividend","asset","liability","shareholder","interest rate","portfolio","currency","statement"] },
  Legal:      { code:"LAW", words:["contract","agreement","clause","hereby","plaintiff","defendant","jurisdiction","statute","liability","covenant","pursuant","tribunal","litigation","testimony","witness","attorney","legislation","regulation"] },
  Health:     { code:"MED", words:["patient","diagnosis","treatment","clinical","medical","symptom","therapy","medicine","hospital","physician","dosage","prescription","surgery","disease","vaccine","nutrition","anatomy"] },
  Education:  { code:"EDU", words:["syllabus","curriculum","lecture","homework","university","semester","exam","student","assignment","chapter","tuition","classroom","professor","enrollment","coursework","thesis"] },
  Science:    { code:"SCI", words:["hypothesis","experiment","methodology","laboratory","analysis","observation","variable","specimen","molecule","reaction","equation","theorem","spectrum","organism","catalyst"] },
  Literature: { code:"LIT", words:["chapter","novel","poem","character","narrative","protagonist","stanza","verse","manuscript","author","fiction","dialogue","metaphor","plot"] },
  Business:   { code:"BUS", words:["strategy","marketing","management","stakeholder","proposal","quarterly","roadmap","revenue growth","leadership","operations","logistics","supply chain","branding","negotiation","forecast"] },
  Design:     { code:"DES", words:["typography","layout","wireframe","prototype","palette","usability","interface design","composition","grid system","branding guideline","illustration","mockup"] },
  Reference:  { code:"REF", words:["manual","instructions","warranty","specification","installation","troubleshooting","assembly","maintenance","user guide","datasheet","appendix","glossary"] },
  Personal:   { code:"PER", words:["resume","curriculum vitae","passport","certificate","receipt","itinerary","application form","cover letter","reference letter"] },
};
const FALLBACK_SUBJECT = { name:"General", code:"GEN" };

const STOPWORDS = new Set("the a an and or but if then else when at by for with about against between into through during before after above below to from up down in out on off over under again further once here there all any both each few more most other some such no nor not only own same so than too very can will just should now this that these those was were been being have has had do does did doing you your yours she her hers him his they them their what which who whom it its our ours us we i me my mine also may might must shall would could".split(" "));

function scoreText(text){
  const t = " " + text.toLowerCase() + " ";
  const scores = {};
  for (const [name, def] of Object.entries(SUBJECTS)){
    let s = 0;
    for (const w of def.words){
      const re = new RegExp("\\b" + w.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&") + "\\b","g");
      const m = t.match(re);
      if (m) s += m.length;
    }
    scores[name] = s;
  }
  let best = FALLBACK_SUBJECT.name, bestScore = 0;
  for (const [name, s] of Object.entries(scores)){
    if (s > bestScore){ best = name; bestScore = s; }
  }
  if (bestScore === 0) return { name: FALLBACK_SUBJECT.name, code: FALLBACK_SUBJECT.code, confidence:0 };
  return { name: best, code: SUBJECTS[best].code, confidence: bestScore };
}

function extractTags(text, max=5){
  const freq = {};
  const words = (text.toLowerCase().match(/[a-z]{4,}/g)) || [];
  for (const w of words){
    if (STOPWORDS.has(w)) continue;
    freq[w] = (freq[w]||0) + 1;
  }
  return Object.entries(freq)
    .sort((a,b)=> b[1]-a[1])
    .slice(0, max)
    .map(([w])=> w);
}

function guessTitle(filename, metaTitle){
  if (metaTitle && metaTitle.trim().length > 2) return metaTitle.trim();
  let n = filename.replace(/\.pdf$/i,"");
  n = n.replace(/[_-]+/g," ").replace(/\s+/g," ").trim();
  return n.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1));
}

function cleanSnippet(text){
  const collapsed = text.replace(/\s+/g," ").trim();
  if (!collapsed) return "No extractable text — this PDF may be a scan or image-based.";
  return collapsed.slice(0, 260) + (collapsed.length > 260 ? "…" : "");
}

async function readPdf(file){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  const meta = await pdf.getMetadata().catch(()=>null);
  const pageCount = pdf.numPages;
  const pagesToRead = Math.min(pageCount, 6);
  for (let i=1; i<=pagesToRead; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += " " + content.items.map(it=>it.str).join(" ");
  }
  return {
    text,
    pageCount,
    metaTitle: meta && meta.info && meta.info.Title ? meta.info.Title : null,
  };
}

/* ---------- IndexedDB ------------------------------------- */

const DB_NAME = "stackroomDB";
const STORE = "documents";
let dbPromise = new Promise((resolve, reject)=>{
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE)){
      db.createObjectStore(STORE, { keyPath:"id" });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function dbAll(){
  const db = await dbPromise;
  return new Promise((resolve,reject)=>{
    const tx = db.transaction(STORE,"readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
async function dbPut(record){
  const db = await dbPromise;
  return new Promise((resolve,reject)=>{
    const tx = db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}
async function dbDelete(id){
  const db = await dbPromise;
  return new Promise((resolve,reject)=>{
    const tx = db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}

/* ---------- App state --------------------------------------- */

let docs = [];          // in-memory mirror of the DB
let activeCategory = "all";
let searchQuery = "";
let sortMode = "added-desc";

const el = (id)=> document.getElementById(id);
const catalogGrid = el("catalogGrid");
const emptyState = el("emptyState");
const drawerList = el("drawerList");
const queueEl = el("queue");
const queueList = el("queueList");

function fmtBytes(n){
  if (n < 1024) return n + " B";
  if (n < 1024*1024) return (n/1024).toFixed(1) + " KB";
  return (n/1024/1024).toFixed(1) + " MB";
}
function fmtDate(ts){
  return new Date(ts).toLocaleDateString(undefined,{ month:"short", day:"numeric", year:"numeric" });
}

/* ---------- Rendering ----------------------------------------- */

function categoryCounts(){
  const counts = {};
  for (const d of docs) counts[d.category] = (counts[d.category]||0)+1;
  return counts;
}

function renderDrawers(){
  const counts = categoryCounts();
  const names = Object.keys(counts).sort();
  el("countAll").textContent = docs.length;
  drawerList.querySelectorAll("[data-generated]").forEach(n=>n.remove());
  for (const name of names){
    const li = document.createElement("li");
    li.dataset.generated = "1";
    const btn = document.createElement("button");
    btn.className = "drawer-tab" + (activeCategory===name ? " active":"");
    btn.dataset.cat = name;
    btn.innerHTML = `${name}<span class="drawer-count">${counts[name]}</span>`;
    btn.addEventListener("click", ()=>{ activeCategory=name; renderAll(); });
    li.appendChild(btn);
    drawerList.appendChild(li);
  }
  drawerList.querySelector('[data-cat="all"]').classList.toggle("active", activeCategory==="all");
}

function visibleDocs(){
  let list = docs.slice();
  if (activeCategory !== "all") list = list.filter(d=>d.category===activeCategory);
  if (searchQuery){
    const q = searchQuery.toLowerCase();
    list = list.filter(d=>
      d.title.toLowerCase().includes(q) ||
      d.category.toLowerCase().includes(q) ||
      d.tags.some(t=>t.includes(q)) ||
      (d.snippet && d.snippet.toLowerCase().includes(q)) ||
      (d.notes && d.notes.toLowerCase().includes(q))
    );
  }
  switch(sortMode){
    case "added-asc": list.sort((a,b)=>a.addedAt-b.addedAt); break;
    case "title-asc": list.sort((a,b)=>a.title.localeCompare(b.title)); break;
    case "category-asc": list.sort((a,b)=>a.category.localeCompare(b.category) || a.title.localeCompare(b.title)); break;
    default: list.sort((a,b)=>b.addedAt-a.addedAt);
  }
  return list;
}

function renderGrid(){
  const list = visibleDocs();
  catalogGrid.innerHTML = "";
  emptyState.classList.toggle("show", docs.length===0);
  catalogGrid.style.display = list.length===0 ? "none" : "grid";

  for (const d of list){
    const card = document.createElement("article");
    card.className = "card";
    card.tabIndex = 0;
    card.innerHTML = `
      <p class="card-callnum">${d.callNumber}</p>
      <h3 class="card-title">${escapeHtml(d.title)}</h3>
      <p class="card-snippet">${escapeHtml(d.snippet)}</p>
      <div class="card-tags">${d.tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
      <div class="card-meta">
        <span class="card-cat-badge">${escapeHtml(d.category)}</span>
        <span>${fmtBytes(d.size)} · ${fmtDate(d.addedAt)}</span>
      </div>`;
    card.addEventListener("click", ()=> openDetail(d.id));
    card.addEventListener("keydown", e=>{ if(e.key==="Enter") openDetail(d.id); });
    catalogGrid.appendChild(card);
  }
}

function renderStats(){
  const counts = categoryCounts();
  const tagSet = new Set();
  let totalSize = 0;
  for (const d of docs){ d.tags.forEach(t=>tagSet.add(t)); totalSize += d.size; }
  el("statTotal").textContent = docs.length;
  el("statCategories").textContent = Object.keys(counts).length;
  el("statTags").textContent = tagSet.size;
  el("statSize").textContent = fmtBytes(totalSize);
}

function renderAll(){
  renderDrawers();
  renderGrid();
  renderStats();
}

function escapeHtml(s){
  return (s||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------- Detail panel --------------------------------------- */

const scrim = el("scrim");
const detailPanel = el("detailPanel");
const detailInner = el("detailInner");
let currentDetailId = null;

function openDetail(id){
  const d = docs.find(x=>x.id===id);
  if (!d) return;
  currentDetailId = id;
  detailInner.innerHTML = `
    <p class="detail-callnum">${d.callNumber}</p>
    <h2 class="detail-title">${escapeHtml(d.title)}</h2>

    <div class="detail-row"><span class="drk">Subject</span><span class="drv">${escapeHtml(d.category)}</span></div>
    <div class="detail-row"><span class="drk">Added</span><span class="drv">${fmtDate(d.addedAt)}</span></div>
    <div class="detail-row"><span class="drk">Size</span><span class="drv">${fmtBytes(d.size)}</span></div>
    <div class="detail-row"><span class="drk">Pages</span><span class="drv">${d.pageCount || "—"}</span></div>
    <div class="detail-row"><span class="drk">File</span><span class="drv">${escapeHtml(d.filename)}</span></div>

    <p class="detail-section-label">Keywords Stackroom found</p>
    <div class="detail-tags" id="detailTags">${d.tags.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join("") || '<span style="color:var(--ink-faint);font-size:12.5px;">none detected</span>'}</div>

    <p class="detail-section-label">Extracted excerpt</p>
    <div class="detail-snippet">${escapeHtml(d.snippet)}</div>

    <p class="detail-section-label">Your notes</p>
    <textarea class="detail-notes" id="detailNotes" placeholder="Add a note about this document…">${escapeHtml(d.notes||"")}</textarea>

    <div class="detail-actions">
      <button class="btn-solid" id="detailOpen" type="button">Open PDF</button>
      <button class="btn-ghost" id="detailDownload" type="button">Download</button>
      <button class="btn-danger" id="detailDelete" type="button">Remove</button>
    </div>
  `;

  el("detailOpen").addEventListener("click", ()=>{
    const url = URL.createObjectURL(d.blob);
    window.open(url, "_blank");
  });
  el("detailDownload").addEventListener("click", ()=>{
    const url = URL.createObjectURL(d.blob);
    const a = document.createElement("a");
    a.href = url; a.download = d.filename;
    a.click();
  });
  el("detailDelete").addEventListener("click", async ()=>{
    if (!confirm(`Remove "${d.title}" from the shelf? This can't be undone.`)) return;
    await dbDelete(d.id);
    docs = docs.filter(x=>x.id!==d.id);
    closeDetail();
    renderAll();
  });
  el("detailNotes").addEventListener("change", async (e)=>{
    d.notes = e.target.value;
    await dbPut(d);
  });

  scrim.hidden = false;
  detailPanel.hidden = false;
}

function closeDetail(){
  scrim.hidden = true;
  detailPanel.hidden = true;
  currentDetailId = null;
}
el("detailClose").addEventListener("click", closeDetail);
scrim.addEventListener("click", closeDetail);
document.addEventListener("keydown", e=>{ if (e.key==="Escape") closeDetail(); });

/* ---------- Ingest pipeline ------------------------------------ */

function nextCallNumber(subjectName, code){
  const year = new Date().getFullYear();
  const countInSubject = docs.filter(d=>d.category===subjectName).length + 1;
  return `${code}-${year}-${String(countInSubject).padStart(3,"0")}`;
}

function addQueueItem(name){
  queueEl.hidden = false;
  const li = document.createElement("li");
  li.className = "queue-item";
  li.dataset.name = name;
  li.innerHTML = `<span class="qi-spinner"></span><span class="qi-name">${escapeHtml(name)}</span><span class="qi-status">Reading…</span>`;
  queueList.appendChild(li);
  return li;
}
function updateQueueItem(liEl, status){
  liEl.querySelector(".qi-status").textContent = status;
}
function removeQueueItem(liEl){
  liEl.remove();
  if (!queueList.children.length) queueEl.hidden = true;
}

async function ingestFile(file){
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")){
    return;
  }
  const li = addQueueItem(file.name);
  try{
    updateQueueItem(li, "Extracting text…");
    let text = "", pageCount = null, metaTitle = null;
    try{
      const res = await readPdf(file);
      text = res.text; pageCount = res.pageCount; metaTitle = res.metaTitle;
    }catch(err){
      console.warn("Could not parse PDF text for", file.name, err);
    }

    updateQueueItem(li, "Classifying subject…");
    const subject = scoreText(text + " " + file.name);

    updateQueueItem(li, "Extracting keywords…");
    const textTags = extractTags(text);
    const tags = textTags.length ? textTags : extractTags(file.name.replace(/[_-]/g," "));

    updateQueueItem(li, "Assigning call number…");
    const callNumber = nextCallNumber(subject.name, subject.code);

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      filename: file.name,
      title: guessTitle(file.name, metaTitle),
      category: subject.name,
      callNumber,
      tags,
      snippet: cleanSnippet(text),
      pageCount,
      size: file.size,
      addedAt: Date.now(),
      notes: "",
      blob: file,
    };

    updateQueueItem(li, "Shelving…");
    await dbPut(record);
    docs.push(record);
    renderAll();
  } finally {
    setTimeout(()=> removeQueueItem(li), 400);
  }
}

async function ingestFiles(fileList){
  const files = Array.from(fileList);
  for (const f of files){
    await ingestFile(f);
  }
}

/* ---------- Upload UI wiring ------------------------------------ */

const dropzone = el("dropzone");
const fileInput = el("fileInput");

dropzone.addEventListener("click", ()=> fileInput.click());
dropzone.addEventListener("keydown", e=>{ if(e.key==="Enter"||e.key===" ") fileInput.click(); });
fileInput.addEventListener("change", e=> { ingestFiles(e.target.files); fileInput.value=""; });

["dragenter","dragover"].forEach(ev=>
  dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.add("drag"); })
);
["dragleave","drop"].forEach(ev=>
  dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.remove("drag"); })
);
dropzone.addEventListener("drop", e=>{
  if (e.dataTransfer.files && e.dataTransfer.files.length) ingestFiles(e.dataTransfer.files);
});

el("headerAddBtn").addEventListener("click", ()=> fileInput.click());

/* ---------- Search / sort / filters ------------------------------ */

const searchInput = el("searchInput");
searchInput.addEventListener("input", e=>{ searchQuery = e.target.value.trim(); renderGrid(); });
document.addEventListener("keydown", e=>{
  if (e.key==="/" && document.activeElement !== searchInput){
    e.preventDefault(); searchInput.focus();
  }
});

el("sortSelect").addEventListener("change", e=>{ sortMode = e.target.value; renderGrid(); });

document.querySelector('[data-cat="all"]').addEventListener("click", ()=>{
  activeCategory = "all"; renderAll();
});

el("statsToggle").addEventListener("click", ()=>{
  const strip = el("statsStrip");
  strip.hidden = !strip.hidden;
  el("statsToggle").textContent = strip.hidden ? "Shelf stats" : "Hide stats";
});

/* ---------- Boot ------------------------------------------------- */

(async function init(){
  try{
    docs = await dbAll();
  }catch(err){
    console.error("Could not open local library database", err);
    docs = [];
  }
  renderAll();
})();
