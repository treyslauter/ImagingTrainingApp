/* Ultrasound B-mode and color Doppler simulator. */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const C = 1.54;                     // speed of sound, mm/µs
const D2R = Math.PI / 180;

/* ============================================================
   State
   ============================================================ */
const US = {
  scene: "abdomen", probe: "curved", freq: 3.5, depth: 160, focus: 80, zones: 1,
  gain: 0, tgc: [0, 0, 0, 0, 0, 0, 0, 0], dr: 60, power: 100,
  harmonic: false, compound: false,
  stone: true, cyst: true, fluid: false, plaque: true,
  doppler: false, prf: 4, steer: 0, cgain: 50,
  marker: null,
};
const PROBES = {
  linear: { fmin: 5, fmax: 15, width: 40, aperture: 14, lines: 192, label: "Linear array" },
  curved: { fmin: 2, fmax: 7, radius: 50, angle: 64, aperture: 24, lines: 224, label: "Curvilinear array" },
};
const SCENE_DEFAULTS = {
  phantom: { probe: "curved", freq: 3.5, depth: 160, focus: 60 },
  abdomen: { probe: "curved", freq: 3.5, depth: 160, focus: 90 },
  vascular: { probe: "linear", freq: 9, depth: 40, focus: 22 },
};

/* ============================================================
   Scenes: shapes with acoustic properties
   ech = backscatter (dB re liver), att = dB/cm/MHz, Z = impedance (MRayl)
   ============================================================ */
const TISSUE = {
  skin:   { ech: 6, att: 0.8, Z: 1.62 },
  fat:    { ech: -9, att: 0.6, Z: 1.38 },
  muscle: { ech: -4, att: 1.0, Z: 1.70 },
  liver:  { ech: 0, att: 0.5, Z: 1.65 },
  cortex: { ech: -8, att: 0.8, Z: 1.62 },
  prfat:  { ech: 5, att: 0.6, Z: 1.46 },
  medulla:{ ech: -13, att: 0.8, Z: 1.62 },
  sinus:  { ech: 11, att: 0.6, Z: 1.48 },
  bile:   { ech: -60, att: 0.02, Z: 1.50, fluid: true },
  cystf:  { ech: -60, att: 0.02, Z: 1.52, fluid: true },
  blood:  { ech: -42, att: 0.15, Z: 1.61, fluid: true, blood: true },
  wall:   { ech: 10, att: 0.8, Z: 1.70 },
  bone:   { ech: 6, att: 20, Z: 7.8, hard: true },
  stone:  { ech: 6, att: 15, Z: 5.0, hard: true },
  calc:   { ech: 12, att: 12, Z: 4.5, hard: true },
  air:    { ech: 0, att: 40, Z: 0.0004, air: true },
  lung:   { ech: 0, att: 40, Z: 0.0004, air: true, mirror: true },
  diaph:  { ech: 14, att: 1.0, Z: 1.75 },
  phant:  { ech: 0, att: 0.5, Z: 1.55 },
};
function ellSDF(x, z, s) {
  const c = Math.cos(s.r || 0), sn = Math.sin(s.r || 0), dx = x - s.x, dz = z - s.z;
  const u = (dx * c + dz * sn) / s.a, v = (-dx * sn + dz * c) / s.b;
  return (Math.sqrt(u * u + v * v) - 1) * Math.min(s.a, s.b);  // approx signed distance (mm)
}
function tubeInfo(x, z, t) {   // distance to the segment axis, and axial unit vector
  const ax = t.x2 - t.x1, az = t.z2 - t.z1, L = Math.hypot(ax, az), ux = ax / L, uz = az / L;
  let p = (x - t.x1) * ux + (z - t.z1) * uz; p = Math.max(0, Math.min(L, p));
  const cx = t.x1 + p * ux, cz = t.z1 + p * uz;
  return { d: Math.hypot(x - cx, z - cz), ux, uz };
}

