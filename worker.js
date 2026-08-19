export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/analyze" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("image");
        const titleLen = parseInt(formData.get("titleLen") || "60");
        const descLen = parseInt(formData.get("descLen") || "150");
        const kwCount = parseInt(formData.get("kwCount") || "15");

        const imageBuffer = await file.arrayBuffer();
        const imageArray = [...new Uint8Array(imageBuffer)];

        const titleResult = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: imageArray,
          prompt: "Give only a short, catchy stock photo title for this image, maximum " + titleLen + " characters. No extra text, just the title.",
          max_tokens: 40,
        });

        const descResult = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: imageArray,
          prompt: "Write a description of this image for a stock photo website, maximum " + descLen + " characters.",
          max_tokens: 200,
        });

        const keywordsResult = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: imageArray,
          prompt: "List exactly " + kwCount + " relevant keywords for this image separated by commas, for stock photo SEO. Only the keywords, no extra text.",
          max_tokens: 200,
        });

        const data = {
          title: (titleResult.description || "তৈরি করা যায়নি").slice(0, titleLen),
          description: (descResult.description || "তৈরি করা যায়নি").slice(0, descLen),
          keywords: keywordsResult.description || "তৈরি করা যায়নি",
        };

        return new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "বিশ্লেষণ করা যায়নি: " + err.message }), {
          headers: { "content-type": "application/json" },
        });
      }
    }

    const html = `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ImageTagger</title>
<style>
  body { font-family: Arial, sans-serif; background: #f4f6f8; margin: 0; padding: 20px; text-align: center; }
  h1 { color: #2c3e50; }
  .subtitle { color: #666; margin-bottom: 20px; }
  .controls { max-width: 500px; margin: 0 auto 20px auto; background: white; border-radius: 10px; padding: 18px; text-align: left; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .controlRow { margin-bottom: 16px; }
  .controlRow label { display: flex; justify-content: space-between; font-size: 14px; color: #333; margin-bottom: 6px; font-weight: bold; }
  .controlRow input[type="range"] { width: 100%; }
  #uploadBox { border: 2px dashed #2c7be5; border-radius: 10px; padding: 25px; max-width: 500px; margin: 0 auto; background: white; }
  button { margin-top: 15px; padding: 12px 20px; background: #2c7be5; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
  #status { margin-top: 15px; color: #2c7be5; font-weight: bold; display: none; }
  #resultsContainer { max-width: 500px; margin: 20px auto; }
  .card { text-align: left; background: white; border-radius: 8px; padding: 15px; margin-bottom: 15px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
  .card img { max-width: 100%; border-radius: 6px; margin-bottom: 10px; }
  .fieldBox { position: relative; background: #f8f9fa; border-radius: 6px; padding: 10px; margin-top: 8px; }
  .fieldBox h3 { margin: 0 0 5px 0; color: #2c7be5; font-size: 12px; }
  .fieldBox p { margin: 0; word-break: break-word; font-size: 14px; padding-right: 55px; }
  .copyBtn { position: absolute; top: 8px; right: 8px; background: #2c7be5; color: white; padding: 4px 10px; font-size: 11px; border-radius: 5px; border: none; cursor: pointer; margin-top: 0; }
</style>
</head>
<body>
  <h1>ImageTagger</h1>
  <p class="subtitle">একাধিক ছবি আপলোড করলে প্রতিটার Title, Description, Keywords তৈরি হবে</p>

  <div class="controls">
    <div class="controlRow">
      <label>Title Length <span id="titleLenVal">60</span> অক্ষর</label>
      <input type="range" id="titleLen" min="20" max="100" value="60">
    </div>
    <div class="controlRow">
      <label>Description Length <span id="descLenVal">150</span> অক্ষর</label>
      <input type="range" id="descLen" min="50" max="300" value="150">
    </div>
    <div class="controlRow">
      <label>Keywords Count <span id="kwCountVal">15</span> টা</label>
      <input type="range" id="kwCount" min="5" max="30" value="15">
    </div>
  </div>

  <div id="uploadBox">
    <input type="file" id="imageInput" accept="image/*" multiple>
    <br>
    <button id="analyzeBtn">Analyze All</button>
  </div>

  <div id="status"></div>
  <div id="resultsContainer"></div>

  <canvas id="hiddenCanvas" style="display:none;"></canvas>

  <script>
    const input = document.getElementById('imageInput');
    const btn = document.getElementById('analyzeBtn');
    const status = document.getElementById('status');
    const resultsContainer = document.getElementById('resultsContainer');
    const canvas = document.getElementById('hiddenCanvas');

    const titleLen = document.getElementById('titleLen');
    const descLen = document.getElementById('descLen');
    const kwCount = document.getElementById('kwCount');
    titleLen.addEventListener('input', () => document.getElementById('titleLenVal').innerText = titleLen.value);
    descLen.addEventListener('input', () => document.getElementById('descLenVal').innerText = descLen.value);
    kwCount.addEventListener('input', () => document.getElementById('kwCountVal').innerText = kwCount.value);

    function resizeImage(file) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const maxSize = 512;
          let w = img.width;
          let h = img.height;
          if (w > h && w > maxSize) { h = h * (maxSize / w); w = maxSize; }
          else if (h > maxSize) { w = w * (maxSize / h); h = maxSize; }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.7);
        };
        img.src = URL.createObjectURL(file);
      });
    }

    function copyText(btnEl) {
      const text = btnEl.parentElement.querySelector('p').innerText;
      navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
      btnEl.innerText = 'Copied!';
      setTimeout(() => { btnEl.innerText = 'Copy'; }, 1500);
    }
    window.copyText = copyText;

    btn.addEventListener('click', async () => {
      const files = input.files;
      if (!files.length) {
        alert('আগে একটা বা একাধিক ছবি নির্বাচন করুন');
        return;
      }

      resultsContainer.innerHTML = '';
      status.style.display = 'block';

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        status.innerText = 'বিশ্লেষণ হচ্ছে... (' + (i + 1) + ' / ' + files.length + ')';

        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = '<img src="' + URL.createObjectURL(file) + '">';
        resultsContainer.appendChild(card);

        try {
          const resizedBlob = await resizeImage(file);
          const formData = new FormData();
          formData.append('image', resizedBlob);
          formData.append('titleLen', titleLen.value);
          formData.append('descLen', descLen.value);
          formData.append('kwCount', kwCount.value);

          const res = await fetch('/analyze', { method: 'POST', body: formData });
          const data = await res.json();

          if (data.error) {
            card.innerHTML += '<p style="color:red;">' + data.error + '</p>';
          } else {
            card.innerHTML +=
              '<div class="fieldBox"><h3>Title</h3><p>' + data.title + '</p><button class="copyBtn" onclick="copyText(this)">Copy</button></div>' +
              '<div class="fieldBox"><h3>Description</h3><p>' + data.description + '</p><button class="copyBtn" onclick="copyText(this)">Copy</button></div>' +
              '<div class="fieldBox"><h3>Keywords</h3><p>' + data.keywords + '</p><button class="copyBtn" onclick="copyText(this)">Copy</button></div>';
          }
        } catch (e) {
          card.innerHTML += '<p style="color:red;">কিছু একটা ভুল হয়েছে</p>';
        }
      }

      status.style.display = 'none';
    });
  </script>
</body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html;charset=UTF-8" },
    });
  },
};
