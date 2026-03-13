/**
 * app.js — ORION WebSocket client and event router
 * =================================================
 * ES module — loaded with <script type="module"> in index.html.
 *
 * Responsibilities:
 *   1. Manages WebSocket connection lifecycle
 *   2. Starts audio I/O via bidi-demo AudioWorklet functions
 *   3. Starts surgical video frame capture (1 fps)
 *   4. Receives ADK event JSON from server, dispatches to display modules
 */

import { startAudioPlayerWorklet } from './audio-player.js';
import { startAudioRecorderWorklet, stopMicrophone } from './audio-recorder.js';

// ── Configuration ──────────────────────────────────────────────────────────
const CONFIG = Object.assign({
  gcsBucket:     'orion-assets-2026',
  ctPath:        'ct/case_demo_001',
  ctTotalSlices: 133,
  modelPath:     'models/lung_model.glb',
  videoPaths:    [
    'video/surgical_video.mp4',  // mmc6:  port_placement, inspection
    'video/mmc11.mp4',           // mmc11: fissure → vascular → bronchial
    'video/mmc12.mp4',           // mmc12: extraction → lymph nodes → closure
  ],
}, window.ORION_CONFIG || {});

const GCS_BASE = `https://storage.googleapis.com/${CONFIG.gcsBucket}`;

// ── DOM references ─────────────────────────────────────────────────────────
const orionOrb         = document.getElementById('orion-orb');
const orionStatusLabel = document.getElementById('orion-status-label');
const routingLog       = document.getElementById('routing-log');
const transcriptLog    = document.getElementById('transcript-log');
const surgicalVideo    = document.getElementById('surgical-video');

// ── Audio state ────────────────────────────────────────────────────────────
let audioPlayerNode  = null;
let audioRecorderCtx = null;   // recorder AudioContext — must be closed on disconnect
let micStream        = null;
let audioSuppressed  = false;  // true after barge-in — suppresses stale audio chunks
let _lastSuppressTime = 0;     // timestamp of last barge-in (debounce unsuppress)

// ── WebSocket / capture state ──────────────────────────────────────────────
let ws                = null;
let _autoReconnect    = false;  // set when server sends error — triggers reconnect on close
let videoInterval     = null;
let offscreenCtx      = null;
let _latestVideoFrame = null;  // most recent JPEG dataURL from startVideoCapture

// Expose to other modules (e.g. LogPanel.capturePhoto) so they can reuse the
// already-captured frame without re-doing the canvas draw.
window.ORION_getLatestFrame = () => _latestVideoFrame;

// ── Transcript state ───────────────────────────────────────────────────────
// Live API streams transcription word-by-word. Track the current in-progress
// bubble for each speaker and update it in place rather than adding new entries.
let currentOrionEntry   = null;
let currentSurgeonEntry = null;

// ── Tool-call deduplication ────────────────────────────────────────────────
// Prevents duplicate execution when the user repeats a command while waiting
// for a response. Key = "toolName:argsJSON", value = timestamp of last dispatch.
const _dispatchedTools = new Map();
const TOOL_DEDUP_MS    = 4000;  // ignore identical call within 4 s

// ── Agent & tool metrics ───────────────────────────────────────────────────
let   _activeAgent  = null;                // current event.author
let   _activeTool   = null;               // tool name being called right now
const _toolMetrics  = new Map();           // toolName → { count, lastCalled }

function updateAgentCard() {
  // Highlight the currently active agent chip
  document.querySelectorAll('.agent-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.agent === _activeAgent);
  });
  // Vision mode: both surgical video and screen capture run only while Screen_Advisor is active
  if (_activeAgent === 'Screen_Advisor') {
    startVideoCapture();
    if (ws && ws.readyState === WebSocket.OPEN) ScreenshareAgent.activate(ws);
  } else {
    stopVideoCapture();
    ScreenshareAgent.deactivate();
  }
}

function updateToolChip(toolName) {
  const metric = _toolMetrics.get(toolName);
  const chip = document.querySelector(`.tool-chip[data-tool="${toolName}"]`);
  if (!chip) return;
  chip.classList.add('called');
  const countEl = chip.querySelector('.tool-chip-count');
  if (countEl && metric) countEl.textContent = `×${metric.count}`;
}

