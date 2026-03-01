"""
ORION Tool Functions
====================
All nine Python tools used by the ORION multi-agent system.

IMPORTANT: Docstrings in this file are instructions to Gemini, not
documentation for humans. They tell the LLM when and how to call each tool.
Write them as explicit natural-language-to-parameter mappings.

Return convention: every tool returns:
  {
    'status': 'success' | 'error',
    'render_command': {
        'layer': 'ct' | 'clinical' | 'ar' | 'all',
        'action': 'show' | 'hide' | 'navigate' | 'rotate' | 'toggle' | 'reset',
        ...additional params
    }
  }
"""

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

# CT navigation state — persists across multiple navigate_ct calls
_ct_state: dict = {'current_slice': 67}

# Total number of CT PNG slices.
# Dataset: LIDC-IDRI-0001, SeriesInstanceUID ending in ...179049...
# 133 slices, 2.5 mm spacing, z range: -340 mm (slice 1) to -10 mm (slice 133)
# slice_num = int((target_z - (-340)) / 2.5) + 1
CT_TOTAL_SLICES: int = 133

# Anatomical landmark → slice number mapping.
# Calibrated to LIDC-IDRI-0001 chest CT (inferior→superior ordering).
# Formula used: slice = int((z - (-340)) / 2.5) + 1
CT_LANDMARKS: dict[str, int] = {
    'diaphragm':   11,   # z ≈ -315 mm — diaphragmatic dome
    'tumor':       29,   # z ≈ -268 mm — LIDC-IDRI-0001 nodule region (lower lobe)
    'carina':      69,   # z ≈ -168 mm — tracheal bifurcation
    'bronchus':    65,   # z ≈ -178 mm — left main bronchus origin
    'aortic_arch': 81,   # z ≈ -138 mm — aortic arch at superior mediastinum
    'clavicle':   115,   # z ≈  -55 mm — clavicle level, superior chest
}

# Synthetic FHIR-compliant patient record for the demo case.
# No real clinical data. Values are plausible for a lung resection patient.
_PATIENT_DATA: dict[str, dict] = {
    'hemoglobin':  {'value': '11.2 g/dL',  'label': 'Hemoglobin',       'note': 'Low — pre-op anemia noted'},
    'creatinine':  {'value': '0.9 mg/dL',  'label': 'Creatinine',       'note': 'Normal renal function'},
    'platelets':   {'value': '210 K/μL',   'label': 'Platelets',        'note': 'Adequate for surgery'},
    'inr':         {'value': '1.1',         'label': 'INR',              'note': 'Normal coagulation'},
    'bp':          {'value': '118/74 mmHg', 'label': 'Blood Pressure',   'note': 'Last recorded 0630'},
    'weight':      {'value': '72 kg',       'label': 'Weight',           'note': ''},
    'age':         {'value': '58 years',    'label': 'Age',              'note': 'Male'},
    'diagnosis':   {'value': 'Stage II NSCLC — left upper lobe', 'label': 'Diagnosis', 'note': 'cT2N1M0'},
    'procedure':   {'value': 'VATS left upper lobectomy', 'label': 'Procedure', 'note': 'da Vinci Si'},
    'allergies':   {'value': 'Penicillin (rash), Codeine (nausea)', 'label': 'Allergies', 'note': ''},
    'medications': {'value': 'Metoprolol 25mg QD, Lisinopril 10mg QD, Aspirin 81mg QD (held)',
                   'label': 'Medications', 'note': 'Aspirin held 7 days pre-op'},
}


# ---------------------------------------------------------------------------
# IR Agent Tools — Information Retrieval (clinical data)
# ---------------------------------------------------------------------------

