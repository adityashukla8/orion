'use strict';

const LogPanel = (() => {
  let modal = null;
  let body  = null;

  // Event type → { short label for badge, accent colour }
  // Colours chosen to be distinct and medically intuitive (green=safe, red=danger, etc.)
  const _TYPE_META = {
    cvs_confirmed:    { label: 'CVS',      color: '#2e7d32' },
    timeout_complete: { label: 'TIMEOUT',  color: '#1565c0' },
    blood_loss:       { label: 'EBL',      color: '#e65100' },
    specimen_removed: { label: 'SPECIMEN', color: '#6a1b9a' },
    complication:     { label: 'COMPL.',   color: '#c62828' },
    milestone:        { label: 'STEP',     color: '#00695c' },
    note:             { label: 'NOTE',     color: '#546e7a' },
    photo:            { label: 'PHOTO',    color: '#4f46e5' },
  };

  // Default display text when the surgeon logs a type without a note
  const _DEFAULT_NOTES = {
    cvs_confirmed:    'Critical View of Safety confirmed',
    timeout_complete: 'WHO surgical safety timeout complete',
    specimen_removed: 'Specimen extracted and bagged',
    photo:            'Surgical photo saved to patient chart',
  };

  // In-memory photo store — keyed by timestamp. Holds base64 dataURLs.
  // In a real EHR integration these would be DICOM secondary captures or
  // JPEG attachments uploaded to the patient's operative note.
  const _photoStore = {};

  function _injectStyles() {
    if (document.getElementById('log-panel-styles')) return;
    const s = document.createElement('style');
    s.id = 'log-panel-styles';
    s.textContent = `
      #log-body { overflow-y: auto; max-height: 100%; padding: 6px 0; }
      .log-entry {
        display: flex; align-items: baseline; gap: 8px;
        padding: 5px 12px; font-size: 11px; line-height: 1.4;
        border-bottom: 1px solid rgba(140,175,220,0.12);
      }
      .log-entry:last-child { border-bottom: none; }
      .log-entry.log-photo-entry { align-items: flex-start; flex-wrap: wrap; }
      .log-ts {
        flex: 0 0 52px; font-size: 9px; font-weight: 600;
        color: #8aabcc; font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .log-badge {
        flex: 0 0 auto; font-size: 8px; font-weight: 700;
        letter-spacing: 0.06em; padding: 2px 5px;
        border-radius: 3px; color: #fff; white-space: nowrap;
      }
      .log-note { flex: 1; color: #1a2e4a; word-break: break-word; }
      .log-photo-meta { flex: 1; display: flex; flex-direction: column; gap: 1px; }
      .log-photo-step { font-size: 10px; font-weight: 600; color: #1a2e4a; }
      .log-photo-note { font-size: 10px; color: #4a6080; }
      .log-photo-saved {
        font-size: 9px; color: #4f46e5; font-weight: 600;
        letter-spacing: 0.04em; margin-top: 1px;
      }
      .log-thumb-wrap {
        flex: 0 0 100%; padding-left: 60px; margin-top: 4px; margin-bottom: 3px;
      }
      .log-thumb {
        width: 100%; max-width: 220px; border-radius: 4px;
        border: 1px solid rgba(79,70,229,0.28);
        display: block; cursor: pointer;
      }
      .log-thumb-placeholder {
        width: 100%; max-width: 220px; height: 60px; border-radius: 4px;
        border: 1px dashed rgba(79,70,229,0.35);
        background: rgba(79,70,229,0.04);
        display: flex; align-items: center; justify-content: center;
        font-size: 9px; color: rgba(79,70,229,0.55); letter-spacing: 0.08em;
        font-weight: 600;
      }
      .log-empty {
        padding: 14px 12px; font-size: 11px;
        color: #8aabcc; font-style: italic;
      }
    `;
    document.head.appendChild(s);
  }

  // Return the most recent surgical video frame.
  // Primary: reuse the frame already captured by app.js's startVideoCapture()
  // (avoids double canvas draw and cross-origin taint issues).
  // Fallback: direct <video> → canvas draw for environments where the shared
  // frame isn't yet available (e.g. photo triggered within the first second).
  function _grabVideoFrame() {
    const shared = window.ORION_getLatestFrame?.();
    if (shared) return shared;

    const video = document.getElementById('surgical-video') || document.querySelector('video');
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width  = 320;
      canvas.height = 240;
      canvas.getContext('2d').drawImage(video, 0, 0, 320, 240);
      return canvas.toDataURL('image/jpeg', 0.6);
    } catch (_) {
      return null;  // cross-origin SecurityError — fall through to placeholder
    }
  }

  function _entryHtml(entry) {
    if (entry.type === 'photo') return _photoEntryHtml(entry);
    const meta = _TYPE_META[entry.type] || _TYPE_META.note;
    const text = entry.note || _DEFAULT_NOTES[entry.type] || '';
    return `<div class="log-entry">
      <span class="log-ts">${_esc(entry.timestamp)}</span>
      <span class="log-badge" style="background:${meta.color}">${meta.label}</span>
      <span class="log-note">${_esc(text)}</span>
    </div>`;
  }

  function _photoEntryHtml(entry) {
    const meta    = _TYPE_META.photo;
    const dataUrl = _photoStore[entry.timestamp] || entry.photo_data || null;
    const step    = _esc(entry.surgical_step || '');
    const note    = _esc(entry.note || _DEFAULT_NOTES.photo);

    const thumbHtml = dataUrl
      ? `<img class="log-thumb" src="${dataUrl}" alt="Surgical photo — ${step}" title="Click to expand" />`
      : `<div class="log-thumb-placeholder">NO VIDEO SIGNAL</div>`;

    return `<div class="log-entry log-photo-entry">
      <span class="log-ts">${_esc(entry.timestamp)}</span>
      <span class="log-badge" style="background:${meta.color}">${meta.label}</span>
      <span class="log-photo-meta">
        <span class="log-photo-step">${step}</span>
        <span class="log-photo-note">${note}</span>
        <span class="log-photo-saved">&#10003; Saved to patient chart</span>
      </span>
      <div class="log-thumb-wrap">${thumbHtml}</div>
    </div>`;
  }

  function append(entry) {
    if (!body) return;
    const empty = body.querySelector('.log-empty');
    if (empty) empty.remove();
    body.insertAdjacentHTML('beforeend', _entryHtml(entry));
    body.scrollTop = body.scrollHeight;
    if (modal) { modal.classList.add('visible'); window.ORION_relayoutModals?.(); }
  }

  // Called by app.js for the 'capture_photo' render_command.
  // Grabs a live video frame, stores it keyed by timestamp, then appends.
  function capturePhoto(entry) {
    const dataUrl = _grabVideoFrame();
    if (dataUrl) _photoStore[entry.timestamp] = dataUrl;
    append(entry);
  }

  function showAll(entries) {
    if (!body) return;
    if (!entries || entries.length === 0) {
      body.innerHTML = '<div class="log-empty">No events logged yet.</div>';
    } else {
      body.innerHTML = entries.map(_entryHtml).join('');
      body.scrollTop = body.scrollHeight;
    }
    if (modal) { modal.classList.add('visible'); window.ORION_relayoutModals?.(); }
  }

  function hide() {
    if (modal) { modal.classList.remove('visible'); window.ORION_relayoutModals?.(); }
  }

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return { init: (config) => {
    modal = document.getElementById(config.modalId || 'log-modal');
    body  = document.getElementById(config.bodyId  || 'log-body');
    _injectStyles();
  }, append, capturePhoto, showAll, hide };
})();
