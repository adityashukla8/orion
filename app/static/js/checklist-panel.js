/**
 * checklist-panel.js — Surgical phase procedural context tile
 * =============================================================
 * Renders the current surgical phase label, 4-point checklist,
 * and an optional critical-warning banner as a tile panel.
 *
 * Public API (called by app.js dispatchRenderCommand):
 *   ChecklistPanel.init(config)
 *   ChecklistPanel.show(phase, label, checklist, warning)
 *   ChecklistPanel.hide()
 */

'use strict';

const ChecklistPanel = (() => {

  let modal = null;
  let body  = null;

  const STYLES = `
    #checklist-body {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      font-family: 'Poppins', sans-serif;
    }
    .pc-phase-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      color: #1a4e80;
      padding: 10px 14px 8px;
      border-bottom: 1px solid rgba(140, 175, 220, 0.22);
    }
    .pc-warning {
      font-size: 10px;
      font-weight: 600;
      background: rgba(229, 57, 53, 0.07);
      border-left: 3px solid #e53935;
      color: #b71c1c;
      padding: 7px 12px;
      line-height: 1.4;
    }
    .pc-checklist {
      padding: 8px 14px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .pc-item {
      font-size: 11px;
      line-height: 1.45;
      color: #1a2e4a;
      display: flex;
      gap: 9px;
      align-items: baseline;
    }
    .pc-num {
      flex: 0 0 14px;
      font-size: 9px;
      font-weight: 700;
      color: #6ea3cf;
      text-align: right;
    }
  `;

  // ── Public API ─────────────────────────────────────────────────────────────

  function init(config) {
    modal = document.getElementById(config.modalId || 'checklist-modal');
    body  = document.getElementById(config.bodyId  || 'checklist-body');

    if (!document.getElementById('orion-checklist-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'orion-checklist-styles';
      styleEl.textContent = STYLES;
      document.head.appendChild(styleEl);
    }
  }

  /**
   * Renders the phase label, checklist items, and optional warning banner.
   * @param {string} phase    - phase key (e.g. 'vascular_dissection')
   * @param {string} label    - human-readable phase name
   * @param {string[]} checklist - array of checklist item strings
   * @param {string|null} warning - optional critical warning text
   */
  function show(phase, label, checklist, warning) {
    if (!body) return;

    const warningHtml = warning
      ? `<div class="pc-warning">&#9888; ${_esc(warning)}</div>`
      : '';

    const itemsHtml = (checklist || [])
      .map((item, i) =>
        `<div class="pc-item"><span class="pc-num">${i + 1}</span>${_esc(item)}</div>`
      )
      .join('');

    body.innerHTML = `
      <div class="pc-phase-label">${_esc(label || phase)}</div>
      ${warningHtml}
      <div class="pc-checklist">${itemsHtml}</div>
    `;

    if (modal) { modal.classList.add('visible'); window.ORION_relayoutModals?.(); }
  }

  /**
   * Hides the checklist tile.
   */
  function hide() {
    if (modal) { modal.classList.remove('visible'); window.ORION_relayoutModals?.(); }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return { init, show, hide };

})();
