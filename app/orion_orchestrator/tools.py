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
      "what is the creatinine" → field='creatinine'
      "what medications is he on" → field='medications'
      "any allergies" → field='allergies'
      "what's the diagnosis" → field='diagnosis'

    For broad requests ("show all labs", "all patient data"), use
    display_all_patient_data() instead — do NOT call this tool in a loop.
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


def display_all_patient_data() -> dict:
    """
    Use this tool when the surgeon asks to see ALL patient data, all labs,
    all vitals, all patient information, or any broad request for the full
    patient record. This shows every field in one single call — do NOT loop
    through display_patient_data repeatedly.

    Use this for:
      "show all patient data"        → display_all_patient_data()
      "show me everything"           → display_all_patient_data()
      "show all the labs"            → display_all_patient_data()
      "what are all the vitals"      → display_all_patient_data()
      "show the full patient record" → display_all_patient_data()
      "display all data"             → display_all_patient_data()

    For a SINGLE specific field, use display_patient_data(field) instead.
    NEVER call display_patient_data in a loop — use this tool instead.
    """
    fields = [
        {'field': k, 'label': v['label'], 'value': v['value'], 'note': v['note']}
        for k, v in _PATIENT_DATA.items()
    ]
    return {
        'status': 'success',
        'render_command': {
            'layer': 'clinical',
            'action': 'show_all',
            'fields': fields,
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


def hide_3d() -> dict:
    """
    Use this tool when the surgeon asks to hide, close, dismiss, or remove
    the 3D anatomy model overlay entirely. Examples:
      "hide the 3D model"
      "close the 3D view"
      "remove the anatomy model"
      "close the model"
      "dismiss the 3D"
      "hide the anatomy"
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'ar',
            'action': 'hide',
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
# PC Agent Tool — Procedural Context (surgical phase detection)
# ---------------------------------------------------------------------------

# Surgical phases for VATS left upper lobectomy (the demo procedure).
# Each phase has a label, 4-point checklist, and optional critical warning.
# Values are calibrated to standard robotic-assisted thoracic surgery protocol.
#
# Video-to-phase mapping (3 sequential surgical videos):
#   Video 1 (surgical_video.mp4 / mmc6):  port_placement, inspection
#   Video 2 (mmc11.mp4):                  fissure_development, vascular_dissection, bronchial_dissection
#   Video 3 (mmc12.mp4):                  specimen_extraction, lymph_node_dissection, closure
SURGICAL_PHASES: dict[str, dict] = {
    'port_placement': {
        'label': 'Port Placement & Access',
        'checklist': [
            'CO2 insufflation pressure ≤12 mmHg',
            'All 3 trocars seated and sealed',
            'Camera white-balance and focus confirmed',
            'DLT positioned — left lung deflated',
        ],
        'warning': 'Avoid intercostal vessels during trocar insertion',
    },
    'inspection': {
        'label': 'Inspection & Adhesion Lysis',
        'checklist': [
            'Survey pleural cavity for unexpected metastases',
            'Note adhesion density — assess resectability',
            'Identify anterior vs posterior access to hilum',
            'Confirm complete lung collapse',
        ],
        'warning': None,
    },
    'fissure_development': {
        'label': 'Fissure Development',
        'checklist': [
            'Identify plane between upper and lower lobes',
            'Stapler parallel to fissure — avoid PA branches',
            'Posterior fissure complete before anterior',
            'Watch for incomplete fissure — blunt dissection',
        ],
        'warning': 'Posterior PA branches hidden in fissure — stay lateral',
    },
    'vascular_dissection': {
        'label': 'Vascular Dissection',
        'checklist': [
            'Identify lingular PA branch before upper division PA',
            'Confirm 2 clips + 1 stapler load per vessel minimum',
            'Superior PV — confirm no common trunk with lower',
            'Divide: upper PA branches, then superior PV',
        ],
        'warning': 'CRITICAL: Left phrenic nerve runs anterior to hilum',
    },
    'bronchial_dissection': {
        'label': 'Bronchial Dissection & Division',
        'checklist': [
            'Clear peribronchial lymph nodes from bronchus',
            'Division point ≥5 mm distal to carina',
            'Stapler load: green (4.8 mm) for bronchus',
            'Test stump with warm saline — check for bubbles',
        ],
        'warning': 'Left upper bronchus — avoid injury to B6 (lower lobe)',
    },
    'specimen_extraction': {
        'label': 'Specimen Extraction',
        'checklist': [
            'Place specimen in extraction bag before removal',
            'Extend anterior port to 3–4 cm if needed',
            'Confirm all vascular pedicles secured',
            'Send for frozen section — margin status',
        ],
        'warning': None,
    },
    'lymph_node_dissection': {
        'label': 'Lymph Node Dissection',
        'checklist': [
            'Level 5, 6 (subaortic, para-aortic) — standard for LUL',
            'Level 7 (subcarinal) — downward retraction',
            'Level 9, 10 (inferior pulmonary ligament)',
            'Hemostasis at each nodal station before moving on',
        ],
        'warning': 'Recurrent laryngeal nerve at risk during level 5',
    },
    'closure': {
        'label': 'Hemostasis & Closure',
        'checklist': [
            'Irrigate 500 mL warm saline — inspect for air bubbles',
            'All staple lines and clips confirmed dry',
            'Place 28Fr chest tube through inferior port site',
            'Verify lung re-expansion on bronchoscopy/ventilation',
        ],
        'warning': None,
    },
}


def get_surgical_phase(phase: str) -> dict:
    """
    Use this tool when the surgeon asks about the current surgical phase,
    what structures to watch for, what comes next, or when stating a phase
    transition. Use visual context from the live surgical video to determine
    the current phase, then call this tool with the appropriate phase name.

    Available phases (pass exactly as shown):
      port_placement        — trocar insertion and OR setup
      inspection            — pleural survey and adhesion lysis
      fissure_development   — developing the interlobar fissure
      vascular_dissection   — isolating and dividing PA and PV branches
      bronchial_dissection  — skeletonizing and stapling the bronchus
      specimen_extraction   — removing the resected lobe in a bag
      lymph_node_dissection — systematic nodal harvest by station
      closure               — hemostasis, chest tube, re-expansion check

    Examples:
      "what phase are we in" → call with phase you detect from the video
      "what should I watch out for" → call with current detected phase
      "we are starting the vascular dissection" → phase='vascular_dissection'
      "show me the checklist" → call with current phase
      "what's next" → call with the upcoming or next phase
    """
    phase = phase.lower().strip().replace(' ', '_')
    if phase not in SURGICAL_PHASES:
        return {
            'status': 'error',
            'message': (
                f"Unknown phase '{phase}'. "
                f"Valid phases: {', '.join(SURGICAL_PHASES.keys())}"
            ),
            'render_command': {'layer': 'checklist', 'action': 'error'},
        }

    data = SURGICAL_PHASES[phase]
    return {
        'status': 'success',
        'phase': phase,
        'render_command': {
            'layer': 'checklist',
            'action': 'show',
            'phase': phase,
            'label': data['label'],
            'checklist': data['checklist'],
            'warning': data.get('warning'),
        },
    }

# hide surgical checklist
def hide_surgical_checklist() -> dict:
    """
    Use this tool when the surgeon asks to hide, clear, or dismiss the surgical
    checklist overlay. Examples:
      "hide the checklist"
      "clear the surgical checklist"
      "remove the checklist"
      "close the checklist panel"
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'checklist',
            'action': 'hide',
        },
    }

