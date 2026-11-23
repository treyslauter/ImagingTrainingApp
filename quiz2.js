/* Quiz mode for CT, X-ray and ultrasound (MRI has its own quiz in index.html). */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const pick = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const CTX = () => window.CTXR, USX = () => window.USIM;
const fmtT = s => s.toFixed(1);

/* ============================================================
   Question banks
   ============================================================ */
const BANK = {
  /* ------------------------------- CT ------------------------------- */
  ct: {
    name: "CT",
    choices: ["Metal streak artifact", "Ring artifact", "Motion artifact", "View aliasing (too few projections)", "Quantum noise (low mAs)", "Beam hardening (uncorrected)"],
    identify: [
      { ans: "Metal streak artifact", st: () => pick([{ region: "chest", metal: true, zFrac: 0.78 }, { region: "head", metal: true, winName: "Brain", zFrac: 0.27 }]),
        why: "Bright and dark streaks radiate from a very dense object. Metal stops almost all photons along some rays (photon starvation) and hardens the beam, so the projections are inconsistent, and filtered backprojection smears the error across the image as streaks." },
      { ans: "Ring artifact", st: () => ({ region: pick(["chest", "head"]), ring: true }),
        why: "A ring centered on the rotation axis comes from one miscalibrated detector element. It reads wrong at every angle, which makes a vertical line in the sinogram that backprojects into a circle. Fix: recalibrate or replace the detector." },
      { ans: "Motion artifact", st: () => ({ region: "chest", motion: 14 }),
        why: "The patient moved partway through the rotation, so early and late projections disagree. The result is streaks along edges, blurring and doubled contours. Fix: immobilize, breath-hold, or scan faster." },
      { ans: "View aliasing (too few projections)", st: () => ({ region: pick(["chest", "head"]), views: 60 }),
        why: "Fine radial streaks away from the center come from too few projection angles. Backprojection needs dense angular sampling, so with too few views each projection's \"spokes\" don't cancel out." },
      { ans: "Quantum noise (low mAs)", st: () => ({ region: pick(["chest", "head"]), mAs: 20 }),
        why: "A grainy, mottled image with no structured streaks comes from too few photons (low mAs). Noise ∝ 1/√(mAs), so quadrupling mAs halves the noise but quadruples the dose." },
      { ans: "Beam hardening (uncorrected)", st: () => ({ region: "head", bh: "uncorrected", winName: "Brain" }),
        why: "Without beam-hardening correction, low-energy photons are filtered out along long paths, so the beam's mean energy rises and the tissue looks less dense. The center of the head looks darker (cupping), and dark bands appear between dense bones. Scanners correct for this in software." },
    ],
    challenges: [
      { title: "Halve the noise without more mAs", st: { region: "chest", mAs: 100 },
        goal: "This chest CT at 100 mAs is noisy. Get the soft-tissue noise to 10 HU or less without raising mAs above 100 and without making slices thicker than 5 mm.",
        checks: [
          ["Noise ≤ 10 HU", () => (CTX().CT.noiseSD ?? 99) <= 10, () => `${fmtT(CTX().CT.noiseSD ?? 0)} HU`],
          ["mAs ≤ 100", () => CTX().CT.mAs <= 100, () => `${CTX().CT.mAs} mAs`],
          ["Slice thickness ≤ 5 mm", () => CTX().CT.thk <= 5, () => `${CTX().CT.thk} mm`],
        ],
        sol: { recon: "iter" },
        why: "Options that cost no extra mAs: iterative reconstruction (largest effect), a smoother kernel (less noise, less sharpness), or a lower pitch (raises effective mAs = mAs ÷ pitch, but also raises dose)." },
      { title: "Low-dose chest CT", st: { region: "chest", mAs: 250 },
        goal: "Bring CTDIvol down to 6 mGy or less while keeping soft-tissue noise at 15 HU or less.",
        checks: [
          ["CTDIvol ≤ 6 mGy", () => CTX().CT.ctdi <= 6, () => `${fmtT(CTX().CT.ctdi)} mGy`],
          ["Noise ≤ 15 HU", () => (CTX().CT.noiseSD ?? 99) <= 15, () => `${fmtT(CTX().CT.noiseSD ?? 0)} HU`],
        ],
        sol: { mAs: 80, recon: "iter" },
        why: "Dose scales with mAs ÷ pitch and with about kVp^2.5. Cutting mAs alone makes noise rise as 1/√mAs. Iterative reconstruction is what lets modern low-dose protocols keep noise acceptable." },
      { title: "CT angiography at low kVp", st: { region: "chest" },
        goal: "Make iodinated blood (250 HU at 120 kVp) reach at least 330 HU, so vessels stand out more, while keeping noise at 18 HU or less.",
        checks: [
          ["Iodinated blood ≥ 330 HU", () => CTX().ctHU(250) >= 330, () => `${Math.round(CTX().ctHU(250))} HU`],
          ["Noise ≤ 18 HU", () => (CTX().CT.noiseSD ?? 99) <= 18, () => `${fmtT(CTX().CT.noiseSD ?? 0)} HU`],
        ],
        sol: { kVp: 80, mAs: 400 },
        why: "Iodine's K-edge is at 33 keV. Lowering kVp moves the spectrum toward it, so iodine attenuates much more relative to water. At 80 kVp contrast rises by about 35%, but fewer photons get through, so mAs has to go up to control noise. This is the basis of low-kVp CTA, which can also reduce the contrast dose." },
      { title: "Stroke window", st: { region: "head" },
        goal: "Early ischemia changes gray matter by only a few HU. Set a stroke window (width ≤ 40 HU) and get noise down to 4 HU or less so subtle changes aren't hidden.",
        checks: [
          ["Window width ≤ 40 HU", () => CTX().CT.win.W <= 40, () => `W ${Math.round(CTX().CT.win.W)}`],
          ["Noise ≤ 4 HU", () => (CTX().CT.noiseSD ?? 99) <= 4, () => `${fmtT(CTX().CT.noiseSD ?? 0)} HU`],
        ],
        sol: { winName: "Stroke", mAs: 450 },
        why: "A narrow window stretches a few HU across the whole gray scale, so noise has to be low or it hides the finding. Options: more mAs, thicker slices, a smoother kernel, or iterative reconstruction." },
      { title: "Read the lungs", st: { region: "chest" },
        goal: "Set up for evaluating lung parenchyma: a lung window (width ≥ 1200, level between −700 and −500) and a sharp kernel.",
        checks: [
          ["Lung window", () => CTX().CT.win.W >= 1200 && CTX().CT.win.L >= -700 && CTX().CT.win.L <= -500, () => `W ${Math.round(CTX().CT.win.W)} L ${Math.round(CTX().CT.win.L)}`],
          ["Sharp kernel", () => CTX().CT.kernel === "sharp", () => CTX().CT.kernel],
        ],
        sol: { winName: "Lung", kernel: "sharp" },
        why: "Lung has very high inherent contrast (air vs tissue), so a sharp kernel can be used: it shows fine detail, and the extra noise doesn't matter at a wide window. Soft tissue needs the opposite, a smooth kernel with a narrow window." },
    ],
    physics: [
      { q: "How is a CT number (HU) defined?", a: ["HU = 1000 × (μ − μwater) / μwater", "HU = 1000 × μ / μair", "HU = μ × 1000 − 1000 (μ in cm⁻¹)", "HU = density × 1000"], why: "Water is 0 HU and air ≈ −1000 HU by definition. Scanners calibrate water at each kVp, so water stays 0, while high-Z materials (iodine, bone) change with kVp." },
      { q: "You double the mAs. What happens to image noise?", a: ["Falls to about 71% (÷√2)", "Halves", "Unchanged", "Doubles"], why: "Noise ∝ 1/√(number of photons). Doubling mAs doubles photons and dose, but noise only drops by √2." },
      { q: "Pitch increases from 1.0 to 1.5 with the same mAs per rotation. What happens?", a: ["Lower dose and more noise", "Higher dose and less noise", "No change in dose or noise", "Higher dose and more noise"], why: "Effective mAs = mAs ÷ pitch. A higher pitch spreads the same photons over more length, so CTDIvol drops and noise rises." },
      { q: "Which kernel would you choose for liver lesions on a portal-venous CT?", a: ["Smooth (soft tissue)", "Sharp (bone)", "Sharp (lung)", "The kernel doesn't affect low-contrast detection"], why: "Low-contrast lesions need low noise. A smooth kernel suppresses high-frequency noise at the cost of spatial resolution." },
      { q: "Why does iodinated contrast look brighter at 80 kVp than at 120 kVp?", a: ["The spectrum moves closer to iodine's K-edge (33 keV), so photoelectric absorption rises", "There are more photons at 80 kVp", "Compton scattering increases at low kVp", "Water becomes less dense at low kVp"], why: "The photoelectric effect scales roughly with Z³/E³, and iodine (Z = 53) has its K-edge at 33.2 keV. Lower-energy spectra therefore raise iodine's attenuation relative to soft tissue." },
      { q: "A complete or partial ring centered in the image is most likely due to:", a: ["A miscalibrated or failed detector element", "Patient motion", "Metal in the field", "Too few projections"], why: "Each detector element always measures at the same distance from the isocenter, so a consistent error traces a circle." },
      { q: "What does CTDIvol represent?", a: ["A standardized dose index measured in a reference phantom, not the patient's actual dose", "The patient's organ dose", "The effective dose in mSv", "The total dose for the whole scan"], why: "CTDIvol (mGy) describes scanner output per rotation in a 16 cm or 32 cm phantom. DLP = CTDIvol × scan length. Effective dose ≈ DLP × a region-specific k factor." },
      { q: "Thicker reconstructed slices cause:", a: ["Less noise but more partial-volume averaging", "More noise and less partial volume", "Higher dose", "Better spatial resolution along z"], why: "More photons contribute to each voxel, so noise drops, but small structures are averaged with their neighbors (partial-volume effect)." },
      { q: "What is the main cause of metal streak artifacts?", a: ["Photon starvation and beam hardening along rays through metal", "Detector afterglow", "Aliasing in the reconstruction grid", "Electronic noise in the tube"], why: "Rays through metal reach the detector with almost no photons, so the log transform amplifies noise, and the hardened spectrum biases the measurements. Metal artifact reduction (MAR) algorithms replace or correct those rays." },
      { q: "Narrowing the window width (same level) will:", a: ["Increase displayed contrast over a smaller HU range", "Reduce image noise", "Change the measured HU values", "Increase spatial resolution"], why: "Window width maps a range of HU onto the gray scale. A narrow window means small HU differences span more gray levels. Noise looks worse too, but the data are unchanged." },
    ],
  },

  /* ------------------------------- X-ray ------------------------------- */
  xr: {
    name: "X-ray",
    choices: ["Underexposed (quantum mottle)", "Missing grid (scatter fog)", "Patient motion blur", "Low kVp (short-scale contrast)", "High kVp (long-scale contrast)", "Overexposed film", "AP projection (magnified heart)"],
    identify: [
      { ans: "Underexposed (quantum mottle)", st: () => ({ mAsI: 1 }), why: "Grainy mottle throughout, especially in the mediastinum and abdomen. Too few photons reached the detector. Digital processing restored the brightness but can't create information: the exposure index would be far below target." },
      { ans: "Missing grid (scatter fog)", st: () => ({ grid: false, mAsI: 5 }), why: "The image looks gray and veiled, with poor contrast in the mediastinum and abdomen. Scatter adds a nearly uniform fog. A grid removes most scatter; without one the scatter-to-primary ratio in the mediastinum can be 3–5." },
      { ans: "Patient motion blur", st: () => ({ motion: 100, focal: "small", mAsI: 16 }), why: "Edges (diaphragm, heart border, vessels) are smeared in one direction. A long exposure time (low mA, small focus, high mAs) combined with breathing blurs the image. Use a short exposure time and good breath-holding." },
      { ans: "Low kVp (short-scale contrast)", st: () => ({ kVp: 60, mAsI: 19 }), why: "Very high contrast: bright ribs, a dense white mediastinum and abdomen, and dark lungs. At low kVp the photoelectric effect dominates, so subject contrast is high, but penetration is poor and patient dose is higher." },
      { ans: "High kVp (long-scale contrast)", st: () => ({ kVp: 150, mAsI: 6 }), why: "A flat, gray image with faint ribs and many shades of gray. At high kVp Compton scatter dominates and subject contrast drops, but patient dose is lower. That's why chest films use high kVp, so the lungs are seen through the ribs." },
      { ans: "Overexposed film", st: () => ({ film: true, mAsI: 17 }), why: "A dark, almost black film with burned-out lungs. Screen-film has no automatic rescaling, so too much exposure darkens everything. A digital system would have hidden this, and only the exposure index would show it." },
      { ans: "AP projection (magnified heart)", st: () => ({ view: "AP", kVp: 100, SID: 100, grid: false, mAsI: 3 }), why: "On an AP film at short SID, the heart is far from the detector and close to the source, so it's magnified (about ×1.16 here vs ×1.06 for PA at 180 cm). Don't judge cardiomegaly on an AP film." },
    ],
    challenges: [
      { title: "Reach target exposure at 60 kVp", st: { kVp: 60, mAsI: 9 },
        goal: "You need high bone contrast, so stay at 70 kVp or less, but the exposure index is far too low. Bring the deviation index within ±1.",
        checks: [
          ["kVp ≤ 70", () => CTX().XR.kVp <= 70, () => `${CTX().XR.kVp} kVp`],
          ["Deviation index within ±1", () => Math.abs(CTX().XR.DI) <= 1, () => `DI ${CTX().XR.DI >= 0 ? "+" : ""}${CTX().XR.DI.toFixed(1)}`],
        ],
        sol: { mAsI: 19 },
        why: "At low kVp the chest transmits far fewer photons, so mAs has to rise roughly 10× compared with 120 kVp. Patient dose rises accordingly. By the 15% rule, a 15% drop in kVp needs about double the mAs." },
      { title: "Lowest-dose PA chest", st: {},
        goal: "Get the entrance skin dose to 0.08 mGy or less for a PA chest with the grid, while keeping the deviation index within ±1.5.",
        checks: [
          ["ESAK ≤ 0.08 mGy", () => CTX().XR.esak <= 0.08, () => `${CTX().XR.esak.toFixed(3)} mGy`],
          ["Deviation index within ±1.5", () => Math.abs(CTX().XR.DI) <= 1.5, () => `DI ${CTX().XR.DI >= 0 ? "+" : ""}${CTX().XR.DI.toFixed(1)}`],
          ["PA view with grid", () => CTX().XR.view === "PA" && CTX().XR.grid, () => ""],
        ],
        sol: { kVp: 150, mAsI: 6 },
        why: "Higher kVp photons penetrate better, so more of them reach the detector for the same entrance dose. Raising kVp and lowering mAs cuts patient dose at the same exposure index, at the cost of lower contrast." },
      { title: "Freeze the motion", st: { motion: 80, focal: "small", mAsI: 12 },
        goal: "This patient can't hold their breath well (80 mm/s). Get motion blur to 0.5 mm or less while keeping the deviation index within ±2.",
        checks: [
          ["Motion blur ≤ 0.5 mm", () => CTX().XR.blurMM <= 0.5, () => `${CTX().XR.blurMM.toFixed(2)} mm`],
          ["Deviation index within ±2", () => Math.abs(CTX().XR.DI) <= 2, () => `DI ${CTX().XR.DI >= 0 ? "+" : ""}${CTX().XR.DI.toFixed(1)}`],
        ],
        sol: { focal: "large", mAsI: 9 },
        why: "Exposure time = mAs ÷ mA. The large focal spot allows a higher tube current (500 mA here), and raising kVp lets you use fewer mAs. Both shorten the exposure. The small focal spot is sharper geometrically, but its lower mA means longer exposures." },
      { title: "Cut scatter without a grid", st: { grid: false, mAsI: 5 },
        goal: "A portable detector without a grid. Get the scatter-to-primary ratio in the mediastinum down to 2.0 or less, keeping the grid off.",
        checks: [
          ["SPR ≤ 2.0", () => CTX().XR.spr <= 2.0, () => `SPR ${CTX().XR.spr.toFixed(2)}`],
          ["Grid off", () => !CTX().XR.grid, () => ""],
        ],
        sol: { fw: 20, fh: 22 },
        why: "Scatter depends on the irradiated volume. Tight collimation reduces the scattering volume (and patient dose). Lower kVp, compression and an air gap also help. A grid is the most effective option but needs more mAs." },
      { title: "True heart size on a portable", st: { view: "AP", kVp: 100, SID: 100, grid: false, mAsI: 3 },
        goal: "On this AP portable film the heart is magnified. Keep it AP but reduce heart magnification to ×1.10 or less.",
        checks: [
          ["Heart magnification ≤ 1.10", () => CTX().XR.mag <= 1.10, () => `×${CTX().XR.mag.toFixed(2)}`],
          ["Still an AP view", () => CTX().XR.view === "AP", () => ""],
        ],
        sol: { SID: 160, mAsI: 5 },
        why: "Magnification = SID ÷ SOD. Increasing the SID makes the beam more parallel, which reduces magnification (and blur). Remember to raise mAs, since intensity falls with the inverse square of distance." },
    ],
    physics: [
      { q: "Raising kVp (with mAs adjusted to keep the same detector exposure) mainly:", a: ["Reduces subject contrast and patient dose", "Increases subject contrast and patient dose", "Increases noise", "Has no effect on contrast"], why: "Higher-energy photons penetrate better and interact more by Compton scatter, so tissue differences shrink while fewer photons are needed at the skin." },
      { q: "Doubling mAs (nothing else changed) will:", a: ["Double the photons and patient dose, and lower noise by √2", "Raise contrast", "Raise the mean beam energy", "Double the scatter fraction"], why: "mAs sets the number of photons, not their energy. The spectrum shape, contrast and scatter fraction are unchanged." },
      { q: "The 15% rule says that increasing kVp by 15% is roughly equivalent to:", a: ["Doubling the mAs", "Halving the mAs", "Doubling the SID", "Removing the grid"], why: "A 15% kVp increase roughly doubles the detector exposure, so mAs can be halved to compensate, with lower contrast and lower patient dose." },
      { q: "You move from 100 cm to 180 cm SID. To keep the same detector exposure, mAs must be multiplied by about:", a: ["3.2", "1.8", "0.55", "1.3"], why: "Inverse square law: (180/100)² = 3.24." },
      { q: "What is the main drawback of using an anti-scatter grid?", a: ["It absorbs some primary photons, so more mAs (dose) is needed", "It increases scatter", "It reduces the mean beam energy", "It increases magnification"], why: "The Bucky factor (typically 3–5) is the mAs increase needed with a grid. A grid improves contrast but costs dose." },
      { q: "A deviation index (DI) of +3 means the detector received:", a: ["About 2× the target exposure", "3× the target exposure", "3% more than target", "Half the target exposure"], why: "DI = 10·log₁₀(EI / EI_target). +3 ≈ ×2, and +10 = ×10." },
      { q: "\"Dose creep\" in digital radiography happens because:", a: ["Overexposed images still look good after processing, so exposure errors aren't noticed", "Detectors become less sensitive over time", "Grids wear out", "kVp drifts upward over time"], why: "Digital processing rescales brightness automatically, so overexposure produces an excellent-looking image. Only the EI/DI reveals it." },
      { q: "Why is a PA chest preferred to AP for judging heart size?", a: ["The heart is closer to the detector, so it's less magnified", "PA uses less kVp", "PA has less scatter", "PA shows the lungs better because of the grid"], why: "Magnification = SID ÷ SOD. In PA the heart is anterior, close to the detector, and SID is usually 180 cm." },
      { q: "Geometric unsharpness (penumbra) increases with:", a: ["A larger focal spot and a larger object-to-detector distance", "A smaller focal spot", "Higher kVp", "Higher mAs"], why: "Penumbra = focal spot size × OID ÷ SOD. Use a small focus, keep the part close to the detector, and use a long SID." },
      { q: "Scatter reaching the detector increases with:", a: ["Larger field size and thicker body parts", "Tighter collimation", "Using a grid", "Lower kVp"], why: "The scatter source is the irradiated volume. Collimate tightly, use a grid, and compress where possible." },
    ],
  },

  /* ------------------------------- Ultrasound ------------------------------- */
  us: {
    name: "Ultrasound",
    choices: ["Posterior acoustic shadowing", "Posterior acoustic enhancement", "Mirror-image artifact", "Reverberation / dirty shadow", "Edge (refraction) shadow", "Color aliasing", "Focus set too shallow", "Incorrect TGC setting"],
    identify: [
      { ans: "Posterior acoustic shadowing", st: () => ({ scene: "abdomen", stone: true, marker: [17, 88] }), why: "A gallstone reflects and absorbs nearly all of the sound, leaving a clean black shadow behind it. This is one of the key signs of a calculus." },
      { ans: "Posterior acoustic enhancement", st: () => ({ scene: "abdomen", stone: false, marker: [-2, 85] }), why: "Fluid (bile) attenuates far less than tissue, but the TGC still compensates as if for tissue, so echoes behind a fluid-filled structure are brighter than their surroundings. This helps identify cysts." },
      { ans: "Mirror-image artifact", st: () => ({ scene: "abdomen", marker: [-58, 132] }), why: "The air-filled lung behind the diaphragm is a strong reflector. Sound bounces back into the liver and returns late, so the machine draws a duplicate liver beyond the diaphragm." },
      { ans: "Reverberation / dirty shadow", st: () => ({ scene: "abdomen", marker: [70, 108] }), why: "Bowel gas reflects almost all the sound. Repeated reflections between the gas and the transducer create bright, regularly spaced lines and a smeared (\"dirty\") shadow." },
      { ans: "Edge (refraction) shadow", st: () => ({ scene: "abdomen", cyst: true, stone: false, marker: [-49.5, 60] }), why: "Thin dark lines extend from the edges of the cyst. The beam bends and spreads where it hits a curved fluid boundary at a grazing angle, so less energy continues below the edge." },
      { ans: "Color aliasing", st: () => ({ scene: "vascular", doppler: true, steer: 20, prf: 3, marker: [0, 23] }), why: "Inside the vessel, color wraps from bright red straight to blue with no black zero line in between. The Doppler shift exceeds the Nyquist limit (PRF/2). Raise the scale (PRF), lower the frequency, increase the angle, or move the baseline." },
      { ans: "Focus set too shallow", st: () => ({ scene: "phantom", focus: 15, marker: [0, 120] }), why: "The deep wire targets are smeared sideways. The beam is narrowest at the focus (yellow marker), so below a shallow focus it diverges and lateral resolution falls apart. Move the focus to the area of interest." },
      { ans: "Incorrect TGC setting", st: () => ({ scene: "phantom", tgc: [0, 0, 0, -18, -18, 0, 0, 0], marker: [-26, 85] }), why: "A dark horizontal band in uniform material comes from time-gain compensation that's too low at that depth. TGC should be set so the same tissue looks equally bright at every depth." },
    ],
    challenges: [
      { title: "See the kidney", st: { scene: "abdomen", freq: 7, depth: 160 },
        goal: "With this high frequency the deep part of the image is lost in noise. Get usable signal down to at least 13 cm with a depth of at least 14 cm.",
        checks: [
          ["Penetration ≥ 13 cm", () => USX().US.penetration >= 130, () => `${(USX().US.penetration / 10).toFixed(1)} cm`],
          ["Depth ≥ 14 cm", () => USX().US.depth >= 140, () => `${(USX().US.depth / 10).toFixed(1)} cm`],
        ],
        sol: { freq: 3, harmonic: false },
        why: "Attenuation is about 0.5 dB/cm/MHz each way. At 7 MHz a 16 cm round trip loses about 112 dB, versus about 56 dB at 3.5 MHz. Deep abdominal imaging needs 2–5 MHz, giving up resolution for penetration." },
      { title: "Resolve the wire pairs", st: { scene: "phantom", probe: "curved", freq: 3.5, depth: 120, focus: 70 },
        goal: "On the QA phantom, get the lateral beam width at 3 cm down to 0.5 mm or less so the closely spaced wires separate.",
        checks: [
          ["Beam width at 3 cm ≤ 0.5 mm", () => USX().beamWidth(30) <= 0.5, () => `${USX().beamWidth(30).toFixed(2)} mm`],
        ],
        sol: { probe: "linear", freq: 12, depth: 50, focus: 30 },
        why: "Lateral resolution equals the beam width, which is narrowest at the focus and proportional to wavelength × F-number. A high-frequency linear probe with the focus at the target gives the best lateral resolution." },
      { title: "Fix the TGC", st: { scene: "phantom", tgc: [10, 6, -12, -16, 4, 14, 16, 18] },
        goal: "The phantom background should look uniform at every depth. Adjust the TGC so the brightness of the background varies by 4 dB or less, across the depths that have signal.",
        checks: [
          ["Background uniform within 4 dB", () => tgcSpread() <= 4, () => `${tgcSpread().toFixed(1)} dB spread`],
        ],
        sol: { tgc: [0, 0, 0, 0, 0, 0, 0, 0] },
        why: "TGC compensates for attenuation with depth. Set it so a uniform medium looks uniform. Many scanners have an automatic optimization button, which here is \"Optimize\"." },
      { title: "Get color in the carotid", st: { scene: "vascular", doppler: true, steer: 0, prf: 2 },
        goal: "No color shows in the artery. Fill at least 60% of the vessel with color, with less than 5% aliasing and a Doppler angle of 70° or less.",
        checks: [
          ["Doppler angle ≤ 70°", () => USX().vesselAngle() <= 70, () => `${USX().vesselAngle().toFixed(0)}°`],
          ["Vessel color fill ≥ 60%", () => USX().US.colorFill >= 0.6, () => `${(100 * USX().US.colorFill).toFixed(0)}%`],
          ["Aliasing < 5%", () => USX().US.aliasFrac < 0.05, () => `${(100 * USX().US.aliasFrac).toFixed(0)}%`],
        ],
        sol: { steer: 20, prf: 10 },
        why: "Doppler shift ∝ cos θ. With the beam at 90° to the flow there is no shift and no color. Steering the color box gives an angle under 90°. The higher shift then needs a higher PRF (scale) to stay below the Nyquist limit: Vmax = c·PRF / (4f₀)." },
      { title: "Frame rate for a moving target", st: { scene: "abdomen", depth: 200, zones: 3 },
        goal: "Frame rate is too low to follow motion. Reach at least 20 Hz while keeping a depth of at least 15 cm.",
        checks: [
          ["Frame rate ≥ 20 Hz", () => USX().US.fr >= 20, () => `${USX().US.fr.toFixed(0)} Hz`],
          ["Depth ≥ 15 cm", () => USX().US.depth >= 150, () => `${(USX().US.depth / 10).toFixed(1)} cm`],
        ],
        sol: { zones: 1, depth: 150 },
        why: "Each line takes 13 µs per cm of depth (round trip). Frame time = lines × focal zones × 2·depth / c. Fewer focal zones, less depth, a narrower sector, or no compounding all raise frame rate." },
    ],
    physics: [
      { q: "What speed of sound does the scanner assume in soft tissue, and what time-to-depth rule follows?", a: ["1540 m/s, 13 µs per cm of depth", "1540 m/s, 6.5 µs per cm of depth", "330 m/s, 13 µs per cm", "4080 m/s, 3 µs per cm"], why: "Round trip: 2 cm ÷ 1.54 mm/µs ≈ 13 µs. Errors in assumed speed cause range-misregistration artifacts." },
      { q: "Raising transducer frequency (everything else equal):", a: ["Improves axial and lateral resolution but reduces penetration", "Improves penetration but reduces resolution", "Has no effect on attenuation", "Only affects Doppler"], why: "Wavelength = c/f, so a higher f gives a shorter pulse and narrower beam, but attenuation (≈0.5 dB/cm/MHz) rises proportionally." },
      { q: "Axial resolution is equal to:", a: ["Half the spatial pulse length", "The beam width", "The wavelength × F-number", "The line density"], why: "Two reflectors along the beam are resolved if they are more than SPL/2 apart. Short pulses (high frequency, damped crystals) improve it." },
      { q: "Lateral resolution is best:", a: ["At the focal zone, where the beam is narrowest", "In the near field just under the transducer", "In the far field", "It's the same at all depths"], why: "Lateral resolution equals beam width. Put the focus at the area of interest; multiple focal zones extend the narrow region but lower frame rate." },
      { q: "Strong reflection (and little transmission) occurs at an interface when:", a: ["The acoustic impedances differ greatly (e.g., soft tissue–air)", "The two tissues have the same impedance", "The beam is perpendicular and impedances are equal", "Attenuation is low"], why: "Intensity reflection coefficient R = ((Z₂ − Z₁)/(Z₂ + Z₁))². Tissue–air reflects about 99.9%, which is why gel is needed and why gas blocks the view." },
      { q: "In the Doppler equation, the measured shift is zero when the beam-to-flow angle is:", a: ["90°", "0°", "45°", "60°"], why: "Δf = 2 f₀ v cos θ / c, and cos 90° = 0. Keep the angle at 60° or less for velocity measurements; above that, small angle errors cause large velocity errors." },
      { q: "Which change does NOT help eliminate color or spectral aliasing?", a: ["Increasing the transducer frequency", "Increasing the PRF (scale)", "Shifting the baseline", "Using a lower-frequency transducer"], why: "Nyquist velocity = c·PRF / (4 f₀). A higher f₀ lowers the Nyquist velocity and makes aliasing worse." },
      { q: "Posterior acoustic enhancement occurs behind structures that:", a: ["Attenuate less than the surrounding tissue (e.g., simple fluid)", "Attenuate more than the surrounding tissue", "Have high impedance", "Contain air"], why: "TGC assumes tissue-level attenuation. Behind fluid, more energy survives, so echoes appear brighter." },
      { q: "What is a main benefit of tissue harmonic imaging?", a: ["A narrower beam with fewer reverberation and side-lobe artifacts", "Deeper penetration", "Higher frame rate", "Lower mechanical index"], why: "Harmonics form mainly in the central, high-pressure part of the beam and build up with depth, so near-field clutter and side lobes are suppressed. The trade-off is some penetration." },
      { q: "The mechanical index (MI) is an indicator of:", a: ["The likelihood of non-thermal (cavitation) bioeffects", "Tissue heating", "Image brightness", "Frame rate"], why: "MI = peak rarefactional pressure ÷ √f. The thermal index (TI) estimates heating. Follow ALARA: use the lowest output that gives a diagnostic image." },
    ],
  },
};
function tgcSpread() {
  const U = USX().US, b = U.bandMeans || [];
  const n = Math.max(1, Math.floor(8 * Math.min(U.penetration, U.depth) / U.depth) - 1);
  const v = b.slice(0, n); return v.length ? Math.max(...v) - Math.min(...v) : 99;
}

