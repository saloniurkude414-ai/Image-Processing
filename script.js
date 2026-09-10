// TerrainScope — Quadtree terrain classification with splitting + merging

const hero = document.getElementById("heroCanvas");
const hctx = hero.getContext("2d");
const canvas = document.getElementById("quadtreeCanvas");
const ctx = canvas.getContext("2d");

const imageInput = document.getElementById("imageInput");
const sampleBtn = document.getElementById("sampleBtn");
const runBtn = document.getElementById("runBtn");
const resetBtn = document.getElementById("resetBtn");
const thresholdInput = document.getElementById("threshold");
const depthInput = document.getElementById("depth");
const mergeInput = document.getElementById("mergeTolerance");

const PROCESS_SIZE = 720;
let threshold = 34;
let maxDepth = 5;
let mergeTolerance = 18;
let displayMode = "classified";
let imageSource = "sample";
let sourceImage = null;
let sourcePixels = null;
let leaves = [];
let mergedRegions = [];
let analysisStats = null;
let running = false;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function pct(v) { return `${v.toFixed(1)}%`; }

// ---------------- HERO DEMO ----------------
function terrainValue(x, y) {
  const hills = Math.sin(x * 0.055) * 0.22 + Math.cos(y * 0.07) * 0.16 + Math.sin((x + y) * 0.028) * 0.12;
  const ridge = Math.exp(-Math.pow((x - y * 0.85 - 90) / 85, 2)) * 0.3;
  const forest = Math.sin(x * 0.22) * Math.sin(y * 0.18) * 0.12;
  return clamp(0.48 + hills + ridge + forest, 0, 1);
}

function terrainColor(v) {
  if (v < .28) return [91, 104, 71];
  if (v < .43) return [137, 143, 91];
  if (v < .58) return [185, 181, 116];
  if (v < .73) return [139, 126, 87];
  return [92, 91, 76];
}

function drawHero() {
  const w = hero.width, h = hero.height;
  const img = hctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = terrainValue(x, y);
      const c = terrainColor(v);
      const i = (y * w + x) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
  }
  hctx.putImageData(img, 0, 0);
  hctx.save();
  hctx.strokeStyle = "rgba(255,255,255,.18)";
  for (let x = 0; x < w; x += 90) { hctx.beginPath(); hctx.moveTo(x, 0); hctx.lineTo(x, h); hctx.stroke(); }
  for (let y = 0; y < h; y += 90) { hctx.beginPath(); hctx.moveTo(0, y); hctx.lineTo(w, y); hctx.stroke(); }
  hctx.restore();
}

drawHero();