# ---------------------------------------------------------------------------
# Session event log — in-memory, lives for the duration of one surgical session.
# Reset each time the FastAPI server restarts (per-session is correct for demo).
# ---------------------------------------------------------------------------
_SESSION_LOG: list[dict] = []


def log_ai_interaction(surgeon_said: str, orion_said: str) -> dict | None:
    """Server-side helper (NOT an agent tool). Called by main.py on turnComplete
    to auto-log every surgeon↔ORION exchange for conversation transparency.
    Returns the entry dict, or None if the turn had no meaningful content."""
    import datetime
    surgeon_said = (surgeon_said or '').strip()
    orion_said = (orion_said or '').strip()
    if not surgeon_said and not orion_said:
        return None
    # Truncate each side to keep log entries concise
    def _trunc(s, maxlen=80):
        return (s[:maxlen] + '…') if len(s) > maxlen else s
    parts = []
    if surgeon_said:
        parts.append(f'Q: {_trunc(surgeon_said)}')
    if orion_said:
        parts.append(f'A: {_trunc(orion_said)}')
    timestamp = datetime.datetime.now().strftime('%H:%M:%S')
    entry = {
        'type': 'ai_interaction',
        'note': ' | '.join(parts),
        'timestamp': timestamp,
    }
    _SESSION_LOG.append(entry)
    return entry


