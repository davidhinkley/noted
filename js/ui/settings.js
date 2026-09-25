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
//
// 'edit' is the WYSIWYG surface (T36): the rendered document IS the editing
// surface, so Markdown markers are hidden while you write and there is no
// separate preview to look at. 'code' is the raw-Markdown source editor
// (CodeMirror) for when you want to see or hand-edit the syntax itself.
//
// Split and Preview were retired in T37. Both were scaffolding for the idea
// that a writer needs the rendered result beside the source; once Write mode
// renders as you type, Preview is just Write with the cursor hidden and Split
// is just two panes of the same document.
export const VIEW_MODES = ['edit', 'code'];

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
    // Settings migration. 'edit' used to mean the raw-Markdown source editor
    // and still does in name only — it now means the WYSIWYG surface, so
    // carrying an old 'edit' straight over would silently move a user who
    // asked for the source view onto a rendered one. Map the old meanings
    // explicitly instead of relying on the name:
    //   old 'edit'    (raw source)     -> 'code'   (the same surface)
    //   old 'write'   (WYSIWYG)         -> 'edit'
    //   old 'split'/'preview' (rendered)-> 'edit'   (closest match)
    // 'defaultPreview' predates all of this and held only 'edit'|'preview'.
    const LEGACY_VIEW = {
      edit: 'code',
      write: 'edit',
      split: 'edit',
      preview: 'edit',
    };
    const rawView = raw.defaultView ?? raw.defaultPreview;
    const view = rawView == null ? undefined : LEGACY_VIEW[rawView] ?? rawView;
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