// ---------------- SAMPLE IMAGE ----------------
function createSampleImage() {
  const off = document.createElement("canvas");
  off.width = PROCESS_SIZE; off.height = PROCESS_SIZE;
  const c = off.getContext("2d");
  const img = c.createImageData(PROCESS_SIZE, PROCESS_SIZE);

  for (let y = 0; y < PROCESS_SIZE; y++) {
    for (let x = 0; x < PROCESS_SIZE; x++) {
      const nx = x / PROCESS_SIZE, ny = y / PROCESS_SIZE;
      let r = 174, g = 165, b = 112;

      // Water area
      if (nx < 0.27 && ny > 0.30 + 0.07 * Math.sin(nx * 18)) {
        r = 49; g = 119; b = 151;
      }
      // Forest area
      else if (nx > 0.52 && ny < 0.58) {
        r = 63 + 18 * Math.sin(x * .07) * Math.sin(y * .06);
        g = 112 + 28 * Math.sin(x * .13 + y * .05);
        b = 57;
      }
      // Rocky / mountain area
      else if (ny < 0.28 + 0.18 * Math.sin(nx * 7)) {
        const ridge = Math.sin(nx * 35) * 14;
        r = 105 + ridge; g = 101 + ridge; b = 91 + ridge;
      }
      // Urban patch
      else if (nx > .66 && ny > .62) {
        r = 111; g = 105; b = 118;
      }
      // Soil / plain
      else {
        const texture = 10 * Math.sin(x * .025) * Math.cos(y * .031);
        r = 170 + texture; g = 137 + texture * .7; b = 79 + texture * .3;
      }

      const i = (y * PROCESS_SIZE + x) * 4;
      img.data[i] = clamp(Math.round(r), 0, 255);
      img.data[i + 1] = clamp(Math.round(g), 0, 255);
      img.data[i + 2] = clamp(Math.round(b), 0, 255);
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  return off;
}

function loadSourceCanvas(offscreen, label) {
  const c = document.createElement("canvas");
  c.width = PROCESS_SIZE; c.height = PROCESS_SIZE;
  const cc = c.getContext("2d");
  cc.imageSmoothingEnabled = true;
  cc.drawImage(offscreen, 0, 0, PROCESS_SIZE, PROCESS_SIZE);
  sourcePixels = cc.getImageData(0, 0, PROCESS_SIZE, PROCESS_SIZE);
  sourceImage = c;
  imageSource = label;
  document.getElementById("fileName").textContent = label;
  document.getElementById("canvasMode").textContent = label.toUpperCase();
  buildAnalysis();
}

function loadImageFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const off = document.createElement("canvas");
      off.width = img.naturalWidth; off.height = img.naturalHeight;
      const oc = off.getContext("2d");
      oc.drawImage(img, 0, 0);
      loadSourceCanvas(off, file.name);
      document.getElementById("status").textContent = "IMAGE LOADED";
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ---------------- PIXEL STATISTICS ----------------
function pixelAt(x, y) {
  x = clamp(Math.floor(x), 0, PROCESS_SIZE - 1);
  y = clamp(Math.floor(y), 0, PROCESS_SIZE - 1);
  const i = (y * PROCESS_SIZE + x) * 4;
  const d = sourcePixels.data;
  return { r: d[i], g: d[i + 1], b: d[i + 2] };
}

function intensity(p) { return (p.r * 0.299 + p.g * 0.587 + p.b * 0.114); }

function regionStats(x, y, size) {
  const step = Math.max(2, Math.floor(size / 12));
  let sum = 0, sum2 = 0, count = 0;
  let rs = 0, gs = 0, bs = 0;

  for (let yy = y + Math.floor(step / 2); yy < y + size; yy += step) {
    for (let xx = x + Math.floor(step / 2); xx < x + size; xx += step) {
      const p = pixelAt(xx, yy);
      const v = intensity(p);
      sum += v; sum2 += v * v; rs += p.r; gs += p.g; bs += p.b; count++;
    }
  }
  const mean = sum / count;
  return {
    mean,
    variance: Math.max(0, sum2 / count - mean * mean),
    r: rs / count,
    g: gs / count,
    b: bs / count
  };
}

function shouldSplit(stat, depth, size) {
  const minimumSize = PROCESS_SIZE / Math.pow(2, maxDepth);
  return depth < maxDepth && size > minimumSize && stat.variance > threshold;
}

function buildQuadtree() {
  leaves = [];
  function split(x, y, size, depth) {
    const stat = regionStats(x, y, size);
    if (shouldSplit(stat, depth, size)) {
      const half = size / 2;
      split(x, y, half, depth + 1);
      split(x + half, y, half, depth + 1);
      split(x, y + half, half, depth + 1);
      split(x + half, y + half, half, depth + 1);
    } else {
      leaves.push({ x, y, size, depth, ...stat });
    }
  }
  split(0, 0, PROCESS_SIZE, 0);
}

// ---------------- TERRAIN CLASSIFICATION ----------------
function classify(stat) {
  const { r, g, b, mean } = stat;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;

  if (b > r * 1.12 && b > g * 0.98 && b > 105) return "water";
  if (g > r * 1.10 && g > b * 1.18 && g > 75) return "forest";
  if (saturation < 0.15 && mean < 145) return "urban";
  if (Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && mean < 130) return "rock";
  return "soil";
}

const classColors = {
  water: [60, 137, 167],
  forest: [79, 130, 63],
  soil: [183, 137, 84],
  rock: [119, 117, 107],
  urban: [117, 111, 137]
};

function enrichClassification(regions) {
  return regions.map(r => ({ ...r, terrainClass: classify(r) }));
}

// ---------------- REGION MERGING ----------------
function touching(a, b) {
  const ax2 = a.x + a.size, ay2 = a.y + a.size;
  const bx2 = b.x + b.size, by2 = b.y + b.size;
  const horizontal = (Math.abs(ax2 - b.x) < 0.01 || Math.abs(bx2 - a.x) < 0.01) && Math.min(ay2, by2) > Math.max(a.y, b.y);
  const vertical = (Math.abs(ay2 - b.y) < 0.01 || Math.abs(by2 - a.y) < 0.01) && Math.min(ax2, bx2) > Math.max(a.x, b.x);
  return horizontal || vertical;
}

function similar(a, b) {
  const meanDiff = Math.abs(a.mean - b.mean);
  const rgbDiff = (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) / 3;
  return a.terrainClass === b.terrainClass && meanDiff <= mergeTolerance && rgbDiff <= mergeTolerance * 1.35;
}

function mergePair(a, b) {
  const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.size, b.x + b.size), maxY = Math.max(a.y + a.size, b.y + b.size);
  const areaA = a.size * a.size, areaB = b.size * b.size, total = areaA + areaB;
  return {
    x: minX, y: minY, size: Math.max(maxX - minX, maxY - minY),
    depth: Math.min(a.depth, b.depth),
    mean: (a.mean * areaA + b.mean * areaB) / total,
    r: (a.r * areaA + b.r * areaB) / total,
    g: (a.g * areaA + b.g * areaB) / total,
    b: (a.b * areaA + b.b * areaB) / total,
    terrainClass: a.terrainClass
  };
}

function mergeRegions(input) {
  let regions = input.map(r => ({ ...r }));
  let changed = true;
  let guard = 0;

  // Repeatedly merge touching, similar regions. The guard keeps the browser responsive.
  while (changed && guard < 12) {
    changed = false;
    guard++;
    outer:
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        if (touching(regions[i], regions[j]) && similar(regions[i], regions[j])) {
          const merged = mergePair(regions[i], regions[j]);
          regions.splice(j, 1);
          regions.splice(i, 1, merged);
          changed = true;
          break outer;
        }
      }
    }
  }
  return regions;
}

