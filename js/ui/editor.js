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

import { EditorState, EditorSelection } from '@codemirror/state';
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

function isUserEdit(update) {
  if (!update.docChanged) return false;
  return update.transactions.some((t) => t.isUserEvent('input') || t.isUserEvent('undo') || t.isUserEvent('redo'));
}

// Everything the formatting toolbar dispatches is annotated as a user 'input'
// event, so isUserEdit fires the debounced save and history collapses each
// action to one undo step. Without the annotation these edits would be
// invisible to the save path.
const FORMAT_EVENT = 'input.format';

// Wrap the selection in inline markers. With no selection, insert the pair and
// leave the caret between the markers.
function wrapSelection(view, before, after) {
  const changes = view.state.changeByRange((range) => {
    const selected = view.state.sliceDoc(range.from, range.to);
    if (!selected) {
      return {
        changes: { from: range.from, insert: before + after },
        range: EditorSelection.cursor(range.from + before.length),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: before + selected + after },
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    };
  });
  view.dispatch(changes, { userEvent: FORMAT_EVENT });
  view.focus();
}

// The unique set of lines touched by the current selection(s). A Map keyed by
// line start keeps overlapping selections from emitting duplicate changes,
// which CodeMirror rejects.
function targetLines(state) {
  const lines = new Map();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      lines.set(line.from, line);
    }
  }
  return [...lines.values()];
}

function dispatchLineChanges(view, edits) {
  if (!edits.length) return;
  view.dispatch({ changes: edits, userEvent: FORMAT_EVENT });
  view.focus();
}

// Headings are mutually exclusive: H2 on an H1 line replaces the marker rather
// than stacking one. Pressing the current level clears the heading.
function setHeading(view, level) {
  const prefix = `${'#'.repeat(level)} `;
  const edits = targetLines(view.state).map((line) => {
    const m = /^(#{1,6})\s+/.exec(line.text);
    const rest = line.text.slice(m ? m[0].length : 0);
    const isSame = m && m[1].length === level;
    return { from: line.from, to: line.to, insert: isSame ? rest : prefix + rest };
  });
  dispatchLineChanges(view, edits);
}

// Toggle a uniform per-line prefix (blockquote). If every target line already
// carries it, remove it; otherwise add it to the lines missing it.
function toggleLinePrefix(view, prefix) {
  const lines = targetLines(view.state);
  const allPrefixed = lines.length > 0 && lines.every((l) => l.text.startsWith(prefix));
  const edits = [];
  for (const line of lines) {
    const has = line.text.startsWith(prefix);
    if (allPrefixed) {
      edits.push({ from: line.from, to: line.from + prefix.length, insert: '' });
    } else if (!has) {
      edits.push({ from: line.from, to: line.from, insert: prefix });
    }
  }
  dispatchLineChanges(view, edits);
}

// Any existing list marker, bullet or ordered, so switching list types replaces
// rather than stacks ("- x" → "1. x", not "1. - x").
const LIST_ITEM_RE = /^(?:[-*+]|\d+\.)\s+/;

// Bullet and ordered lists share this: strip whatever marker is present, then
// apply the target type (numbering across the selection). Pressing the active
// type on an all-of-type selection removes the marker.
function setListType(view, kind) {
  const lines = targetLines(view.state);
  const markerRe = kind === 'ol' ? /^\d+\.\s+/ : /^[-*+]\s+/;
  const allMatch = lines.length > 0 && lines.every((l) => markerRe.test(l.text));
  const edits = [];
  let n = 1;
  for (const line of lines) {
    const body = line.text.replace(LIST_ITEM_RE, '');
    if (allMatch) {
      edits.push({ from: line.from, to: line.to, insert: body });
    } else {
      const prefix = kind === 'ol' ? `${n}. ` : '- ';
      edits.push({ from: line.from, to: line.to, insert: prefix + body });
      n += 1;
    }
  }
  dispatchLineChanges(view, edits);
}

// Fenced block / horizontal rule. The selection (if any) becomes the body and
// the caret lands inside it; otherwise the caret lands on the empty middle line.
function insertBlock(view, open, close) {
  const changes = view.state.changeByRange((range) => {
    const selected = view.state.sliceDoc(range.from, range.to);
    const insert = open + selected + close;
    const start = range.from + open.length;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(start, start + selected.length),
    };
  });
  view.dispatch(changes, { userEvent: FORMAT_EVENT });
  view.focus();
}

// Link / image. A selection becomes the label (or alt text) and the caret
// selects the placeholder URL so it can be typed over immediately.
function insertLink(view, isImage) {
  const lead = isImage ? '![' : '[';
  const changes = view.state.changeByRange((range) => {
    const selected = view.state.sliceDoc(range.from, range.to);
    const label = selected || 'text';
    const insert = `${lead}${label}](url)`;
    const urlStart = range.from + lead.length + label.length + 2;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlStart, urlStart + 3),
    };
  });
  view.dispatch(changes, { userEvent: FORMAT_EVENT });
  view.focus();
}

// The toolbar/keymap action table. Names match the data-md-action attributes in
// index.html and the keys in app.js formatAction.
const MD_ACTIONS = {
  bold: (view) => wrapSelection(view, '**', '**'),
  italic: (view) => wrapSelection(view, '*', '*'),
  strike: (view) => wrapSelection(view, '~~', '~~'),
  code: (view) => wrapSelection(view, '`', '`'),
  h1: (view) => setHeading(view, 1),
  h2: (view) => setHeading(view, 2),
  h3: (view) => setHeading(view, 3),
  ul: (view) => setListType(view, 'ul'),
  ol: (view) => setListType(view, 'ol'),
  quote: (view) => toggleLinePrefix(view, '> '),
  codeblock: (view) => insertBlock(view, '```\n', '\n```'),
  link: (view) => insertLink(view, false),
  image: (view) => insertLink(view, true),
  hr: (view) => insertBlock(view, '\n---\n', ''),
};

// Mod-b / Mod-i mirror the two most-used toolbar buttons. Placed before the
// default keymap so they win the binding.
const formatKeymap = keymap.of([
  { key: 'Mod-b', run: (view) => (MD_ACTIONS.bold(view), true) },
  { key: 'Mod-i', run: (view) => (MD_ACTIONS.italic(view), true) },
]);

// Built after formatKeymap (referenced above) and after the action table, so
// the module has no forward references at initialization time.
const extensions = [
  lineNumbers(),
  highlightActiveLine(),
  drawSelection(),
  history(),
  bracketMatching(),
  highlightSelectionMatches(),
  syntaxHighlighting(highlightStyle),
  markdown(),
  placeholder('Write Markdown...'),
  EditorView.lineWrapping,
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  formatKeymap,
  notedTheme,
];

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
    /** Run a named Markdown formatting action (see MD_ACTIONS). No-op if unknown. */
    runAction(name) {
      const action = MD_ACTIONS[name];
      if (action) action(view);
    },
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