/* ui/editor.js — the CodeMirror 6 wrapper.
 *
 * This is the ONLY file that imports CodeMirror. Storage, preview, search, and
 * export stay editor-agnostic (AGENTS.md: the editor is swappable). The app
 * hands us a doc getter and a change callback; we never touch the database or
 * the note record.
 *
 * Packages load as ES modules through the import map in index.html — no
 * bundler. One instance each; the map pins every bare specifier so no package
 * is duplicated across the graph.
 */

import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';

// Syntax colours come from CSS variables so the editor follows the app's own
// light/dark scheme instead of CodeMirror's hardcoded palettes.
const highlightStyle = HighlightStyle.define([
  { tag: tags.content, color: 'var(--ink)' },
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.monospace, color: 'var(--cm-code)' },
  { tag: tags.comment, color: 'var(--muted)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--muted)' },
]);

const notedTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', fontSize: 'var(--editor-font-size, 15px)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    lineHeight: '1.7',
    color: 'var(--ink)',
    overflow: 'auto',
  },
  '.cm-content': { padding: '2px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 2px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted)',
    border: 'none',
    paddingRight: '8px',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ink) 4%, transparent)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--ink) 4%, transparent)',
  },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-placeholder': { color: 'var(--muted)' },
});

const extensions = [
  lineNumbers(),
  highlightActiveLine(),
  drawSelection(),
  history(),
  bracketMatching(),
  highlightSelectionMatches(),
  syntaxHighlighting(highlightStyle),
  markdown(),
  placeholder('Write Markdown…'),
  EditorView.lineWrapping,
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  notedTheme,
];

function isUserEdit(update) {
  if (!update.docChanged) return false;
  return update.transactions.some((t) => t.isUserEvent('input') || t.isUserEvent('undo') || t.isUserEvent('redo'));
}

export function createMarkdownEditor(parent, { getDoc, onDocChange }) {
  const updateListener = EditorView.updateListener.of((update) => {
    if (isUserEdit(update)) onDocChange(update.state.doc.toString());
  });

  let view = new EditorView({
    parent,
    state: EditorState.create({
      doc: getDoc(),
      extensions: [...extensions, updateListener],
    }),
  });

  return {
    view,
    /** Replace the document wholesale (used when switching notes). Resets undo history. */
    setDoc(doc) {
      if (view.state.doc.toString() === doc) return;
      view.setState(
        EditorState.create({
          doc,
          extensions: [...extensions, updateListener],
        }),
      );
    },
    destroy() {
      view.destroy();
    },
  };
}