/* CT and X-ray simulator. Kept separate from the MRI code; shares only the page's CSS. */
(() => {
"use strict";

/* ============================================================
   Physics tables (NIST XCOM, linear attenuation in cm^-1)
   ============================================================ */
const E_TAB = [20, 30, 40, 50, 60, 80, 100, 150];
const MU_W  = [0.8096, 0.3756, 0.2683, 0.2269, 0.2059, 0.1837, 0.1707, 0.1505];                 // water
const MU_B  = [4.001, 1.331, 0.6655, 0.4242, 0.3148, 0.2229, 0.1855, 0.1480].map(x => x * 1.92); // cortical bone
const MU_AL = [3.441, 1.128, 0.5685, 0.3681, 0.2778, 0.2018, 0.1704, 0.1378].map(x => x * 2.699); // aluminium
function muAt(E, tab) {
  let i = 0;
  if (E <= E_TAB[0]) i = 0; else if (E >= E_TAB[E_TAB.length - 1]) i = E_TAB.length - 2;
  else while (E > E_TAB[i + 1]) i++;
  const f = (Math.log(E) - Math.log(E_TAB[i])) / (Math.log(E_TAB[i + 1]) - Math.log(E_TAB[i]));
  return Math.exp(Math.log(tab[i]) + f * (Math.log(tab[i + 1]) - Math.log(tab[i])));
}
// Detected-energy-weighted spectrum: Kramers (kVp - E), tungsten K lines, aluminium filtration
function spectrum(kVp, alMM, step = 2) {
  const E = [], w = [];
  for (let e = 16 + step / 2; e < kVp; e += step) {
    let k = (kVp - e);
    if (kVp > 70 && Math.abs(e - 59.3) <= step / 2) k += 0.12 * kVp;
    if (kVp > 70 && Math.abs(e - 67.2) <= step / 2) k += 0.04 * kVp;
    k *= Math.exp(-muAt(e, MU_AL) * alMM / 10);
    E.push(e); w.push(k);
  }
  const s = w.reduce((a, b) => a + b, 0);
  return { E, w: w.map(x => x / s), muW: E.map(e => muAt(e, MU_W)), muB: E.map(e => muAt(e, MU_B)) };
}
// effective attenuation after hardening by `cm` of water
function effMu(sp, cm) {
  let sw = 0, mw = 0, mb = 0;
  sp.E.forEach((_, k) => { const h = sp.w[k] * Math.exp(-sp.muW[k] * cm); sw += h; mw += h * sp.muW[k]; mb += h * sp.muB[k]; });
  return { w: mw / sw, b: mb / sw };
}
const REF = effMu(spectrum(120, 6), 20);
const HU_BONE_REF = 1000 * (REF.b / REF.w - 1);   // HU of cortical bone in the source scans (120 kVp)

/* ============================================================
   Shared helpers
   ============================================================ */
const $ = id => document.getElementById(id);
function gauss() { let u = 0; while (u === 0) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }
async function loadVolume(name) {
  const meta = await (await fetch(name + ".json")).json();
  const b64 = (await (await fetch(name + ".b64.txt")).text()).trim();
  const bin = atob(b64), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  const raw = await new Response(ds).arrayBuffer();
  const vol = new Int16Array(raw);
  if (vol.length !== meta.nz * meta.ny * meta.nx) throw new Error("volume size mismatch");
  return { meta, vol };
}
// HU -> (water-equivalent density, bone fraction)
function decompose(hu) {
  if (hu <= 0) return [Math.max(0, 1 + hu / 1000), 0];
  const b = hu / HU_BONE_REF;
  return [Math.max(0, 1 - b), b];
}
function segBind(id, cb) {
  document.querySelectorAll(`#${id} button`).forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(`#${id} button`).forEach(x => x.classList.toggle("on", x === b));
    cb(b.dataset.v);
  }));
}
function fmt1(v) { return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2); }

// FFT for projection filtering
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/* ============================================================
   Implants (analytic shapes in voxel coordinates of each volume)
   ============================================================ */
// Chest: left infraclavicular pacemaker with a lead through the SVC into the right ventricle.
const PACER_PATH = [[172, 178], [160, 190], [140, 182], [112, 160], [104, 126], [128, 110], [150, 106]]; // [x, z] voxel
const PACER_Y = [null, 50, 55, 60, 64, 52, 40];  // y (row) voxel along the path; first point is set from the skin
function buildPacer(V) {
  const { vol, meta } = V, { nx, ny } = meta;
  // find skin at generator site
  const gx = 190, gz = 175;
  let sy = 0; for (let y = 0; y < ny; y++) if (vol[(gz * ny + y) * nx + gx] > -300) { sy = y; break; }
  const gy = sy + 5;
  const shapes = [{ type: "ell", c: [gx, gy, gz], r: [15, 2.8, 11], b: 4 }];
  const pts = PACER_PATH.map((p, i) => [p[0], i === 0 ? gy + 2 : PACER_Y[i], p[1]]);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], c = pts[i + 1], L = Math.hypot(c[0] - a[0], c[1] - a[1], (c[2] - a[2]) * meta.dz / meta.px);
    const n = Math.ceil(L / 0.6);
    for (let k = 0; k < n; k++) { const f = k / n; shapes.push({ type: "ell", c: [a[0] + f * (c[0] - a[0]), a[1] + f * (c[1] - a[1]), a[2] + f * (c[2] - a[2])], r: [0.75, 0.75, 0.75 * meta.px / meta.dz], b: 5 }); }
  }
  return shapes;
}
// Head: aneurysm clip near the circle of Willis
function buildClip(V) {
  const { nx, ny, nz } = V.meta;
  return [{ type: "ell", c: [nx * 0.47, ny * 0.40, nz * 0.27], r: [4.5, 2.0, 1.4], b: 9 }];
}
// fraction of voxel (x, y, z) inside ellipsoid, sampled 2x2 in-plane
function shapeFrac(s, x, y, z) {
  let f = 0;
  for (let a = -0.25; a <= 0.25; a += 0.5) for (let b = -0.25; b <= 0.25; b += 0.5) {
    const dx = (x + a - s.c[0]) / s.r[0], dy = (y + b - s.c[1]) / s.r[1], dz = (z - s.c[2]) / s.r[2];
    if (dx * dx + dy * dy + dz * dz <= 1) f += 0.25;
  }
  return f;
}

/* ============================================================
   CT
   ============================================================ */
const FR = 256;                 // projection frame (pixels)
const ND = 368;                 // detector channels (> frame diagonal)
const CT = {
  region: "chest", kVp: 120, mAs: 200, pitch: 1, thk: 5, z: 0, kernel: "standard", recon: "fbp", views: 360,
  dfov: 0, bh: "water", metal: false, ring: false, motion: 0,
  vols: {}, slW: null, slB: null, Lw: null, Lb: null, img: new Float32Array(FR * FR), win: { W: 400, L: 40 }, sino: null,
  dirtyProj: true, busy: false,
};
const CT_WINDOWS = {
  chest: [["Mediastinum", 400, 40], ["Lung", 1500, -600], ["Bone", 1800, 400], ["Abdomen", 350, 50], ["Liver", 160, 60]],
  head: [["Brain", 80, 40], ["Subdural", 215, 75], ["Stroke", 30, 35], ["Bone", 2800, 600], ["Soft tissue", 350, 40]],
};
const CT_REGION = {
  chest: { file: "chest_ct", ctdi100: 7.0, k: 0.014, label: "Chest CT with IV contrast" },
  head: { file: "head_ct", ctdi100: 17, k: 0.0021, label: "Head CT without contrast" },
};

