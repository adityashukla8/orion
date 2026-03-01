#!/usr/bin/env python3
"""
generate_3d_model.py — LIDC-IDRI-0001 DICOM → GLB lung anatomy model
======================================================================
Generates a multi-mesh GLB from the raw DICOM CT series using the
LUNA16-validated lung segmentation pipeline:

  lung_right  — right lung parenchyma (patient-right)
  lung_left   — left lung parenchyma  (patient-left)
  tumor       — the LIDC-IDRI-0001 right-lower-lobe nodule (~8mm)
  bronchus    — main carina / bronchi region

Mesh names are logged to the browser console by anatomy-3d.js after load.
Use them to update toggle_structure in app/orion_orchestrator/tools.py.

Usage (from project root, orion conda env active):
  conda activate orion
  python assets/generate_3d_model.py
"""

import sys
from pathlib import Path

import numpy as np
import pydicom
import scipy.ndimage as ndi
from skimage import measure
from skimage.segmentation import clear_border
import trimesh

# ── Config ──────────────────────────────────────────────────────────────────

DICOM_DIR  = Path(__file__).parent / 'dicom_raw'
OUTPUT_GLB = Path(__file__).parent / 'lung_model.glb'

# HU thresholds (LUNA16-validated values)
HU_LUNG_THRESHOLD = -320   # everything below = lung / air

# Nodule search: solid tissue inside the lung at the known level
NODULE_SLICE_RANGE = (20, 50)   # 0-based slice indices (covers PNG slice 29)
NODULE_HU_MIN      = -150
NODULE_HU_MAX      =  200
NODULE_AREA_MIN    =  50        # voxels at 0.703mm resolution
NODULE_AREA_MAX    = 5_000

# Target isotropic spacing for mesh generation (matches CT slice spacing)
ISO_MM = 2.5

# Marching-cubes step_size — bigger = coarser mesh, smaller file
STEP_LUNG   = 2
STEP_BRONCH = 2
STEP_TUMOR  = 1

# Mesh RGBA colours  (R, G, B, A)  0–255
COL_RIGHT  = [215, 145, 130, 210]   # warm salmon – right lung
COL_LEFT   = [190, 135, 165, 210]   # dusty mauve – left lung
COL_TUMOR  = [220,  50,  50, 245]   # red – nodule
COL_BRONCH = [160, 210, 240, 220]   # pale blue – bronchi


# ── DICOM loading ─────────────────────────────────────────────────────────

def load_volume(dicom_dir: Path):
    """Return (hu_vol [n,H,W], spacing_dz_dy_dx tuple in mm)."""
    dcm_files = sorted(dicom_dir.glob('*.dcm'))
    if not dcm_files:
        print(f"ERROR: no .dcm files in {dicom_dir}"); sys.exit(1)

    print(f"Loading {len(dcm_files)} DICOM files…")
    slices = [pydicom.dcmread(str(f)) for f in dcm_files]
    try:
        slices.sort(key=lambda s: float(s.SliceLocation))
    except AttributeError:
        slices.sort(key=lambda s: int(s.InstanceNumber))

    hu_slices = []
    for ds in slices:
        arr   = ds.pixel_array.astype(np.float32)
        slope = float(getattr(ds, 'RescaleSlope',     1))
        inter = float(getattr(ds, 'RescaleIntercept', -1024))
        hu_slices.append(arr * slope + inter)

    vol = np.stack(hu_slices, axis=0)             # (n, H, W)
    dz  = float(getattr(slices[0], 'SliceThickness', 2.5))
    dy, dx = [float(v) for v in slices[0].PixelSpacing]
    print(f"Shape: {vol.shape}  HU: [{vol.min():.0f}, {vol.max():.0f}]")
    print(f"Spacing: dz={dz}mm  dy={dy}mm  dx={dx}mm")
    return vol, (dz, dy, dx)


# ── Segmentation (full-resolution) ─────────────────────────────────────────