def display_patient_data(field: str) -> dict:
    """
    Use this tool when the surgeon asks to see, show, or display any clinical
    patient data. Valid field names are:

      hemoglobin  — blood hemoglobin level in g/dL
      creatinine  — serum creatinine in mg/dL
      platelets   — platelet count in K/μL
      inr         — international normalized ratio (coagulation)
      bp          — blood pressure in mmHg
      weight      — patient weight in kg
      age         — patient age in years
      diagnosis   — primary diagnosis and staging
      procedure   — name of the current surgical procedure
      allergies   — known drug allergies and reactions
      medications — current medication list

    Examples:
      "show me the hemoglobin" → field='hemoglobin'
      "what are the labs" → call display_patient_data for hemoglobin, then creatinine, then platelets
      "what medications is he on" → field='medications'
      "any allergies" → field='allergies'
      "what's the diagnosis" → field='diagnosis'
    """
    field = field.lower().strip()
    if field not in _PATIENT_DATA:
        return {
            'status': 'error',
            'message': f"Unknown field '{field}'. Valid fields: {', '.join(_PATIENT_DATA.keys())}",
            'render_command': {'layer': 'clinical', 'action': 'error'},
        }
    record = _PATIENT_DATA[field]
    return {
        'status': 'success',
        'field': field,
        'label': record['label'],
        'value': record['value'],
        'note': record['note'],
        'render_command': {
            'layer': 'clinical',
            'action': 'show',
            'field': field,
            'label': record['label'],
            'value': record['value'],
            'note': record['note'],
        },
    }


def hide_patient_data() -> dict:
    """
    Use this tool when the surgeon asks to hide, clear, or remove the clinical
    data display. Examples:
      "hide the labs"
      "clear the clinical data"
      "remove the patient info"
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'clinical',
            'action': 'hide',
        },
    }


# ---------------------------------------------------------------------------
# IV Agent Tools — Image Viewer (CT/MRI navigation)
# ---------------------------------------------------------------------------

def navigate_ct(direction: str, count: int = 1) -> dict:
    """
    Use this tool when the surgeon asks to move through CT scan slices.

    Direction mapping:
      'prev' — use when the surgeon says: superior, cranial, up, higher, above
      'next' — use when the surgeon says: inferior, caudal, down, lower, below

    Count mapping:
      1 (default) — a single move, "next slice", "one slice"
      3 — "a bit", "a few", "slightly"
      5 — "several", "quite a few", "a bunch"
      10 — "many", "a lot", "further"
      Surgeon can also say an explicit number: "go down 7 slices" → count=7

    Examples:
      "go up two slices" → direction='prev', count=2
      "move to the next slice" → direction='next', count=1
      "go superior a bit" → direction='prev', count=3
      "go inferior several" → direction='next', count=5
      "scroll down 10 slices" → direction='next', count=10
    """
    direction = direction.lower().strip()
    if direction not in ('prev', 'next'):
        return {
            'status': 'error',
            'message': "direction must be 'prev' or 'next'",
            'render_command': {'layer': 'ct', 'action': 'error'},
        }

    current = _ct_state['current_slice']
    if direction == 'prev':
        new_slice = max(1, current - count)
    else:
        new_slice = min(CT_TOTAL_SLICES, current + count)

    _ct_state['current_slice'] = new_slice

    return {
        'status': 'success',
        'slice': new_slice,
        'total': CT_TOTAL_SLICES,
        'render_command': {
            'layer': 'ct',
            'action': 'navigate',
            'slice': new_slice,
            'total': CT_TOTAL_SLICES,
        },
    }


def jump_to_landmark(landmark: str) -> dict:
    """
    Use this tool when the surgeon asks to go to a specific anatomical
    structure or landmark in the CT scan. Available landmarks:

      carina      — tracheal bifurcation into left and right main bronchi
      aortic_arch — the aortic arch at the superior mediastinum
      clavicle    — clavicle level, superior chest
      diaphragm   — diaphragmatic dome, inferior boundary of thorax
      tumor       — primary tumor, left upper lobe
      bronchus    — left main bronchus origin

    Examples:
      "go to the carina" → landmark='carina'
      "show me the aortic arch" → landmark='aortic_arch'
      "jump to the tumor" → landmark='tumor'
      "show the diaphragm" → landmark='diaphragm'
    """
    landmark = landmark.lower().strip().replace(' ', '_')
    if landmark not in CT_LANDMARKS:
        return {
            'status': 'error',
            'message': f"Unknown landmark '{landmark}'. Available: {', '.join(CT_LANDMARKS.keys())}",
            'render_command': {'layer': 'ct', 'action': 'error'},
        }

    slice_num = CT_LANDMARKS[landmark]
    _ct_state['current_slice'] = slice_num

    return {
        'status': 'success',
        'landmark': landmark,
        'slice': slice_num,
        'total': CT_TOTAL_SLICES,
        'render_command': {
            'layer': 'ct',
            'action': 'navigate',
            'slice': slice_num,
            'total': CT_TOTAL_SLICES,
            'landmark': landmark,
        },
    }


def hide_ct() -> dict:
    """
    Use this tool when the surgeon asks to hide, clear, or dismiss the CT scan
    overlay. Examples:
      "hide the CT"
      "clear the scan"
      "remove the CT overlay"
      "close the CT"
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'ct',
            'action': 'hide',
        },
    }


