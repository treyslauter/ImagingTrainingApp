"""Build the CT/X-ray phantoms (HU volumes) for the simulator.

Chest: TCIA CT Lymph Nodes, MED_LYMPH_054 (contrast-enhanced chest CT, CC BY 3.0).
Head:  TCIA EAY131 (NCI-MATCH), EAY131-368292 THIN_BONE (non-contrast head CT, CC BY 4.0).
Both downloaded from the NCI Imaging Data Commons with idc-index.

Usage: python build_ct.py <chest_dicom_dir> <head_dicom_dir> <out_dir>
Output: chest_ct.json/.b64.txt, head_ct.json/.b64.txt (base64 of gzip of int16 HU, z-major).
"""
import sys, glob, json, gzip, base64
import numpy as np, pydicom
from scipy import ndimage as ndi

def load(d):
    ds = [pydicom.dcmread(f) for f in glob.glob(f"{d}/**/*.dcm", recursive=True)]
    ds.sort(key=lambda x: float(x.ImagePositionPatient[2]))
    v = np.stack([x.pixel_array * float(x.RescaleSlope) + float(x.RescaleIntercept) for x in ds]).astype(np.float32)
    dz = abs(float(ds[1].ImagePositionPatient[2]) - float(ds[0].ImagePositionPatient[2]))
    return v, float(ds[0].PixelSpacing[0]), dz

def body_mask(v, thr=-400, open_it=3):
    m = v > thr
    m = ndi.binary_opening(m, iterations=open_it)          # detach table / head holder
    lab, n = ndi.label(m)
    if n > 1:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = lab == (1 + int(np.argmax(sizes)))
    m = ndi.binary_dilation(m, iterations=open_it + 1)
    for k in range(m.shape[0]):
        m[k] = ndi.binary_fill_holes(m[k])
    return m

def block_mean(v, fz, fy, fx):
    Z, Y, X = (s // f for s, f in zip(v.shape, (fz, fy, fx)))
    v = v[:Z * fz, :Y * fy, :X * fx]
    return v.reshape(Z, fz, Y, fy, X, fx).mean(axis=(1, 3, 5))

def crop(v, mask, pad=4):
    idx = np.where(mask)
    lo = [max(0, int(i.min()) - pad) for i in idx]; hi = [int(i.max()) + pad + 1 for i in idx]
    return v[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]], lo

def smooth_soft(v, sigma):
    """Denoise soft tissue without blurring bone into it: smooth a bone-clipped copy, use it where tissue is soft."""
    clipped = np.clip(v, -1024, 150)
    sm = ndi.gaussian_filter(clipped, sigma)
    soft = (v > -200) & (v < 150) & (ndi.maximum_filter(v, 3) < 250)
    out = v.copy(); out[soft] = sm[soft]
    return out

def write(name, v, px, dz, info, out):
    v = np.clip(np.round(v), -1024, 3071).astype("<i2")
    meta = {"nz": v.shape[0], "ny": v.shape[1], "nx": v.shape[2], "px": px, "dz": dz, **info}
    open(f"{out}/{name}.b64.txt", "w").write(base64.b64encode(gzip.compress(v.tobytes(), 9)).decode())
    json.dump(meta, open(f"{out}/{name}.json", "w"))
    print(name, v.shape, f"px {px:.3f} dz {dz:.2f}", len(open(f"{out}/{name}.b64.txt").read()) // 1024, "KB b64")

chest_dir, head_dir, out = sys.argv[1:4]

# ---- chest ----
v, px, dz = load(chest_dir)                      # (z inf->sup, rows A->P, cols R->L)
m = body_mask(v)
v[~m] = -1024
v = block_mean(v, 2, 2, 2); m = block_mean(m.astype(np.float32), 2, 2, 2) > 0.5
v = smooth_soft(v, 0.7)
v, lo = crop(v, m)
write("chest_ct", v, px * 2, dz * 2, {
    "region": "chest", "source": "TCIA CT Lymph Nodes, MED_LYMPH_054 (CC BY 3.0)", "contrast": True}, out)

# ---- head ----
v, px, dz = load(head_dir)
m = body_mask(v, thr=-300, open_it=2)
v[~m] = -1024
v = block_mean(v, 2, 2, 2); m = block_mean(m.astype(np.float32), 2, 2, 2) > 0.5
v = smooth_soft(ndi.median_filter(v, size=(1, 3, 3)), 1.5)
v, lo = crop(v, m)
write("head_ct", v, px * 2, dz * 2, {
    "region": "head", "source": "TCIA EAY131 (NCI-MATCH), EAY131-368292 (CC BY 4.0)", "contrast": False, "gantry_tilt_deg": 16}, out)