function ctVol() { return CT.vols[CT.region]; }
function ctZRange() { const V = ctVol(); if (!V) return [0, 0]; const m = V.meta; return [0, (m.nz - 1) * m.dz]; }

// Build the water/bone maps of the current slice (thickness-weighted average of planes)
function ctBuildSlice() {
  const V = ctVol(), { meta, vol } = V, { nx, ny, nz, dz } = meta;
  const ox = Math.floor((FR - nx) / 2), oy = Math.floor((FR - ny) / 2);
  const W = new Float32Array(FR * FR), B = new Float32Array(FR * FR);
  const half = Math.max(CT.thk, dz * 0.5) / 2, zc = CT.z;
  const planes = [];
  for (let k = 0; k < nz; k++) {
    const ov = Math.min(zc + half, k * dz + dz / 2) - Math.max(zc - half, k * dz - dz / 2);
    if (ov > 0) planes.push([k, ov]);
  }
  if (!planes.length) planes.push([Math.max(0, Math.min(nz - 1, Math.round(zc / dz))), 1]);
  const ws = planes.reduce((a, p) => a + p[1], 0);
  for (const [k, ov] of planes) {
    const wgt = ov / ws, base = k * ny * nx;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const hu = vol[base + y * nx + x];
      if (hu <= -1000) continue;
      const [w, b] = decompose(hu), i = (y + oy) * FR + (x + ox);
      W[i] += w * wgt; B[i] += b * wgt;
    }
    if (CT.metal) for (const s of (V.implant || [])) {
      if (Math.abs(k - s.c[2]) > s.r[2] + 1) continue;
      const x0 = Math.floor(s.c[0] - s.r[0] - 1), x1 = Math.ceil(s.c[0] + s.r[0] + 1), y0 = Math.floor(s.c[1] - s.r[1] - 1), y1 = Math.ceil(s.c[1] + s.r[1] + 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const f = shapeFrac(s, x, y, k); if (!f) continue;
        const i = (y + oy) * FR + (x + ox); W[i] *= 1 - f * wgt * 0; B[i] += f * s.b * wgt;
      }
    }
  }
  CT.slW = W; CT.slB = B; CT.ox = ox; CT.oy = oy;
}

// Parallel-beam forward projection of both basis materials
function ctProject() {
  const Nv = CT.views, px = ctVol().meta.px, pcm = px / 10;
  const W = CT.slW, B = CT.slB;
  const Lw = new Float32Array(Nv * ND), Lb = new Float32Array(Nv * ND);
  const c0 = FR / 2 - 0.5, S = Math.ceil(FR * 0.72);
  // support radius (skip empty rays)
  let rmax = 0;
  for (let y = 0; y < FR; y++) for (let x = 0; x < FR; x++) if (W[y * FR + x] + B[y * FR + x] > 0.01) rmax = Math.max(rmax, Math.hypot(x - c0, y - c0));
  rmax += 2;
  const motion = CT.motion / px;
  for (let v = 0; v < Nv; v++) {
    const th = Math.PI * v / Nv, cs = Math.cos(th), sn = Math.sin(th);
    // patient drifts in the AP direction during the second half of the rotation
    const f = v / Nv, my = f > 0.55 ? motion : f > 0.45 ? motion * (f - 0.45) * 10 : 0;
    for (let d = 0; d < ND; d++) {
      const t = d - ND / 2 + 0.5 - my * sn;
      if (Math.abs(t) > rmax) continue;
      const smax = Math.sqrt(Math.max(0, rmax * rmax - t * t));
      let x = c0 + t * cs + smax * sn, y = c0 + t * sn - smax * cs;
      let sw = 0, sb = 0;
      for (let s = -smax; s <= smax; s += 1, x -= sn, y += cs) {
        const ix = Math.floor(x), iy = Math.floor(y);
        if (ix < 0 || iy < 0 || ix >= FR - 1 || iy >= FR - 1) continue;
        const ax = x - ix, ay = y - iy, i = iy * FR + ix;
        const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
        sw += W[i] * w00 + W[i + 1] * w10 + W[i + FR] * w01 + W[i + FR + 1] * w11;
        sb += B[i] * w00 + B[i + 1] * w10 + B[i + FR] * w01 + B[i + FR + 1] * w11;
      }
      Lw[v * ND + d] = sw * pcm; Lb[v * ND + d] = sb * pcm;
    }
  }
  CT.Lw = Lw; CT.Lb = Lb;
}

const kernelCache = {};
function rampFilter(kernel, dcm) {
  const key = kernel + dcm;
  if (kernelCache[key]) return kernelCache[key];
  const M = 1024, re = new Float64Array(M), im = new Float64Array(M);
  for (let n = -ND; n <= ND; n++) {
    const k = (n + M) % M;
    re[k] = n === 0 ? 1 / (4 * dcm * dcm) : (n % 2 ? -1 / (Math.PI * Math.PI * n * n * dcm * dcm) : 0);
  }
  fft(re, im, false);
  const H = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    const u = Math.min(k, M - k) / (M / 2); // 0..1 of Nyquist
    let win = 1;
    if (kernel === "smooth") win = 0.5 * (1 + Math.cos(Math.PI * u));
    else if (kernel === "standard") win = u === 0 ? 1 : Math.sin(Math.PI * u / 2) / (Math.PI * u / 2);
    else win = (1 + 0.9 * u * u) * (u > 0.85 ? 0.5 * (1 + Math.cos(Math.PI * (u - 0.85) / 0.15)) : 1);
    H[k] = re[k] * win;
  }
  return (kernelCache[key] = H);
}