# ---------------------------------------------------------------------------
# AR Agent Tools — Anatomy Renderer (3D model)
# ---------------------------------------------------------------------------

def rotate_model(axis: str, degrees: float) -> dict:
    """
    Use this tool when the surgeon asks to rotate the 3D anatomy model to see
    it from a different angle.

    Axis and degrees mapping:
      axis='y', degrees=180  — posterior view (back of the lung)
                               Use when surgeon says: back, behind, posterior, rotate around
      axis='y', degrees=0    — anterior view (front of the lung)
                               Use when surgeon says: front, anterior, face forward, reset rotation
      axis='x', degrees=-90  — superior view (looking down from above)
                               Use when surgeon says: above, superior, top view, from above
      axis='x', degrees=90   — inferior view (looking up from below)
                               Use when surgeon says: below, inferior, bottom view, from below
      axis='y', degrees=90   — lateral view (side view)
                               Use when surgeon says: side, lateral, profile

    Examples:
      "rotate the model to show the back" → axis='y', degrees=180
      "show me the posterior surface" → axis='y', degrees=180
      "I want to see it from above" → axis='x', degrees=-90
      "show the front again" → axis='y', degrees=0
      "give me a side view" → axis='y', degrees=90
    """
    axis = axis.lower().strip()
    if axis not in ('x', 'y', 'z'):
        return {
            'status': 'error',
            'message': "axis must be 'x', 'y', or 'z'",
            'render_command': {'layer': 'ar', 'action': 'error'},
        }

    return {
        'status': 'success',
        'axis': axis,
        'degrees': degrees,
        'render_command': {
            'layer': 'ar',
            'action': 'rotate',
            'axis': axis,
            'degrees': degrees,
        },
    }


def toggle_structure(structure: str, visible: bool) -> dict:
    """
    Use this tool when the surgeon asks to show or hide a specific anatomical
    structure in the 3D model. The structure names must exactly match the mesh
    names in the loaded GLB file.

    Available structures (GLB mesh names from LIDC-IDRI-0001 segmentation):
      lung_right — right lung parenchyma (patient-right)
      lung_left  — left lung parenchyma (patient-left)
      bronchus   — main carina / bronchi region
      tumor      — right-lower-lobe nodule (~8mm)

    visible=True  — show the structure (surgeon says: show, display, make visible)
    visible=False — hide the structure (surgeon says: hide, remove, turn off)

    Examples:
      "hide the right lung"  → structure='lung_right', visible=False
      "show me the tumor"    → structure='tumor', visible=True
      "hide the bronchus"    → structure='bronchus', visible=False
      "show the left lung"   → structure='lung_left', visible=True
    """
    structure = structure.lower().strip()

    return {
        'status': 'success',
        'structure': structure,
        'visible': visible,
        'render_command': {
            'layer': 'ar',
            'action': 'toggle',
            'structure': structure,
            'visible': visible,
        },
    }


def reset_3d_view() -> dict:
    """
    Use this tool when the surgeon asks to reset the 3D model back to the
    default view, restore all hidden structures, or start the model view over.
    Examples:
      "reset the model"
      "show everything again"
      "restore the 3D view"
      "go back to default"
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'ar',
            'action': 'reset',
        },
    }


# ---------------------------------------------------------------------------
# Root Agent Tool — crosses all three display domains
# ---------------------------------------------------------------------------

def hide_all_overlays() -> dict:
    """
    Use this tool when the surgeon asks to clear, hide, close, or dismiss ALL
    active overlays simultaneously — CT scan, clinical data, and the 3D model.
    Trigger on ANY of the following (and natural variations):
      "clear everything"        "hide everything"
      "hide all overlays"       "hide all"
      "clear the screen"        "clear all"
      "remove everything"       "remove all"
      "clean up"                "clean the screen"
      "close everything"        "close all"
      "close all panels"        "close the panels"
      "dismiss everything"      "dismiss all"
      "ORION, clear"            "go back to just the video"
      "get rid of everything"   "take it all away"
    Do NOT route this to a sub-agent. Handle it directly at the root level.
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'all',
            'action': 'hide',
        },
    }