# ---------------------------------------------------------------------------
# DOC Agent Tools — Intraoperative Documentation
# ---------------------------------------------------------------------------

def log_event(event_type: str, note: str = '') -> dict:
    """
    Use this tool when the surgeon voice-logs any intraoperative event.
    Auto-timestamps the event and appends it to the session operative log.

    event_type — pass exactly one of:
      cvs_confirmed     — Critical View of Safety confirmed before structure division
      timeout_complete  — WHO surgical safety timeout completed
      blood_loss        — Estimated blood loss (put "X mL" in the note)
      specimen_removed  — Specimen extracted from chest and placed in bag
      complication      — Unexpected intraoperative event (describe in note)
      milestone         — Key procedural step completed (describe in note)
      note              — General surgeon observation (describe in note)

    Examples:
      "log CVS confirmed"              → event_type='cvs_confirmed'
      "timeout complete"               → event_type='timeout_complete'
      "log blood loss 200ml"           → event_type='blood_loss', note='200 mL'
      "specimen removed"               → event_type='specimen_removed'
      "note: artery clipped at hilum"  → event_type='milestone', note='Artery clipped at hilum'
      "log complication — bleeding"    → event_type='complication', note='Bleeding at hilum'
    """
    import datetime
    valid_types = {
        'cvs_confirmed', 'timeout_complete', 'blood_loss', 'specimen_removed',
        'complication', 'milestone', 'note',
    }
    etype = event_type.lower().strip().replace(' ', '_')
    if etype not in valid_types:
        etype = 'note'
    entry = {
        'type': etype,
        'note': note.strip(),
        'timestamp': datetime.datetime.now().strftime('%H:%M:%S'),
    }
    _SESSION_LOG.append(entry)
    return {
        'status': 'success',
        'render_command': {
            'layer': 'log',
            'action': 'append',
            'entry': entry,
        },
    }


def show_event_log() -> dict:
    """
    Use this tool when the surgeon asks to see the operative log or event log.
    Displays the full session event timeline tile on screen.

    Trigger phrases: "show operative log", "show the log", "show event log",
    "what have we logged", "display the timeline"
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'log',
            'action': 'show_all',
            'entries': list(_SESSION_LOG),
        },
    }


def hide_event_log() -> dict:
    """
    Use this tool when the surgeon asks to hide or close the operative log panel.

    Trigger phrases: "hide the log", "close the log", "dismiss the log"
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'log',
            'action': 'hide',
        },
    }


def capture_surgical_photo(surgical_step: str, note: str = '') -> dict:
    """
    Capture a still frame from the live surgical video feed, timestamp it to the
    current operative step, and save it to the patient's intraoperative chart.

    Indications — call this tool when the surgeon says any of:
      "capture this", "take a photo", "screenshot this", "photograph this",
      "save this image", "document this view", "capture that", "save the image"

    Also call proactively when the surgeon logs:
      - CVS confirmed   → immediately capture the critical-view image as medicolegal record
      - Complication    → capture the field at the moment of the unexpected event
      - Specimen removed → capture the specimen before bag extraction

    Args:
        surgical_step: Name of the current operative step or event that prompted
                       the capture (e.g., 'CVS confirmation', 'staple line check',
                       'unexpected adhesions', 'specimen in bag', 'haemostasis confirmed').
        note: Optional voice-dictated annotation — anatomy observed, findings,
              reason for capture (e.g., 'Cystic duct and artery clearly isolated',
              '50 mL active bleed from inferior pulmonary vein').

    Clinical context:
      - SAGES guidelines require photographic documentation of CVS in every
        laparoscopic cholecystectomy as medicolegal protection.
      - The Joint Commission recommends intraoperative photo documentation of
        unexpected anatomy and complications for peer-review and QA.
      - Photos are filed as timestamped attachments to the operative note in the EHR.
    """
    import datetime
    timestamp = datetime.datetime.now().strftime('%H:%M:%S')
    entry = {
        'type': 'photo',
        'surgical_step': surgical_step.strip(),
        'note': note.strip(),
        'timestamp': timestamp,
    }
    _SESSION_LOG.append(entry)
    return {
        'status': 'success',
        'message': (
            f'Photo captured at {timestamp} — step: {surgical_step}. '
            'Saved to patient chart.'
        ),
        'render_command': {
            'layer': 'log',
            'action': 'capture_photo',
            'entry': entry,
        },
    }


