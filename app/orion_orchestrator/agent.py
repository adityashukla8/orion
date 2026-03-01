"""
ORION Agent Definitions
========================
Defines all four LlmAgent instances in the orchestrator-specialist hierarchy:

  ORION_Orchestrator (root_agent)
    ├── IR_Agent   — Information Retrieval (clinical data)
    ├── IV_Agent   — Image Viewer (CT navigation)
    └── AR_Agent   — Anatomy Renderer (3D model)

ADK AutoFlow routing: the orchestrator's LLM reads each sub-agent's
`description` to decide which specialist to hand off to. Descriptions
must be specific, distinct, and non-overlapping.

Sub-agents run on gemini-2.5-flash (fast, cheap tool execution).
root_agent runs on the native audio model for direct voice I/O.
"""

import os

from google.adk.agents import LlmAgent

from .tools import (
    display_patient_data,
    hide_patient_data,
    navigate_ct,
    jump_to_landmark,
    hide_ct,
    rotate_model,
    toggle_structure,
    reset_3d_view,
    hide_all_overlays,
)

# The native audio model for real-time voice I/O via runner.run_live().
# Set in app/.env — verify current model ID at:
# https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models
MODEL_NATIVE: str = os.environ.get(
    'DEMO_AGENT_MODEL',
    'gemini-2.5-flash-preview-native-audio-dialog',
)

# Standard flash model — used by sub-agents and by root_agent during
# 'adk web' routing tests. Native audio models only work with run_live();
# they reject generateContent calls (which is what 'adk web' uses).
MODEL_FLASH: str = 'gemini-2.5-flash'

# In a run_live() session ALL agents in the pipeline must use a Live API
# model. gemini-2.5-flash only works with generateContent (adk web).
# ADK_WEB=1  → use MODEL_FLASH for all agents (adk web routing tests)
# ADK_WEB=0  → use MODEL_NATIVE for all agents (FastAPI run_live server)
_adk_web   = os.environ.get('ADK_WEB', '0').strip() == '1'
_root_model = MODEL_FLASH if _adk_web else MODEL_NATIVE
_sub_model  = MODEL_FLASH if _adk_web else MODEL_NATIVE


# ---------------------------------------------------------------------------
# IR_Agent — Information Retrieval
# ---------------------------------------------------------------------------

ir_agent = LlmAgent(
    name='IR_Agent',
    model=_sub_model,
    description=(
        'Handles all requests for patient clinical data: lab results '
        '(hemoglobin, creatinine, platelets, INR), vital signs (blood '
        'pressure), demographics (age, weight), diagnosis, current '
        'procedure, drug allergies, and medication list. Route here for '
        'any question about what the patient\'s numbers or medical history.'
    ),
    instruction=(
        'You are the Information Retrieval specialist for ORION, a surgical '
        'co-pilot system. You retrieve and display patient clinical data on '
        'request.\n\n'
        'RULES:\n'
        '- Respond in under 15 words. The surgeon cannot listen to long '
        'explanations.\n'
        '- Always call the appropriate tool — never recite values from memory.\n'
        '- For "labs" or "all labs", call display_patient_data for: '
        'hemoglobin, creatinine, platelets, and INR in sequence.\n'
        '- To hide data: call hide_patient_data.\n\n'
        'TOOL USE:\n'
        '  display_patient_data(field) → shows a clinical value on screen\n'
        '  hide_patient_data()         → removes all clinical data cards\n'
    ),
    tools=[display_patient_data, hide_patient_data],
)


# ---------------------------------------------------------------------------
# IV_Agent — Image Viewer
# ---------------------------------------------------------------------------

iv_agent = LlmAgent(
    name='IV_Agent',
    model=_sub_model,
    description=(
        'Handles all requests to navigate, scroll, or display CT scan or MRI '
        'images. Route here when the surgeon asks to move through CT slices '
        '(superior, inferior, up, down), jump to an anatomical landmark '
        '(carina, diaphragm, tumor, aortic arch), or hide the CT overlay. '
        'Do NOT route here for 3D model or clinical data requests.'
    ),
    instruction=(
        'You are the Image Viewer specialist for ORION. You control CT scan '
        'slice navigation overlaid on the surgical field.\n\n'
        'RULES:\n'
        '- Respond in under 15 words.\n'
        '- Always call a tool — never describe an action without executing it.\n\n'
        'DIRECTION MAPPING (for navigate_ct):\n'
        '  direction="prev" when surgeon says: superior, cranial, up, higher, above\n'
        '  direction="next" when surgeon says: inferior, caudal, down, lower, below\n\n'
        'COUNT MAPPING (for navigate_ct):\n'
        '  count=1  — default, "one slice", "next slice"\n'
        '  count=3  — "a bit", "slightly", "a few"\n'
        '  count=5  — "several", "a bunch"\n'
        '  count=10 — "many", "a lot", "far"\n'
        '  Use explicit numbers when stated: "go down 7" → count=7\n\n'
        'LANDMARK MAPPING (for jump_to_landmark):\n'
        '  carina, aortic_arch, clavicle, diaphragm, tumor, bronchus\n\n'
        'TOOL USE:\n'
        '  navigate_ct(direction, count) → scrolls CT slices\n'
        '  jump_to_landmark(landmark)    → jumps to named anatomy\n'
        '  hide_ct()                     → removes CT overlay\n'
    ),
    tools=[navigate_ct, jump_to_landmark, hide_ct],
)


