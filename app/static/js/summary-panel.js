/**
 * summary-panel.js — Agent text summary overlay tile
 * =====================================================
 * Renders a structured text summary from a specialist agent
 * (WHO Timeout, Operative Report, Complication Protocol, SBAR Handoff)
 * as a glass tile on the surgical display.
 *
 * Public API:
 *   SummaryPanel.init(config)
 *   SummaryPanel.show(title, content, bullets)
 *   SummaryPanel.hide()
 */

'use strict';

const SummaryPanel = (() => {

  let modal     = null;   // #summary-modal
  let titleEl   = null;   // .modal-title inside the tile
  let body      = null;   // #summary-body

  const STYLES = `
    #summary-body {
      overflow-y: auto;
      padding: 10px 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-family: 'Poppins', sans-serif;
    }
    .summary-content {
      font-size: 11.5px;
      color: rgba(20, 50, 110, 0.85);
      line-height: 1.55;
    }
    .summary-bullets {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .summary-bullet {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 5px 0;
      border-bottom: 1px solid rgba(180, 200, 235, 0.22);
    }
    .summary-bullet:last-child {
      border-bottom: none;
    }
    .summary-bullet-num {
      flex-shrink: 0;
      min-width: 18px;
      font-size: 9px;
      font-weight: 700;
      color: rgba(59, 130, 246, 0.8);
      padding-top: 2px;
      text-align: right;
    }
    .summary-bullet-text {
      font-size: 11px;
      color: rgba(20, 50, 110, 0.82);
      line-height: 1.45;
    }
  `;

  // ── Public API ───────────────────────────────────────────────────────────

  function init(config) {
    modal   = document.getElementById(config.modalId   || 'summary-modal');
    body    = document.getElementById(config.bodyId    || 'summary-body');
    titleEl = modal ? modal.querySelector('.modal-title') : null;

    if (!document.getElementById('orion-summary-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'orion-summary-styles';
      styleEl.textContent = STYLES;
      document.head.appendChild(styleEl);
    }
  }

  /**
   * Show the summary tile with a title, optional intro paragraph, and bullets.
   * @param {string}   title    — Tile header (e.g. 'Handoff — SBAR')
   * @param {string}   content  — Introductory text (can be '')
   * @param {string[]} bullets  — Array of bullet/step strings
   */
  function show(title, content, bullets) {
    if (!modal || !body) return;

    // Update the tile's title bar
    if (titleEl) titleEl.textContent = title || 'Summary';

    const contentHtml = (content && content.trim())
      ? `<div class="summary-content">${_esc(content)}</div>`
      : '';

    const bulletsArr = Array.isArray(bullets) ? bullets : [];
    const bulletsHtml = bulletsArr.length
      ? `<div class="summary-bullets">${
          bulletsArr.map((text, i) => `
            <div class="summary-bullet">
              <span class="summary-bullet-num">${i + 1}</span>
              <span class="summary-bullet-text">${_esc(text)}</span>
            </div>`).join('')
        }</div>`
      : '';

    body.innerHTML = contentHtml + bulletsHtml;
    modal.classList.add('visible');
    window.ORION_relayoutModals?.();
  }

  /**
   * Hide and clear the summary tile.
   */
  function hide() {
    if (!modal) return;
    modal.classList.remove('visible');
    if (body) body.innerHTML = '';
    window.ORION_relayoutModals?.();
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return { init, show, hide };

})();
