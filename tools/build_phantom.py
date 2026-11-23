"""Build the simulator's tissue-fraction phantom from the ICBM152 2009c template.

Inputs: TemplateFlow tpl-MNI152NLin2009cAsym res-01 T1w, T2w and GM/WM/CSF probseg.
Output: phantom.b64.txt (base64 of gzip) (uint8 fractions) and phantom.json (layout).
Usage: python build_phantom.py <template_dir> <out_dir>
"""
import sys, json, gzip
import numpy as np, nibabel as nb
from scipy import ndimage as ndi

src, out = sys.argv[1], sys.argv[2]
ld = lambda k: nb.load(f"{src}/tpl_res-01_{k}.nii.gz").get_fdata().astype(np.float32)
t1, t2 = ld("T1w"), ld("T2w")
gm, wm, csf = ld("label-GM_probseg"), ld("label-WM_probseg"), ld("label-CSF_probseg")
s = gm + wm + csf
over = s > 1
gm[over] /= s[over]; wm[over] /= s[over]; csf[over] /= s[over]
brain = np.clip(gm + wm + csf, 0, 1)

t1n = t1 / np.median(t1[wm > 0.95])
t2n = t2 / np.median(t2[csf > 0.95])

# head mask: threshold, close, fill holes slice by slice
head = t1n > 0.12
head = ndi.binary_closing(head, iterations=3)
for k in range(head.shape[2]):
    head[:, :, k] = ndi.binary_fill_holes(head[:, :, k])
head = ndi.binary_opening(head, iterations=1)

ss = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))
rest = np.clip(1 - brain, 0, 1) * head
# soft memberships for non-brain tissue, from the template's T1w/T2w intensities
fl = ss(0.55, 0.80, t2n) * (1 - ss(0.50, 0.75, t1n))             # vitreous, extracerebral fluid
dk = (1 - ss(0.16, 0.36, t1n)) * (1 - ss(0.30, 0.50, t2n))       # bone / air: dark on both
ft = ss(0.50, 0.72, t1n) * ss(0.13, 0.26, t2n) * (1 - fl)        # fat: bright T1, not dark T2
mu = np.clip(1 - fl - dk - ft, 0.05, 1)                          # muscle / skin / other soft tissue
tot = fl + dk + ft + mu
fluid, bone, fat, musc = (rest * v / tot for v in (fl, dk, ft, mu))
csf = csf + fluid

chans = {"gm": gm, "wm": wm, "csf": csf, "fat": fat, "bone": bone, "musc": musc}
# radiological display: column = patient right->left (x from + to -), row = anterior->posterior
dz, z_lo, z_hi = 3, -48, 78   # slab centres in MNI mm
origin = np.array([-96.0, -132.0, -78.0])
slabs = list(range(z_lo, z_hi + 1, dz))
W, H = t1.shape[0], t1.shape[1]
buf = bytearray()
for zc in slabs:
    ks = [int(round(zc + d - origin[2])) for d in (-1, 0, 1)]
    for name in chans:
        a = np.mean([chans[name][:, :, k] for k in ks], axis=0)   # (x, y)
        img = a[::-1, ::-1].T                                     # rows: y desc, cols: x desc
        buf += np.round(np.clip(img, 0, 1) * 255).astype(np.uint8).tobytes()
meta = {
    "w": W, "h": H, "channels": list(chans), "slabs": slabs, "dz": dz,
    "x_left": float(origin[0] + W - 1), "y_top": float(origin[1] + H - 1), "mm": 1.0,
    "source": "ICBM 152 Nonlinear Asymmetric 2009c (TemplateFlow tpl-MNI152NLin2009cAsym)",
}
import base64
open(f"{out}/phantom.b64.txt", "w").write(base64.b64encode(gzip.compress(bytes(buf), 9)).decode())
json.dump(meta, open(f"{out}/phantom.json", "w"))
print(len(buf), "raw bytes", len(slabs), "slabs")