/* ============================================================
   Engine
   ============================================================ */
const G = { on: false, mod: null, cat: "mixed", cur: null, score: {}, last: {}, chalIdx: {}, physOrder: {} };
const panel = $("gqPanel");
function api(mod) {
  if (mod === "ct") return { apply: p => CTX().ctApply(p), defaults: () => CTX().ctApply({ region: "chest" }) };
  if (mod === "xr") return { apply: p => CTX().xrApply(p), defaults: () => CTX().xrApply({}) };
  return { apply: p => { const U = USX(); Object.assign(U.US, U.defaults(), p.scene ? { scene: p.scene } : {}); if (p.scene) U.setScene(p.scene); Object.assign(U.US, p); U.changed(); }, defaults: () => { const U = USX(); Object.assign(U.US, U.defaults()); U.setScene("abdomen"); U.changed(); } };
}
function sc() { return G.score[G.mod] || (G.score[G.mod] = { c: 0, t: 0, s: 0 }); }
function updateScore() { const s = sc(); $("gqScore").textContent = `${BANK[G.mod].name} score ${s.c} / ${s.t}${s.s > 1 ? ` · streak ${s.s}` : ""}`; }
function hide(on) { document.body.classList.toggle("gqhide", on); }
function feedback(html, good) {
  const fb = $("gqFeedback");
  fb.innerHTML = (good === true ? '<b class="good">Correct.</b> ' : good === false ? '<b class="bad">Not quite.</b> ' : "") + html;
  fb.classList.add("show");
}
function next() {
  const B = BANK[G.mod];
  const cat = G.cat === "mixed" ? pick(["identify", "identify", "chal", "phys", "phys"]) : G.cat;
  let q;
  if (cat === "identify") {
    let it; do { it = pick(B.identify); } while (B.identify.length > 1 && it === G.last[G.mod]);
    G.last[G.mod] = it;
    const opts = shuffle([it.ans, ...shuffle(B.choices.filter(c => c !== it.ans)).slice(0, 3)]);
    q = { type: "identify", text: `<small>Identify</small>What does this image show${G.mod === "us" ? " at the yellow arrow" : ""}?`, opts, correct: opts.indexOf(it.ans), why: it.why, state: it.st() };
  } else if (cat === "chal") {
    G.chalIdx[G.mod] = ((G.chalIdx[G.mod] ?? -1) + 1) % B.challenges.length;
    const c = B.challenges[G.chalIdx[G.mod]];
    q = { type: "chal", c, text: `<small>Challenge ${G.chalIdx[G.mod] + 1} of ${B.challenges.length} · ${c.title}</small>${c.goal}`, state: c.st };
  } else {
    const ord = G.physOrder[G.mod] && G.physOrder[G.mod].length ? G.physOrder[G.mod] : (G.physOrder[G.mod] = shuffle(B.physics.map((_, i) => i)));
    const it = B.physics[ord.pop()], order = shuffle(it.a.map((_, i) => i));
    q = { type: "phys", text: `<small>Physics</small>${it.q}`, opts: order.map(i => it.a[i]), correct: order.indexOf(0), why: it.why };
  }
  G.cur = q; q.done = false;
  $("gqText").innerHTML = q.text;
  $("gqFeedback").className = ""; $("gqFeedback").innerHTML = "";
  $("gqSolve").style.display = q.type === "chal" ? "" : "none";
  const body = $("gqBody"); body.innerHTML = "";
  if (q.type === "chal") {
    const ul = document.createElement("ul"); ul.className = "qchecks"; ul.id = "gqChecks";
    q.c.checks.forEach(ch => { const li = document.createElement("li"); li.innerHTML = `<span>${ch[0]}</span><span class="now"></span>`; ul.appendChild(li); });
    body.appendChild(ul);
  } else {
    const box = document.createElement("div"); box.className = "qopts";
    q.opts.forEach((o, i) => { const b = document.createElement("button"); b.textContent = o; b.addEventListener("click", () => answer(i)); box.appendChild(b); });
    body.appendChild(box);
  }
  hide(q.type === "identify");
  if (G.mod === "us") USX().US.marker = null;
  if (q.state) api(G.mod).apply(q.state);
}
function answer(i) {
  const q = G.cur; if (!q || q.done) return;
  q.done = true;
  document.querySelectorAll("#gqBody .qopts button").forEach((b, j) => { b.disabled = true; if (j === q.correct) b.classList.add("right"); else if (j === i) b.classList.add("wrong"); });
  const ok = i === q.correct, s = sc();
  s.t++; if (ok) { s.c++; s.s++; } else s.s = 0;
  updateScore(); hide(false);
  feedback(q.why, ok);
}
function onRender(e) {
  const q = G.cur;
  if (!G.on || e.detail !== G.mod || !q || q.type !== "chal") return;
  const lis = document.querySelectorAll("#gqChecks li");
  let all = true;
  q.c.checks.forEach((ch, i) => {
    let ok = false; try { ok = !!ch[1](); } catch (err) { ok = false; }
    all = all && ok;
    if (lis[i]) { lis[i].classList.toggle("ok", ok); try { lis[i].querySelector(".now").textContent = ch[2] ? ch[2]() : ""; } catch (err) {} }
  });
  if (all && !q.done) { q.done = true; if (!q.gaveUp) { const s = sc(); s.t++; s.c++; s.s++; updateScore(); feedback(q.c.why, true); } }
}
window.addEventListener("modrender", onRender);
$("gqNext").addEventListener("click", next);
$("gqSolve").addEventListener("click", () => {
  const q = G.cur; if (!q || q.type !== "chal") return;
  if (!q.done && !q.gaveUp) { q.gaveUp = true; const s = sc(); s.t++; s.s = 0; updateScore(); }
  const st = Object.assign({}, q.c.st, q.c.sol);
  api(G.mod).apply(st);
  feedback("<b>Solution applied.</b> " + q.c.why);
});
document.querySelectorAll("#gqCat button").forEach(b => b.addEventListener("click", () => {
  G.cat = b.dataset.v;
  document.querySelectorAll("#gqCat button").forEach(x => x.classList.toggle("on", x === b));
  if (G.cat === "chal") G.chalIdx[G.mod] = -1;
  next();
}));
function start(mod) {
  G.on = true; G.mod = mod;
  const center = document.querySelector(`#mod-${mod} .center`);
  center.insertBefore(panel, center.firstChild);
  panel.style.display = "block";
  document.body.classList.add("gquiz");
  $("quizBtn").textContent = "Exit quiz";
  updateScore();
  window.scrollTo({ top: 0, behavior: "smooth" });
  next();
}
function stop() {
  if (!G.on) return;
  G.on = false; G.cur = null; hide(false);
  panel.style.display = "none";
  document.body.classList.remove("gquiz");
  $("quizBtn").textContent = "Quiz mode";
  if (G.mod === "us") { USX().US.marker = null; }
  api(G.mod).defaults();
}
$("quizBtn").addEventListener("click", () => {
  const mod = document.body.dataset.mod;
  if (mod === "mri") return;
  if (G.on) stop(); else start(mod);
});
document.querySelectorAll("#modality button").forEach(b => b.addEventListener("click", () => { if (G.on && b.dataset.v !== G.mod) stop(); }));
window.QUIZ2 = { G, BANK, start, stop, next };
})();