# ---------------------------------------------------------------------------
# Complication Advisor Tools
# ---------------------------------------------------------------------------
# Phase-aware complication management protocols for VATS lobectomy.
# Each complication type maps to a dict of phase → protocol steps.

_COMPLICATION_PROTOCOLS: dict[str, dict] = {
    'bleeding': {
        '_default': [
            'Apply direct pressure with sponge stick.',
            'Identify source vessel.',
            'Clip proximal and distal to injury if accessible.',
            'If uncontrolled — call for blood products and prepare for conversion.',
        ],
        'vascular_dissection': [
            'Immediate suction-compression on the PA injury site.',
            'Do NOT remove the sponge — maintain tamponade.',
            'Identify if PA branch or trunk is involved.',
            'Branch: proximal clip + suture repair with 5-0 prolene.',
            'Trunk: pack tightly and convert to thoracotomy immediately.',
        ],
        'fissure_development': [
            'Compress the fissure with a sponge stick.',
            'Identify posterior PA branches hidden in the fissure.',
            'Clip-and-compress technique — do NOT chase the bleeder blindly.',
            'If >200 mL in 60 seconds, convert to open.',
        ],
    },
    'air_leak': {
        '_default': [
            'Irrigate with warm saline and ventilate to identify leak.',
            'Check all staple lines for incomplete closure.',
            'Small leak: oversew with 4-0 prolene figure-of-eight.',
            'Large parenchymal leak: consider buttressed re-stapling.',
        ],
        'bronchial_dissection': [
            'Test bronchial stump with warm saline under ventilation.',
            'Look for bubbles at the staple line.',
            'If positive: reinforce with 4-0 prolene interrupted sutures.',
            'If stump is necrotic: re-staple 5 mm proximal.',
        ],
    },
    'nerve_injury': {
        '_default': [
            'Stop all dissection in the area immediately.',
            'Identify the injured nerve — recurrent laryngeal or phrenic.',
            'Do NOT cauterize near the nerve — ischemic injury worsens.',
            'Document the injury and notify the team.',
        ],
    },
    'conversion': {
        '_default': [
            'Inform anesthesia — prepare for single-lung ventilation adjustment.',
            'Extend the anterior utility incision to 8-10 cm.',
            'Place a rib spreader and convert to anterolateral thoracotomy.',
            'Maintain vascular control throughout conversion.',
        ],
    },
}

# Structure highlights for each complication type (for 3D viewer)
_COMPLICATION_STRUCTURES: dict[str, list[str]] = {
    'bleeding': ['vessels'],
    'air_leak': ['bronchus', 'lung_left'],
    'nerve_injury': ['vessels'],  # nerves run alongside vessels in the model
    'conversion': ['ribs', 'lung_left'],
}