function ctReconstruct() {
  const Nv = CT.views, V = ctVol(), px = V.meta.px, dcm = px / 10;
  const sp = spectrum(CT.kVp, 6, 4);
  const mono = effMu(sp, 20);                          // effective energy of the hardened beam
  const muRef = mono.w;
  // photons per detector per view (unattenuated)
  const mAsEff = CT.mAs / CT.pitch;
  const N0 = (CT.region === "head" ? 2.0e4 : 5.0e2) * mAsEff * Math.pow(CT.kVp / 120, 2.5) * (CT.thk / 5) * px * (360 / Nv);
  // water beam-hardening correction table: polychromatic p -> water path
  const corrL = [], corrP = [];
  for (let L = 0; L <= 80; L += 0.5) {
    let T = 0; sp.E.forEach((_, k) => { T += sp.w[k] * Math.exp(-sp.muW[k] * L); });
    corrL.push(L); corrP.push(-Math.log(T));
  }
  const waterCorr = p => {
    let i = 0; while (i < corrP.length - 2 && corrP[i + 1] < p) i++;
    const f = (p - corrP[i]) / (corrP[i + 1] - corrP[i]);
    return (corrL[i] + f * (corrL[i + 1] - corrL[i])) * muRef;
  };
  const badCh = Math.round(ND / 2 + 19);
  const P = new Float32Array(Nv * ND), PN = new Float32Array(Nv * ND);
  const K = sp.E.length;
  for (let i = 0; i < Nv * ND; i++) {
    const lw = CT.Lw[i], lb = CT.Lb[i];
    let T;
    if (CT.bh === "ideal") T = Math.exp(-(mono.w * lw + mono.b * lb));
    else { T = 0; for (let k = 0; k < K; k++) T += sp.w[k] * Math.exp(-(sp.muW[k] * lw + sp.muB[k] * lb)); }
    const nc = N0 * T;
    let n = nc + Math.sqrt(nc) * gauss();
    const ch = i % ND, g = CT.ring && (ch === badCh || ch === ND - 1 - badCh) ? 0.8 : 1;  // 360° scanner: both halves of the ring
    n = Math.max(n * g, 0.6);                            // photon starvation floor
    let p = -Math.log(n / N0), pc = -Math.log(Math.max(nc * g, 0.6) / N0);
    if (CT.bh === "water") { p = waterCorr(p); pc = waterCorr(pc); }
    P[i] = p; PN[i] = p - pc;                            // PN = the noise part alone
  }
  CT.sino = P;
  // filter
  const H = rampFilter(CT.kernel, dcm), M = 1024;
  const Q = new Float32Array(Nv * ND), re = new Float64Array(M), im = new Float64Array(M);
  for (let v = 0; v < Nv; v++) {
    re.fill(0); im.fill(0);
    for (let d = 0; d < ND; d++) re[d] = P[v * ND + d];
    fft(re, im, false);
    for (let k = 0; k < M; k++) { re[k] *= H[k]; im[k] *= H[k]; }
    fft(re, im, true);
    for (let d = 0; d < ND; d++) Q[v * ND + d] = re[d] * dcm;
  }
  // backproject
  const dfov = CT.dfov || FR * px, rp = dfov / FR / px; // recon pixel in projection pixels
  const img = CT.img; img.fill(0);
  const cosT = new Float32Array(Nv), sinT = new Float32Array(Nv);
  for (let v = 0; v < Nv; v++) { cosT[v] = Math.cos(Math.PI * v / Nv); sinT[v] = Math.sin(Math.PI * v / Nv); }
  for (let v = 0; v < Nv; v++) {
    const cs = cosT[v] * rp, sn = sinT[v] * rp, row = v * ND;
    for (let j = 0; j < FR; j++) {
      const yy = j - FR / 2 + 0.5;
      let t = (-FR / 2 + 0.5) * cs + yy * sn + ND / 2 - 0.5;
      for (let i = 0; i < FR; i++, t += cs) {
        const it = t | 0;
        if (it < 0 || it >= ND - 1) continue;
        const f = t - it;
        img[j * FR + i] += Q[row + it] * (1 - f) + Q[row + it + 1] * f;
      }
    }
  }
  const sc = Math.PI / Nv;
  for (let k = 0; k < FR * FR; k++) img[k] = 1000 * (img[k] * sc - muRef) / muRef;
  // exact noise SD: reconstruct the noise-only sinogram at sample points inside soft tissue
  const pts = [];
  for (let j = 4; j < FR - 4; j += 6) for (let i = 4; i < FR - 4; i += 6) { const h = img[j * FR + i]; if (h > -200 && h < 300) pts.push([i, j]); }
  if (pts.length > 20) {
    const QN = new Float32Array(Nv * ND);
    for (let v = 0; v < Nv; v++) {
      re.fill(0); im.fill(0);
      for (let d = 0; d < ND; d++) re[d] = PN[v * ND + d];
      fft(re, im, false);
      for (let k = 0; k < M; k++) { re[k] *= H[k]; im[k] *= H[k]; }
      fft(re, im, true);
      for (let d = 0; d < ND; d++) QN[v * ND + d] = re[d] * dcm;
    }
    let s1 = 0, s2 = 0;
    for (const [i, j] of pts) {
      let acc = 0;
      for (let v = 0; v < Nv; v++) {
        const t = (i - FR / 2 + 0.5) * cosT[v] * rp + (j - FR / 2 + 0.5) * sinT[v] * rp + ND / 2 - 0.5, it = t | 0, f = t - it;
        acc += QN[v * ND + it] * (1 - f) + QN[v * ND + it + 1] * f;
      }
      const hu = 1000 * acc * sc / muRef; s1 += hu; s2 += hu * hu;
    }
    CT.noiseSD = Math.sqrt(Math.max(0, s2 / pts.length - (s1 / pts.length) ** 2));
    if (CT.recon === "iter") CT.noiseSD *= 0.45;
  } else CT.noiseSD = null;
  if (CT.recon === "iter") bilateral(img, 28);
  CT.muRef = muRef; CT.mono = mono; CT.sp = sp;
}
function bilateral(img, sr) {
  const out = new Float32Array(img.length), r = 2, ss = 1.4;
  const wsp = []; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) wsp.push(Math.exp(-(dx * dx + dy * dy) / (2 * ss * ss)));
  for (let y = 0; y < FR; y++) for (let x = 0; x < FR; x++) {
    const c = img[y * FR + x]; let s = 0, ws = 0, q = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++, q++) {
      const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= FR || xx >= FR) continue;
      const v = img[yy * FR + xx], d = (v - c) / sr, w = wsp[q] * Math.exp(-0.5 * d * d);
      s += v * w; ws += w;
    }
    out[y * FR + x] = s / ws;
  }
  img.set(out);
}

