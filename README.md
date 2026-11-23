# Radiology Physics Simulator

An interactive teaching app that shows how acquisition parameters change MRI, CT and X-ray images. Every image is recalculated live in the browser from real anatomy, so a change to TR, kVp, mAs or any other setting shows its effect immediately.

## Modalities

**MRI.** An axial head built from the ICBM152 template, with a slice slider.
- Sequences: spin echo, FSE, inversion recovery (FLAIR, STIR, PSIR), spoiled GRE, at 1.5T or 3T.
- Parameters: TR, TE, TI, flip angle, ETL, NEX, matrix, FOV, slice thickness, bandwidth, phase direction.
- Options: fat saturation, gadolinium, MS or tumor pathology.
- Artifacts: Gibbs ringing, wraparound, chemical shift, motion, Rician noise.
- Live T1-recovery and T2-decay plots (zoomable), a tissue signal table and a k-space viewer. The k-space viewer offers partial Fourier, ×2 undersampling, center/edge reconstruction and click-to-add spikes.
- Quiz mode with three question types: name the sequence, hands-on challenges, physics multiple choice.

**CT.** Chest (contrast) and head (non-contrast) from real patient CTs, reconstructed live: polychromatic projections → photon noise → filtered backprojection.
- Parameters: kVp, mAs, pitch, slice thickness, kernel, FBP or iterative, number of views, display FOV, beam-hardening mode.
- Artifacts: metal streaks, ring, motion, view aliasing, photon starvation.
- Readouts: window presets, HU and ROI mean ± SD on hover, sinogram viewer, CT numbers vs kVp, CTDIvol, DLP and effective dose.

**X-ray.** Chest PA, AP portable and lateral, projected through the chest CT with divergent-beam magnification.
- Parameters: kVp, mAs, SID, focal spot, grid, collimation, patient motion, pacemaker.
- Image receptor: digital processing or screen-film.
- Readouts: exposure index and deviation index, entrance dose, effective dose, spectrum plot, scatter and magnification.

## Running it

It is a static site with no build step. The page loads its data files with `fetch`, so serve the folder over HTTP rather than opening `index.html` directly:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Any static host works (GitHub Pages, Netlify, etc.).

## Files

| File | What it is |
|---|---|
| `index.html` | Page, styles and the MRI simulator |
| `ctxr.js` | CT and X-ray simulators |
| `phantom.json`, `phantom.b64.txt` | MRI tissue fractions (GM, WM, CSF, fat, bone, muscle) in 3 mm axial slabs |
| `chest_ct.json`, `chest_ct.b64.txt` | Chest CT in HU (int16), 1.64 × 1.64 × 2 mm |
| `head_ct.json`, `head_ct.b64.txt` | Head CT in HU (int16), 0.86 × 0.86 × 2.5 mm |
| `tools/build_phantom.py` | Builds the MRI phantom from the ICBM152 template |
| `tools/build_ct.py` | Builds the CT volumes from the source DICOM series (removes the table, denoises, downsamples) |

The `.b64.txt` files hold base64-encoded gzip data. Base64 is used so the files can be served by hosts that refuse binary or archive types.

## Rebuilding the data

```bash
pip install -r tools/requirements.txt
```

MRI anatomy (TemplateFlow, MNI152NLin2009cAsym, 1 mm): download `tpl-MNI152NLin2009cAsym_res-01_{T1w,T2w,label-CSF_probseg,label-GM_probseg,label-WM_probseg}.nii.gz` from `https://templateflow.s3.amazonaws.com/tpl-MNI152NLin2009cAsym/` into one folder, renaming each to `tpl_res-01_<suffix>.nii.gz`. Then run:

```bash
python tools/build_phantom.py <template_dir> .
```

CT data (NCI Imaging Data Commons):

```bash
python -c "from idc_index import IDCClient; IDCClient().download_from_selection(seriesInstanceUID=['61.7.165782612538761479349524122796947298715','1.3.6.1.4.1.14519.5.2.1.1620.1226.263763416609144989966623786783'], downloadDir='data_raw', dirTemplate='%PatientID')"
```

```bash
python tools/build_ct.py data_raw/MED_LYMPH_054 data_raw/EAY131-368292 .
```

## Data sources and credits

- **MRI anatomy:** ICBM 152 Nonlinear Asymmetric 2009c template (Fonov et al., NeuroImage 2011; Fonov et al., NeuroImage 2009), via TemplateFlow. Copyright (C) 1993–2004 Louis Collins, McConnell Brain Imaging Centre, Montreal Neurological Institute, McGill University. Permission to use, copy, modify, and distribute this software and its documentation for any purpose and without fee is hereby granted, provided that the above copyright notice appear in all copies. The authors and McGill University make no representations about the suitability of this software for any purpose. It is provided "as is" without express or implied warranty.
- **Chest CT:** The Cancer Imaging Archive, CT Lymph Nodes collection, case MED_LYMPH_054 (Roth HR et al., MICCAI 2014; Seff A et al., MICCAI 2015; doi:10.7937/K9/TCIA.2015.AQIIDCNM). CC BY 3.0.
- **Head CT:** The Cancer Imaging Archive, NCI-MATCH EAY131 collection, case EAY131-368292. CC BY 4.0.
- TCIA: Clark K et al., "The Cancer Imaging Archive (TCIA): Maintaining and Operating a Public Information Repository", J Digit Imaging 2013. Data accessed through the NCI Imaging Data Commons.

The CT data was downsampled, denoised and stripped of the scanner table. Lesions and implants in the app are simulated.

## Limitations

This app is a teaching model, not a scanner simulation.
- **MRI:** uses closed-form signal equations, so FSE blurring, magnetization transfer, B1 effects, flow and susceptibility are not modeled.
- **CT:** uses a parallel beam, and "iterative" is an edge-preserving denoising stand-in.
- **X-ray:** scatter is an analytic approximation. The chest CT patient had their arms raised.
- **Dose:** values are typical figures for illustration.

For education only. Not for clinical use.