// Each scene: props(x, z) -> { t: tissue, sdf: function for the boundary normal, vel: [vx, vz] cm/s }
const SCENES = {
  phantom: {
    label: "QA phantom",
    points: (() => {
      const P = [];
      for (let z = 10; z <= 150; z += 10) P.push([0, z, 30]);                          // vertical wire column
      [[4, 6], [9, 10], [13, 13.5]].forEach(([a, b]) => { P.push([a, 30, 30], [b, 30, 30]); P.push([a + 22, 90, 30], [b + 22, 90, 30]); });  // lateral groups
      [[30, 32], [36, 37], [41, 41.5], [45, 45.25]].forEach(([a, b]) => { P.push([-10, a, 30], [-10, b, 30]); }); // axial group
      return P;
    })(),
    shapes: [
      { type: "ell", x: 12, z: 50, a: 1.5, b: 1.5, t: "cystf" },
      { type: "ell", x: 12, z: 62, a: 2.5, b: 2.5, t: "cystf" },
      { type: "ell", x: 12, z: 77, a: 4, b: 4, t: "cystf" },
      { type: "ell", x: 12, z: 94, a: 5, b: 5, t: "cystf" },
      { type: "ell", x: -30, z: 120, a: 6, b: 6, t: "g12" },
      { type: "ell", x: -10, z: 120, a: 6, b: 6, t: "g6" },
      { type: "ell", x: 10, z: 120, a: 6, b: 6, t: "gm6" },
      { type: "ell", x: 30, z: 120, a: 6, b: 6, t: "cystf" },
      { type: "ell", x: -14, z: 14, a: 2, b: 2, t: "cystf" },
      { type: "ell", x: -16, z: 70, a: 3, b: 3, t: "g12" },
    ],
    bg: () => "phant",
  },
  abdomen: {
    label: "Abdomen (RUQ, longitudinal)",
    points: [],
    shapes: [
      { type: "ell", x: -55, z: 17, a: 8, b: 7, t: "bone", id: "rib" },
      { type: "ell", x: 35, z: 122, a: 46, b: 24, r: 0.2, t: "prfat", id: "perirenal" },
      { type: "ell", x: 35, z: 122, a: 40, b: 19, r: 0.2, t: "cortex", id: "kidney" },
      { type: "ell", x: 22, z: 117, a: 6, b: 5, r: 0.2, t: "medulla" },
      { type: "ell", x: 38, z: 113, a: 6, b: 5, r: 0.2, t: "medulla" },
      { type: "ell", x: 52, z: 124, a: 6, b: 5, r: 0.2, t: "medulla" },
      { type: "ell", x: 30, z: 132, a: 6, b: 5, r: 0.2, t: "medulla" },
      { type: "ell", x: 36, z: 123, a: 17, b: 6, r: 0.2, t: "sinus" },
      { type: "ell", x: 8, z: 60, a: 28, b: 14.5, r: -0.25, t: "wall", id: "gbwall" },
      { type: "ell", x: 8, z: 60, a: 26.5, b: 13, r: -0.25, t: "bile", id: "gb" },
      { type: "ell", x: 17, z: 66, a: 4.5, b: 4.5, t: "stone", id: "stone", opt: "stone" },
      { type: "ell", x: -24, z: 82, a: 9, b: 6.5, t: "wall" },
      { type: "ell", x: -24, z: 82, a: 7.8, b: 5.3, t: "blood", id: "pv", vel: [12, 0] },
      { type: "tube", x1: -70, z1: 40, x2: -40, z2: 112, rad: 3.6, t: "blood", vmax: 15 },
      { type: "ell", x: -42, z: 42, a: 7, b: 7, t: "cystf", id: "cyst", opt: "cyst" },
      { type: "ell", x: 70, z: 82, a: 10, b: 8, t: "air", id: "gas" },
    ],
    bg: (x, z) => {
      if (z < 2) return "skin";
      if (z < 13 + 2 * Math.sin(x / 25)) return "fat";
      if (z < 23 + 2 * Math.sin(x / 25)) return "muscle";
      if (x < 45) { const zd = 112 + 0.0045 * (x + 70) ** 2; if (z > zd + 2) return "lung"; if (z > zd - 1.5) return "diaph"; }
      return "liver";
    },
    extra: (x, z) => {   // free fluid in Morison's pouch
      if (!US.fluid) return null;
      const k = { x: 35, z: 122, a: 46, b: 24, r: 0.2 }, s = ellSDF(x, z, k);
      if (s > 0 && s < 4.5 && z < 122 + (x - 35) * 0.2) return "cystf";
      return null;
    },
  },
  vascular: {
    label: "Vascular (carotid, long axis)",
    points: [],
    shapes: [
      { type: "tube", x1: -30, z1: 13.4, x2: 30, z2: 12.2, rad: 4.4, t: "wall" },
      { type: "tube", x1: -30, z1: 13.4, x2: 30, z2: 12.2, rad: 3.7, t: "blood", vmax: -28, id: "ijv" },
      { type: "tube", x1: -30, z1: 21, x2: 30, z2: 24.5, rad: 4.0, t: "wall" },
      { type: "tube", x1: -30, z1: 21, x2: 30, z2: 24.5, rad: 3.2, t: "blood", vmax: 90, id: "cca" },
      { type: "ell", x: 6, z: 26.9, a: 4.5, b: 1.5, r: 0.06, t: "calc", id: "plaque", opt: "plaque" },
      { type: "ell", x: -10, z: 36.5, a: 4, b: 2.4, t: "bone" },
      { type: "ell", x: 14, z: 37.5, a: 4, b: 2.4, t: "bone" },
    ],
    bg: (x, z) => {
      if (z < 1) return "skin";
      if (z < 4.5) return "fat";
      if (z < 10 - x * 0.04 && z > 5 + x * 0.03) return "muscle";
      if (z > 30) return "muscle";
      return "fat2";
    },
  },
};
TISSUE.fat2 = { ech: -6, att: 0.6, Z: 1.42 };
TISSUE.g12 = { ech: 12, att: 0.5, Z: 1.57 };
TISSUE.g6 = { ech: 6, att: 0.5, Z: 1.56 };
TISSUE.gm6 = { ech: -6, att: 0.5, Z: 1.55 };

function props(x, z) {
  const S = SCENES[US.scene];
  let t = S.bg(x, z), sh = null, vel = null;
  for (const s of S.shapes) {
    if (s.opt && !US[s.opt]) continue;
    if (s.type === "ell") {
      if (Math.abs(x - s.x) > s.a + s.b || Math.abs(z - s.z) > s.a + s.b) continue;
      if (ellSDF(x, z, s) <= 0) { t = s.t; sh = s; vel = s.vel || null; }
    } else {
      const ti = tubeInfo(x, z, s);
      if (ti.d <= s.rad) { t = s.t; sh = s; vel = s.vmax ? [s.vmax * (1 - (ti.d / s.rad) ** 2) * ti.ux, s.vmax * (1 - (ti.d / s.rad) ** 2) * ti.uz] : null; }
    }
  }
  if (S.extra) { const e = S.extra(x, z); if (e) { t = e; sh = null; } }
  return { t, sh, vel };
}
function shapeNormal(s, x, z) {   // gradient of the shape's distance field
  const e = 0.2;
  const f = s.type === "ell" ? (a, b) => ellSDF(a, b, s) : (a, b) => tubeInfo(a, b, s).d - s.rad;
  const gx = f(x + e, z) - f(x - e, z), gz = f(x, z + e) - f(x, z - e), L = Math.hypot(gx, gz) || 1;
  return [gx / L, gz / L];
}

/* ============================================================
   Speckle: stable random scatterers fixed to tissue position
   ============================================================ */