function setActiveToolChip(toolName) {
  // Clear previous active
  if (_activeTool) {
    const prev = document.querySelector(`.tool-chip[data-tool="${_activeTool}"]`);
    if (prev) prev.classList.remove('active');
  }
  _activeTool = toolName;
  if (toolName) {
    const chip = document.querySelector(`.tool-chip[data-tool="${toolName}"]`);
    if (chip) chip.classList.add('active');
  }
}

// ── Entry point ────────────────────────────────────────────────────────────
orionOrb.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) disconnect();
  else connect();
});

// Screen share badge click → full teardown (user explicitly ending vision mode)
const _ssBadge = document.getElementById('screenshare-badge');
if (_ssBadge) {
  _ssBadge.addEventListener('click', () => ScreenshareAgent.teardown());
}

// screenshare:started fires once (first permission grant) — just update badge
document.addEventListener('screenshare:started', () => {
  if (_ssBadge) _ssBadge.classList.add('ss-active');
  logRouting('Vision mode active — surgical video + screen capture streaming', 'turn');
});
// screenshare:stopped fires on full teardown (disconnect or browser stop button)
document.addEventListener('screenshare:stopped', () => {
  if (_ssBadge) _ssBadge.classList.remove('ss-active');
  logRouting('Vision mode stopped.', 'turn');
});
document.addEventListener('screenshare:error', (e) => {
  logRouting(`Screen capture unavailable: ${e.detail?.message || 'permission denied'}`, 'error');
});

// Sequential video playlist with 3-stage fallback per video:
//   Stage 0 → local /static/ (dev: same-origin, canvas always works)
//   Stage 1 → GCS + crossorigin="anonymous" (prod: canvas works when CORS configured)
//   Stage 2 → GCS plain, no crossorigin (CORS not configured: video plays, no thumbnails)
let currentVideoIndex = 0;

(function loadVideo() {
  let _stage = 0;

  function playIndex(idx) {
    currentVideoIndex = idx;
    _stage = 0;
    const path = CONFIG.videoPaths[idx];
    surgicalVideo.removeAttribute('crossorigin');
    surgicalVideo.src = `/static/${path}`;
  }

  surgicalVideo.addEventListener('error', function onVideoError() {
    const path = CONFIG.videoPaths[currentVideoIndex];
    _stage++;
    if (_stage === 1) {
      surgicalVideo.crossOrigin = 'anonymous';
      surgicalVideo.src = `${GCS_BASE}/${path}`;
    } else if (_stage === 2) {
      surgicalVideo.removeAttribute('crossorigin');
      surgicalVideo.load();
    }
    // Stage 3+: skip to next video if this one can't load at all
    else if (_stage === 3 && CONFIG.videoPaths.length > 1) {
      playIndex((currentVideoIndex + 1) % CONFIG.videoPaths.length);
    }
  });

  surgicalVideo.addEventListener('ended', () => {
    playIndex((currentVideoIndex + 1) % CONFIG.videoPaths.length);
  });

  playIndex(0);
}());