def get_complication_protocol(complication_type: str, current_phase: str = '') -> dict:
    """
    Use this tool when the surgeon reports a complication and needs a management
    protocol. Returns step-by-step instructions tailored to the complication
    type and current surgical phase.

    complication_type — one of: bleeding, air_leak, nerve_injury, conversion
    current_phase — optional, the current surgical phase for phase-specific advice

    Examples:
      "I have bleeding"           → complication_type='bleeding'
      "there's an air leak"       → complication_type='air_leak'
      "nerve injury"              → complication_type='nerve_injury'
      "we need to convert"        → complication_type='conversion'
    """
    ctype = complication_type.lower().strip().replace(' ', '_')
    protocols = _COMPLICATION_PROTOCOLS.get(ctype)
    if not protocols:
        valid = ', '.join(sorted(_COMPLICATION_PROTOCOLS.keys()))
        return {'status': 'error', 'message': f'Unknown complication: "{ctype}". Valid: {valid}'}

    phase = current_phase.lower().strip().replace(' ', '_')
    steps = protocols.get(phase, protocols['_default'])
    structures = _COMPLICATION_STRUCTURES.get(ctype, [])

    return {
        'status': 'success',
        'complication': ctype,
        'phase': phase or 'general',
        'steps': steps,
        'highlight_structures': structures,
        'render_command': {
            'layer': 'clinical',
            'action': 'show',
            'field': 'complication_protocol',
            'data': {'type': ctype, 'steps': steps},
        },
    }


# ---------------------------------------------------------------------------
# EBL Tracker Tools
# ---------------------------------------------------------------------------

_EBL_TOTAL_ML: int = 0  # Running cumulative estimated blood loss


def update_ebl(amount_ml: int) -> dict:
    """
    Use this tool when the surgeon reports blood loss to add to the running
    estimated blood loss (EBL) total.

    amount_ml — blood loss in millilitres for this event

    Examples:
      "blood loss 200 mL"         → amount_ml=200
      "another 150 of blood loss" → amount_ml=150
      "50 mL bleed"               → amount_ml=50
    """
    import datetime
    global _EBL_TOTAL_ML
    try:
        amount = int(amount_ml)
    except (ValueError, TypeError):
        return {'status': 'error', 'message': f'Invalid amount: {amount_ml}. Provide a number in mL.'}
    if amount <= 0:
        return {'status': 'error', 'message': 'Amount must be positive.'}

    _EBL_TOTAL_ML += amount
    timestamp = datetime.datetime.now().strftime('%H:%M:%S')

    # Also log as a blood_loss event in session log
    _SESSION_LOG.append({
        'type': 'blood_loss',
        'note': f'{amount} mL (total: {_EBL_TOTAL_ML} mL)',
        'timestamp': timestamp,
    })

    # Estimate blood volume from patient weight (70 mL/kg)
    weight_str = _PATIENT_DATA.get('weight', {}).get('value', '70 kg')
    weight_kg = int(''.join(c for c in weight_str if c.isdigit()) or '70')
    ebv = weight_kg * 70  # estimated blood volume in mL
    pct = round(_EBL_TOTAL_ML / ebv * 100, 1) if ebv > 0 else 0

    alert = ''
    if pct >= 40:
        alert = 'CRITICAL: Massive transfusion protocol recommended.'
    elif pct >= 25:
        alert = 'WARNING: Check hemoglobin and prepare transfusion.'
    elif pct >= 15:
        alert = 'CAUTION: Consider type and screen.'

    return {
        'status': 'success',
        'ebl_total_ml': _EBL_TOTAL_ML,
        'ebl_pct': pct,
        'alert': alert,
        'render_command': {
            'layer': 'clinical',
            'action': 'show',
            'field': 'ebl',
            'data': {
                'total_ml': _EBL_TOTAL_ML,
                'pct': pct,
                'alert': alert,
            },
        },
    }


def get_ebl_summary() -> dict:
    """
    Use this tool when the surgeon asks for the current estimated blood loss
    total or fluid status.

    Examples:
      "what's the total blood loss"   → call get_ebl_summary()
      "EBL status"                    → call get_ebl_summary()
      "how much have we lost"         → call get_ebl_summary()
    """
    weight_str = _PATIENT_DATA.get('weight', {}).get('value', '70 kg')
    weight_kg = int(''.join(c for c in weight_str if c.isdigit()) or '70')
    ebv = weight_kg * 70
    pct = round(_EBL_TOTAL_ML / ebv * 100, 1) if ebv > 0 else 0
    hgb = _PATIENT_DATA.get('hemoglobin', {}).get('value', 'unknown')

    return {
        'status': 'success',
        'ebl_total_ml': _EBL_TOTAL_ML,
        'ebl_pct': pct,
        'estimated_blood_volume_ml': ebv,
        'pre_op_hemoglobin': hgb,
        'render_command': {
            'layer': 'clinical',
            'action': 'show',
            'field': 'ebl',
            'data': {'total_ml': _EBL_TOTAL_ML, 'pct': pct, 'alert': ''},
        },
    }