function hash2(ix, iz, s) {
  let h = (ix * 374761393 + iz * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return ((h >>> 0) + 0.5) / 4294967297;
}
function scat(x, z) {    // complex Gaussian scatterer (stable), on a 0.15 mm lattice
  const ix = Math.round(x / 0.15), iz = Math.round(z / 0.15);
  const u = hash2(ix, iz, 1), v = hash2(ix, iz, 2), r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

/* ============================================================
   Beam model
   ============================================================ */
function lambda() { return C / US.freq; }   // mm
function focalZones() {
  if (US.zones === 1) return [US.focus];
  const sp = Math.min(US.depth * 0.22, 25);
  return US.zones === 2 ? [US.focus - sp / 2, US.focus + sp / 2] : [US.focus - sp, US.focus, US.focus + sp];
}
function beamWidth(z) {  // lateral FWHM (mm) at depth z
  const P = PROBES[US.probe], A = P.aperture, lam = lambda() * (US.harmonic ? 0.7 : 1);
  let best = Infinity;
  for (const zf of focalZones()) {
    const zfc = Math.max(4, zf);
    const wd = 1.02 * lam * Math.max(z, 2) / A;
    const geo = A * Math.abs(1 - z / zfc) * 0.14;   // two-way, with dynamic receive focusing
    best = Math.min(best, Math.sqrt(wd * wd + geo * geo));
  }
  return best;
}
function axialRes() { return (US.harmonic ? 1.4 : 1.0) * lambda(); }  // SPL/2 with a 2-cycle pulse

/* ============================================================
   Rendering
   ============================================================ */
const NS = 560;
const OUT = 560;
const cv = $("usImg"), cx = cv.getContext("2d");
cv.width = OUT; cv.height = OUT;
const off = document.createElement("canvas"); off.width = OUT; off.height = OUT;
const offx = off.getContext("2d"), idata = offx.createImageData(OUT, OUT);

function geometry() {
  const P = PROBES[US.probe];
  if (US.probe === "linear") {
    const W = P.width, D = US.depth;
    return { W, D, R: 0, th: 0, box: { x0: -W / 2, x1: W / 2, z0: 0, z1: D } };
  }
  const R = P.radius, th = P.angle * D2R, D = US.depth;
  const x1 = (R + D) * Math.sin(th / 2);
  return { R, th, D, box: { x0: -x1, x1, z0: 0, z1: R + D - R * Math.cos(th / 2) } };
}
function lineRay(l, NL, G, phi) {   // origin and direction of scan line l
  if (US.probe === "linear") {
    const x = G.box.x0 + (l + 0.5) / NL * G.W;
    return [x, 0, Math.sin(phi), Math.cos(phi)];
  }
  const th = -G.th / 2 + (l + 0.5) / NL * G.th;
  return [G.R * Math.sin(th), G.R * Math.cos(th) - G.R, Math.sin(th + phi), Math.cos(th + phi)];
}

// One B-mode frame along lines steered by phi; returns envelope (NL x NS) and per-depth signal stats
function frame(phi, seedShift) {
  const P = PROBES[US.probe], NL = P.lines, G = geometry(), ds = US.depth / NS;
  const f = US.freq, fRx = US.harmonic ? 2 * f : f;
  const re = new Float32Array(NL * NS), im = new Float32Array(NL * NS);
  const ampAt = new Float32Array(NL * NS);         // round-trip amplitude factor (for point targets)
  const mirrorAt = new Int32Array(NL).fill(-1), airAt = new Int32Array(NL).fill(-1), airAmp = new Float32Array(NL);
  const sigRow = new Float64Array(NS);
  const powerF = US.power / 100;
  const wmin = Math.min(...Array.from({ length: 20 }, (_, i) => beamWidth(US.depth * (i + 0.5) / 20)));
  const focusGain = new Float32Array(NS);
  for (let s = 0; s < NS; s++) focusGain[s] = Math.max(0.85, Math.pow(wmin / beamWidth((s + 0.5) * ds), 0.1));
  for (let l = 0; l < NL; l++) {
    const [ox, oz, ux, uz] = lineRay(l, NL, G, phi);
    let attDB = 0, Tint = 1, prev = null, prevSh = null, blocked = false;
    for (let s = 0; s < NS; s++) {
      const d = (s + 0.5) * ds, x = ox + d * ux, z = oz + d * uz, k = l * NS + s;
      if (blocked) { ampAt[k] = 0; continue; }
      const p = props(x, z), T = TISSUE[p.t];
      // interfaces: specular reflection and transmission loss
      if (prev && T.Z !== prev.Z) {
        const Rf = ((T.Z - prev.Z) / (T.Z + prev.Z)) ** 2;
        let cosI = 1;
        const shp = p.sh || prevSh;
        if (shp) { const nrm = shapeNormal(shp, x, z); cosI = Math.abs(nrm[0] * ux + nrm[1] * uz); }
        else if (T.mirror || prev.mirror || p.t === "diaph") cosI = 0.9;
        const a = Math.sqrt(Rf) * (0.25 + 0.75 * cosI * cosI) * Math.sqrt(Tint) * Math.pow(10, -attDB / 20) * 60 * powerF;
        const ph = scat(x * 0.37, z * 0.37);
        re[k] += a * ph[0] * 0.5 + a * 0.7; im[k] += a * ph[1] * 0.5;
        Tint *= (1 - Rf);
        // refraction (edge) shadow where the beam grazes a curved fluid boundary
        if ((T.fluid || prev.fluid) && shp && cosI < 0.22 && !T.blood && !prev.blood) Tint *= 0.08;
        if (T.air) {
          if (T.mirror) mirrorAt[l] = s; else { airAt[l] = s; airAmp[l] = a; }
          blocked = true; ampAt[k] = 0; continue;
        }
      }
      prev = T; prevSh = p.sh;
      // attenuation (two-way, transmit at f, receive at fRx)
      attDB += T.att * (f + fRx) * ds / 10;
      const amp = Math.sqrt(Tint) * Math.pow(10, -attDB / 20) * focusGain[s] * powerF;
      ampAt[k] = amp;
      const sc = scat(x, z + seedShift), e = Math.pow(10, T.ech / 20) * amp;
      re[k] += e * sc[0]; im[k] += e * sc[1];
      sigRow[s] += e;
    }
  }
  // PSF: axial Gaussian (fixed), lateral Gaussian (depth dependent)
  const sAx = axialRes() / 2.355 / ds;
  convAxial(re, NL, sAx); convAxial(im, NL, sAx);
  const sigL = new Float32Array(NS);
  for (let s = 0; s < NS; s++) {
    const z = (s + 0.5) * ds, spacing = US.probe === "linear" ? G.W / NL : (G.R + z) * G.th / NL;
    sigL[s] = beamWidth(z) / 2.355 / spacing;
  }
  convLateral(re, NL, sigL); convLateral(im, NL, sigL);
  // point targets (wires): added as the point-spread function itself, peak amplitude set by the target
  const S = SCENES[US.scene];
  for (const [px, pz, adb] of S.points) {
    let lf, sf;
    if (US.probe === "linear") { lf = (px - pz * Math.tan(phi) - G.box.x0) / G.W * NL - 0.5; sf = pz / Math.cos(phi) / ds - 0.5; }
    else { const th = Math.atan2(px, pz + G.R); lf = (th + G.th / 2) / G.th * NL - 0.5; sf = (Math.hypot(px, pz + G.R) - G.R) / ds - 0.5; }
    const l0 = Math.round(lf), s0 = Math.round(sf);
    if (l0 < 0 || l0 >= NL || s0 < 0 || s0 >= NS) continue;
    const amp0 = ampAt[l0 * NS + s0]; if (!amp0) continue;
    const a = Math.pow(10, adb / 20) * amp0 * 2.5, sl = Math.max(0.5, sigL[s0]), sa = Math.max(0.5, sAx);
    for (let dl = -Math.ceil(3 * sl); dl <= 3 * sl; dl++) for (let dsm = -Math.ceil(3 * sa); dsm <= 3 * sa; dsm++) {
      const l = l0 + dl, q = s0 + dsm; if (l < 0 || l >= NL || q < 0 || q >= NS) continue;
      const w = Math.exp(-((l - lf) ** 2) / (2 * sl * sl) - ((q - sf) ** 2) / (2 * sa * sa));
      re[l * NS + q] += a * w; im[l * NS + q] += a * w * 0.2;
    }
  }
  const env = new Float32Array(NL * NS);
  for (let k = 0; k < env.length; k++) env[k] = Math.hypot(re[k], im[k]);
  // reverberation behind gas (and comet-tail smear); mirror image beyond the diaphragm
  const revF = US.harmonic ? 0.35 : 1;
  for (let l = 0; l < NL; l++) {
    const sa = airAt[l];
    if (sa > 0) {
      const a = airAmp[l] * 0.06;
      for (let s = sa; s < NS; s++) {
        const k = l * NS + s;
        let v = 0;
        for (let m = 2; m < 8; m++) { const sm = sa * m; if (Math.abs(s - sm) < 3 && sm < NS) v += a * Math.pow(0.45, m - 1) * revF * (1 - Math.abs(s - sm) / 3); }
        const sc = scat(l * 0.3, s * 0.11);
        v += a * 0.18 * revF * Math.exp(-(s - sa) / 35) * Math.hypot(sc[0], sc[1]);
        env[k] += v;
      }
    }
    const sm = mirrorAt[l];
    if (sm > 0) for (let s = sm + 1; s < NS; s++) { const src = 2 * sm - s; if (src < 0) break; env[l * NS + s] += env[l * NS + src] * 0.55; }
  }
  return { env, NL, sigRow };
}
function convAxial(a, NL, sig) {
  if (sig < 0.35) return;
  const r = Math.ceil(sig * 2.5), w = []; let ws = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sig * sig)); w.push(v); ws += v * v; }
  ws = Math.sqrt(ws);   // energy normalisation: speckle brightness independent of PSF size
  const t = new Float32Array(NS);
  for (let l = 0; l < NL; l++) {
    const o = l * NS;
    for (let s = 0; s < NS; s++) { let acc = 0; for (let i = -r; i <= r; i++) { const q = s + i; if (q >= 0 && q < NS) acc += a[o + q] * w[i + r]; } t[s] = acc / ws; }
    a.set(t, o);
  }
}
function convLateral(a, NL, sigL) {
  const t = new Float32Array(NL);
  for (let s = 0; s < NS; s++) {
    const sig = Math.max(0.3, sigL[s]), r = Math.min(40, Math.ceil(sig * 2.5));
    const w = new Float32Array(2 * r + 1); let ws = 0;
    for (let i = -r; i <= r; i++) { w[i + r] = Math.exp(-i * i / (2 * sig * sig)); ws += w[i + r] * w[i + r]; }
    ws = Math.sqrt(ws);
    for (let l = 0; l < NL; l++) { let acc = 0; for (let i = -r; i <= r; i++) { const q = l + i; if (q >= 0 && q < NL) acc += a[q * NS + s] * w[i + r]; } t[l] = acc / ws; }
    for (let l = 0; l < NL; l++) a[l * NS + s] = t[l];
  }
}