async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const userId    = `surgeon_${Date.now()}`;
  const sessionId = `session_${Date.now()}`;
  const protocol  = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl     = `${protocol}://${window.location.host}/ws/${userId}/${sessionId}`;

  setStatus('connecting');
  logRouting('Connecting to ORION server…', 'turn');

  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = async () => {
    setStatus('active');
    logRouting('Session established.', 'turn');

    try {
      // Start audio output (24kHz playback)
      [audioPlayerNode] = await startAudioPlayerWorklet();

      // Start audio input (16kHz capture) — capture context so we can close it on disconnect
      [, audioRecorderCtx, micStream] = await startAudioRecorderWorklet(audioRecorderHandler);
    } catch (err) {
      logRouting(`Audio init failed: ${err.message || err} — refresh if issue persists`, 'error');
      setStatus('offline');
      return;
    }

    // Initialise display modules
    CTViewer.init({
      canvasId:    'ct-canvas',
      gcsBase:     GCS_BASE,
      ctPath:      CONFIG.ctPath,
      totalSlices: CONFIG.ctTotalSlices,
    });
    Anatomy3D.init({
      canvasId: 'ar-canvas',
      modelUrl: `${GCS_BASE}/${CONFIG.modelPath}`,
    });
    ClinicalPanel.init({ modalId: 'clinical-modal', bodyId: 'vitals-body' });
    ChecklistPanel.init({ modalId: 'checklist-modal', bodyId: 'checklist-body' });
    LogPanel.init({ modalId: 'log-modal', bodyId: 'log-body' });
    SummaryPanel.init({ modalId: 'summary-modal', bodyId: 'summary-body' });
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') handleServerEvent(event.data);
  };

  ws.onclose = () => {
    setStatus('offline');
    _activeAgent = null;
    _toolMetrics.clear();
    _dispatchedTools.clear();       // reset dedup cache so reconnect isn't silenced
    currentOrionEntry   = null;     // drop stale DOM refs from previous session
    currentSurgeonEntry = null;
    updateAgentCard();
    setActiveToolChip(null);
    SummaryPanel.hide();
    document.querySelectorAll('.tool-chip').forEach((chip) => {
      chip.classList.remove('called', 'active');
      const countEl = chip.querySelector('.tool-chip-count');
      if (countEl) countEl.textContent = '';
    });
    stopVideoCapture();
    ScreenshareAgent.teardown();
    if (micStream) { stopMicrophone(micStream); micStream = null; }
    if (audioRecorderCtx) {         // close recorder AudioContext — prevents browser limit (~6) being hit on repeated reconnects
      try { audioRecorderCtx.close(); } catch (_) {}
      audioRecorderCtx = null;
    }
    if (audioPlayerNode) {          // tear down audio player so reconnect gets a clean context
      try {
        audioPlayerNode.port.postMessage({ command: 'endOfAudio' });
        audioPlayerNode.disconnect();
        audioPlayerNode.context.close();
      } catch (_) {}
      audioPlayerNode = null;
    }
    if (_autoReconnect) {
      _autoReconnect = false;
      logRouting('Reconnecting…', 'turn');
      setTimeout(connect, 1500);
    } else {
      logRouting('Connection closed.', 'turn');
    }
  };

  ws.onerror = () => {
    setStatus('offline');
    logRouting('WebSocket error — check server logs.', 'error');
  };
}

function disconnect() {
  if (ws) { ws.close(); ws = null; }
}


// ── Audio I/O ──────────────────────────────────────────────────────────────

/**
 * Barge-in handler — flush audio player + suppress stale chunks + update UI.
 * Idempotent: safe to call from multiple triggers (interrupted, inputTranscription).
 * This is the ADK-standard pattern: react to server events, don't predict locally.
 */
function _bargeIn() {
  if (audioSuppressed) return;
  audioSuppressed = true;
  _lastSuppressTime = Date.now();
  if (audioPlayerNode) audioPlayerNode.port.postMessage({ command: 'endOfAudio' });
  currentOrionEntry = null;
  setStatus('interrupted');
}

/** Called by startAudioRecorderWorklet — receives raw PCM ArrayBuffer. */
function audioRecorderHandler(pcmData) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(pcmData);  // binary frame — server handles VAD via Live API
  }
}

/** Decode base64 PCM audio and send to AudioWorklet player. */
function base64ToArray(base64) {
  // Handle base64url encoding (replace - and _ with + and /)
  const std = base64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}


// ── Video frame capture ────────────────────────────────────────────────────

function startVideoCapture() {
  const offscreen = document.createElement('canvas');
  offscreen.width = 320; offscreen.height = 240;
  offscreenCtx = offscreen.getContext('2d');

  videoInterval = setInterval(() => {
    if (surgicalVideo.readyState < 2) return;
    try {
      offscreenCtx.drawImage(surgicalVideo, 0, 0, 320, 240);
      const b64 = offscreen.toDataURL('image/jpeg', 0.6);
      _latestVideoFrame = b64;  // stored for photo capture via ORION_getLatestFrame
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'image_frame', data: b64 }));
    } catch (e) {
      // Cross-origin taint: GCS video without CORS headers.
      // Video plays normally; canvas capture is blocked until CORS is configured
      // on the GCS bucket: gsutil cors set cors.json gs://orion-assets-2026
    }
  }, 1000);
}

function stopVideoCapture() {
  clearInterval(videoInterval);
  videoInterval = null;
}


// ── Server event handling ──────────────────────────────────────────────────

/**
 * ADK serialises events as snake_case via model_dump_json().
 * Some fields may also arrive camelCase — we check both to be safe.
 */