// ---------------- ANALYSIS + STATS ----------------
function calculateDistribution(regions) {
  const area = { water: 0, forest: 0, soil: 0, rock: 0, urban: 0 };
  regions.forEach(r => { area[r.terrainClass] += r.size * r.size; });
  const total = PROCESS_SIZE * PROCESS_SIZE;
  return Object.fromEntries(Object.entries(area).map(([k, v]) => [k, (v / total) * 100]));
}

function updateStats() {
  const reduction = leaves.length ? ((1 - mergedRegions.length / leaves.length) * 100) : 0;
  document.getElementById("regionCount").textContent = leaves.length;
  document.getElementById("mergedCount").textContent = mergedRegions.length;
  document.getElementById("metricDepth").textContent = maxDepth;
  document.getElementById("reduction").textContent = `${reduction.toFixed(1)}%`;

  const dist = calculateDistribution(mergedRegions);
  for (const key of ["water", "forest", "soil", "rock", "urban"]) {
    document.getElementById(`${key}Pct`).textContent = pct(dist[key]);
    document.getElementById(`${key}Bar`).style.width = `${dist[key]}%`;
  }
  analysisStats = { dist, reduction };
}

function buildAnalysis() {
  if (!sourcePixels) return;
  document.getElementById("status").textContent = "ANALYZING…";
  buildQuadtree();
  leaves = enrichClassification(leaves);
  mergedRegions = mergeRegions(leaves);
  updateStats();
  drawCurrent();
  document.getElementById("status").textContent = "COMPLETE";
}

// ---------------- DRAWING ----------------
function drawSource() {
  ctx.clearRect(0, 0, PROCESS_SIZE, PROCESS_SIZE);
  ctx.drawImage(sourceImage, 0, 0, PROCESS_SIZE, PROCESS_SIZE);
}

function drawGrid(regions, options = {}) {
  ctx.save();
  ctx.lineWidth = options.lineWidth || 1;
  regions.forEach(r => {
    ctx.strokeStyle = options.color || "rgba(20,38,31,.55)";
    ctx.strokeRect(r.x + .5, r.y + .5, r.size - 1, r.size - 1);
  });
  ctx.restore();
}

