export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/analyze" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("image");
        const imageBuffer = await file.arrayBuffer();
        const imageArray = [...new Uint8Array(imageBuffer)];

        const titleResult = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: imageArray,
          prompt: "Give only a short, catchy stock photo title for this image, under 10 words. No extra text, just the title.",
          max_tokens: 30,
        });

        const descResult = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: imageArray,
          prompt: "Write a detailed description of this image for a stock photo website, 2-3 sentences.",
          max_tokens: 150,
        });

        const keywordsResult = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: imageArray,
          prompt: "List 15 relevant keywords for this image separated by commas, for stock photo SEO. Only the keywords, no extra text.",
          max_tokens: 150,
        });

        const data = {
          title: titleResult.description || "তৈরি করা যায়নি",
          description: descResult.description || "তৈরি করা যায়নি",
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
  .subtitle { color: #666; margin-bottom: 25px; }
  #uploadBox { border: 2px dashed #2c7be5; border-radius: 10px; padding: 30px; max-width: 400px; margin: 0 auto; background: white; }
  #preview { max-width: 100%; margin-top: 15px; border-radius: 8px; display: none; }
  button { margin-top: 15px; padding: 12px 20px; background: #2c7be5; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
  #loading { display: none; margin-top: 15px; color: #2c7be5; font-weight: bold; }
  .resultBox { max-width: 400px; margin: 12px auto; text-align: left; background: white; border-radius: 8px; padding: 15px; display: none; position: relative; }
  .resultBox h3 { margin: 0 0 8px 0; color: #2c7be5; font-size: 14px; }
  .resultBox p { margin: 0; word-break: break-word; }
  .copyBtn { position: absolute; top: 10px; right: 10px; background: #eee; color: #333; padding: 5px 10px; font-size: 12px; border-radius: 5px; }
</style>
</head>
<body>
  <h1>ImageTagger</h1>
  <p class="subtitle">ছবি আপলোড করলে Title, Description, Keywords তৈরি হবে</p>

  <div id="uploadBox">
    <input type="file" id="imageInput" accept="image/*">
    <img id="preview">
    <br>
    <button id="analyzeBtn">Analyze</button>
  </div>

  <div id="loading">লোড হচ্ছে... (একটু সময় লাগতে পারে)</div>

  <div class="resultBox" id="titleBox">
    <h3>Title</h3>
    <p id="titleText"></p>
    <button class="copyBtn" onclick="copyText('titleText')">Copy</button>
  </div>

  <div class="resultBox" id="descBox">
    <h3>Description</h3>
    <p id="descText"></p>
    <button class="copyBtn" onclick="copyText('descText')">Copy</button>
  </div>

  <div class="resultBox" id="keywordsBox">
    <h3>Keywords</h3>
    <p id="keywordsText"></p>
    <button class="copyBtn" onclick="copyText('keywordsText')">Copy</button>
  </div>

  <canvas id="hiddenCanvas" style="display:none;"></canvas>

  <script>
    const input = document.getElementById('imageInput');
    const preview = document.getElementById('preview');
    const btn = document.getElementById('analyzeBtn');
    const loading = document.getElementById('loading');
    const canvas = document.getElementById('hiddenCanvas');

    input.addEventListener('change', () => {
      const file = input.files[0];
      if (file) {
        preview.src = URL.createObjectURL(file);
        preview.style.display = 'block';
      }
    });

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

    function copyText(id) {
      const text = document.getElementById(id).innerText;
      navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
      alert('কপি হয়েছে!');
    }

    btn.addEventListener('click', async () => {
      const file = input.files[0];
      if (!file) {
        alert('আগে একটা ছবি নির্বাচন করুন');
        return;
      }

      loading.style.display = 'block';
      document.getElementById('titleBox').style.display = 'none';
      document.getElementById('descBox').style.display = 'none';
      document.getElementById('keywordsBox').style.display = 'none';

      try {
        const resizedBlob = await resizeImage(file);
        const formData = new FormData();
        formData.append('image', resizedBlob);

        const res = await fetch('/analyze', { method: 'POST', body: formData });
        const data = await res.json();

        loading.style.display = 'none';

        if (data.error) {
          alert(data.error);
        } else {
          document.getElementById('titleText').innerText = data.title;
          document.getElementById('descText').innerText = data.description;
          document.getElementById('keywordsText').innerText = data.keywords;
          document.getElementById('titleBox').style.display = 'block';
          document.getElementById('descBox').style.display = 'block';
          document.getElementById('keywordsBox').style.display = 'block';
        }
      } catch (e) {
        loading.style.display = 'none';
        alert('কিছু একটা ভুল হয়েছে');
      }
    });
  </script>
</body>
</html>`;
    return new Response(html, {
      headers: { "content-type": "text/html;charset=UTF-8" },
    });
  },
};