function handleServerEvent(jsonString) {
  let event;
  try { event = JSON.parse(jsonString); }
  catch { return; }

  // AI interaction transparency log — sent by main.py on turnComplete
  if (event.type === 'ai_log' && event.entry) {
    LogPanel.append(event.entry);
    return;
  }

  // Recoverable server error — log it and flag for auto-reconnect on close
  if (event.type === 'error') {
    logRouting(`⚠ ${event.message || 'Unknown error'} — reconnecting…`, 'error');
    _autoReconnect = true;
    return;
  }

  // Input transcription (surgeon speech — what Gemini heard).
  // Barge-in: surgeon is speaking → flush any playing audio and suppress
  // stale chunks. The Live API's automatic VAD also sends `interrupted`
  // (handled below), but inputTranscription often arrives first.
  const inputText = event.inputTranscription?.text ?? event.input_transcription?.text;
  if (inputText) {
    _bargeIn();
    setStatus('listening');
    _upsertTranscript('surgeon', inputText);
  }

  // Output transcription (ORION spoken response) — streams in chunks.
  // Unsuppress audio: a new outputTranscription means the model is responding
  // to the surgeon's latest input. Debounce to avoid unsuppressing from stale
  // output that overlaps with a fresh barge-in.
  const outputText = event.outputTranscription?.text ?? event.output_transcription?.text;
  if (outputText) {
    if (Date.now() - _lastSuppressTime > 300) audioSuppressed = false;
    _upsertTranscript('orion', outputText);
  }

  // Agent routing visibility + metrics card
  if (event.author) {
    if (event.author !== _activeAgent) {
      _activeAgent = event.author;
      updateAgentCard();
    }
    if (event.author !== 'ORION_Orchestrator') {
      logRouting(`→ ${event.author}`, 'transfer');
    }
  }

  const parts = event.content?.parts ?? [];
  for (const part of parts) {

    // Audio output — send PCM to AudioWorklet player.
    // Forward audio from ANY agent (orchestrator or sub-agents). ADK's
    // multi-agent live flow has sub-agents generate the audio response.
    const inlineData = part.inlineData ?? part.inline_data;
    const mimeType   = inlineData?.mimeType ?? inlineData?.mime_type ?? '';
    if (inlineData && mimeType.startsWith('audio/pcm') && audioPlayerNode && !audioSuppressed) {
      setStatus('speaking');
      audioPlayerNode.port.postMessage(base64ToArray(inlineData.data));
    }

    // Text from model (non-audio fallback)
    if (part.text && event.content?.role === 'model' && !outputText) {
      _upsertTranscript('orion', part.text);
    }

    // Function call → dispatch to display layer (deduplicated)
    const fc = part.functionCall ?? part.function_call;
    if (fc) {
      const key  = `${fc.name}:${JSON.stringify(fc.args ?? fc.arguments ?? {})}`;
      const now  = Date.now();
      const last = _dispatchedTools.get(key) ?? 0;
      if (now - last > TOOL_DEDUP_MS) {
        _dispatchedTools.set(key, now);
        // Track tool call count and highlight chip
        const prev = _toolMetrics.get(fc.name) ?? { count: 0, lastCalled: 0 };
        _toolMetrics.set(fc.name, { count: prev.count + 1, lastCalled: Date.now() });
        setActiveToolChip(fc.name);
        updateToolChip(fc.name);
        logRouting(`▶ ${fc.name}(${JSON.stringify(fc.args)})`, 'tool-call');
        dispatchRenderCommand(fc.name, fc.args ?? fc.arguments ?? {});
      } else {
        logRouting(`⚠ deduplicated ${fc.name}`, 'turn');
      }
    }

    // Function response → update display with actual clinical values
    const fr = part.functionResponse ?? part.function_response;
    if (fr) handleFunctionResponse(fr);
  }

  // Interrupt — server-side VAD detected barge-in (root agent audio).
  // _bargeIn() is idempotent — safe to call even if already suppressed.
  if (event.interrupted) _bargeIn();

  // Turn complete — multi-agent flow fires turnComplete after each sub-agent.
  // Only seal the surgeon bubble (their utterance is fully received).
  // Keep currentOrionEntry open so all agent responses within one user
  // request accumulate into a single ORION bubble.
  if (event.turnComplete ?? event.turn_complete) {
    currentSurgeonEntry = null;
    setActiveToolChip(null);
    if (ws && ws.readyState === WebSocket.OPEN) setStatus('active');
  }
}


// ── Render command dispatch ────────────────────────────────────────────────