/* ---------- CT drawing ---------- */
const ctCv = $("ctImg"), ctCx = ctCv.getContext("2d");
const ctOff = document.createElement("canvas"); ctOff.width = FR; ctOff.height = FR;
const ctOffx = ctOff.getContext("2d"), ctId = ctOffx.createImageData(FR, FR);
function ctDraw() {
  const { W, L } = CT.win, lo = L - W / 2, d = ctId.data, img = CT.img;
  for (let k = 0; k < FR * FR; k++) {
    let g = (img[k] - lo) / W * 255; g = g < 0 ? 0 : g > 255 ? 255 : g;
    d[4 * k] = d[4 * k + 1] = d[4 * k + 2] = g; d[4 * k + 3] = 255;
  }
  ctOffx.putImageData(ctId, 0, 0);
  ctCx.imageSmoothingEnabled = true; ctCx.imageSmoothingQuality = "high";
  ctCx.drawImage(ctOff, 0, 0, ctCv.width, ctCv.height);
  $("ctBL").textContent = `W ${Math.round(W)}  L ${Math.round(L)}`;
}
function ctDrawSino() {
  const c = $("ctSino"), g = c.getContext("2d"), Nv = CT.views;
  c.width = ND; c.height = Nv;
  const id = g.createImageData(ND, Nv); let mx = 0;
  for (let i = 0; i < CT.sino.length; i++) if (CT.sino[i] > mx) mx = CT.sino[i];
  for (let i = 0; i < CT.sino.length; i++) { const v = Math.max(0, CT.sino[i]) / mx * 255; id.data[4 * i] = id.data[4 * i + 1] = id.data[4 * i + 2] = v; id.data[4 * i + 3] = 255; }
  g.putImageData(id, 0, 0);
}
function ctNoiseEstimate() {
  // CT noise is spatially correlated, so measure the SD inside small uniform patches (like an ROI)
  // and take a low percentile: patches without anatomy show pure noise.
  const img = CT.img, sds = [], r = 4;
  for (let y = r; y < FR - r; y += 5) for (let x = r; x < FR - r; x += 5) {
    let s = 0, s2 = 0, n = 0, ok = true;
    for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r; dx++) {
      const v = img[(y + dy) * FR + x + dx];
      if (v < -150 || v > 200) { ok = false; break; }
      s += v; s2 += v * v; n++;
    }
    if (ok) sds.push(Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)));
  }
  if (sds.length < 8) return null;
  sds.sort((a, b) => a - b);
  return sds[Math.floor(sds.length * 0.25)];
}
function ctInfo() {
  const R = CT_REGION[CT.region], m = ctVol().meta;
  const mAsEff = CT.mAs / CT.pitch;
  const ctdi = R.ctdi100 * mAsEff / 100 * Math.pow(CT.kVp / 120, 2.5);
  const len = m.nz * m.dz / 10;
  const dlp = ctdi * len;
  $("ctCTDI").textContent = fmt1(ctdi) + " mGy";
  $("ctDLP").textContent = Math.round(dlp) + " mGy·cm";
  $("ctDLPs").textContent = `over ${len.toFixed(0)} cm scan length`;
  $("ctE").textContent = fmt1(dlp * R.k) + " mSv";
  const sd = CT.noiseSD;
  $("ctSD").textContent = sd ? sd.toFixed(1) + " HU" : "–";
  $("ctTL").textContent = `${R.label}\n${CT.kVp} kVp  ${CT.mAs} mAs  pitch ${CT.pitch.toFixed(1)}\n${CT.thk} mm  ${CT.views} views`;
  const dfov = CT.dfov || FR * m.px;
  $("ctTR").textContent = `${{ smooth: "Smooth", standard: "Standard", sharp: "Sharp" }[CT.kernel]} kernel  ${CT.recon === "iter" ? "Iterative" : "FBP"}\nDFOV ${Math.round(dfov / 10)} cm\n${(dfov / FR).toFixed(2)} mm/px`;
  $("ctBR").textContent = `Z ${(CT.z - ctZRange()[1] / 2).toFixed(0)} mm`;
  // CT numbers table at this kVp
  const mono = CT.mono, mats = [["Air", -1000], ["Lung", -850], ["Fat", -100], ["Water", 0], ["Gray matter", 40], ["Blood + iodine (aorta)", 250], ["Cancellous bone", 400], ["Cortical bone", 1300]];
  let h = `<tr><th>Material</th><th>at 120 kVp</th><th>at ${CT.kVp} kVp</th></tr>`;
  for (const [n, hu] of mats) {
    const [w, b] = decompose(hu);
    const mu = w * mono.w + b * mono.b, hk = 1000 * (mu - mono.w) / mono.w;
    h += `<tr><td>${n}</td><td>${hu}</td><td>${Math.round(hk)}</td></tr>`;
  }
  $("ctTbl").innerHTML = h;
  // notes
  const notes = [];
  if (sd != null) notes.push(sd > 25 ? `Noise is high (≈${sd.toFixed(0)} HU). Noise falls with √(mAs × slice thickness ÷ pitch). Doubling mAs only reduces noise by 1/√2 but doubles dose.` : sd < 8 ? `Noise is low (≈${sd.toFixed(1)} HU), but check the dose: CTDIvol is ${fmt1(ctdi)} mGy.` : `Noise is ≈${sd.toFixed(0)} HU in soft tissue.`);
  if (CT.views < 180) notes.push("With few projection angles, backprojection leaves fine radial streaks away from the center (view aliasing).");
  if (CT.bh === "uncorrected") notes.push("Without beam-hardening correction, the beam gets harder (higher mean energy) as it crosses the patient, so the center looks too dark (cupping), with dark streaks between dense bones.");
  if (CT.bh === "ideal") notes.push("A monoenergetic beam has no beam hardening. Real tubes produce a spectrum, so this is only a reference.");
  if (CT.kVp <= 100) notes.push(`At ${CT.kVp} kVp, iodine and bone attenuate relatively more (see the table), so contrast-enhanced vessels get brighter. Low-kVp protocols use this to cut contrast dose, but noise rises unless mAs is increased.`);
  if (CT.kVp === 140) notes.push("140 kVp penetrates large patients and dense bone better, but iodine and soft-tissue contrast drop.");
  if (CT.metal) notes.push("Metal absorbs almost all photons along some rays (photon starvation) and hardens the beam strongly. Filtered backprojection spreads those errors as bright and dark streaks. Scanners reduce this with metal artifact reduction (MAR) algorithms.");
  if (CT.ring) notes.push("One miscalibrated detector channel makes a vertical line in the sinogram, which backprojects into a ring centered on the rotation axis.");
  if (CT.motion > 0) notes.push("The patient moved partway through the rotation, so the projections are inconsistent and edges show streaks and doubling.");
  if (CT.kernel === "sharp") notes.push("The sharp kernel boosts high spatial frequencies, so edges (bone, lung detail) are crisper and noise is coarser and higher.");
  if (CT.kernel === "smooth") notes.push("The smooth kernel suppresses high frequencies, so noise is lower at the cost of fine detail. It's best for low-contrast soft tissue such as liver and brain.");
  if (CT.recon === "iter") notes.push("This simulated iterative reconstruction uses edge-preserving denoising. Noise drops a lot (allowing lower dose), but strong settings give a waxy, plastic look.");
  if (CT.pitch > 1.2) notes.push(`Pitch ${CT.pitch.toFixed(1)} covers the scan length faster and lowers dose per mAs, but effective mAs (mAs ÷ pitch) falls, so noise rises.`);
  $("ctNotes").innerHTML = notes.map(n => `<p>${n}</p>`).join("");
}
let ctPending = false;
function ctUpdate(reproject) {
  if (reproject) CT.dirtyProj = true;
  if (ctPending || !ctVol()) return;
  ctPending = true;
  $("ctBusy").classList.remove("hidden");
  setTimeout(() => requestAnimationFrame(() => {
    ctPending = false;
    if (CT.dirtyProj) { ctBuildSlice(); ctProject(); CT.dirtyProj = false; }
    ctReconstruct(); ctDraw(); ctDrawSino(); ctInfo();
    $("ctBusy").classList.add("hidden");
  }), 0);
}