# ---------------------------------------------------------------------------
# Drug Safety Checker Tools
# ---------------------------------------------------------------------------

# Common intraoperative drugs with allergy cross-reactivity and interaction flags.
# Each entry: { 'class': ..., 'cross_allergies': [...], 'interactions': {...}, 'note': ... }
_DRUG_DB: dict[str, dict] = {
    'cefazolin': {
        'class': 'Cephalosporin antibiotic',
        'cross_allergies': ['penicillin'],
        'cross_allergy_note': '1-2% cross-reactivity with penicillin allergy',
        'interactions': {},
        'alternative': 'vancomycin',
    },
    'heparin': {
        'class': 'Anticoagulant',
        'cross_allergies': [],
        'cross_allergy_note': '',
        'interactions': {'aspirin': 'Increased bleeding risk when combined with aspirin'},
        'alternative': None,
    },
    'ketorolac': {
        'class': 'NSAID analgesic',
        'cross_allergies': ['aspirin', 'nsaid'],
        'cross_allergy_note': 'Cross-reactivity with aspirin/NSAID allergy',
        'interactions': {'low_platelets': 'Risk with platelets <100K', 'anticoagulant': 'Increased bleeding risk'},
        'alternative': 'acetaminophen IV',
    },
    'vancomycin': {
        'class': 'Glycopeptide antibiotic',
        'cross_allergies': [],
        'cross_allergy_note': '',
        'interactions': {},
        'alternative': None,
    },
    'ondansetron': {
        'class': 'Antiemetic (5-HT3 antagonist)',
        'cross_allergies': [],
        'cross_allergy_note': '',
        'interactions': {},
        'alternative': None,
    },
    'fentanyl': {
        'class': 'Opioid analgesic',
        'cross_allergies': ['codeine', 'morphine'],
        'cross_allergy_note': 'Partial cross-reactivity within opioid class',
        'interactions': {},
        'alternative': 'hydromorphone',
    },
    'morphine': {
        'class': 'Opioid analgesic',
        'cross_allergies': ['codeine'],
        'cross_allergy_note': 'Cross-reactivity with codeine allergy',
        'interactions': {},
        'alternative': 'fentanyl or hydromorphone',
    },
    'epinephrine': {
        'class': 'Vasopressor / anaphylaxis rescue',
        'cross_allergies': [],
        'cross_allergy_note': '',
        'interactions': {},
        'alternative': None,
    },
    'sugammadex': {
        'class': 'Neuromuscular reversal agent',
        'cross_allergies': [],
        'cross_allergy_note': '',
        'interactions': {'oral_contraceptive': 'May reduce efficacy of hormonal contraceptives'},
        'alternative': None,
    },
    'tranexamic_acid': {
        'class': 'Antifibrinolytic',
        'cross_allergies': [],
        'cross_allergy_note': '',
        'interactions': {},
        'alternative': None,
    },
}