function dispatchRenderCommand(toolName, args) {
  switch (toolName) {
    case 'display_patient_data':
      ClinicalPanel.showLoading(args.field);
      break;
    case 'display_all_patient_data':
      // No loading state needed — show_all arrives in handleFunctionResponse
      break;
    case 'hide_patient_data':
      ClinicalPanel.hide();
      break;
    case 'navigate_ct':
      CTViewer.navigate(args.direction, args.count || 1);
      break;
    case 'jump_to_landmark':
      CTViewer.jumpToLandmark(args.landmark);
      break;
    case 'hide_ct':
      CTViewer.hide();
      break;
    case 'rotate_model':
      Anatomy3D.rotate(args.axis, args.degrees);
      break;
    case 'toggle_structure':
      Anatomy3D.toggleStructure(args.structure, args.visible);
      break;
    case 'reset_3d_view':
      Anatomy3D.reset();
      break;
    case 'hide_3d':
      Anatomy3D.hide();
      relayoutTiles();
      break;
    case 'log_event':
      // no loading state — result arrives immediately in handleFunctionResponse
      break;
    case 'capture_surgical_photo':
      break;
    case 'show_event_log':
      break;
    case 'hide_surgical_checklist':
      ChecklistPanel.hide();
      relayoutTiles();
      break;
    case 'hide_event_log':
      LogPanel.hide();
      relayoutTiles();
      break;
    case 'hide_all_overlays':
      CTViewer.hide(); ClinicalPanel.hide(); Anatomy3D.hide(); ChecklistPanel.hide(); LogPanel.hide(); SummaryPanel.hide();
      relayoutTiles();
      break;
    case 'show_only_ar':
      CTViewer.hide(); ClinicalPanel.hide(); ChecklistPanel.hide(); LogPanel.hide();
      relayoutTiles();
      break;
    default:
      console.warn('[app.js] Unknown tool:', toolName);
  }
}

function handleFunctionResponse(fr) {
  const cmd = fr.response?.render_command;
  if (!cmd) return;
  if (cmd.layer === 'clinical' && cmd.action === 'show') {
    const d = cmd.data;
    if (cmd.field === 'ebl' && d) {
      const note = d.alert || '';
      ClinicalPanel.show('ebl', 'Est. Blood Loss', `${d.total_ml} mL (${d.pct}% BV)`, note);
    } else if (cmd.field === 'drug_check' && d) {
      const label = d.status === 'safe' ? 'DRUG: SAFE' : 'DRUG: CAUTION';
      ClinicalPanel.show('drug_check', label, d.drug, d.summary);
    } else if (cmd.field === 'complication_protocol' && d) {
      const steps = (d.steps || []).join(' → ');
      ClinicalPanel.show('complication', 'COMPLICATION', d.type, steps);
    } else if (cmd.field === 'anatomy_context' && d) {
      ClinicalPanel.show('anatomy', 'ANATOMY', d.phase || '', d.pearl || '');
    } else {
      ClinicalPanel.show(cmd.field, cmd.label, cmd.value, cmd.note);
    }
  }
  if (cmd.layer === 'clinical' && cmd.action === 'show_all') {
    (cmd.fields || []).forEach(f => ClinicalPanel.show(f.field, f.label, f.value, f.note));
  }
  if (cmd.layer === 'checklist' && cmd.action === 'show') {
    ChecklistPanel.show(cmd.phase, cmd.label, cmd.checklist, cmd.warning);
  }
  if (cmd.layer === 'checklist' && cmd.action === 'hide') {
    ChecklistPanel.hide();
    relayoutTiles();
  }
  if (cmd.layer === 'log') {
    if (cmd.action === 'append') {
      LogPanel.append(cmd.entry);
      relayoutTiles();
    } else if (cmd.action === 'capture_photo') {
      LogPanel.capturePhoto(cmd.entry);
      relayoutTiles();
    } else if (cmd.action === 'show_all') {
      LogPanel.showAll(cmd.entries);
      relayoutTiles();
    } else if (cmd.action === 'hide') {
      LogPanel.hide();
      relayoutTiles();
    }
  }
  if (cmd.layer === 'summary' && cmd.action === 'show') {
    SummaryPanel.show(cmd.title, cmd.content, cmd.bullets);
  }
  if (cmd.layer === 'summary' && cmd.action === 'hide') {
    SummaryPanel.hide();
    relayoutTiles();
  }
  if (cmd.layer === 'all' && cmd.action === 'hide') {
    CTViewer.hide(); ClinicalPanel.hide(); Anatomy3D.hide();
    ChecklistPanel.hide(); LogPanel.hide(); SummaryPanel.hide();
    relayoutTiles();
  }
  // screenshare layer actions are now system-managed via updateAgentCard()
}