function render() {
  const P = PROBES[US.probe], G = geometry(), NL = P.lines, ds = US.depth / NS;
  const angles = US.compound && US.probe === "linear" ? [-12 * D2R, 0, 12 * D2R] : [0];
  let env = new Float32Array(NL * NS), sigRow = null;
  for (let a = 0; a < angles.length; a++) {
    const F = frame(angles[a], a * 0.07);
    if (angles[a] === 0) { sigRow = F.sigRow; }
    if (angles.length === 1) { env = F.env; break; }
    // resample a steered frame onto the unsteered line grid (linear array)
    const t = Math.tan(angles[a]), c = Math.cos(angles[a]);
    for (let l = 0; l < NL; l++) for (let s = 0; s < NS; s++) {
      const x = G.box.x0 + (l + 0.5) / NL * G.W, z = (s + 0.5) * ds;
      const lf = (x - z * t - G.box.x0) / G.W * NL - 0.5, sf = z / c / ds - 0.5;
      const li = Math.floor(lf), si = Math.floor(sf);
      let v = 0;
      if (li >= 0 && li < NL - 1 && si >= 0 && si < NS - 1) {
        const fl = lf - li, fs = sf - si, k = li * NS + si;
        v = (F.env[k] * (1 - fl) + F.env[k + NS] * fl) * (1 - fs) + (F.env[k + 1] * (1 - fl) + F.env[k + NS + 1] * fl) * fs;
      }
      env[l * NS + s] += v / angles.length;
    }
  }
  // receiver noise, gain, preset depth compensation + user TGC, log compression
  const noiseA = 0.0012;
  const dB = new Float32Array(NL * NS);
  const comp0 = 0.5 * (US.freq + (US.harmonic ? 2 * US.freq : US.freq));   // preset TGC slope: compensates 0.5 dB/cm/MHz, in dB per cm
  US.penetration = US.depth;
  const noiseRow = noiseA * 1.25;
  for (let s = 0; s < NS; s++) {
    const zcm = (s + 0.5) * ds / 10;
    const tg = tgcAt((s + 0.5) / NS);
    const g = US.gain + tg + Math.min(60, comp0 * zcm);   // receiver gain is limited, so deep noise isn't amplified without bound
    if (sigRow && US.penetration === US.depth && s > NS * 0.08 && sigRow[s] / NL < noiseRow * 1.5) US.penetration = Math.round((s + 0.5) * ds);
    for (let l = 0; l < NL; l++) {
      const k = l * NS + s, sc = scat(l * 1.7 + 1000, s * 0.9 + 1000);
      const v = Math.hypot(env[k] + noiseA * sc[0], noiseA * sc[1]);
      dB[k] = 20 * Math.log10(v + 1e-9) + g - 30;
    }
  }
  US.bandMeans = [];
  for (let b = 0; b < 8; b++) {
    const vals = [];
    for (let s = Math.floor(b * NS / 8) + 4; s < Math.floor((b + 1) * NS / 8) - 4; s += 3) {
      const row = []; for (let l = 0; l < NL; l += 2) row.push(dB[l * NS + s]);
      row.sort((a, c) => a - c); vals.push(row[Math.floor(row.length / 2)]);
    }
    US.bandMeans.push(vals.reduce((a, c) => a + c, 0) / vals.length);
  }
  US.dB = dB; US.NL = NL; US.G = G;
  draw();
  info();
}
function tgcAt(f) {   // interpolate the 8 TGC sliders
  const x = f * 8 - 0.5, i = Math.max(0, Math.min(6, Math.floor(x))), t = Math.max(0, Math.min(1, x - i));
  return US.tgc[i] * (1 - t) + US.tgc[i + 1] * t;
}