def check_drug_safety(drug_name: str) -> dict:
    """
    Use this tool when the surgeon asks whether a medication is safe to give.
    Cross-checks the drug against the patient's allergies, current medications,
    and lab values.

    drug_name — the medication to check (e.g. heparin, cefazolin, ketorolac)

    Examples:
      "can I give heparin?"         → drug_name='heparin'
      "is cefazolin safe?"          → drug_name='cefazolin'
      "check ketorolac"             → drug_name='ketorolac'
      "can we use morphine?"        → drug_name='morphine'
    """
    name = drug_name.lower().strip().replace(' ', '_')
    drug = _DRUG_DB.get(name)
    if not drug:
        known = ', '.join(sorted(_DRUG_DB.keys()))
        return {'status': 'error', 'message': f'Drug "{name}" not in database. Known drugs: {known}'}

    allergies_raw = _PATIENT_DATA.get('allergies', {}).get('value', '').lower()
    meds_raw = _PATIENT_DATA.get('medications', {}).get('value', '').lower()
    platelets_raw = _PATIENT_DATA.get('platelets', {}).get('value', '')

    warnings = []

    # Check cross-allergies
    for allergen in drug['cross_allergies']:
        if allergen in allergies_raw:
            warnings.append(
                f'ALLERGY WARNING: Patient has {allergen} allergy. '
                f'{drug["cross_allergy_note"]}.'
                + (f' Consider {drug["alternative"]} instead.' if drug['alternative'] else '')
            )

    # Check medication interactions
    for trigger, msg in drug['interactions'].items():
        if trigger == 'aspirin' and 'aspirin' in meds_raw:
            warnings.append(f'INTERACTION: {msg}. Note: aspirin may be held — check status.')
        elif trigger == 'low_platelets':
            plat_num = int(''.join(c for c in platelets_raw if c.isdigit()) or '999')
            if plat_num < 100:
                warnings.append(f'LAB WARNING: {msg}. Current platelets: {platelets_raw}.')
        elif trigger == 'anticoagulant' and ('heparin' in meds_raw or 'warfarin' in meds_raw):
            warnings.append(f'INTERACTION: {msg}.')

    status = 'caution' if warnings else 'safe'
    summary = '; '.join(warnings) if warnings else f'{name} — no allergy conflicts or interactions detected. Safe to administer.'

    return {
        'status': 'success',
        'drug': name,
        'drug_class': drug['class'],
        'safety_status': status,
        'summary': summary,
        'warnings': warnings,
        'render_command': {
            'layer': 'clinical',
            'action': 'show',
            'field': 'drug_check',
            'data': {'drug': name, 'status': status, 'summary': summary},
        },
    }


# ---------------------------------------------------------------------------
# Anatomy Spotter Tools
# ---------------------------------------------------------------------------

# Phase → relevant anatomy with clinical pearls and associated structures/landmarks
_PHASE_ANATOMY: dict[str, dict] = {
    'port_placement': {
        'structures': ['ribs', 'lung_left'],
        'landmark': 'diaphragm',
        'pearl': 'Intercostal vessels run along the inferior rib border. Insert trocars above the rib to avoid them.',
    },
    'inspection': {
        'structures': ['lung_left', 'pleura'],
        'landmark': 'tumor',
        'pearl': 'Survey the pleural cavity for unexpected metastases before committing to resection.',
    },
    'fissure_development': {
        'structures': ['vessels', 'lung_left'],
        'landmark': 'bronchus',
        'pearl': 'Posterior PA branches are hidden in the fissure. Stay lateral to avoid injury. Incomplete fissure is common — use blunt dissection.',
    },
    'vascular_dissection': {
        'structures': ['vessels', 'bronchus'],
        'landmark': 'carina',
        'pearl': 'Left phrenic nerve runs anterior to the hilum. Identify lingular PA branch before upper division PA. Superior PV — confirm no common trunk with lower lobe vein.',
    },
    'bronchial_dissection': {
        'structures': ['bronchus', 'lung_left'],
        'landmark': 'bronchus',
        'pearl': 'Left upper bronchus — division point must be ≥5 mm from carina. Avoid injury to B6 (superior segment of lower lobe).',
    },
    'specimen_extraction': {
        'structures': ['tumor', 'lung_left'],
        'landmark': 'tumor',
        'pearl': 'Bag the specimen before extraction. Confirm all vascular pedicles are secured. Send for frozen section margin analysis.',
    },
    'lymph_node_dissection': {
        'structures': ['vessels'],
        'landmark': 'aortic_arch',
        'pearl': 'Level 5 (subaortic): recurrent laryngeal nerve at risk. Level 7 (subcarinal): retract lung downward. Hemostasis at each station before moving on.',
    },
    'closure': {
        'structures': ['ribs', 'lung_left', 'pleura'],
        'landmark': 'diaphragm',
        'pearl': 'Irrigate with warm saline and check for air leaks under ventilation. Verify lung re-expansion. Place chest tube through inferior port.',
    },
}