/* ---------- CT controls ---------- */
function ctSlider(id, key, fmtf, reproject, parse = parseFloat) {
  const el = $(id), out = $("o_" + id);
  const show = () => { out.textContent = fmtf(CT[key]); };
  el.value = CT[key]; show();
  el.addEventListener("input", () => { CT[key] = parse(el.value); show(); ctUpdate(reproject); });
  return { el, show };
}
function ctSetRegion(r) {
  CT.region = r;
  const V = ctVol(), m = V.meta;
  if (!V.implant) V.implant = r === "chest" ? buildPacer(V) : buildClip(V);
  const [z0, z1] = ctZRange();
  const zs = $("ctZ"); zs.min = z0; zs.max = z1; zs.step = m.dz;
  CT.z = r === "chest" ? Math.round(z1 * 0.56 / m.dz) * m.dz : Math.round(z1 * 0.5 / m.dz) * m.dz; zs.value = CT.z;
  const th = $("ctTHK"); th.min = m.dz; CT.thk = Math.max(CT.thk, m.dz); th.value = CT.thk;
  CT.dfov = r === "chest" ? 360 : 0; $("ctDFOV").max = Math.round(FR * m.px); $("ctDFOV").min = Math.round(FR * m.px * 0.4); $("ctDFOV").value = CT.dfov || Math.round(FR * m.px);
  CT.mAs = r === "head" ? 300 : 200; $("ctMAS").value = CT.mAs;
  const [, W, L] = CT_WINDOWS[r][0]; CT.win = { W, L };
  $("ctWin").innerHTML = "";
  for (const [n, W, L] of CT_WINDOWS[r]) {
    const b = document.createElement("button"); b.textContent = `${n} (${W}/${L})`;
    b.addEventListener("click", () => { CT.win = { W, L }; ctDraw(); });
    $("ctWin").appendChild(b);
  }
  $("ctMetalLbl").textContent = r === "chest" ? "Metal: pacemaker and lead" : "Metal: aneurysm clip";
  ctShowAll(); ctUpdate(true);
}
let ctShowAll = () => {};
function ctInitControls() {
  const sl = [
    ctSlider("ctMAS", "mAs", v => v + " mAs", false),
    ctSlider("ctPITCH", "pitch", v => v.toFixed(1), false),
    ctSlider("ctTHK", "thk", v => v + " mm", true),
    ctSlider("ctZ", "z", v => (v - ctZRange()[1] / 2).toFixed(0) + " mm", true),
    ctSlider("ctDFOV", "dfov", v => Math.round((v || (ctVol() ? FR * ctVol().meta.px : 0)) / 10) + " cm", false),
    ctSlider("ctMOT", "motion", v => v ? v + " mm" : "none", true),
  ];
  ctShowAll = () => sl.forEach(s => s.show());
  $("ctDFOV").addEventListener("input", () => { if (+$("ctDFOV").value >= +$("ctDFOV").max) CT.dfov = 0; });
  segBind("ctKVP", v => { CT.kVp = +v; ctUpdate(false); });
  segBind("ctKER", v => { CT.kernel = v; ctUpdate(false); });
  segBind("ctREC", v => { CT.recon = v; ctUpdate(false); });
  segBind("ctVIEWS", v => { CT.views = +v; ctUpdate(true); });
  segBind("ctRegion", v => ctEnsure(v));
  $("ctBH").addEventListener("change", e => { CT.bh = e.target.value; ctUpdate(false); });
  $("ctMetal").addEventListener("change", e => { CT.metal = e.target.checked; ctUpdate(true); });
  $("ctRing").addEventListener("change", e => { CT.ring = e.target.checked; ctUpdate(false); });
  // window/level drag + HU readout
  let drag = null;
  ctCv.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, W: CT.win.W, L: CT.win.L }; ctCv.setPointerCapture(e.pointerId); });
  ctCv.addEventListener("pointerup", () => { drag = null; });
  ctCv.addEventListener("pointermove", e => {
    if (drag) { CT.win.W = Math.max(1, drag.W * Math.exp((e.clientX - drag.x) / 200)); CT.win.L = drag.L - (e.clientY - drag.y) * drag.W / 300; ctDraw(); }
    const r = ctCv.getBoundingClientRect(), u = (e.clientX - r.left) / r.width * FR, v = (e.clientY - r.top) / r.height * FR;
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= FR || j >= FR) return;
    const m = ctVol().meta, dfov = CT.dfov || FR * m.px, rr = 5 / (dfov / FR); // 5 mm radius ROI
    let s = 0, s2 = 0, n = 0;
    for (let y = Math.floor(v - rr); y <= v + rr; y++) for (let x = Math.floor(u - rr); x <= u + rr; x++) {
      if (x < 0 || y < 0 || x >= FR || y >= FR || (x - u) ** 2 + (y - v) ** 2 > rr * rr) continue;
      const h = CT.img[y * FR + x]; s += h; s2 += h * h; n++;
    }
    const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    $("ctBL").textContent = `HU ${Math.round(CT.img[j * FR + i])}\nROI (1 cm) ${Math.round(mean)} ± ${sd.toFixed(1)}\nW ${Math.round(CT.win.W)}  L ${Math.round(CT.win.L)}`;
  });
  ctCv.addEventListener("pointerleave", () => { if (!drag) ctDraw(); });
}
async function ctEnsure(region) {
  CT.region = region;
  if (!CT.vols[region]) {
    $("ctLoading").classList.remove("hidden");
    $("ctLoading").textContent = "Loading CT data…";
    try { CT.vols[region] = await loadVolume(CT_REGION[region].file); }
    catch (err) { $("ctLoading").textContent = "Could not load the CT data: " + err.message; return; }
  }
  $("ctLoading").classList.add("hidden");
  ctSetRegion(region);
}

/* ============================================================
   X-ray (projection radiography)
   ============================================================ */
const XR = {
  view: "PA", kVp: 120, mAsI: 9, SID: 180, grid: true, focal: "large", fw: 40, fh: 43, motion: 0, film: false, edge: true, pacer: false,
  slabs: null, slabView: null, detW: 0, detH: 0,
};
const MAS_STEPS = [0.25, 0.32, 0.4, 0.5, 0.63, 0.8, 1, 1.25, 1.6, 2, 2.5, 3.2, 4, 5, 6.3, 8, 10, 12.5, 16, 20, 25, 32, 40, 50, 63, 80, 100];
const XPIX = 1.2;
// fixed display LUT per projection: width and centre offset in ln(signal) units (calibrated at 120 kVp)
const XR_LUT = { PA: { w: 3.7, c: -0.87 }, AP: { w: 2.55, c: -0.81 }, LAT: { w: 4.3, c: -1.3 } };   // detector display pixel, mm
const DET_W = 430, DET_H = 460;
const NSLAB = 10;
// Precompute slab projections (water & bone path lengths) for a view, in volume mm coordinates
function xrBuildSlabs() {
  const V = CT.vols.chest, { meta, vol } = V, { nx, ny, nz, px, dz } = meta;
  const lateral = XR.view === "LAT";
  const nU = lateral ? ny : nx, nA = lateral ? nx : ny;       // detector-horizontal axis, beam axis
  const slabs = [];
  // body extent along the beam
  let a0 = nA, a1 = -1;
  for (let z = 0; z < nz; z += 4) for (let y = 0; y < ny; y += 2) for (let x = 0; x < nx; x += 2) {
    if (vol[(z * ny + y) * nx + x] > -400) { const a = lateral ? x : y; if (a < a0) a0 = a; if (a > a1) a1 = a; }
  }
  const per = Math.ceil((a1 - a0 + 1) / NSLAB);
  const implant = XR.pacer ? (V.implant || (V.implant = buildPacer(V))) : [];
  for (let s = 0; s < NSLAB; s++) {
    const lo = a0 + s * per, hi = Math.min(a1 + 1, lo + per);
    const Lw = new Float32Array(nU * nz), Lb = new Float32Array(nU * nz);
    for (let z = 0; z < nz; z++) for (let a = lo; a < hi; a++) {
      for (let u = 0; u < nU; u++) {
        const x = lateral ? a : u, y = lateral ? u : a;
        const hu = vol[(z * ny + y) * nx + x];
        if (hu <= -1000) continue;
        const [w, b] = decompose(hu);
        Lw[z * nU + u] += w; Lb[z * nU + u] += b;
      }
    }
    // implants (sampled voxel by voxel inside their bounding boxes)
    for (const sh of implant) {
      const ac = lateral ? sh.c[0] : sh.c[1], ar = lateral ? sh.r[0] : sh.r[1];
      if (ac + ar < lo || ac - ar >= hi) continue;
      for (let z = Math.floor(sh.c[2] - sh.r[2] - 1); z <= sh.c[2] + sh.r[2] + 1; z++) for (let a = Math.max(lo, Math.floor(ac - ar - 1)); a < Math.min(hi, ac + ar + 1); a++) {
        const uc = lateral ? sh.c[1] : sh.c[0], ur = lateral ? sh.r[1] : sh.r[0];
        for (let u = Math.floor(uc - ur - 1); u <= uc + ur + 1; u++) {
          if (u < 0 || u >= nU || z < 0 || z >= nz) continue;
          const f = lateral ? shapeFrac(sh, a, u, z) : shapeFrac(sh, u, a, z);
          if (f) Lb[z * nU + u] += f * sh.b;
        }
      }
    }
    const scale = px / 10; // voxel length along beam, cm
    for (let i = 0; i < Lw.length; i++) { Lw[i] *= scale; Lb[i] *= scale; }
    slabs.push({ Lw, Lb, a: (lo + hi) / 2 * px });   // slab centre along beam (mm)
  }
  XR.slabs = { slabs, nU, nz, du: px, dz, a0: a0 * px, a1: (a1 + 1) * px, lateral };
  XR.slabView = XR.view + (XR.pacer ? "+p" : "");
}
function xrHeartDepth() {
  // heart centre in volume voxels (from the chest volume layout): x 128, y 62, z 118
  const S = XR.slabs, pos = S.lateral ? 128 * CT.vols.chest.meta.px : 62 * CT.vols.chest.meta.px;
  return xrDistToDetector(pos);
}
function xrDistToDetector(a) {   // mm from a point at beam-axis coordinate a to the detector
  const S = XR.slabs, gap = 15;
  if (XR.view === "PA") return a - S.a0 + gap;            // detector at the anterior chest
  if (XR.view === "AP") return S.a1 - a + gap;            // detector behind the back
  return S.a1 - a + gap;                                  // left lateral: detector at patient's left
}
const XROUT = { w: Math.round(DET_W / XPIX), h: Math.round(DET_H / XPIX) };
const xrCv = $("xrImg"), xrCx = xrCv.getContext("2d");
xrCv.width = XROUT.w * 2; xrCv.height = XROUT.h * 2;
const xrOff = document.createElement("canvas"); xrOff.width = XROUT.w; xrOff.height = XROUT.h;
const xrOffx = xrOff.getContext("2d"), xrId = xrOffx.createImageData(XROUT.w, XROUT.h);

