#!/usr/bin/env python3
"""
convert_ct.py — DICOM series → numbered PNG slices
====================================================
Usage:
  1. Download a LIDC-IDRI lung CT series from The Cancer Imaging Archive
     (cancerimagingarchive.net) in DICOM format.
  2. Place all .dcm files in a single directory.
  3. Run:
       pip install pydicom Pillow numpy
       python assets/convert_ct.py /path/to/dicom_dir assets/ct_slices/

Output: zero-padded PNG files — 001.png, 002.png, … NNN.png
Update CT_TOTAL_SLICES in app/orion_orchestrator/tools.py and CTViewer config
in app/static/js/ct-viewer.js after running this script.
"""

import argparse
import sys
from pathlib import Path

try:
    import pydicom
    import numpy as np
    from PIL import Image
except ImportError:
    print("ERROR: missing dependencies. Run: pip install pydicom Pillow numpy")
    sys.exit(1)


def window_image(pixel_array: np.ndarray, window_center: int, window_width: int) -> np.ndarray:
    """Apply CT windowing (window/level) to map HU values to 0-255."""
    lower = window_center - window_width // 2
    upper = window_center + window_width // 2
    windowed = np.clip(pixel_array, lower, upper)
    windowed = ((windowed - lower) / (upper - lower) * 255).astype(np.uint8)
    return windowed


def load_dicom_series(dicom_dir: Path) -> list:
    """Load and sort all DICOM slices in a directory by SliceLocation."""
    dcm_files = sorted(dicom_dir.glob('*.dcm'))
    if not dcm_files:
        dcm_files = sorted(dicom_dir.glob('*.DCM'))
    if not dcm_files:
        print(f"ERROR: No .dcm files found in {dicom_dir}")
        sys.exit(1)

    print(f"Found {len(dcm_files)} DICOM files.")

    slices = []
    for f in dcm_files:
        try:
            ds = pydicom.dcmread(str(f))
            slices.append(ds)
        except Exception as e:
            print(f"  Skipping {f.name}: {e}")

    # Sort by SliceLocation (z-axis position); fall back to InstanceNumber
    try:
        slices.sort(key=lambda s: float(s.SliceLocation))
    except AttributeError:
        try:
            slices.sort(key=lambda s: int(s.InstanceNumber))
        except AttributeError:
            print("WARNING: Could not sort slices. Using file order.")

    return slices


def convert(dicom_dir: Path, output_dir: Path,
            window_center: int = -600, window_width: int = 1500):
    """
    Convert all DICOM slices to PNG.

    Default windowing: lung window (WC=-600, WW=1500) — ideal for lung parenchyma.
    Adjust if your CT dataset uses different scout parameters.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    slices = load_dicom_series(dicom_dir)
    total = len(slices)
    print(f"Converting {total} slices with lung window (WC={window_center}, WW={window_width})")

    for i, ds in enumerate(slices, start=1):
        try:
            # Apply rescale slope/intercept to get Hounsfield Units
            pixel_array = ds.pixel_array.astype(np.float32)
            if hasattr(ds, 'RescaleSlope'):
                pixel_array = pixel_array * float(ds.RescaleSlope) + float(ds.RescaleIntercept)

            # Apply windowing
            windowed = window_image(pixel_array, window_center, window_width)

            # Save as PNG — zero-padded filename
            out_path = output_dir / f"{i:03d}.png"
            Image.fromarray(windowed).save(str(out_path))

            if i % 50 == 0 or i == total:
                print(f"  {i}/{total} → {out_path.name}")

        except Exception as e:
            print(f"  ERROR on slice {i}: {e}")

    print(f"\nDone. {total} PNGs written to {output_dir}")
    print(f"\nNEXT STEP: Update CT_TOTAL_SLICES = {total} in:")
    print("  app/orion_orchestrator/tools.py")
    print("  app/static/js/app.js  (CONFIG.ctTotalSlices)")
    print("\nAlso inspect the slices and update CT_LANDMARKS slice numbers")
    print("in tools.py to match anatomical positions in this dataset.")


def main():
    parser = argparse.ArgumentParser(description='Convert DICOM CT series to PNG slices')
    parser.add_argument('dicom_dir', type=Path, help='Directory containing .dcm files')
    parser.add_argument('output_dir', type=Path, nargs='?',
                        default=Path('assets/ct_slices'),
                        help='Output directory for PNG files (default: assets/ct_slices/)')
    parser.add_argument('--wc', type=int, default=-600,
                        help='Window center in HU (default: -600, lung window)')
    parser.add_argument('--ww', type=int, default=1500,
                        help='Window width in HU (default: 1500, lung window)')
    args = parser.parse_args()

    if not args.dicom_dir.is_dir():
        print(f"ERROR: {args.dicom_dir} is not a directory")
        sys.exit(1)

    convert(args.dicom_dir, args.output_dir, args.wc, args.ww)


if __name__ == '__main__':
    main()
