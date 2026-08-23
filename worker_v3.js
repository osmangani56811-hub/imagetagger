// ===================================================================
// ImageTagger — Cloudflare Worker (single file)
// Backend: Cloudflare Workers AI (FREE)
//   - Vision:  @cf/llava-hf/llava-1.5-7b-hf
//   - Text:    @cf/meta/llama-3.1-8b-instruct-fast
// ===================================================================

const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

const PLATFORM_RULES = {
  general:   "General stock metadata, keep it broadly usable.",
  adobe:     "Adobe Stock style: descriptive title (max 70 chars), no brand names, no camera/lens info.",
  shutterstock: "Shutterstock style: concise commercial title, avoid superlatives like 'best' or 'amazing'.",
  freepik:   "Freepik style: SEO-friendly title, simple everyday keywords.",
  getty:     "Getty Images style: journalistic, factual, neutral tone, no marketing language.",
  istock:    "iStock style: similar to Getty, factual and neutral.",
  dreamstime:"Dreamstime style: keyword-rich, straightforward description.",
  vecteezy:  "Vecteezy style: emphasize vector/illustration terms if relevant."
};

const FILLER_WORDS = [
  "close-up","close up", "closeup", "eye-catching", "eye catching",
  "attractive", "beautiful", "amazing", "stunning", "gorgeous",
  "lovely", "nice", "great", "wonderful", "fantastic", "style"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/analyze" && request.method === "POST") {
      return handleAnalyze(request, env);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(HTML_PAGE, {
        headers: { "content-type": "text/html;charset=UTF-8" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};

// -------------------------------------------------------------------
// Backend: analyze one image -> title/description/keywords JSON
// -------------------------------------------------------------------
async function handleAnalyze(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get("image");
    const titleLen = parseInt(formData.get("titleLen") || "60", 10);
    const descLen = parseInt(formData.get("descLen") || "150", 10);
    const kwCount = parseInt(formData.get("kwCount") || "20", 10);
    const platform = formData.get("platform") || "general";
    const customPrompt = formData.get("customPrompt") || "";

    if (!file) {
      return Response.json({ error: "কোনো ছবি পাওয়া যায়নি।" }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // Step 1: get a visual description from the vision model
    const visionResp = await env.AI.run(VISION_MODEL, {
      image: Array.from(bytes),
      prompt: "Describe this image in detail: main subject, colors, style, mood, background.",
      max_tokens: 512
    });

    const visualDescription = visionResp.description || visionResp.response || "";

    // Step 2: turn that description into structured stock metadata
    const rule = PLATFORM_RULES[platform] || PLATFORM_RULES.general;
    const systemPrompt =
      `You are a senior microstock SEO strategist who has studied years of Adobe Stock, ` +
      `Shutterstock and Freepik search-ranking data. Based on the image description given, ` +
      `produce commercial stock metadata engineered to rank at the TOP of search results and ` +
      `maximize buyer click-through. ${rule} ` +
      `TITLE: write it like a professional stock photographer would — front-load the single most ` +
      `searched, highest commercial-intent term, then supporting descriptive terms. No filler words. ` +
      `DESCRIPTION: a natural, professional sentence that reads well for humans AND naturally contains ` +
      `secondary high-value search terms a buyer would actually type. ` +
      `KEYWORDS: act like you ran real keyword research — prioritize terms with real search volume and ` +
      `buyer intent (concept keywords, use-case keywords, style/mood keywords, synonyms), ordered from ` +
      `highest search relevance to lowest, the way a top-selling contributor would tag for maximum discoverability. ` +
      `Return ONLY valid JSON, no markdown, no explanation, in this exact shape: ` +
      `{"title":"...","description":"...","keywords":["...","..."]}. ` +
      `Rules: title max ${titleLen} characters. description max ${descLen} characters. ` +
      `Provide exactly ${kwCount} keywords. Every keyword must be unique — do NOT repeat the same ` +
      `word or a near-duplicate/variant of a word already used (e.g. if "sepia" is used, do not also ` +
      `add "sepia tone" or "sepia toned"). Only include keywords that accurately describe something ` +
      `actually visible in the image — never guess or invent unrelated objects. NEVER use vague ` +
      `filler/marketing words anywhere — not in the title, not in the description, not in the keywords. ` +
      `Banned words/phrases: "close-up", "close up", "closeup", "eye-catching", "attractive", "beautiful", ` +
      `"amazing", "stunning", "gorgeous", "lovely", "nice", "great", "wonderful", "fantastic". ` +
      `Use concrete, specific, high-search-value terms only.` +
      (customPrompt ? ` Additional instructions: ${customPrompt}` : "");

    const textResp = await env.AI.run(TEXT_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Image description: ${visualDescription}` }
      ],
      max_tokens: 800
    });

    let raw = textResp.response;
    if (typeof raw !== "string") {
      // Some model responses come back as an object/array instead of plain text
      raw = JSON.stringify(raw || "");
    }
    raw = raw.trim();
    raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // fallback: try to find the JSON object in the text
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "AI থেকে সঠিক JSON পাওয়া যায়নি, আবার চেষ্টা করুন। (raw: " + raw.slice(0, 120) + ")" }, { status: 500 });
    }

    // --- enforce limits + strip filler words server-side, since the model doesn't always obey ---
    let title = stripFillerText(String(parsed.title || "").trim());
    if (title.length > titleLen) title = title.slice(0, titleLen).trim();

    let description = stripFillerText(String(parsed.description || "").trim());
    if (description.length > descLen) description = description.slice(0, descLen).trim();

    let keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
    keywords = keywords.filter(k => !FILLER_WORDS.includes(String(k).trim().toLowerCase()));
    keywords = dedupeKeywords(keywords);
    keywords = keywords.slice(0, kwCount); // HARD LIMIT — never exceed requested count

    return Response.json({ title, description, keywords });

  } catch (err) {
    return Response.json({ error: String(err && err.message ? err.message : err) }, { status: 500 });
  }
}

// -------------------------------------------------------------------
// Remove filler/marketing words from free text (title/description)
// -------------------------------------------------------------------
function stripFillerText(text) {
  let out = text;
  FILLER_WORDS.forEach(w => {
    const re = new RegExp("\\b" + w.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\b", "gi");
    out = out.replace(re, "");
  });
  out = out.replace(/\s+of\s+a\b/gi, " a").replace(/\s+of\s+an\b/gi, " an"); // clean "of a" left dangling
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
  // capitalize first letter if it got lowercased by the cleanup
  if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

// -------------------------------------------------------------------
// Dedupe exact + near-duplicate keywords (e.g. "sepia" vs "sepia tone")
// -------------------------------------------------------------------
function dedupeKeywords(list) {
  const clean = list
    .map(k => String(k || "").trim())
    .filter(Boolean);

  const kept = [];
  const keptLower = [];

  for (const kw of clean) {
    const low = kw.toLowerCase();
    const isDuplicate = keptLower.some(existing => {
      if (existing === low) return true;
      // treat as near-duplicate if one contains the other as a whole word/phrase
      return existing.includes(low) || low.includes(existing);
    });
    if (!isDuplicate) {
      kept.push(kw);
      keptLower.push(low);
    }
  }
  return kept;
}

// -------------------------------------------------------------------
// Frontend
// -------------------------------------------------------------------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ImageTagger</title>
<style>
  :root{
    --accent:#f5720c;
    --bg:#ffffff; --panel:#f6f7f9; --border:#e3e5e8; --text:#1b1f24; --muted:#6b7280;
  }
  *{box-sizing:border-box;}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:16px;}
  h1{font-size:20px;margin:0 0 16px;}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px;}
  .card h2{font-size:15px;margin:0 0 14px;}
  .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;}
  .row label{font-size:13px;color:var(--muted);}
  .row .val{font-size:12px;background:var(--accent);color:#fff;padding:2px 8px;border-radius:6px;}
  input[type=range]{width:100%;accent-color:var(--accent);}
  select, input[type=text]{width:100%;padding:9px;border-radius:8px;border:1px solid var(--border);background:#fff;font-size:14px;}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;}
  .tab{padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:#fff;font-size:12px;cursor:pointer;}
  .tab.active{border-color:var(--accent);color:var(--accent);font-weight:600;}
  .dropzone{border:2px dashed var(--border);border-radius:10px;padding:28px 10px;text-align:center;color:var(--muted);font-size:13px;}
  .dropzone.drag{border-color:var(--accent);color:var(--accent);}
  .btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
  button{border:none;border-radius:8px;padding:10px 14px;font-size:13px;cursor:pointer;color:#fff;}
  .btn-main{background:var(--accent);width:100%;padding:12px;font-size:14px;font-weight:600;}
  .btn-clear{background:#d9362f;}
  .btn-pause{background:#c98a1d;}
  .btn-gen{background:var(--accent);}
  .btn-export{background:#1f9d55;}
  .btn-hist{background:#4b5563;}
  .filelist{margin-top:10px;font-size:12px;color:var(--muted);}
  .result{border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:10px;background:#fff;}
  .result h3{margin:0 0 6px;font-size:14px;}
  .result p{margin:4px 0;font-size:13px;}
  .kw{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;}
  .kw span{background:#eef0f3;border-radius:6px;padding:2px 7px;font-size:11px;}
  .switch{position:relative;width:40px;height:22px;}
  .switch input{opacity:0;width:0;height:0;}
  .slider-toggle{position:absolute;inset:0;background:#ccc;border-radius:22px;cursor:pointer;transition:.2s;}
  .slider-toggle:before{content:"";position:absolute;height:16px;width:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;}
  input:checked + .slider-toggle{background:var(--accent);}
  input:checked + .slider-toggle:before{transform:translateX(18px);}
  .copybtn{background:#e5e7eb;color:#1b1f24;border:none;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;}
  .delbtn{background:#d9362f;color:#fff;border:none;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer;flex-shrink:0;}
  .card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
  .progress-wrap{margin-top:10px;font-size:12px;color:var(--muted);}
  .progress-outer{width:100%;height:8px;background:#e3e5e8;border-radius:6px;overflow:hidden;margin-top:4px;}
  .progress-inner{height:100%;background:var(--accent);width:0%;transition:width .2s;}
  .stars{display:flex;gap:2px;margin:8px 0;}
  .star{font-size:20px;cursor:pointer;color:#d1d5db;user-select:none;}
  .star.filled{color:#f5a623;}
  .btn-save-img{background:#0e7490;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer;width:100%;margin-top:8px;}
  .thumb-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
  .thumb-box{position:relative;width:56px;height:56px;border-radius:8px;overflow:hidden;background:#e5e7eb;}
  .thumb-box img{width:100%;height:100%;object-fit:cover;display:block;}
  .thumb-box .spin-overlay{position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}
  .spinner{width:20px;height:20px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .thumb-grid-head{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:12px;color:var(--muted);}
  .field-row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin:6px 0;}
  .field-row .field-text{flex:1;}
  .field-row .copybtn{flex-shrink:0;}
  .kwhead{display:flex;justify-content:space-between;align-items:center;margin:8px 0 4px;}
  .empty{text-align:center;color:var(--muted);font-size:13px;padding:30px 0;border:1px dashed var(--border);border-radius:10px;}
  .small{font-size:11px;color:var(--muted);}
</style>
</head>
<body>

<h1>🖼️ ImageTagger</h1>

<div class="card">
  <h2>Generation Controls</h2>

  <div class="row"><label>Batch Size (একসাথে কতগুলো ছবি প্রসেস হবে)</label></div>
  <input type="range" id="batchSize" min="1" max="5" value="1">
  <div class="row"><span></span><span class="val" id="batchSizeVal">1x</span></div>

  <div class="row">
    <label>Requests Per Minute সীমা</label>
    <label class="switch"><input type="checkbox" id="rpmToggle" checked><span class="slider-toggle"></span></label>
  </div>
  <input type="range" id="rpm" min="1" max="30" value="15">
  <div class="row"><span></span><span class="val" id="rpmVal">15 / min</span></div>

  <div class="tabs">
    <div class="tab active" data-tab="metadata">Metadata</div>
    <div class="tab" data-tab="prompt">Prompt</div>
  </div>

  <div id="tab-metadata">
    <div class="row"><label>Title Length</label><span class="val" id="titleLenVal">60 Chars</span></div>
    <input type="range" id="titleLen" min="20" max="200" value="60">

    <div class="row"><label>Description Length</label><span class="val" id="descLenVal">150 Chars</span></div>
    <input type="range" id="descLen" min="50" max="500" value="150">

    <div class="row"><label>Keywords Count</label><span class="val" id="kwCountVal">20 Keywords</span></div>
    <input type="range" id="kwCount" min="5" max="49" value="20">
  </div>

  <div id="tab-prompt" style="display:none;">
    <label class="small">Custom Prompt (নিজের ইচ্ছেমতো নির্দেশনা লিখুন — খালি রাখলে ডিফল্ট নিয়ম চলবে)</label>
    <input type="text" id="customPrompt" placeholder="যেমন: শুধু বাংলা কীওয়ার্ড দাও">
  </div>

  <div class="row" style="margin-top:14px;">
    <label>File extension override</label>
  </div>
  <input type="text" id="fileExt" placeholder="Default (যেমন .jpg রাখুন খালি)">

  <div class="row" style="margin-top:14px;">
    <label>Theme Color</label>
    <input type="color" id="themeColor" value="#f5720c" style="width:40px;height:30px;border:none;background:none;">
  </div>

  <button class="btn-main" id="saveSettings">Save Settings</button>
</div>

<div class="card">
  <h2>Upload Files</h2>
  <div class="tabs" id="platformTabs">
    <div class="tab active" data-platform="general">General</div>
    <div class="tab" data-platform="adobe">Adobe Stock</div>
    <div class="tab" data-platform="shutterstock">Shutterstock</div>
    <div class="tab" data-platform="freepik">Freepik</div>
    <div class="tab" data-platform="getty">Getty Images</div>
    <div class="tab" data-platform="istock">iStock</div>
    <div class="tab" data-platform="dreamstime">Dreamstime</div>
    <div class="tab" data-platform="vecteezy">Vecteezy</div>
  </div>

  <div class="dropzone" id="dropzone">
    📁 Drag & drop files here, or <b style="color:var(--accent);">click to select</b>
    <div class="small">Supported: JPG, PNG (ছবি বিশ্লেষণের জন্য)</div>
  </div>
  <input type="file" id="fileInput" accept="image/*" multiple style="display:none;">
  <div class="filelist" id="fileList"></div>

  <div class="thumb-grid-head" id="thumbGridHead" style="display:none;">
    <span id="thumbGridLabel">Selected images</span>
    <span id="thumbGridPct"></span>
  </div>
  <div class="thumb-grid" id="thumbGrid"></div>

  <div class="btnrow">
    <button class="btn-clear" id="clearBtn">🗑 Clear</button>
    <button class="btn-pause" id="pauseBtn">⏸ Pause</button>
    <button class="btn-gen" id="genBtn">✨ Generate</button>
    <button class="btn-export" id="exportBtn">⬇ Export CSV</button>
    <button class="btn-hist" id="histBtn">🕒 History</button>
  </div>

  <div class="progress-wrap" id="progressBox" style="display:none;">
    <span id="progressText"></span>
    <div class="progress-outer"><div class="progress-inner" id="progressBar"></div></div>
  </div>
</div>

<div class="card">
  <h2 id="resultsTitle">Generated Metadata (0)</h2>
  <div id="results"><div class="empty">Results will appear here after generation.</div></div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/piexifjs/1.0.6/piexif.js"></script>
<script>
let files = [];
let results = [];
let paused = false;
let currentPlatform = "general";
let totalToProcess = 0;
let completedCount = 0;
let fileCounter = 0;
let processingIds = new Set();
let doneIds = new Set();

// --- restore saved settings ---
const saved = JSON.parse(localStorage.getItem("imgtagger_settings") || "{}");
if (saved.titleLen) document.getElementById("titleLen").value = saved.titleLen;
if (saved.descLen) document.getElementById("descLen").value = saved.descLen;
if (saved.kwCount) document.getElementById("kwCount").value = saved.kwCount;
if (saved.batchSize) document.getElementById("batchSize").value = saved.batchSize;
if (saved.rpm) document.getElementById("rpm").value = saved.rpm;
if (saved.themeColor) { document.getElementById("themeColor").value = saved.themeColor; document.documentElement.style.setProperty('--accent', saved.themeColor); }
if (saved.customPrompt) document.getElementById("customPrompt").value = saved.customPrompt;
if (saved.fileExt) document.getElementById("fileExt").value = saved.fileExt;

function syncLabels(){
  document.getElementById("titleLenVal").textContent = document.getElementById("titleLen").value + " Chars";
  document.getElementById("descLenVal").textContent = document.getElementById("descLen").value + " Chars";
  document.getElementById("kwCountVal").textContent = document.getElementById("kwCount").value + " Keywords";
  document.getElementById("batchSizeVal").textContent = document.getElementById("batchSize").value + "x";
  document.getElementById("rpmVal").textContent = document.getElementById("rpm").value + " / min";
}
syncLabels();
["titleLen","descLen","kwCount","batchSize","rpm"].forEach(id=>{
  document.getElementById(id).addEventListener("input", syncLabels);
});

document.getElementById("themeColor").addEventListener("input", e=>{
  document.documentElement.style.setProperty('--accent', e.target.value);
});

document.getElementById("saveSettings").addEventListener("click", ()=>{
  const settings = {
    titleLen: document.getElementById("titleLen").value,
    descLen: document.getElementById("descLen").value,
    kwCount: document.getElementById("kwCount").value,
    batchSize: document.getElementById("batchSize").value,
    rpm: document.getElementById("rpm").value,
    themeColor: document.getElementById("themeColor").value,
    customPrompt: document.getElementById("customPrompt").value,
    fileExt: document.getElementById("fileExt").value
  };
  localStorage.setItem("imgtagger_settings", JSON.stringify(settings));
  alert("সেটিংস সেভ হয়েছে ✅");
});

// --- tabs (metadata/prompt) ---
document.querySelectorAll("#tab-metadata, #tab-prompt").forEach(()=>{});
document.querySelectorAll(".card .tabs .tab").forEach(tab=>{
  if (tab.dataset.tab){
    tab.addEventListener("click", ()=>{
      document.querySelectorAll("[data-tab]").forEach(t=>t.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-metadata").style.display = tab.dataset.tab==="metadata" ? "block":"none";
      document.getElementById("tab-prompt").style.display = tab.dataset.tab==="prompt" ? "block":"none";
    });
  }
});

// --- platform tabs ---
document.querySelectorAll("#platformTabs .tab").forEach(tab=>{
  tab.addEventListener("click", ()=>{
    document.querySelectorAll("#platformTabs .tab").forEach(t=>t.classList.remove("active"));
    tab.classList.add("active");
    currentPlatform = tab.dataset.platform;
  });
});

// --- file handling ---
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
dropzone.addEventListener("click", ()=>fileInput.click());
dropzone.addEventListener("dragover", e=>{e.preventDefault();dropzone.classList.add("drag");});
dropzone.addEventListener("dragleave", ()=>dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", e=>{
  e.preventDefault(); dropzone.classList.remove("drag");
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", e=>addFiles(e.target.files));

const fileThumbs = {};
const fileThumbsByName = {};
function addFiles(fileListObj){
  const newFiles = Array.from(fileListObj);
  newFiles.forEach(f => {
    f.customId = "f" + (fileCounter++);
    const url = URL.createObjectURL(f);
    fileThumbs[f.customId] = url;
    fileThumbsByName[f.name] = url;
  });
  files = files.concat(newFiles);
  document.getElementById("fileList").textContent = files.length + " files selected";
  renderThumbGrid();
}

function renderThumbGrid(){
  const head = document.getElementById("thumbGridHead");
  const grid = document.getElementById("thumbGrid");
  const visible = files.filter(f => !doneIds.has(f.customId));

  if (visible.length === 0){
    head.style.display = "none";
    grid.innerHTML = "";
    return;
  }
  head.style.display = "flex";
  grid.innerHTML = visible.map(f=>{
    const spinning = processingIds.has(f.customId);
    return '<div class="thumb-box" title="'+f.name+'">' +
      '<img src="' + fileThumbs[f.customId] + '">' +
      (spinning ? '<div class="spin-overlay"><div class="spinner"></div></div>' : '') +
      '</div>';
  }).join("");
}

function copyText(text){
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(()=>fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text){
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand("copy"); } catch(e){}
  document.body.removeChild(ta);
}

document.getElementById("clearBtn").addEventListener("click", ()=>{
  files = []; results = [];
  processingIds = new Set();
  doneIds = new Set();
  document.getElementById("fileList").textContent = "";
  renderThumbGrid();
  renderResults();
});

document.getElementById("pauseBtn").addEventListener("click", (e)=>{
  paused = !paused;
  e.target.textContent = paused ? "▶ Resume" : "⏸ Pause";
});

document.getElementById("genBtn").addEventListener("click", generateAll);
document.getElementById("exportBtn").addEventListener("click", exportCSV);
document.getElementById("histBtn").addEventListener("click", showHistory);

async function generateAll(){
  if (files.length === 0){ alert("আগে ছবি সিলেক্ট করুন।"); return; }
  paused = false;
  document.getElementById("pauseBtn").textContent = "⏸ Pause";

  totalToProcess = files.length;
  completedCount = 0;
  processingIds = new Set();
  doneIds = new Set();
  updateProgress();
  renderThumbGrid();

  const batchSize = parseInt(document.getElementById("batchSize").value, 10);
  const rpmEnabled = document.getElementById("rpmToggle").checked;
  const rpm = parseInt(document.getElementById("rpm").value, 10);
  const gapMs = rpmEnabled ? Math.max(60000 / rpm, 200) : 0;

  const titleLen = document.getElementById("titleLen").value;
  const descLen = document.getElementById("descLen").value;
  const kwCount = document.getElementById("kwCount").value;
  const customPrompt = document.getElementById("customPrompt").value;

  for (let i=0; i<files.length; i+=batchSize){
    while(paused){ await sleep(300); }
    const batch = files.slice(i, i+batchSize);
    batch.forEach(f => processingIds.add(f.customId));
    renderThumbGrid();
    await Promise.all(batch.map(f => analyzeOne(f, titleLen, descLen, kwCount, customPrompt)));
    if (gapMs) await sleep(gapMs);
  }
}

function updateProgress(){
  const box = document.getElementById("progressBox");
  const pctText = document.getElementById("thumbGridPct");
  if (totalToProcess === 0){ box.style.display = "none"; if (pctText) pctText.textContent = ""; return; }
  const pct = Math.round((completedCount / totalToProcess) * 100);
  box.style.display = "block";
  document.getElementById("progressText").textContent =
    "প্রসেস হচ্ছে: " + completedCount + " / " + totalToProcess + " (" + pct + "%)";
  document.getElementById("progressBar").style.width = pct + "%";
  if (pctText) pctText.textContent = completedCount + " / " + totalToProcess + " (" + pct + "%)";
}

async function analyzeOne(file, titleLen, descLen, kwCount, customPrompt){
  const buildFd = (blob) => {
    const fd = new FormData();
    fd.append("image", blob, file.name);
    fd.append("titleLen", titleLen);
    fd.append("descLen", descLen);
    fd.append("kwCount", kwCount);
    fd.append("platform", currentPlatform);
    fd.append("customPrompt", customPrompt);
    return fd;
  };

  // Try the image as-is first (no forced size limit). If Cloudflare rejects it
  // for being too large, automatically shrink it step by step and retry —
  // so the person never has to worry about image size themselves.
  const sizeStages = [null, 2200, 1600, 1100, 800];
  let data = null;

  for (let s = 0; s < sizeStages.length; s++){
    const dim = sizeStages[s];
    const blob = dim ? await resizeImageFile(file, dim, 0.85) : file;
    try {
      const res = await fetch("/api/analyze", { method:"POST", body: buildFd(blob) });
      data = await res.json();
    } catch(err){
      data = { error: String(err) };
    }
    const tooLarge = data && data.error && /too large|3006|413/i.test(String(data.error));
    if (!tooLarge) break; // success, or a different kind of error — stop retrying
  }

  if (data && data.error){
    results.push({ file: file.name, error: data.error });
  } else {
    results.push({ file: file.name, ...data });
    saveToHistory({ file: file.name, ...data, date: new Date().toISOString() });
  }
  processingIds.delete(file.customId);
  doneIds.add(file.customId);
  completedCount++;
  updateProgress();
  renderThumbGrid();
  renderResults();
}

function renderResults(){
  const box = document.getElementById("results");
  document.getElementById("resultsTitle").textContent = "Generated Metadata (" + results.length + ")";
  if (results.length === 0){
    box.innerHTML = '<div class="empty">Results will appear here after generation.</div>';
    return;
  }
  box.innerHTML = results.map((r, idx)=>{
    const thumb = fileThumbsByName[r.file]
      ? '<img src="' + fileThumbsByName[r.file] + '" style="width:32px;height:32px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px;">'
      : '';
    if (r.error){
      return '<div class="result"><div class="card-head"><h3 style="margin:0;">' + thumb + r.file + '</h3>' +
        '<button class="delbtn" data-idx="'+idx+'">🗑 Delete</button></div>' +
        '<p style="color:#d9362f;">⚠ ' + r.error + '</p></div>';
    }
    const stars = [1,2,3,4,5].map(n=>
      '<span class="star' + ((r.rating||0) >= n ? ' filled' : '') + '" data-idx="'+idx+'" data-star="'+n+'">★</span>'
    ).join("");
    return '<div class="result">' +
      '<div class="card-head"><h3 style="margin:0;">' + thumb + r.file + '</h3>' +
        '<button class="delbtn" data-idx="'+idx+'">🗑 Delete</button></div>' +
      '<div class="field-row"><div class="field-text"><b>Title:</b> ' + (r.title||"") + '</div>' +
        '<button class="copybtn" data-idx="'+idx+'" data-field="title">Copy</button></div>' +
      '<div class="field-row"><div class="field-text"><b>Description:</b> ' + (r.description||"") + '</div>' +
        '<button class="copybtn" data-idx="'+idx+'" data-field="description">Copy</button></div>' +
      '<div class="kwhead"><b>Keywords:</b>' +
        '<button class="copybtn" data-idx="'+idx+'" data-field="keywords">Copy</button></div>' +
      '<div class="kw">' + (r.keywords||[]).map(k=>'<span>'+k+'</span>').join("") + '</div>' +
      '<div class="stars">' + stars + '</div>' +
      '<button class="btn-save-img" data-idx="'+idx+'">💾 Save Title/Description/Rating Into Image</button>' +
      '</div>';
  }).join("");
}

document.getElementById("results").addEventListener("click", async (e)=>{
  const starEl = e.target.closest(".star");
  if (starEl){
    const idx = parseInt(starEl.dataset.idx, 10);
    results[idx].rating = parseInt(starEl.dataset.star, 10);
    renderResults();
    return;
  }
  const saveBtn = e.target.closest(".btn-save-img");
  if (saveBtn){
    const idx = parseInt(saveBtn.dataset.idx, 10);
    saveBtn.textContent = "⏳ Saving...";
    await saveMetadataToImage(idx);
    saveBtn.textContent = "💾 Save Title/Description/Rating Into Image";
    return;
  }
  const delBtn = e.target.closest(".delbtn");
  if (delBtn){
    const idx = parseInt(delBtn.dataset.idx, 10);
    results.splice(idx, 1);
    renderResults();
    return;
  }
  const btn = e.target.closest(".copybtn");
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  const r = results[idx];
  if (!r) return;
  let text = "";
  if (btn.dataset.field === "title") text = r.title || "";
  else if (btn.dataset.field === "description") text = r.description || "";
  else if (btn.dataset.field === "keywords") text = (r.keywords||[]).join(", ");
  copyText(text);
  const old = btn.textContent;
  btn.textContent = "✓ Copied";
  setTimeout(()=>{ btn.textContent = old; }, 1200);
});

function exportCSV(){
  if (results.length === 0){ alert("এখনও কোনো ফলাফল নেই।"); return; }
  let csv = "Filename,Title,Description,Keywords\\n";
  results.forEach(r=>{
    if (r.error) return;
    const row = [r.file, r.title, r.description, (r.keywords||[]).join("|")]
      .map(v => '"' + String(v||"").replace(/"/g,'""') + '"').join(",");
    csv += row + "\\n";
  });
  const blob = new Blob([csv], { type:"text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "imagetagger_export.csv";
  a.click();
}

function saveToHistory(entry){
  const hist = JSON.parse(localStorage.getItem("imgtagger_history") || "[]");
  hist.unshift(entry);
  localStorage.setItem("imgtagger_history", JSON.stringify(hist.slice(0, 200)));
}

function showHistory(){
  const hist = JSON.parse(localStorage.getItem("imgtagger_history") || "[]");
  if (hist.length === 0){ alert("হিস্টোরি খালি।"); return; }
  results = hist.map(h => ({ file:h.file, title:h.title, description:h.description, keywords:h.keywords }));
  renderResults();
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// Embed Title/Description/Rating directly into the image file's metadata
// (EXIF ImageDescription + UserComment) so it travels with the file when
// uploaded to microstock sites. Works on JPG files.
async function saveMetadataToImage(idx){
  const r = results[idx];
  if (!r || r.error){ alert("এই ছবির জন্য কোনো বৈধ ফলাফল নেই।"); return; }

  const originalFile = files.find(f => f.name === r.file);
  if (!originalFile){ alert("মূল ছবির ফাইলটি আর পাওয়া যাচ্ছে না (হয়তো Clear করা হয়েছে)।"); return; }

  const isJpeg = /\.jpe?g$/i.test(originalFile.name) || originalFile.type === "image/jpeg";
  if (!isJpeg || typeof piexif === "undefined"){
    alert("দুঃখিত, শুধু JPG ছবিতে মেটাডেটা সেভ করা যায় (PNG সাপোর্ট করে না)।");
    return;
  }

  try{
    const dataUrl = await fileToDataUrl(originalFile);
    const ratingText = r.rating ? (r.rating + "/5 stars") : "Not rated";
    const zeroth = {};
    zeroth[piexif.ImageIFD.ImageDescription] = r.title || "";
    zeroth[piexif.ImageIFD.XPTitle] = strToUtf16Bytes(r.title || "");
    zeroth[piexif.ImageIFD.XPSubject] = strToUtf16Bytes((r.keywords||[]).join(", "));
    zeroth[piexif.ImageIFD.XPComment] = strToUtf16Bytes((r.description || "") + " | Rating: " + ratingText);

    const exifObj = { "0th": zeroth, "Exif": {}, "GPS": {} };
    const exifBytes = piexif.dump(exifObj);
    const newDataUrl = piexif.insert(exifBytes, dataUrl);

    const a = document.createElement("a");
    a.href = newDataUrl;
    a.download = originalFile.name.replace(/\.jpe?g$/i, "") + "_tagged.jpg";
    a.click();
  } catch(err){
    alert("মেটাডেটা সেভ করতে সমস্যা হয়েছে: " + err);
  }
}

function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// piexifjs expects Windows XP tags (XPTitle etc.) as UTF-16LE byte arrays
function strToUtf16Bytes(str){
  const bytes = [];
  for (let i=0; i<str.length; i++){
    const code = str.charCodeAt(i);
    bytes.push(code & 0xff, (code >> 8) & 0xff);
  }
  bytes.push(0,0);
  return bytes;
}

// Resize/compress image client-side before sending — phone camera photos are
// often several MB, which the AI API rejects as "too large".
function resizeImageFile(file, maxDim, quality){
  return new Promise((resolve)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim){
        if (w > h){ h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob=>{
        URL.revokeObjectURL(url);
        resolve(blob || file);
      }, "image/jpeg", quality);
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}
</script>
</body>
</html>`;
