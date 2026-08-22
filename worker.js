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
      `You are a microstock metadata expert. Based on the image description given, ` +
      `produce commercial stock metadata. ${rule} ` +
      `Return ONLY valid JSON, no markdown, no explanation, in this exact shape: ` +
      `{"title":"...","description":"...","keywords":["...","..."]}. ` +
      `Rules: title max ${titleLen} characters. description max ${descLen} characters. ` +
      `exactly ${kwCount} keywords, single words or short phrases, no duplicates, most relevant first.` +
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

    return Response.json({
      title: parsed.title || "",
      description: parsed.description || "",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : []
    });

  } catch (err) {
    return Response.json({ error: String(err && err.message ? err.message : err) }, { status: 500 });
  }
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

  <div class="btnrow">
    <button class="btn-clear" id="clearBtn">🗑 Clear</button>
    <button class="btn-pause" id="pauseBtn">⏸ Pause</button>
    <button class="btn-gen" id="genBtn">✨ Generate</button>
    <button class="btn-export" id="exportBtn">⬇ Export CSV</button>
    <button class="btn-hist" id="histBtn">🕒 History</button>
  </div>
</div>

<div class="card">
  <h2 id="resultsTitle">Generated Metadata (0)</h2>
  <div id="results"><div class="empty">Results will appear here after generation.</div></div>
</div>

<script>
let files = [];
let results = [];
let paused = false;
let currentPlatform = "general";

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

function addFiles(fileListObj){
  files = files.concat(Array.from(fileListObj));
  document.getElementById("fileList").textContent = files.length + " files selected";
}

document.getElementById("clearBtn").addEventListener("click", ()=>{
  files = []; results = [];
  document.getElementById("fileList").textContent = "";
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
    await Promise.all(batch.map(f => analyzeOne(f, titleLen, descLen, kwCount, customPrompt)));
    if (gapMs) await sleep(gapMs);
  }
}

async function analyzeOne(file, titleLen, descLen, kwCount, customPrompt){
  const fd = new FormData();
  fd.append("image", file);
  fd.append("titleLen", titleLen);
  fd.append("descLen", descLen);
  fd.append("kwCount", kwCount);
  fd.append("platform", currentPlatform);
  fd.append("customPrompt", customPrompt);

  try{
    const res = await fetch("/api/analyze", { method:"POST", body: fd });
    const data = await res.json();
    if (data.error){
      results.push({ file: file.name, error: data.error });
    } else {
      results.push({ file: file.name, ...data });
      saveToHistory({ file: file.name, ...data, date: new Date().toISOString() });
    }
  } catch(err){
    results.push({ file: file.name, error: String(err) });
  }
  renderResults();
}

function renderResults(){
  const box = document.getElementById("results");
  document.getElementById("resultsTitle").textContent = "Generated Metadata (" + results.length + ")";
  if (results.length === 0){
    box.innerHTML = '<div class="empty">Results will appear here after generation.</div>';
    return;
  }
  box.innerHTML = results.map(r=>{
    if (r.error){
      return '<div class="result"><h3>' + r.file + '</h3><p style="color:#d9362f;">⚠ ' + r.error + '</p></div>';
    }
    return '<div class="result"><h3>' + r.file + '</h3>' +
      '<p><b>Title:</b> ' + (r.title||"") + '</p>' +
      '<p><b>Description:</b> ' + (r.description||"") + '</p>' +
      '<div class="kw">' + (r.keywords||[]).map(k=>'<span>'+k+'</span>').join("") + '</div>' +
      '</div>';
  }).join("");
}

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
</script>
</body>
</html>`;
