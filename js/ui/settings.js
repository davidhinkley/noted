/* ui/settings.js — app settings: the ONLY sanctioned localStorage use
 * (AGENTS.md: "settings, never note data"). Note data stays in IndexedDB.
 *
 * Stored under the single key `noted.settings` as one JSON object so a bad
 * value can never corrupt more than one setting and the whole record is
 * easy to reset. Unknown/extra keys are ignored on load so a newer app's
 * settings load cleanly into an older one (same forward-compat stance as
 * import, see io/import.js).
 */

export const STORAGE_KEY = 'noted.settings';

// View modes for the note editor. Order is the Ctrl+E cycle order.
// 'write' is the WYSIWYG surface (T35): the rendered document is the editing
// surface, so Markdown markers are hidden while you write.
export const VIEW_MODES = ['edit', 'split', 'write', 'preview'];

export const DEFAULT_SETTINGS = {
  theme: 'system',
  editorFontSize: '15',
  defaultView: 'edit',
};

export const FONT_SIZES = [13, 15, 17];

export function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const s = { ...DEFAULT_SETTINGS };
    if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') {
      s.theme = raw.theme;
    }
    if (FONT_SIZES.includes(Number(raw.editorFontSize))) {
      s.editorFontSize = String(Number(raw.editorFontSize));
    }
    // `defaultPreview` predates the split mode (T28) and held only
    // 'edit'|'preview'. Read it as a fallback so an existing preference is
    // carried over by the rename rather than silently reset.
    const view = raw.defaultView ?? raw.defaultPreview;
    if (VIEW_MODES.includes(view)) {
      s.defaultView = view;
    }
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** Push settings onto the page without touching storage. */
export function applySettings(settings) {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--editor-font-size', `${settings.editorFontSize}px`);
}