def get_anatomy_context(query: str = '', current_phase: str = '') -> dict:
    """
    Use this tool when the surgeon asks about nearby anatomy, danger zones,
    structures at risk, or wants a clinical pearl for the current phase.

    query — the surgeon's question (e.g. "what's near the hilum", "danger zone")
    current_phase — the current surgical phase for context

    Examples:
      "what structure is at risk?"    → call get_anatomy_context()
      "show me the danger zone"       → call get_anatomy_context()
      "what's near the hilum?"        → call get_anatomy_context(query='hilum')
      "anatomy check"                 → call get_anatomy_context()
    """
    phase = current_phase.lower().strip().replace(' ', '_')
    context = _PHASE_ANATOMY.get(phase)
    if not context:
        # Return a general response with all phases listed
        return {
            'status': 'success',
            'phase': 'unknown',
            'pearl': 'Specify a surgical phase for anatomy context.',
            'available_phases': list(_PHASE_ANATOMY.keys()),
            'render_command': {'layer': 'clinical', 'action': 'show', 'field': 'anatomy_context',
                               'data': {'pearl': 'Phase not specified.'}},
        }

    return {
        'status': 'success',
        'phase': phase,
        'structures': context['structures'],
        'landmark': context['landmark'],
        'pearl': context['pearl'],
        'render_command': {
            'layer': 'clinical',
            'action': 'show',
            'field': 'anatomy_context',
            'data': {'phase': phase, 'pearl': context['pearl']},
        },
    }


# ---------------------------------------------------------------------------
# Root Agent Tool — crosses all three display domains
# ---------------------------------------------------------------------------

def show_only_ar() -> dict:
    """
    Use this tool when the surgeon asks to keep ONLY the 3D anatomy model
    and close or hide everything else (CT scan, patient data, checklists).
    Examples:
      "only keep the 3D model"
      "keep only the anatomy"
      "close everything except the 3D"
      "hide everything but the model"
      "just show me the 3D"
    Do NOT route this to a sub-agent. Handle it directly at the root level.
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'all_except_ar',
            'action': 'hide',
        },
    }


def show_agent_summary(title: str, content: str, bullets: list = None) -> dict:
    """
    Display a formatted text summary tile on the surgical console.
    Call this as the FINAL step after all other display tools to surface
    the agent's key output as a readable tile for the surgeon.

    Args:
        title:   Tile header (e.g. 'WHO Surgical Safety Checklist', 'Handoff — SBAR')
        content: Introductory paragraph or free-form text (can be empty string '')
        bullets: Optional list of numbered/bulleted items (protocol steps, SBAR sections, etc.)
    """
    return {
        'status': 'displayed',
        'render_command': {
            'layer': 'summary',
            'action': 'show',
            'title': title,
            'content': content,
            'bullets': bullets or [],
        },
    }


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


# ---------------------------------------------------------------------------
# Screen Share Tools
# ---------------------------------------------------------------------------

def start_screen_share() -> dict:
    """
    Activates screen sharing mode so ORION can visually analyze what the
    surgical team sees on their monitor. Use this tool when the surgeon says
    any of the following (and natural variations):
      "start screen share"       "share your screen"
      "enable screen share"      "show ORION my screen"
      "ORION, look at my screen" "screen share on"
      "start visual analysis"    "analyze my screen"
      "I want you to see my screen"
    After calling this tool, route the conversation to Screen_Advisor so it
    can describe, interpret, and act on the screen content.
    Do NOT route this to a sub-agent at the root level — handle the tool call
    here, then transfer to Screen_Advisor.
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'screenshare',
            'action': 'start',
        },
    }


def stop_screen_share() -> dict:
    """
    Deactivates screen sharing mode. The live screen frame stream stops and
    ORION's visual analysis is suspended. Use when the surgeon says:
      "stop screen share"        "disable screen share"
      "screen share off"         "stop sharing"
      "ORION, stop looking"      "end screen share"
      "stop visual analysis"     "close screen share"
    Handle directly at root level without sub-agent routing.
    """
    return {
        'status': 'success',
        'render_command': {
            'layer': 'screenshare',
            'action': 'stop',
        },
    }