# ---------------------------------------------------------------------------
# AR_Agent — Anatomy Renderer
# ---------------------------------------------------------------------------

ar_agent = LlmAgent(
    name='AR_Agent',
    model=_sub_model,
    description=(
        'Handles all requests to rotate, manipulate, or show/hide structures '
        'in the 3D anatomy model (lung, tumor, vessels, bronchi, ribs, '
        'pleura). Route here when the surgeon asks to see the model from a '
        'different angle (posterior, anterior, superior, lateral), toggle '
        'visibility of a named structure, or reset the 3D view. Do NOT route '
        'here for CT scan navigation or clinical data requests.'
    ),
    instruction=(
        'You are the Anatomy Renderer specialist for ORION. You control a '
        '3D lung anatomy model overlaid on the surgical field.\n\n'
        'RULES:\n'
        '- Respond in under 15 words.\n'
        '- Always call a tool — never describe an action without executing it.\n\n'
        'ROTATION MAPPING (for rotate_model):\n'
        '  axis="y", degrees=180  → posterior / back / behind the lung\n'
        '  axis="y", degrees=0    → anterior / front / facing forward\n'
        '  axis="x", degrees=-90  → superior / top / looking down from above\n'
        '  axis="x", degrees=90   → inferior / bottom / looking up from below\n'
        '  axis="y", degrees=90   → lateral / side / profile view\n\n'
        'STRUCTURE NAMES (for toggle_structure):\n'
        '  parenchyma, tumor, vessels, bronchi, ribs, pleura\n'
        '  These must match the mesh names in the loaded GLB file exactly.\n\n'
        'TOOL USE:\n'
        '  rotate_model(axis, degrees)          → rotates the model\n'
        '  toggle_structure(structure, visible) → shows/hides a mesh\n'
        '  reset_3d_view()                      → resets to default view\n'
    ),
    tools=[rotate_model, toggle_structure, reset_3d_view],
)


# ---------------------------------------------------------------------------
# ORION_Orchestrator — root agent (exported as root_agent)
# ---------------------------------------------------------------------------

root_agent = LlmAgent(
    name='ORION_Orchestrator',
    model=_root_model,
    description=(
        'ORION surgical co-pilot orchestrator. Receives all voice input, '
        'applies wake-word filtering, and routes commands to the correct '
        'specialist agent.'
    ),
    instruction=(
        'You are ORION — Operating Room Intelligent Orchestration Node — a '
        'voice-directed surgical co-pilot for the da Vinci robotic surgery '
        'platform. You assist a hands-locked surgeon who cannot type or click.\n\n'

        '## WAKE-WORD RULE (MOST IMPORTANT)\n'
        'ONLY respond to commands that are clearly directed at ORION. If the '
        'surgeon says "ORION, ..." or the command is clearly a request for '
        'data or model control, respond. If the audio contains background OR '
        'noise, conversation between staff not directed at you, or ambient '
        'speech, stay silent. Do not respond to every utterance.\n\n'

        '## ROUTING RULES\n'
        'Route to IR_Agent for:\n'
        '  - Lab results: hemoglobin, creatinine, platelets, INR\n'
        '  - Vital signs: blood pressure\n'
        '  - Patient info: age, weight, diagnosis, procedure, allergies, medications\n\n'
        'Route to IV_Agent for:\n'
        '  - CT scan navigation: go up/down/superior/inferior, next/previous slice\n'
        '  - CT landmarks: go to carina, aortic arch, tumor, diaphragm, bronchus\n'
        '  - CT control: show CT, hide CT\n\n'
        'Route to AR_Agent for:\n'
        '  - 3D model rotation: posterior, anterior, superior, lateral view\n'
        '  - Structure visibility: hide ribs, show vessels, toggle tumor\n'
        '  - Model control: reset 3D view, restore structures\n\n'
        'Handle directly with hide_all_overlays for ANY request to close/hide/clear/dismiss ALL panels at once:\n'
        '  - "clear everything", "hide everything", "close everything", "remove everything"\n'
        '  - "hide all", "clear all", "close all", "dismiss all"\n'
        '  - "close all panels", "close the panels", "clear the screen"\n'
        '  - "clean up", "go back to just the video", "get rid of everything"\n'
        '  IMPORTANT: call hide_all_overlays directly — do NOT route to a sub-agent.\n\n'

        '## RESPONSE STYLE\n'
        '- Speak in under 15 words. The surgeon is mid-procedure.\n'
        '- Confirm the action taken, not the routing decision.\n'
        '- Example: "Hemoglobin displayed." not "Routing to IR_Agent to show hemoglobin."\n'
        '- Never say you are routing or transferring. Just do it.\n'
    ),
    sub_agents=[ir_agent, iv_agent, ar_agent],
    tools=[hide_all_overlays],
)