/* ---------- scan conversion, color Doppler and overlays ---------- */
function colorBox() {
  if (US.scene === "vascular") return { x0: -16, x1: 16, z0: 9, z1: 31 };
  if (US.scene === "abdomen") return { x0: -50, x1: 0, z0: 60, z1: 105 };
  return { x0: -15, x1: 15, z0: 20, z1: 60 };
}
function nyquist() { return 1540 * US.prf * 1e3 / (4 * US.freq * 1e6) * 100; }  // Vn = c·PRF / (4 f0), in cm/s
function draw() {
  const G = US.G, B = G.box, NL = US.NL, ds = US.depth / NS;
  const sc = Math.min(OUT / (B.x1 - B.x0), OUT / (B.z1 - B.z0));
  const offX = (OUT - (B.x1 - B.x0) * sc) / 2;
  US.view = { sc, offX };
  const d = idata.data, lo = -US.dr;
  const box = US.doppler ? colorBox() : null, vn = nyquist();
  const psi = US.probe === "linear" ? US.steer * D2R : 0;
  let colorPx = 0, aliasPx = 0, vesselPx = 0;
  for (let py = 0; py < OUT; py++) for (let px = 0; px < OUT; px++) {
    const x = B.x0 + (px + 0.5 - offX) / sc, z = (py + 0.5) / sc;
    const o = 4 * (py * OUT + px);
    let lf, sf;
    if (US.probe === "linear") { lf = (x - B.x0) / G.W * NL - 0.5; sf = z / ds - 0.5; }
    else { const th = Math.atan2(x, z + G.R); lf = (th + G.th / 2) / G.th * NL - 0.5; sf = (Math.hypot(x, z + G.R) - G.R) / ds - 0.5; }
    const li = Math.floor(lf), si = Math.floor(sf);
    if (li < 0 || li >= NL - 1 || si < 0 || si >= NS - 1 || x < B.x0 || x > B.x1) { d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = 255; continue; }
    const fl = lf - li, fs = sf - si, k = li * NS + si;
    const v = (US.dB[k] * (1 - fl) + US.dB[k + NS] * fl) * (1 - fs) + (US.dB[k + 1] * (1 - fl) + US.dB[k + NS + 1] * fl) * fs;
    let g = (v - lo) / US.dr; g = g < 0 ? 0 : g > 1 ? 1 : g;
    let r = g * 255, gg = g * 255, b = g * 255;
    if (box && z >= box.z0 && z <= box.z1 && x - z * Math.tan(psi) >= box.x0 && x - z * Math.tan(psi) <= box.x1) {
      const p = props(x, z);
      const noiseHit = hash2(px, py, 7);
      if (p.vel) {
        vesselPx++;
        let vt = -(p.vel[0] * Math.sin(psi) + p.vel[1] * Math.cos(psi));      // toward transducer = positive
        const fill = Math.min(1, US.cgain / 45);
        if (Math.abs(vt) > 0.05 * vn && noiseHit < fill) {
          let va = ((vt + vn) % (2 * vn) + 2 * vn) % (2 * vn) - vn;          // aliasing wrap
          if (Math.abs(va - vt) > 1e-6) aliasPx++;
          colorPx++;
          const m = Math.min(1, Math.abs(va) / vn);
          if (va > 0) { r = 150 + 105 * m; gg = 40 + 200 * m * m; b = 20; } else { r = 10; gg = 60 + 180 * m * m; b = 160 + 95 * m; }
        }
      } else if (US.cgain > 65 && noiseHit < (US.cgain - 65) / 220) {        // color noise when gain is too high
        const red = hash2(px, py, 9) > 0.5; r = red ? 200 : 20; gg = 60; b = red ? 30 : 200;
      }
    }
    d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
  }
  US.colorFill = vesselPx ? colorPx / vesselPx : 0;
  US.aliasFrac = colorPx ? aliasPx / colorPx : 0;
  offx.putImageData(idata, 0, 0);
  cx.drawImage(off, 0, 0);
  // overlays: depth scale, focus markers, color box, quiz marker
  cx.strokeStyle = "rgba(240,239,236,0.75)"; cx.fillStyle = "rgba(240,239,236,0.85)"; cx.font = "11px ui-monospace, Menlo, monospace"; cx.lineWidth = 1;
  const step = US.depth <= 50 ? 5 : US.depth <= 100 ? 10 : 20;
  for (let z = 0; z <= US.depth; z += step) {
    const y = z * sc; cx.beginPath(); cx.moveTo(OUT - 10, y + .5); cx.lineTo(OUT - 2, y + .5); cx.stroke();
    if (z % (step * 2) === 0 && z > 0) { cx.textAlign = "right"; cx.fillText(z / 10 + "", OUT - 13, y + 4); }
  }
  cx.fillStyle = "#f0b84a";
  for (const zf of focalZones()) { const y = zf * sc; cx.beginPath(); cx.moveTo(OUT - 2, y); cx.lineTo(OUT - 10, y - 5); cx.lineTo(OUT - 10, y + 5); cx.fill(); }
  if (box) {
    cx.strokeStyle = "rgba(240,239,236,0.8)"; cx.setLineDash([4, 3]);
    const t = Math.tan(psi), P2 = (x, z) => [offX + (x - B.x0) * sc, z * sc];
    const pts = [P2(box.x0 + box.z0 * t, box.z0), P2(box.x1 + box.z0 * t, box.z0), P2(box.x1 + box.z1 * t, box.z1), P2(box.x0 + box.z1 * t, box.z1)];
    cx.beginPath(); pts.forEach((p, i) => i ? cx.lineTo(p[0], p[1]) : cx.moveTo(p[0], p[1])); cx.closePath(); cx.stroke(); cx.setLineDash([]);
  }
  if (US.marker) {
    const [mx, mz] = US.marker, X = offX + (mx - B.x0) * sc, Y = mz * sc;
    cx.strokeStyle = "#ffd84a"; cx.fillStyle = "#ffd84a"; cx.lineWidth = 2.5;
    cx.beginPath(); cx.moveTo(X - 34, Y - 34); cx.lineTo(X - 9, Y - 9); cx.stroke();
    cx.beginPath(); cx.moveTo(X - 6, Y - 6); cx.lineTo(X - 18, Y - 10); cx.lineTo(X - 10, Y - 18); cx.closePath(); cx.fill();
  }
}