function drawClassified(regions) {
  ctx.save();
  regions.forEach(r => {
    const c = classColors[r.terrainClass];
    ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},.72)`;
    ctx.fillRect(r.x, r.y, r.size, r.size);
    ctx.strokeStyle = "rgba(255,255,255,.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + .5, r.y + .5, r.size - 1, r.size - 1);
    if (r.size >= 55) {
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.font = "500 9px 'DM Mono', monospace";
      ctx.fillText(r.terrainClass.toUpperCase(), r.x + 7, r.y + 16);
    }
  });
  ctx.restore();
}

function drawCurrent() {
  if (!sourceImage) return;
  const title = document.getElementById("canvasTitle");
  if (displayMode === "original") {
    drawSource();
    title.textContent = "ORIGINAL TERRAIN IMAGE";
    return;
  }

  if (displayMode === "quadtree") {
    drawSource();
    drawGrid(leaves, { color: "rgba(25,47,37,.75)" });
    title.textContent = "QUADTREE SPLIT REGIONS";
    return;
  }

  if (displayMode === "merged") {
    drawSource();
    drawGrid(mergedRegions, { color: "rgba(22,43,34,.85)", lineWidth: 1.5 });
    mergedRegions.forEach(r => {
      ctx.fillStyle = "rgba(217,234,132,.13)";
      ctx.fillRect(r.x, r.y, r.size, r.size);
    });
    title.textContent = "MERGED REGIONS";
    return;
  }

  drawSource();
  drawClassified(mergedRegions);
  title.textContent = "TERRAIN CLASSIFICATION";
}

// ---------------- CONTROLS ----------------
imageInput.addEventListener("change", e => loadImageFile(e.target.files[0]));

sampleBtn.addEventListener("click", () => {
  loadSourceCanvas(createSampleImage(), "Sample terrain");
  document.getElementById("status").textContent = "SAMPLE READY";
});

thresholdInput.addEventListener("input", e => {
  threshold = Number(e.target.value);
  document.getElementById("thresholdValue").textContent = threshold;
  buildAnalysis();
});

depthInput.addEventListener("input", e => {
  maxDepth = Number(e.target.value);
  document.getElementById("depthValue").textContent = maxDepth;
  buildAnalysis();
});

mergeInput.addEventListener("input", e => {
  mergeTolerance = Number(e.target.value);
  document.getElementById("mergeValue").textContent = mergeTolerance;
  buildAnalysis();
});

document.querySelectorAll(".mode-select .terrain-option").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-select .terrain-option").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    displayMode = btn.dataset.mode;
    drawCurrent();
  });
});

runBtn.addEventListener("click", () => {
  if (running || !sourcePixels) return;
  running = true;
  runBtn.disabled = true;
  document.getElementById("status").textContent = "RUNNING…";
  document.getElementById("status").classList.add("status-running");

  // Small staged animation so the workflow is visible during a presentation.
  const stages = ["SPLITTING…", "MERGING…", "CLASSIFYING…", "COMPLETE"];
  let index = 0;
  const timer = setInterval(() => {
    document.getElementById("status").textContent = stages[index++];
    if (index >= stages.length) {
      clearInterval(timer);
      buildAnalysis();
      running = false;
      runBtn.disabled = false;
      document.getElementById("status").classList.remove("status-running");
    }
  }, 350);
});

resetBtn.addEventListener("click", () => {
  threshold = 34; maxDepth = 5; mergeTolerance = 18; displayMode = "classified";
  thresholdInput.value = threshold; depthInput.value = maxDepth; mergeInput.value = mergeTolerance;
  document.getElementById("thresholdValue").textContent = threshold;
  document.getElementById("depthValue").textContent = maxDepth;
  document.getElementById("mergeValue").textContent = mergeTolerance;
  document.querySelectorAll(".mode-select .terrain-option").forEach(b => b.classList.remove("active"));
  document.querySelector('.mode-select [data-mode="classified"]').classList.add("active");
  loadSourceCanvas(createSampleImage(), "Sample terrain");
  document.getElementById("status").textContent = "RESET";
});

// ---------------- INITIALIZATION ----------------
loadSourceCanvas(createSampleImage(), "Sample terrain");

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => { if (entry.isIntersecting) entry.target.classList.add("visible"); });
}, { threshold: .12 });
document.querySelectorAll(".reveal").forEach(el => observer.observe(el));
