// 入口：读 models.json 清单、渲染模型选择器、串联上传/识别/结果渲染
import { loadModelFiles } from './loader.js';
import { createPipeline } from './ppocr.js';

// ===== DOM =====
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const dropzone = document.getElementById('dropzone');
const placeholder = document.getElementById('placeholder');
const resultsEl = document.getElementById('results');
const runBtn = document.getElementById('runBtn');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const resultCount = document.getElementById('resultCount');
const modelInfo = document.getElementById('modelInfo');
const progressWrap = document.getElementById('progressWrap');
const progressLabel = document.getElementById('progressLabel');
const progressBar = document.getElementById('progressBar');
const modelList = document.getElementById('modelList');
const modelProgressWrap = document.getElementById('modelProgressWrap');
const modelProgressLabel = document.getElementById('modelProgressLabel');
const modelProgressBar = document.getElementById('modelProgressBar');

// ===== 状态 =====
let models = [];
let currentEntry = null;
let pipeline = null;
let currentImageData = null;
let loadToken = 0; // 防止切换模型时旧加载结果覆盖新状态

function setStatus(text, cls) {
  statusText.textContent = text;
  statusDot.className = 'dot ' + (cls || '');
}

// 识别进度条（pct < 0 隐藏）
function setProgress(pct, label) {
  progressWrap.style.display = pct >= 0 ? 'block' : 'none';
  if (pct >= 0) {
    progressBar.style.width = pct + '%';
    if (label) progressLabel.textContent = label;
  }
}

// 模型加载进度条（pct < 0 隐藏）
function setModelProgress(pct, label) {
  modelProgressWrap.style.display = pct >= 0 ? 'block' : 'none';
  if (pct >= 0) {
    modelProgressBar.style.width = pct + '%';
    if (label) modelProgressLabel.textContent = label;
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== 模型选择器 =====
function renderModelList() {
  modelList.innerHTML = '';
  for (const m of models) {
    const card = document.createElement('div');
    card.className = 'model-card' + (currentEntry && currentEntry.id === m.id ? ' selected' : '');
    card.innerHTML = `
      <div class="mc-head">
        <span class="mc-name">${escapeHtml(m.name)}</span>
        ${m.recommended ? '<span class="mc-badge">推荐</span>' : ''}
      </div>
      <div class="mc-desc">${escapeHtml(m.desc)}</div>
      <div class="mc-meta">
        <span>${m.sizeMB} MB · ${m.source === 'local' ? '本站' : '远程'}</span>
        <span class="mc-status" data-model-status="${escapeHtml(m.id)}"></span>
      </div>`;
    card.addEventListener('click', () => selectModel(m));
    modelList.appendChild(card);
  }
}

function setCardStatus(id, text, cls) {
  const el = modelList.querySelector(`[data-model-status="${id}"]`);
  if (el) {
    el.textContent = text;
    el.className = 'mc-status ' + (cls || '');
  }
}

async function selectModel(entry) {
  if (currentEntry && currentEntry.id === entry.id && pipeline) return;
  currentEntry = entry;
  renderModelList();

  const token = ++loadToken;
  pipeline = null;
  runBtn.disabled = true;
  setCardStatus(entry.id, '加载中…');
  setStatus(`加载模型：${entry.name}`, 'loading');

  try {
    const files = await loadModelFiles(entry, (p) => {
      if (token !== loadToken) return;
      setModelProgress(p.pct, `${p.label} ${Math.round(p.pct)}%${p.fromCache ? ' · 缓存' : ''}`);
    });
    if (token !== loadToken) return;

    setModelProgress(100, '创建推理会话…');
    const pl = await createPipeline({
      det: files.det,
      rec: files.rec,
      dict: files.dict,
      params: entry.params,
    });
    if (token !== loadToken) return;

    pipeline = pl;
    setModelProgress(-1);
    setCardStatus(entry.id, files.allFromCache ? '就绪 · 已缓存' : '就绪', 'ok');
    setStatus(`模型就绪 (${pipeline.backend})`, 'ok');
    modelInfo.textContent = `字符集 ${pipeline.dictSize} · 后端 ${pipeline.backend}`;
    if (currentImageData) runBtn.disabled = false;
  } catch (e) {
    if (token !== loadToken) return;
    console.error(e);
    setModelProgress(-1);
    setCardStatus(entry.id, '加载失败', 'err');
    setStatus('模型加载失败: ' + e.message, '');
  }
}

// ===== 识别 =====
async function runOCR() {
  if (!pipeline || !currentImageData) return;
  runBtn.disabled = true;

  try {
    const out = await pipeline.run(currentImageData, (p) => setProgress(p.pct, p.label));
    setProgress(-1);

    if (out.boxesFound === 0) {
      resultsEl.innerHTML = '<div class="empty"><span class="icon">😕</span>未检测到文本<br>请尝试更清晰的图片</div>';
      resultCount.textContent = '';
    } else {
      drawBoxes(out.results);
      renderResults(out.results, out);
    }
  } catch (e) {
    console.error(e);
    setProgress(-1);
    resultsEl.innerHTML = `<div class="empty"><span class="icon">⚠️</span>识别失败: ${escapeHtml(e.message)}</div>`;
  }
  runBtn.disabled = false;
}

function drawBoxes(results) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.putImageData(currentImageData, 0, 0);
  const colors = ['#00ff88', '#4c9aff', '#ff9f43', '#f368e0'];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    ctx.strokeStyle = colors[i % colors.length];
    ctx.lineWidth = 2;
    ctx.strokeRect(r.box.x0, r.box.y0, r.box.x1 - r.box.x0, r.box.y1 - r.box.y0);
  }
}

function renderResults(results, out) {
  const ms = Math.round(out.totalMs);
  resultCount.textContent = `共 ${results.length} 行 · ${ms}ms · ${out.backend}`;
  if (!results.length) {
    resultsEl.innerHTML = '<div class="empty"><span class="icon">😕</span>未识别到有效文本</div>';
    return;
  }
  // 置信度区间（相对展示：数据本身为 logits 的 softmax 概率，绝对值偏小）
  const confs = results.map(r => r.confidence);
  const maxC = Math.max(...confs, 0.001);
  resultsEl.innerHTML = '';
  results.forEach((r, i) => {
    const ratio = r.confidence / maxC;
    const cls = ratio > 0.7 ? 'high' : ratio > 0.4 ? 'mid' : 'low';
    const row = document.createElement('div');
    row.className = 'result-row';
    row.innerHTML = `
      <span class="idx">#${i + 1}</span>
      <span class="conf ${cls}">${(r.confidence * 100).toFixed(2)}%</span>
      <span class="text">${escapeHtml(r.text)}</span>`;
    resultsEl.appendChild(row);
  });
}

// ===== 上传交互 =====
function loadImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      currentImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      canvas.style.display = 'block';
      placeholder.style.display = 'none';
      if (pipeline) runBtn.disabled = false;
      resultCount.textContent = '';
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

dropzone.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (e) => loadImageFile(e.target.files[0]);
  input.click();
});

['dragover', 'dragenter'].forEach(ev => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
}));
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) loadImageFile(file);
});

runBtn.addEventListener('click', runOCR);

// ===== 启动 =====
async function init() {
  try {
    const resp = await fetch('models.json');
    const manifest = await resp.json();
    models = manifest.models || [];
  } catch (e) {
    setStatus('模型清单加载失败: ' + e.message, '');
    return;
  }
  renderModelList();
  const def = models.find(m => m.recommended) || models[0];
  if (def) selectModel(def);
}

init();