/* ---------- readouts ---------- */
function frameRate() {
  const P = PROBES[US.probe];
  const tLine = 2 * US.depth / C;                       // µs per line per focal zone
  let t = tLine * P.lines * US.zones * (US.compound && US.probe === "linear" ? 3 : 1);
  if (US.doppler) { const b = colorBox(); const frac = Math.min(1, (b.x1 - b.x0) / (US.probe === "linear" ? P.width : 2 * (P.radius + US.depth) * Math.sin(P.angle * D2R / 2))); t += 2 * US.depth / C * P.lines * frac * 10; }
  return 1e6 / t;
}
function mechIndex() { return (1.6 + 0.12 * US.freq) * US.power / 100 / Math.sqrt(US.freq) * (US.harmonic ? 1.05 : 1); }
function thermIndex() { return (US.power / 100) * (0.25 + 0.06 * US.freq) * (US.doppler ? 1.8 : 1); }
function vesselAngle() {   // Doppler angle at the CCA centre (vascular scene)
  const s = SCENES.vascular.shapes.find(q => q.id === "cca");
  const ux = s.x2 - s.x1, uz = s.z2 - s.z1, L = Math.hypot(ux, uz);
  const psi = US.probe === "linear" ? US.steer * D2R : 0;
  const bx = Math.sin(psi), bz = Math.cos(psi);
  const cosA = Math.abs((ux * bx + uz * bz) / L);
  return Math.acos(cosA) / D2R;
}
function info() {
  const fr = frameRate(), MI = mechIndex(), TI = thermIndex();
  US.fr = fr; US.MI = MI;
  const lat = beamWidth(US.focus), ax = axialRes();
  US.latRes = lat; US.axRes = ax;
  $("usFR").textContent = fr.toFixed(0) + " Hz";
  $("usAx").textContent = ax.toFixed(2) + " mm";
  $("usLat").textContent = lat.toFixed(2) + " mm";
  $("usLatS").textContent = `at the focus (${(US.focus / 10).toFixed(1)} cm)`;
  $("usMI").textContent = `${MI.toFixed(2)} / ${TI.toFixed(1)}`;
  $("usTL").textContent = `${PROBES[US.probe].label}  ${US.freq.toFixed(1)} MHz${US.harmonic ? " THI" : ""}\nDepth ${(US.depth / 10).toFixed(1)} cm  Gain ${US.gain >= 0 ? "+" : ""}${US.gain} dB\nDR ${US.dr} dB  Power ${US.power}%`;
  $("usTR").textContent = `MI ${MI.toFixed(2)}  TIS ${TI.toFixed(1)}\n${fr.toFixed(0)} Hz${US.compound && US.probe === "linear" ? "  Compound" : ""}`;
  $("usBL").textContent = SCENES[US.scene].label;
  // Doppler panel
  const dp = $("usDop");
  if (US.doppler) {
    const vn = nyquist();
    let h = `<tr><th>Quantity</th><th>Value</th></tr><tr><td>PRF</td><td>${US.prf.toFixed(1)} kHz</td></tr><tr><td>Nyquist velocity (scale)</td><td>±${vn.toFixed(0)} cm/s</td></tr>`;
    if (US.scene === "vascular") {
      const ang = vesselAngle(), v = 90, df = 2 * US.freq * 1e6 * (v / 100) * Math.cos(ang * D2R) / (C * 1e3);
      US.dopAngle = ang;
      h += `<tr><td>Beam-to-flow angle (CCA)</td><td>${ang.toFixed(0)}°</td></tr><tr><td>Peak velocity in CCA</td><td>${v} cm/s</td></tr><tr><td>Doppler shift at peak</td><td>${(df / 1000).toFixed(2)} kHz</td></tr><tr><td>Measured (v·cos θ)</td><td>${(v * Math.cos(ang * D2R)).toFixed(0)} cm/s</td></tr>`;
    }
    h += `<tr><td>Vessel filled with color</td><td>${(100 * US.colorFill).toFixed(0)}%</td></tr><tr><td>Aliased color pixels</td><td>${(100 * US.aliasFrac).toFixed(0)}%</td></tr>`;
    dp.innerHTML = h;
  } else dp.innerHTML = `<tr><td style="color:var(--text-muted)">Turn on color Doppler to see Doppler measurements.</td></tr>`;
  beamPlot();
  // notes
  const notes = [];
  const S = US.scene;
  if (S === "abdomen") {
    if (US.stone) notes.push("<b>Gallstone:</b> a bright curved echo with a clean, black <b>posterior acoustic shadow</b>. The stone reflects and absorbs nearly all of the beam.");
    notes.push("<b>Gallbladder:</b> anechoic bile attenuates far less than liver, so the tissue behind it is brighter (<b>posterior acoustic enhancement</b>). Thin dark lines at its curved edges are <b>edge (refraction) shadows</b>.");
    notes.push("<b>Diaphragm:</b> the air-filled lung behind it acts as a mirror, so liver texture appears again above the diaphragm (<b>mirror-image artifact</b>). On the left, the rib casts a shadow.");
    notes.push("<b>Bowel gas</b> (right) gives a <b>dirty shadow</b> with bright repeating echoes (<b>reverberation</b>). Air reflects almost everything, so the sound bounces back and forth.");
    if (US.fluid) notes.push("<b>Free fluid</b> shows as an anechoic stripe in Morison's pouch, between the liver and the right kidney. This is a key FAST finding.");
  }
  if (S === "phantom") notes.push("The <b>vertical wire column</b> shows how the beam width changes with depth: wires look smallest at the focus (yellow marker). The <b>axial group</b> (left, pairs at 2, 1, 0.5 and 0.25 mm) tests axial resolution, which depends on frequency. The <b>lateral groups</b> test beam width. Anechoic cysts show enhancement behind them, and small deep cysts fill in when resolution is poor.");
  if (S === "vascular") {
    notes.push("Long-axis view: the internal jugular vein (top) and the common carotid artery (below). The calcified plaque on the far wall of the carotid casts an acoustic shadow.");
    if (US.doppler) {
      const ang = vesselAngle();
      if (ang > 80) notes.push(`<b>No color in the artery?</b> The beam is almost perpendicular to the flow (${ang.toFixed(0)}°), and cos 90° = 0. Steer the color box to make the angle smaller.`);
      else if (ang > 60) notes.push(`The Doppler angle is ${ang.toFixed(0)}°. Above 60°, small angle errors cause large velocity errors.`);
      if (US.aliasFrac > 0.05) notes.push("<b>Aliasing:</b> velocities above the Nyquist limit (PRF ÷ 2) wrap around to the opposite color. Fix it by raising the scale (PRF), lowering the frequency, shifting the baseline, or increasing the angle.");
      if (US.colorFill < 0.6 && ang <= 80) notes.push("The vessel isn't filling with color. Increase the color gain or lower the scale.");
      if (US.cgain > 70) notes.push("Color gain is too high: color noise is bleeding into the tissue outside the vessel.");
      notes.push("Color convention (BART): blue = away, red = toward the transducer. Color shows direction relative to the beam, not artery vs vein.");
    }
  }
  if (US.penetration < US.depth * 0.95) notes.push(`Signal drops into the noise below about ${(US.penetration / 10).toFixed(1)} cm. Attenuation ≈ 0.5 dB/cm/MHz, so lower frequencies penetrate deeper, at the cost of resolution.`);
  if (US.freq >= 10) notes.push(`At ${US.freq} MHz the wavelength is only ${lambda().toFixed(2)} mm, which gives excellent resolution but shallow penetration. That's ideal for superficial structures.`);
  if (US.zones > 1) notes.push(`${US.zones} focal zones keep the beam narrow over a longer depth range, but each line has to be fired ${US.zones} times, so frame rate drops.`);
  if (US.harmonic) notes.push("Tissue harmonic imaging forms the image from the 2nd harmonic generated in tissue. The beam is narrower, and there's less reverberation and near-field clutter, but less penetration.");
  if (US.compound && US.probe === "linear") notes.push("Spatial compounding averages frames steered at different angles. Speckle is smoother and edges are better defined, but shadowing and enhancement are reduced (which can hide a small stone) and frame rate falls.");
  if (US.compound && US.probe !== "linear") notes.push("Spatial compounding is simulated for the linear array only.");
  if (US.gain > 12) notes.push("Overall gain is high: the image is bright, and noise and clutter appear in fluid-filled structures.");
  if (US.gain < -12) notes.push("Overall gain is low: weak echoes from soft tissue disappear.");
  if (Math.max(...US.tgc) - Math.min(...US.tgc) > 12) notes.push("Uneven TGC makes bright and dark bands at different depths. Set the TGC so the same tissue looks uniform from top to bottom.");
  if (US.dr < 45) notes.push("A low dynamic range gives a high-contrast, black-and-white image, and subtle echo differences are lost.");
  if (US.dr > 75) notes.push("A high dynamic range gives a smooth, gray image that shows subtle differences but has less contrast.");
  $("usNotes").innerHTML = notes.map(n => `<p>${n}</p>`).join("");
  window.dispatchEvent(new CustomEvent("modrender", { detail: "us" }));
}
function beamPlot() {
  const c = $("usBeam"), dpr = window.devicePixelRatio || 1, w = c.clientWidth || 300, h = 170;
  c.width = w * dpr; c.height = h * dpr; c.style.height = h + "px";
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const m = { l: 36, r: 12, t: 10, b: 26 }, pw = w - m.l - m.r, ph = h - m.t - m.b;
  const ws = []; for (let i = 0; i <= 100; i++) ws.push(beamWidth(US.depth * i / 100));
  const wmax = Math.max(4, Math.ceil(Math.max(...ws)));
  const X = z => m.l + z / US.depth * pw, Y = v => m.t + ph / 2 - v / wmax * ph / 2;
  g.font = "11px system-ui, sans-serif"; g.fillStyle = "#8f8e86"; g.strokeStyle = "#2e2d2a";
  for (let i = 0; i <= 4; i++) { const z = US.depth * i / 4; g.beginPath(); g.moveTo(X(z) + .5, m.t); g.lineTo(X(z) + .5, m.t + ph); g.stroke(); g.textAlign = "center"; g.fillText((z / 10).toFixed(1), X(z), m.t + ph + 14); }
  g.textAlign = "right"; g.fillText(`±${(wmax / 2).toFixed(1)}`, m.l - 4, m.t + 8); g.fillText("0", m.l - 4, m.t + ph / 2 + 4);
  g.textAlign = "left"; g.fillText("depth (cm)", m.l + pw - 54, m.t + ph + 24 - 10 + 10);
  g.beginPath(); ws.forEach((v, i) => { const x = X(US.depth * i / 100), y = Y(v / 2); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  for (let i = 100; i >= 0; i--) g.lineTo(X(US.depth * i / 100), Y(-ws[i] / 2));
  g.closePath(); g.fillStyle = "rgba(57,135,229,0.3)"; g.fill(); g.strokeStyle = "#3987e5"; g.lineWidth = 2; g.stroke();
  g.fillStyle = "#f0b84a";
  for (const zf of focalZones()) { g.beginPath(); g.moveTo(X(zf), m.t + 2); g.lineTo(X(zf) - 5, m.t - 6 + 2); g.lineTo(X(zf) + 5, m.t - 6 + 2); g.fill(); }
}

/* ============================================================
   Controls
   ============================================================ */
let pending = false;
function update() {
  if (pending) return; pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}
const sliders = {
  usFREQ: ["freq", v => v.toFixed(1) + " MHz"], usDEPTH: ["depth", v => (v / 10).toFixed(1) + " cm"], usFOCUS: ["focus", v => (v / 10).toFixed(1) + " cm"],
  usGAIN: ["gain", v => (v >= 0 ? "+" : "") + v + " dB"], usDR: ["dr", v => v + " dB"], usPOWER: ["power", v => v + "%"],
  usPRF: ["prf", v => v.toFixed(1) + " kHz"], usCGAIN: ["cgain", v => v + "%"],
};
function syncUI() {
  const P = PROBES[US.probe];
  const fe = $("usFREQ"); fe.min = P.fmin; fe.max = P.fmax;
  const de = $("usDEPTH"); de.min = US.probe === "linear" ? 20 : 40; de.max = US.probe === "linear" ? 80 : 240;
  $("usFOCUS").min = 5; $("usFOCUS").max = US.depth;
  for (const [id, [key, f]] of Object.entries(sliders)) { $(id).value = US[key]; $("o_" + id).textContent = f(US[key]); }
  document.querySelectorAll("#usScene button").forEach(b => b.classList.toggle("on", b.dataset.v === US.scene));
  document.querySelectorAll("#usProbe button").forEach(b => b.classList.toggle("on", b.dataset.v === US.probe));
  document.querySelectorAll("#usZones button").forEach(b => b.classList.toggle("on", +b.dataset.v === US.zones));
  document.querySelectorAll("#usSteer button").forEach(b => b.classList.toggle("on", +b.dataset.v === US.steer));
  ["harmonic", "compound", "stone", "cyst", "fluid", "plaque", "doppler"].forEach(k => { const e = $("us_" + k); if (e) e.checked = US[k]; });
  document.querySelectorAll(".usopt").forEach(e => e.style.display = e.dataset.scene === US.scene ? "" : "none");
  $("usSteerRow").style.display = US.probe === "linear" ? "" : "none";
  document.querySelectorAll("#usTGC input").forEach((e, i) => { e.value = US.tgc[i]; });
}
function constrain() {
  const P = PROBES[US.probe];
  US.freq = Math.min(P.fmax, Math.max(P.fmin, US.freq));
  US.depth = Math.min(US.probe === "linear" ? 80 : 240, Math.max(US.probe === "linear" ? 20 : 40, US.depth));
  US.focus = Math.min(US.depth, Math.max(5, US.focus));
}
function changed() { constrain(); syncUI(); update(); }
for (const [id, [key]] of Object.entries(sliders)) $(id).addEventListener("input", e => { US[key] = parseFloat(e.target.value); changed(); });
function seg(id, cb) { document.querySelectorAll(`#${id} button`).forEach(b => b.addEventListener("click", () => { cb(b.dataset.v); changed(); })); }
function setScene(s) {
  US.scene = s; Object.assign(US, SCENE_DEFAULTS[s]);
  US.doppler = false; US.steer = 0; US.marker = null;
}
seg("usScene", v => setScene(v));
seg("usProbe", v => {
  US.probe = v;
  if (v === "linear") { US.freq = Math.max(US.freq, 7.5); US.depth = Math.min(US.depth, 60); US.focus = Math.min(US.focus, US.depth * 0.6); }
  else { US.freq = Math.min(US.freq, 4); US.depth = Math.max(US.depth, 120); }
});
seg("usZones", v => { US.zones = +v; });
seg("usSteer", v => { US.steer = +v; });
["harmonic", "compound", "stone", "cyst", "fluid", "plaque", "doppler"].forEach(k => { const e = $("us_" + k); if (e) e.addEventListener("change", () => { US[k] = e.checked; changed(); }); });
const tgcBox = $("usTGC");
for (let i = 0; i < 8; i++) {
  const inp = document.createElement("input"); inp.type = "range"; inp.min = -20; inp.max = 20; inp.step = 1; inp.value = 0;
  inp.setAttribute("aria-label", `TGC band ${i + 1}`);
  inp.addEventListener("input", () => { US.tgc[i] = +inp.value; update(); });
  tgcBox.appendChild(inp);
}
$("usTGCreset").addEventListener("click", () => { US.tgc = [0, 0, 0, 0, 0, 0, 0, 0]; changed(); });
$("usOpt").addEventListener("click", () => {   // "auto-optimize": flat TGC, focus at the region of interest, sensible gain
  US.tgc = [0, 0, 0, 0, 0, 0, 0, 0]; US.gain = 0; US.dr = 60;
  US.focus = US.scene === "vascular" ? 22 : US.scene === "abdomen" ? 90 : 60;
  changed();
});
window.addEventListener("resize", () => { if (document.body.dataset.mod === "us" && US.G) beamPlot(); });

window.USIM = {
  US, update, changed, setScene, syncUI,
  defaults: () => ({ scene: "abdomen", probe: "curved", freq: 3.5, depth: 160, focus: 90, zones: 1, gain: 0, tgc: [0, 0, 0, 0, 0, 0, 0, 0], dr: 60, power: 100, harmonic: false, compound: false, stone: true, cyst: true, fluid: false, plaque: true, doppler: false, prf: 4, steer: 0, cgain: 50, marker: null }),
  nyquist, vesselAngle, beamWidth, frameRate, props,
};
document.querySelectorAll("#modality button").forEach(b => b.addEventListener("click", () => { if (b.dataset.v === "us") { syncUI(); update(); } }));
})();