def segment_lungs_full_res(hu_vol):
    """
    LUNA16-validated lung segmentation using clear_border per axial slice.

    clear_border removes objects touching the image edge (= outside-scan air
    at -1024 HU that otherwise confuses fill_holes).  The surviving interior
    air regions are the lung parenchyma.

    Returns uint8 (n,H,W): 0=background  1=lung_right  2=lung_left.
    """
    print("Segmenting lungs (LUNA16 clear_border pipeline)…")
    n, H, W = hu_vol.shape

    binary = hu_vol < HU_LUNG_THRESHOLD
    lung3d = np.zeros(binary.shape, dtype=bool)

    for i in range(n):
        cleared  = clear_border(binary[i])
        labelled = measure.label(cleared)
        for p in measure.regionprops(labelled):
            if p.area > 500:                              # skip tiny specs
                lung3d[i] |= ndi.binary_fill_holes(labelled == p.label)

    # 3-D label — both lungs usually form one fused component
    labelled3d = measure.label(lung3d)
    props = measure.regionprops(labelled3d)
    props.sort(key=lambda p: p.area, reverse=True)
    main = (labelled3d == props[0].label)

    # Split left / right at the sagittal midplane detected from the x-profile
    x_profile = main.sum(axis=(0, 1))
    center     = x_profile[W // 4 : 3 * W // 4]
    split_x    = int(np.argmin(center)) + W // 4
    print(f"  mediastinal split at x={split_x}  (image centre={W//2})")

    xs  = np.arange(W)
    out = np.zeros((n, H, W), dtype=np.uint8)
    # Patient right → smaller x in standard DICOM axial view
    out[main & (xs[np.newaxis, np.newaxis, :] <  split_x)] = 1   # lung_right
    out[main & (xs[np.newaxis, np.newaxis, :] >= split_x)] = 2   # lung_left

    for v in [1, 2]:
        print(f"  lung {v}: {(out == v).sum():,} voxels")
    return out


def find_nodule_full_res(hu_vol, lung_mask, spacing):
    """
    Find the LIDC-IDRI-0001 right-lower-lobe nodule at full DICOM resolution.

    Returns (centroid_mm_xyz, radius_mm) or None.
    centroid_mm_xyz is in physical space (mm) aligned to GLTF/Three.js axes.
    """
    print("Searching for nodule (full resolution)…")
    dz, dy, dx = spacing
    z0, z1 = NODULE_SLICE_RANGE

    # Slightly dilate lung mask so nodule at the surface is included
    lung_dilated = ndi.binary_dilation(lung_mask > 0, iterations=5)

    # Candidate: solid tissue inside dilated lung in the search z-range
    search_vol = np.zeros_like(hu_vol, dtype=bool)
    search_vol[z0:z1] = (
        lung_dilated[z0:z1] &
        (hu_vol[z0:z1] >= NODULE_HU_MIN) &
        (hu_vol[z0:z1] <= NODULE_HU_MAX)
    )

    labelled = measure.label(search_vol)
    props    = measure.regionprops(labelled)
    candidates = [p for p in props
                  if NODULE_AREA_MIN < p.area < NODULE_AREA_MAX]
    candidates.sort(key=lambda p: p.area, reverse=True)

    if not candidates:
        print("  WARNING: no nodule found"); return None

    best = candidates[0]
    cz, cy, cx = best.centroid
    radius_mm = np.cbrt(best.area * dx * dy * dz * 3 / (4 * np.pi))
    print(f"  nodule: area={best.area} vox  slice {int(cz)+1}  "
          f"centroid ({cx:.0f},{cy:.0f})  radius≈{radius_mm:.1f}mm")

    # Physical coordinates remapped to Three.js (x,z,y) — same as mask_to_mesh axis remap
    return (cx * dx, cz * dz, cy * dy), radius_mm


def segment_bronchus_full_res(hu_vol, lung_mask):
    """
    Approximate carina / main bronchi: air in the mediastinal gap between
    the two lungs, restricted to the carina-level z-range (slices 55–85).
    """
    print("Segmenting bronchus region…")
    n, H, W = hu_vol.shape

    # Find mediastinal x-range (gap between the two lungs)
    right_x = np.where((lung_mask == 1).any(axis=(0, 1)))[0]
    left_x  = np.where((lung_mask == 2).any(axis=(0, 1)))[0]
    if not right_x.size or not left_x.size:
        print("  WARNING: cannot determine mediastinum bounds"); return None

    med_lo = max(int(right_x.max()) - 10, 0)
    med_hi = min(int(left_x.min()) + 10, W)
    z_lo   = max(0,  55)
    z_hi   = min(n, 85)
    print(f"  mediastinal x=[{med_lo},{med_hi}]  z=[{z_lo},{z_hi}]")

    # Air in the mediastinum = airways (bronchi)
    air_med = (
        (hu_vol < HU_LUNG_THRESHOLD) &
        np.isin(
            np.arange(W)[np.newaxis, np.newaxis, :] >= med_lo,  # dummy; use mask below
            [True]
        )
    )
    # Proper x+z masking
    x_ok = (np.arange(W) >= med_lo) & (np.arange(W) <= med_hi)
    z_ok = np.zeros(n, dtype=bool); z_ok[z_lo:z_hi] = True

    roi = (
        hu_vol < HU_LUNG_THRESHOLD
    ) & x_ok[np.newaxis, np.newaxis, :] & z_ok[:, np.newaxis, np.newaxis]

    labelled = measure.label(roi)
    props    = measure.regionprops(labelled)
    if not props:
        print("  WARNING: no bronchus component found"); return None
    props.sort(key=lambda p: p.area, reverse=True)
    bronch = ndi.binary_closing(labelled == props[0].label, iterations=2)
    print(f"  bronchus voxels: {bronch.sum():,}")
    return bronch


# ── Resampling ─────────────────────────────────────────────────────────────

def resample_mask_isotropic(mask, spacing, target_mm=ISO_MM):
    dz, dy, dx = spacing
    zoom = (dz / target_mm, dy / target_mm, dx / target_mm)
    return ndi.zoom(mask.astype(np.float32), zoom, order=0) > 0.5


# ── Mesh generation ────────────────────────────────────────────────────────

def mask_to_mesh(binary_mask, iso_spacing, colour, step=1):
    """
    Marching cubes on a boolean mask → trimesh with GLTF-compatible axes.
    Vertices are in physical mm from the volume origin (NOT pre-centred)
    so that mask meshes and the nodule sphere share the same coordinate space
    and can be globally centred together in main().
    """
    smoothed = ndi.gaussian_filter(binary_mask.astype(np.float32), sigma=0.8)
    verts, faces, _, _ = measure.marching_cubes(
        smoothed, level=0.5, spacing=iso_spacing,
        step_size=step, allow_degenerate=False,
    )
    # DICOM (z, y, x) → Three.js (x, z, y)  i.e. column [2,0,1]
    verts = verts[:, [2, 0, 1]]
    mesh  = trimesh.Trimesh(vertices=verts, faces=faces, process=True)
    colours = np.tile(colour, (len(mesh.vertices), 1)).astype(np.uint8)
    mesh.visual = trimesh.visual.ColorVisuals(vertex_colors=colours)
    return mesh


def nodule_sphere_mesh(centroid_phys, radius_mm):
    """
    Sphere at the physical nodule centroid in the same coordinate space
    as mask_to_mesh (DICOM mm, axes already remapped to Three.js).
    centroid_phys: (x_mm, y_mm, z_mm) already axis-remapped.
    """
    sphere = trimesh.creation.icosphere(subdivisions=3, radius=max(radius_mm, 5.0))
    sphere.apply_translation(centroid_phys)
    colours = np.tile(COL_TUMOR, (len(sphere.vertices), 1)).astype(np.uint8)
    sphere.visual = trimesh.visual.ColorVisuals(vertex_colors=colours)
    return sphere


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    if not DICOM_DIR.exists():
        print(f"ERROR: {DICOM_DIR} not found"); sys.exit(1)

    # 1. Load
    hu_vol, spacing = load_volume(DICOM_DIR)

    # 2. Full-resolution segmentation (preserves small nodule detail)
    lung_full = segment_lungs_full_res(hu_vol)
    nodule    = find_nodule_full_res(hu_vol, lung_full, spacing)
    bronch_fr = segment_bronchus_full_res(hu_vol, lung_full)

    # 3. Resample masks to isotropic 2.5mm for mesh generation
    print(f"Resampling masks to {ISO_MM}mm isotropic…")
    iso_sp   = (ISO_MM,) * 3
    r_right  = resample_mask_isotropic(lung_full == 1, spacing)
    r_left   = resample_mask_isotropic(lung_full == 2, spacing)
    r_bronch = resample_mask_isotropic(bronch_fr,  spacing) if bronch_fr is not None else None

    # 4. Build scene
    scene  = trimesh.Scene()
    meshes = {}

    for name, mask, colour, step in [
        ('lung_right', r_right, COL_RIGHT, STEP_LUNG),
        ('lung_left',  r_left,  COL_LEFT,  STEP_LUNG),
    ]:
        if not mask.any():
            print(f"  SKIP {name}: empty mask"); continue
        print(f"Building {name} mesh…")
        m = mask_to_mesh(mask, iso_sp, colour, step)
        meshes[name] = m

    if r_bronch is not None and r_bronch.any():
        print("Building bronchus mesh…")
        meshes['bronchus'] = mask_to_mesh(r_bronch, iso_sp, COL_BRONCH, STEP_BRONCH)

    if nodule is not None:
        print("Building tumor mesh (sphere at nodule centroid)…")
        centroid_phys, radius_mm = nodule
        meshes['tumor'] = nodule_sphere_mesh(centroid_phys, radius_mm)

    # Centre all meshes around a common origin
    all_verts = np.vstack([m.vertices for m in meshes.values()])
    global_centroid = all_verts.mean(axis=0)
    for m in meshes.values():
        m.vertices -= global_centroid

    for name, mesh in meshes.items():
        nv, nf = len(mesh.vertices), len(mesh.faces)
        print(f"  {name:12s}  {nv:>8,} verts  {nf:>8,} faces")
        scene.add_geometry(mesh, node_name=name, geom_name=name)

    # 5. Export
    print(f"\nExporting → {OUTPUT_GLB}")
    OUTPUT_GLB.write_bytes(scene.export(file_type='glb'))
    mb = OUTPUT_GLB.stat().st_size / 1_048_576
    print(f"Done!  {OUTPUT_GLB.name}  ({mb:.1f} MB)")

    print("\n── Next steps ────────────────────────────────────────────────")
    print("Upload to GCS:")
    print("  gsutil cp assets/lung_model.glb gs://orion-assets-2026/models/lung_model.glb")
    print("  gsutil acl ch -u AllUsers:R gs://orion-assets-2026/models/lung_model.glb")
    print(f"\nMesh names for tools.py toggle_structure:")
    print(f"  {list(meshes.keys())}")


if __name__ == '__main__':
    main()