// ── Tile layout ────────────────────────────────────────────────────────────

const MODAL_IDS = ['ct-modal', 'ar-modal', 'clinical-modal', 'checklist-modal', 'log-modal', 'summary-modal'];

// When any tile panel becomes visible the tiles column expands to 40% width,
// pushing the video into the remaining 60%. No position arithmetic needed —
// each visible tile gets an equal share of the column height via flex: 1.
function relayoutTiles() {
  const col = document.getElementById('tiles-column');
  if (!col) return;
  const anyVisible = MODAL_IDS.some(
    (id) => document.getElementById(id)?.classList.contains('visible')
  );
  col.classList.toggle('has-tiles', anyVisible);
}

// Expose globally so ct-viewer.js, anatomy-3d.js, clinical-panel.js can call it
window.ORION_relayoutModals = relayoutTiles;


// ── UI helpers ─────────────────────────────────────────────────────────────

function setStatus(state) {
  orionOrb.className = '';
  orionStatusLabel.className = '';
  switch (state) {
    case 'connecting':
      orionOrb.classList.add('orb-connecting');
      orionStatusLabel.textContent = 'Connecting…';
      orionStatusLabel.classList.add('lbl-connecting');
      break;
    case 'active':
      orionOrb.classList.add('orb-active');
      orionStatusLabel.textContent = 'Active';
      orionStatusLabel.classList.add('lbl-active');
      break;
    case 'listening':
      orionOrb.classList.add('orb-listening');
      orionStatusLabel.textContent = 'Listening…';
      orionStatusLabel.classList.add('lbl-listening');
      break;
    case 'speaking':
      orionOrb.classList.add('orb-speaking');
      orionStatusLabel.textContent = 'Speaking';
      orionStatusLabel.classList.add('lbl-speaking');
      break;
    case 'interrupted':
      orionOrb.classList.add('orb-interrupted');
      orionStatusLabel.textContent = 'Interrupted';
      orionStatusLabel.classList.add('lbl-interrupted');
      // Animation runs 3× (1.5s total) then auto-reverts to active
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) setStatus('active');
      }, 1600);
      break;
    default: // inactive / offline
      orionStatusLabel.textContent = 'ORION offline. Tap to wake.';
  }
}

function logRouting(text, type = 'turn') {
  const entry = document.createElement('div');
  entry.className = `routing-event ${type}`;
  entry.textContent = text;
  routingLog.appendChild(entry);
  routingLog.scrollTop = routingLog.scrollHeight;
  while (routingLog.children.length > 50) routingLog.removeChild(routingLog.firstChild);
}

/**
 * Upserts a transcript bubble for the given speaker.
 * Live API streams text in chunks — this updates the current in-progress
 * bubble in place instead of adding a new card for every chunk.
 * A new bubble is created only when the previous turn has been sealed
 * (currentOrionEntry / currentSurgeonEntry set to null on turnComplete).
 */
function _upsertTranscript(speaker, text) {
  if (!text?.trim()) return;

  const isSurgeon = speaker === 'surgeon';
  const current   = isSurgeon ? currentSurgeonEntry : currentOrionEntry;

  if (current) {
    // Update the existing in-progress bubble
    const textEl = current.querySelector('.text');
    if (textEl) textEl.innerHTML = escapeHtml(text);
  } else {
    // Start a new bubble for this turn
    const entry = document.createElement('div');
    entry.className = `transcript-entry ${speaker}`;
    entry.innerHTML = `
      <div class="speaker">${isSurgeon ? 'Surgeon' : 'ORION'}</div>
      <div class="text">${escapeHtml(text)}</div>`;
    transcriptLog.appendChild(entry);
    // Trim history
    while (transcriptLog.children.length > 100) transcriptLog.removeChild(transcriptLog.firstChild);

    if (isSurgeon) currentSurgeonEntry = entry;
    else           currentOrionEntry   = entry;
  }

  transcriptLog.scrollTop = transcriptLog.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
