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

export const DEFAULT_SETTINGS = {
  theme: 'system',
  editorFontSize: '15',
  defaultPreview: 'edit',
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
    if (raw.defaultPreview === 'edit' || raw.defaultPreview === 'preview') {
      s.defaultPreview = raw.defaultPreview;
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