function boxBlur(a, w, h, rx, ry) {
  const t = new Float32Array(a.length);
  if (rx > 0) for (let y = 0; y < h; y++) { let s = 0; const o = y * w;
    for (let x = -rx; x <= rx; x++) s += a[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { t[o + x] = s / (2 * rx + 1); s += a[o + Math.min(w - 1, x + rx + 1)] - a[o + Math.max(0, x - rx)]; } }
  else t.set(a);
  if (ry > 0) for (let x = 0; x < w; x++) { let s = 0;
    for (let y = -ry; y <= ry; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { a[y * w + x] = s / (2 * ry + 1); s += t[Math.min(h - 1, y + ry + 1) * w + x] - t[Math.max(0, y - ry) * w + x]; } }
  else a.set(t);
}

function xrRender() {
  if (XR.slabView !== XR.view + (XR.pacer ? "+p" : "")) xrBuildSlabs();
  const S = XR.slabs, { w: OW, h: OH } = XROUT, n = OW * OH;
  const mAs = MAS_STEPS[XR.mAsI], SID = XR.SID * 10; // mm
  // centre of the field on the volume
  const cu = S.nU * S.du / 2, cz = S.nz * S.dz - DET_H / 2 + 10;
  const Lw = new Float32Array(n), Lb = new Float32Array(n);
  for (const sl of S.slabs) {
    const d = xrDistToDetector(sl.a), M = SID / (SID - d);
    for (let v = 0; v < OH; v++) {
      const zmm = cz + ((OH / 2 - v - 0.5) * XPIX) / M;
      const zf = zmm / S.dz - 0.5; const iz = Math.floor(zf); if (iz < 0 || iz >= S.nz - 1) continue;
      const fz = zf - iz;
      for (let u = 0; u < OW; u++) {
        const umm = cu + ((u + 0.5 - OW / 2) * XPIX) / M;
        const uf = umm / S.du - 0.5; const iu = Math.floor(uf); if (iu < 0 || iu >= S.nU - 1) continue;
        const fu = uf - iu, i0 = iz * S.nU + iu, i1 = i0 + S.nU;
        const a = (1 - fu) * (1 - fz), b = fu * (1 - fz), c = (1 - fu) * fz, e = fu * fz;
        Lw[v * OW + u] += sl.Lw[i0] * a + sl.Lw[i0 + 1] * b + sl.Lw[i1] * c + sl.Lw[i1 + 1] * e;
        Lb[v * OW + u] += sl.Lb[i0] * a + sl.Lb[i0 + 1] * b + sl.Lb[i1] * c + sl.Lb[i1 + 1] * e;
      }
    }
  }
  // beam & detector
  const sp = spectrum(XR.kVp, 3, 3), K = sp.E.length;
  const Kin = 90 * Math.pow(XR.kVp / 120, 2) * mAs * Math.pow(1000 / SID, 2); // µGy at detector plane, no patient
  const fieldW = XR.fw * 10, fieldH = XR.fh * 10;
  const P = new Float32Array(n), Sc = new Float32Array(n), mask = new Uint8Array(n), teq = new Float32Array(n);
  const heel = 0.14 * (1000 / SID);
  for (let v = 0; v < OH; v++) for (let u = 0; u < OW; u++) {
    const i = v * OW + u, x = (u + 0.5 - OW / 2) * XPIX, y = (OH / 2 - v - 0.5) * XPIX;
    mask[i] = Math.abs(x) <= fieldW / 2 && Math.abs(y) <= fieldH / 2 ? 1 : 0;
    const lw = Lw[i], lb = Lb[i];
    let T = 0; for (let k = 0; k < K; k++) T += sp.w[k] * Math.exp(-(sp.muW[k] * lw + sp.muB[k] * lb));
    const hf = 1 + heel * (y / (DET_H / 2)) * 0.5;      // anode–cathode intensity variation
    P[i] = mask[i] ? Kin * T * hf : 0;
    teq[i] = lw + 1.9 * lb;
    // scatter generated in proportion to irradiated, attenuating tissue
    Sc[i] = mask[i] ? Kin * hf * 0.2 * (1 - Math.exp(-0.16 * teq[i])) * Math.exp(-0.045 * teq[i]) : 0;
  }
  // scatter spreads widely: blur on a coarse grid
  boxBlur(Sc, OW, OH, 22, 22); boxBlur(Sc, OW, OH, 22, 22);
  const areaF = Math.sqrt((fieldW * fieldH) / (400 * 430));
  const kvF = 0.85 + 0.15 * XR.kVp / 120;
  const gP = XR.grid ? 0.72 : 1, gS = XR.grid ? 0.11 : 1;
  const D = new Float32Array(n);
  let spSum = 0, ppSum = 0;
  for (let i = 0; i < n; i++) {
    const s = Sc[i] * areaF * kvF * (mask[i] ? 1 : 0.15);
    D[i] = P[i] * gP + s * gS;
    if (mask[i] && teq[i] > 15) { spSum += s * gS; ppSum += P[i] * gP; }
  }
  XR.spr = ppSum > 0 ? spSum / ppSum : 0;
  // motion blur during the exposure (vertical, breathing)
  const mA = XR.focal === "small" ? 200 : 500;
  const tms = mAs / mA * 1000;
  const blurMM = XR.motion * tms / 1000;
  const rb = Math.round(blurMM / XPIX / 2);
  if (rb > 0) boxBlur(D, OW, OH, 0, rb);
  // focal spot penumbra (small at these distances, shown for completeness)
  // quantum noise: photons per display pixel per µGy (scaled for visibility)
  const QPG = 450;
  const sat = 20000; // µGy detector saturation (direct-beam level)
  for (let i = 0; i < n; i++) {
    let q = D[i] * QPG; q = q + Math.sqrt(Math.max(q, 0)) * gauss();
    D[i] = Math.min(sat, Math.max(q / QPG, 0.0005));
  }
  // exposure index from the anatomy in the field
  const vals = [];
  for (let i = 0; i < n; i += 3) if (mask[i] && teq[i] > 3) vals.push(D[i]);
  vals.sort((a, b) => a - b);
  const Kdet = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  let ns = 0, na = 0;
  for (let i = 0; i < n; i += 3) if (mask[i] && teq[i] > 3) { na++; if (D[i] >= sat * 0.999) ns++; }
  XR.satFrac = na ? ns / na : 0;
  XR.EI = 100 * Kdet; XR.DI = 10 * Math.log10(Math.max(XR.EI, 1) / 250);
  XR.Kin = Kin; XR.tms = tms; XR.blurMM = blurMM;
  // display
  const out = xrId.data;
  if (!XR.film) {
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = -Math.log(D[i]);
    const lv = []; for (let i = 0; i < n; i += 2) if (mask[i] && teq[i] > 1) lv.push(L[i]);
    lv.sort((a, b) => a - b);
    const lo = lv[Math.floor(lv.length * 0.01)] ?? 0, hi = lv[Math.floor(lv.length * 0.995)] ?? 1;
    // dynamic range compression (large-kernel subtraction) so the mediastinum and lungs both stay readable
    const big = L.slice(); boxBlur(big, OW, OH, 30, 30); boxBlur(big, OW, OH, 30, 30);
    const E = new Float32Array(n), mid = (lo + hi) / 2;
    for (let i = 0; i < n; i++) E[i] = L[i] - 0.55 * (big[i] - mid);
    if (XR.edge) { const bl = E.slice(); boxBlur(bl, OW, OH, 5, 5); for (let i = 0; i < n; i++) E[i] += 0.8 * (E[i] - bl[i]); }
    const ev = []; for (let i = 0; i < n; i += 2) if (mask[i] && teq[i] > 1) ev.push(E[i]);
    ev.sort((a, b) => a - b);
    // Exposure recognition: shift brightness to the anatomy's median signal, but keep a FIXED contrast
    // curve for each projection (like a per-exam LUT). Subject-contrast changes, such as kVp, stay visible.
    const lut = XR_LUT[XR.view], med = ev.length ? ev[Math.floor(ev.length * 0.5)] : 0;
    const elo = med + lut.c - lut.w / 2, ehi = med + lut.c + lut.w / 2;
    for (let i = 0; i < n; i++) {
      let g;
      if (!mask[i]) g = 255;                                         // unexposed: white
      else if (D[i] >= sat * 0.999) g = 0;                           // detector saturation: burned out
      else { const t = (E[i] - elo) / (ehi - elo); g = 255 / (1 + Math.exp(-5 * (t - 0.5))); }   // smooth roll-off instead of a hard clip
      g = Math.min(255, Math.max(0, g));
      out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = g; out[4 * i + 3] = 255;
    }
  } else {
    // screen-film: Hurter & Driffield curve, speed chosen so correct exposure lands on the straight part
    for (let i = 0; i < n; i++) {
      const od = mask[i] ? 0.2 + 3.0 / (1 + Math.exp(-3.0 * 2.3026 * (Math.log10(Math.max(D[i], 1e-4)) - Math.log10(2.0)) / 2.3026 * 2.3026 / 2.3026)) : 0.2;
      const lum = Math.pow(10, -od);
      const g = 255 * Math.pow(lum / 0.66, 0.42);
      out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = Math.min(255, g); out[4 * i + 3] = 255;
    }
  }
  xrOffx.putImageData(xrId, 0, 0);
  xrCx.imageSmoothingEnabled = true; xrCx.imageSmoothingQuality = "high";
  xrCx.drawImage(xrOff, 0, 0, xrCv.width, xrCv.height);
  xrInfo(sp);
}
function xrInfo(sp) {
  const mAs = MAS_STEPS[XR.mAsI];
  const DIv = XR.DI, st = Math.abs(DIv) <= 1 ? ["good", "Target exposure"] : Math.abs(DIv) <= 3 ? ["warn", DIv > 0 ? "Overexposed" : "Underexposed"] : ["bad", DIv > 0 ? "Overexposed: repeat not needed, but dose was too high" : "Underexposed: noisy, consider repeating"];
  $("xrEI").textContent = Math.round(XR.EI);
  $("xrDI").innerHTML = `DI ${DIv >= 0 ? "+" : ""}${DIv.toFixed(1)} · <span class="chip ${st[0]}">${st[1]}</span>`;
  // entrance surface air kerma: inverse square to the skin, backscatter 1.35
  const S = XR.slabs, thick = S.a1 - S.a0;
  const skinDist = XR.SID * 10 - (thick + 15);
  const esak = 90 * Math.pow(XR.kVp / 120, 2) * mAs * Math.pow(1000 / skinDist, 2) * 1.35 / 1000; // mGy
  $("xrESAK").textContent = (esak < 0.1 ? esak.toFixed(3) : esak.toFixed(2)) + " mGy";
  const kE = XR.view === "LAT" ? 0.09 : 0.13;
  $("xrE").textContent = (esak * kE * (XR.fw * XR.fh) / (40 * 43)).toFixed(3) + " mSv";
  $("xrT").textContent = XR.tms < 10 ? XR.tms.toFixed(1) + " ms" : Math.round(XR.tms) + " ms";
  $("xrTs").textContent = `${XR.focal === "small" ? "small focus, 200" : "large focus, 500"} mA`;
  const Mh = (XR.SID * 10) / (XR.SID * 10 - xrHeartDepth());
  $("xrMag").textContent = "×" + Mh.toFixed(2);
  $("xrTL").textContent = `Chest ${XR.view === "LAT" ? "lateral" : XR.view === "AP" ? "AP (portable)" : "PA"}\n${XR.kVp} kVp  ${mAs} mAs\nSID ${XR.SID} cm  ${XR.grid ? "grid" : "no grid"}`;
  $("xrTR").textContent = `EI ${Math.round(XR.EI)}\nDI ${DIv >= 0 ? "+" : ""}${DIv.toFixed(1)}`;
  $("xrBR").textContent = XR.film ? "Screen-film" : "Digital, processed";
  // spectrum plot & table
  xrSpectrum(sp);
  const mw = sp.E.reduce((a, e, k) => a + e * sp.w[k], 0);
  const eff = effMu(sp, 0);
  const cBone = 1 - Math.exp(-(eff.b - eff.w) * 1.0);   // 1 cm bone replacing water
  const cSoft = 1 - Math.exp(-eff.w * 0.5 * 0.05);      // 5% density difference over 5 mm
  const cLung = 1 - Math.exp(-eff.w * 2 * 0.75);        // 2 cm lung (25% density) vs soft tissue
  $("xrTbl").innerHTML = `<tr><th>Quantity</th><th>Value</th></tr>
    <tr><td>Mean beam energy (detected)</td><td>${mw.toFixed(0)} keV</td></tr>
    <tr><td>Subject contrast: 1 cm bone vs soft tissue</td><td>${(100 * cBone).toFixed(0)}%</td></tr>
    <tr><td>Subject contrast: 2 cm lung vs soft tissue</td><td>${(100 * cLung).toFixed(0)}%</td></tr>
    <tr><td>Scatter-to-primary ratio (mediastinum)</td><td>${XR.spr.toFixed(2)}</td></tr>
    <tr><td>Heart magnification</td><td>×${Mh.toFixed(2)}</td></tr>
    <tr><td>Motion blur during exposure</td><td>${XR.blurMM.toFixed(1)} mm</td></tr>`;
  const notes = [];
  if (DIv < -3) notes.push("The detector got too little dose, so quantum mottle (noise) is obvious. Digital processing rescales brightness, which hides the underexposure. The exposure index is how you catch it.");
  else if (DIv > 3) notes.push("Overexposed: digital processing still produces a normal-looking image, so the extra dose goes unnoticed. This is called dose creep. Check the deviation index.");
  if (!XR.film && XR.satFrac > 0.01) notes.push("At this dose parts of the detector saturate, so those areas burn out to black with no detail.");
  if (!XR.film && DIv > 3 && XR.satFrac <= 0.01) notes.push("More mAs only means more photons, so quantum noise keeps falling (noise ∝ 1/√mAs). The image looks smoother, but patient dose rises in proportion.");
  if (XR.film) notes.push("With screen-film there's no rescaling: underexposed films come out pale, and overexposed films come out dark. The latitude is narrow compared with digital.");
  if (!XR.grid) notes.push(`Without a grid, scatter (SPR ≈ ${XR.spr.toFixed(1)}) adds a uniform fog that reduces contrast, especially in the mediastinum. A grid removes most scatter but also some primary, so it needs more mAs (the Bucky factor).`);
  if (XR.kVp < 90) notes.push("Low kVp: the photoelectric effect dominates, so bone, soft tissue and the abdomen show high contrast (short scale). But penetration is poor: the mediastinum and abdomen get far fewer photons, so you need much more mAs (and patient dose) to reach the same exposure index. Chest radiography uses high kVp (110–125) to see lung through the ribs and mediastinum.");
  if (XR.kVp > 130) notes.push("High kVp: Compton scatter dominates, so differences between tissues shrink (long scale, lower contrast) and more scatter reaches the detector. In exchange, penetration is better and less mAs is needed, so patient dose is lower.");
  if (XR.view === "AP") notes.push(`AP at short SID magnifies the heart (×${Mh.toFixed(2)} here) because it's far from the detector, so cardiac size can't be judged reliably on an AP film. PA at 180 cm keeps the heart close to the detector.`);
  if (XR.view === "LAT") notes.push("This CT patient had their arms raised, which is also correct positioning for a lateral chest X-ray.");
  if (XR.blurMM > 1.5) notes.push(`The patient moved ${XR.blurMM.toFixed(1)} mm during the ${Math.round(XR.tms)} ms exposure. Use a shorter exposure time (higher mA, large focus) or better breath-holding.`);
  if (XR.fw * XR.fh < 30 * 30) notes.push("Tight collimation reduces patient dose and scatter. The unexposed area appears white.");
  if (XR.pacer) notes.push("The pacemaker generator sits in the left infraclavicular region. Its lead runs through the left subclavian and brachiocephalic veins and the SVC into the right ventricle.");
  notes.push("This projection is computed from a real CT. The patient's arms are raised, as is usual for CT, so the scapulae and arm shadows differ from a standard PA chest film.");
  $("xrNotes").innerHTML = notes.map(n => `<p>${n}</p>`).join("");
}
function xrSpectrum(sp) {
  const c = $("xrSpec"), dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = 170;
  c.width = w * dpr; c.height = h * dpr; c.style.height = h + "px";
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const m = { l: 34, r: 12, t: 12, b: 26 }, pw = w - m.l - m.r, ph = h - m.t - m.b;
  const X = e => m.l + (e - 10) / 140 * pw;
  const mx = Math.max(...sp.w);
  g.font = "11px system-ui, sans-serif"; g.fillStyle = "#8f8e86"; g.strokeStyle = "#2e2d2a";
  for (let e = 20; e <= 150; e += 20) { g.beginPath(); g.moveTo(X(e) + .5, m.t); g.lineTo(X(e) + .5, m.t + ph); g.stroke(); g.textAlign = "center"; g.fillText(e, X(e), m.t + ph + 6 + 8); }
  g.textAlign = "left"; g.fillText("keV", m.l + pw - 18, m.t + ph + 22);
  g.beginPath(); g.moveTo(m.l, m.t + ph + .5); g.lineTo(m.l + pw, m.t + ph + .5); g.strokeStyle = "#55544f"; g.stroke();
  g.beginPath(); g.moveTo(X(sp.E[0]), m.t + ph);
  sp.E.forEach((e, k) => g.lineTo(X(e), m.t + ph - sp.w[k] / mx * ph * 0.95));
  g.lineTo(X(sp.E[sp.E.length - 1]), m.t + ph); g.closePath();
  g.fillStyle = "rgba(57,135,229,0.25)"; g.fill(); g.strokeStyle = "#3987e5"; g.lineWidth = 2; g.stroke();
  const mean = sp.E.reduce((a, e, k) => a + e * sp.w[k], 0);
  g.setLineDash([4, 4]); g.strokeStyle = "#c3c2b7"; g.lineWidth = 1; g.beginPath(); g.moveTo(X(mean) + .5, m.t); g.lineTo(X(mean) + .5, m.t + ph); g.stroke(); g.setLineDash([]);
  g.fillStyle = "#f0efec"; g.textAlign = "left"; g.fillText(`mean ${mean.toFixed(0)} keV`, X(mean) + 4, m.t + 10);
}
let xrPending = false;
function xrUpdate() {
  if (xrPending || !CT.vols.chest) return;
  xrPending = true;
  requestAnimationFrame(() => { xrPending = false; xrRender(); });
}
function xrInitControls() {
  const sl = (id, key, f, parse = parseFloat) => {
    const el = $(id), out = $("o_" + id);
    const show = () => { out.textContent = f(XR[key]); };
    el.value = XR[key]; show();
    el.addEventListener("input", () => { XR[key] = parse(el.value); show(); xrUpdate(); });
    return show;
  };
  const shows = [
    sl("xrKVP", "kVp", v => v + " kVp"),
    sl("xrMAS", "mAsI", v => MAS_STEPS[v] + " mAs", v => parseInt(v)),
    sl("xrSID", "SID", v => v + " cm"),
    sl("xrFW", "fw", v => v + " cm"),
    sl("xrFH", "fh", v => v + " cm"),
    sl("xrMOT", "motion", v => v ? v + " mm/s" : "none"),
  ];
  XR.showAll = () => shows.forEach(s => s());
  segBind("xrView", v => {
    XR.view = v;
    // typical technique for each projection
    const T = { PA: [120, 180, true, 9], AP: [100, 100, false, 3], LAT: [120, 180, true, 13] }[v];
    [XR.kVp, XR.SID, XR.grid, XR.mAsI] = T;
    ["xrKVP", "xrSID", "xrMAS"].forEach((id, k) => { $(id).value = [XR.kVp, XR.SID, XR.mAsI][k]; });
    $("xrGrid").checked = XR.grid; XR.showAll(); xrUpdate();
  });
  segBind("xrFocal", v => { XR.focal = v; xrUpdate(); });
  segBind("xrProc", v => { XR.film = v === "film"; xrUpdate(); });
  $("xrGrid").addEventListener("change", e => { XR.grid = e.target.checked; xrUpdate(); });
  $("xrEdge").addEventListener("change", e => { XR.edge = e.target.checked; xrUpdate(); });
  $("xrPacer").addEventListener("change", e => { XR.pacer = e.target.checked; xrUpdate(); });
  window.addEventListener("resize", () => { if (XR.slabs && document.body.dataset.mod === "xr") xrSpectrum(spectrum(XR.kVp, 3, 3)); });
}
async function xrEnsure() {
  if (!CT.vols.chest) {
    $("xrLoading").classList.remove("hidden"); $("xrLoading").textContent = "Loading chest data…";
    try { CT.vols.chest = await loadVolume("chest_ct"); }
    catch (err) { $("xrLoading").textContent = "Could not load the chest data: " + err.message; return; }
  }
  $("xrLoading").classList.add("hidden");
  xrUpdate();
}

/* ============================================================
   Modality switching
   ============================================================ */
ctInitControls(); xrInitControls();
segBind("modality", m => {
  document.body.dataset.mod = m;
  if (m === "ct") ctEnsure(CT.region);
  if (m === "xr") xrEnsure();
  if (m === "mri") window.dispatchEvent(new Event("resize"));
});
window.CTXR = { CT, XR, ctUpdate, xrUpdate, ctEnsure, xrEnsure };
})();
