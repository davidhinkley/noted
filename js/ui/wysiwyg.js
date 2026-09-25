/* ui/wysiwyg.js — the "Write" mode editor: a contenteditable rendering of the
 * note that round-trips to Markdown.
 *
 * The editor is swappable (AGENTS.md) and this is the second implementation
 * behind that seam. Like ui/editor.js it owns every mutation of the editing
 * surface and hands the rest of the app nothing but Markdown: storage, search,
 * export, and routing never learn that this mode exists. That is what lets
 * Write mode be swapped for a real rich-text engine later without touching a
 * caller.
 *
 * The cycle is marked -> DOMPurify -> contenteditable, and on every settled
 * edit contenteditable -> Turndown -> Markdown. So note.body stays raw
 * Markdown (D4) and the database never sees HTML.
 *
 * KNOWN LIMITATIONS (deliberate, v1):
 *  - The round-trip is lossy in the ways Markdown itself is ambiguous. Trailing
 *    "  " hard breaks, "setext" headings, and reference links come back in ATX
 *    / inline form. Formatting survives; exact bytes do not.
 *  - The whole document is re-rendered on each settled edit, so a caret sitting
 *    inside syntax that the parser consumed (`## ` becoming a heading) drifts by
 *    the width of the markers. Typing at the end of a line, which is the normal
 *    case, is unaffected. Typora solves this by revealing the raw source of the
 *    active block; that is the natural next step here.
 *  - Undo is ours, not the browser's: re-rendering wipes the native
 *    contenteditable history, so this module keeps a small Markdown snapshot
 *    stack and handles Mod-z / Mod-Shift-z itself.
 */

const SETTLE_MS = 250;
const UNDO_LIMIT = 200;

// Turndown is cheap to configure but not free to construct, and the GFM bundle
// must be present before it is useful; build one per page and reuse it.
let serializer = null;

function getSerializer() {
  if (serializer) return serializer;
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    // marked runs with breaks:true, so a <br> is just a newline. Emitting the
    // two-space hard-break form would bloat the stored Markdown and fight the
    // trailing-whitespace rules editors apply on save.
    br: '',
  });
  const gfm = window.turndownPluginGfm;
  if (gfm && gfm.gfm) {
    service.use(gfm.gfm);
  } else {
    console.warn('[noted] turndown-plugin-gfm missing; GFM tables and task lists will not round-trip');
  }
  // The gfm bundle covers tables, task lists and strikethrough, but not the
  // info string on a fenced block: marked's <code class="language-x"> would
  // lose its language on the way back to Markdown.
  service.addRule('fencedCodeLanguage', {
    filter(node) {
      return node.nodeName === 'CODE' && node.parentNode && node.parentNode.nodeName === 'PRE';
    },
    replacement(content, node) {
      const cls = node.getAttribute('class') || '';
      const lang = /language-([\w+-]+)/.exec(cls);
      const body = node.textContent.replace(/\n$/, '');
      return '\n\n```' + (lang ? lang[1] : '') + '\n' + body + '\n```\n\n';
    },
  });
  serializer = service;
  return service;
}

function renderMarkdown(body) {
  const html = marked.parse(body || '', { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}

// Turndown is faithful about structure and sloppy about the whitespace GFM
// leaves behind, so normalize the two things it reliably gets wrong rather
// than trusting the bytes verbatim.
function tidy(md) {
  return md
    .replace(/\r\n?/g, '\n')
    // 3+ blank lines collapse to one; Markdown only ever needs one.
    .replace(/\n{3,}/g, '\n\n')
    // A task marker plus the space the checkbox consumed, and any padding:
    // "- [x]  text" -> "- [x] text".
    .replace(/^(\s*(?:[-*+]|\d+\.)\s+\[[ xX]\])\s+/gm, '$1 ')
    // Turndown backslash-escapes Markdown metacharacters that reach it as
    // literal text. That is correct for a converter, and wrong here: in a
    // rendered document `*` is just a character, so escaping it means typing
    // `**bold**` stores `\*\*bold\*\*` and the next render shows plain
    // asterisks instead of bold — the one gesture this mode exists for.
    // Undo the escaping so typed syntax round-trips as syntax, the way Typora
    // and Obsidian behave. The cost is that a genuinely literal metacharacter
    // can no longer be written; a notes app whose whole point is Markdown
    // gets that trade.
    //
    // The class must be "punctuation", spelled out, rather than `[^\w\s]`:
    // \w includes the underscore, so that class silently skipped `\_` and
    // left typed `_italic_` as visible `\ _italic\ _`. `\w` is the wrong
    // notion of "safe to un-escape" — what matters is "is this a character
    // Markdown can backslash-escape", which is ASCII punctuation. Letters,
    // digits and whitespace are excluded so an intentional literal backslash
    // (`C:\new`) survives the round-trip as a backslash rather than turning
    // into a newline.
    .replace(/\\([!-\/:-@\[-`{-~])/g, '$1')
    // Drop the caret anchor (see placeCaretAtEnd) so it never reaches storage.
    .replace(/\u200b/g, '')
    .trim();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// ---- caret preservation -----------------------------------------------------
//
// A character offset is not stable across a re-render (the markers the parser
// ate are not text nodes), so the caret is tracked as a top-level block index
// plus an offset inside that block. The block index is stable because marked
// emits one element per source block, and the in-block offset is stable because
// it counts only visible text, which is exactly what survives the round-trip.

function currentRange(host) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return host.contains(range.startContainer) ? range : null;
}

/** The blocks of the document, as ELEMENT children only.
 *
 * marked separates blocks with literal "\n" text nodes, so childNodes is
 * [P, #text, P, #text, ...] and the last child is very often a stray text node
 * rather than the last block. Indexing childNodes directly made blockIndex
 * depend on how many newlines the parser happened to emit, which drifts as the
 * document changes — and put the caret in a document-level text node where
 * escapeInlineTail can find no inline ancestor to escape, so the next thing
 * typed silently inherited the trailing formatting. */
function blockElements(host) {
  return [...host.childNodes].filter((n) => n.nodeType === 1);
}

function readCaret(host) {
  const range = currentRange(host);
  if (!range) return null;
  let el = range.startContainer.nodeType === 3 ? range.startContainer.parentNode : range.startContainer;
  while (el && el.parentNode !== host) el = el.parentNode;
  if (!el || el.parentNode !== host) return null;
  const blockIndex = blockElements(host).indexOf(el);
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return { blockIndex, offset: pre.toString().length };
}

function writeCaret(host, position) {
  if (!position) return false;
  const blocks = blockElements(host);
  if (!blocks.length) return false;
  const el = blocks[Math.min(position.blockIndex, blocks.length - 1)];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = position.offset;
  let node = walker.nextNode();
  while (node) {
    if (remaining <= node.nodeValue.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      escapeInlineTail(host);
      return true;
    }
    remaining -= node.nodeValue.length;
    node = walker.nextNode();
  }
  // Nothing long enough to land in (an empty block): park the caret at its end.
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  escapeInlineTail(host);
  return true;
}

// A zero-width space is the standard trick for parking a caret outside inline
// formatting: the browser will happily place one inside a trailing <strong>,
// and everything typed next then inherits that formatting. An empty text node
// is the only position inside a block that is unambiguously "after the run".
const ZWSP = '\u200b';
const INLINE_RE = /^(STRONG|EM|B|I|CODE|A|DEL|S|INS|MARK|U|SPAN|SUB|SUP)$/;

/** If the caret sits at the very end of a trailing inline run (`<strong>` etc.),
 * move it to a zero-width space just after that run. Without this, repainting
 * drops the caret back inside the formatting and the next thing typed silently
 * inherits it — typing after a bold line would keep bolding.
 * Only the end-of-run case moves; a caret in the middle of bold text stays. */
function escapeInlineTail(host) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!host.contains(range.startContainer)) return;
  let el = range.startContainer.nodeType === 3 ? range.startContainer.parentNode : range.startContainer;
  let inline = null;
  while (el && el !== host) {
    if (el.nodeType === 1 && INLINE_RE.test(el.nodeName)) inline = el;
    el = el.parentNode;
  }
  if (!inline || !inline.parentNode || inline.nextSibling) return;
  // Is the caret exactly at the end of that run's text?
  const upto = document.createRange();
  upto.selectNodeContents(inline);
  upto.setEnd(range.startContainer, range.startOffset);
  if (upto.toString().length !== inline.textContent.length) return;
  const zw = document.createTextNode(ZWSP);
  inline.parentNode.appendChild(zw);
  const escaped = document.createRange();
  escaped.setStart(zw, 0);
  escaped.collapse(true);
  sel.removeAllRanges();
  sel.addRange(escaped);
}

/** Place the caret at the end of the last block, outside any inline formatting.
 * `focus()` alone leaves a contentEditable with no selection, so execCommand
 * has nothing to act on; landing inside a trailing <strong> is worse, because
 * the next thing typed silently becomes bold. */
function placeCaretAtEnd(host) {
  if (host.offsetParent === null) return false; // hidden (other view modes): no caret to place
  let blocks = blockElements(host);
  // An empty note renders to no elements at all, so there is nowhere to put a
  // caret. Give the document a single empty block first.
  if (!blocks.length) {
    host.innerHTML = '<p><br></p>';
    blocks = blockElements(host);
  }
  const last = blocks[blocks.length - 1];
  // If the block ends in an inline run, append a zero-width space as a direct
  // child of the block and put the caret in that instead.
  const tail = last.lastChild;
  if (tail && tail.nodeType === 1 && INLINE_RE.test(tail.nodeName)) {
    const zw = document.createTextNode(ZWSP);
    last.appendChild(zw);
    const range = document.createRange();
    range.setStart(zw, 0);
    range.collapse(true);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    host.focus();
    return true;
  }
  const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  // Walk to the final text node, then collapse the caret at its end.
  while (node) {
    const next = walker.nextNode();
    if (!next) break;
    node = next;
  }
  const target = node || last;
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  host.focus();
  return true;
}

export function createWysiwygEditor(parent, { getBody, onBodyChange }) {
  // Use the mount element itself as the editing surface, the way editor.js
  // does. Wrapping it in a second div would make querySelector('.wysiwyg-host')
  // resolve to the wrapper, not the contenteditable, and every keystroke would
  // land on an element that never fires this module's `input` listener.
  const host = parent;
  host.classList.add('markdown-body');
  host.contentEditable = 'true';
  host.spellcheck = true;
  host.setAttribute('role', 'textbox');
  host.setAttribute('aria-multiline', 'true');
  host.setAttribute('aria-label', 'Note body');

  // The Markdown currently painted into the DOM. Everything else derives from
  // it, so a settle that changes nothing is a no-op.
  let painted = null;
  let lastCaret = null;
  let settleTimer = null;
  const undoStack = [];
  const redoStack = [];

  // makeSelectable's changes do not fire `input`, but some browsers still
  // report one; the guard keeps a repaint from re-entering the commit path.
  let repainting = false;

  function makeSelectable() {
    // Task-list checkboxes are rendered disabled because a preview is
    // read-only; in Write mode they are the fastest way to tick a box, so make
    // them live and keep them out of the caret's way.
    for (const box of host.querySelectorAll('input[type="checkbox"]')) {
      box.removeAttribute('disabled');
      box.contentEditable = 'false';
    }
  }

  function paint(body, position) {
    const scrollTop = host.scrollTop;
    repainting = true;
    host.innerHTML = renderMarkdown(body);
    repainting = false;
    makeSelectable();
    painted = body;
    if (position) {
      writeCaret(host, position);
      // Only restore scroll when the caret was restored: mounting a note should
      // start at the top of the document.
      host.scrollTop = scrollTop;
    } else {
      // A fresh paint (mount, setBody) needs a caret or the editor is unusable:
      // focus() alone leaves a contentEditable with no selection, so execCommand
      // has nothing to act on and the first keystroke is silently lost.
      placeCaretAtEnd(host);
    }
  }

  /** Serialize the edited DOM, publish it, and repaint so the user sees the
   * formatting they just typed. This is the whole "see the result as you type"
   * loop, and it is debounced so it does not fight fast typists. */
  function settle() {
    clearTimeout(settleTimer);
    settleTimer = null;
    const position = readCaret(host);
    const md = tidy(getSerializer().turndown(host.innerHTML));
    if (md === painted) return;
    undoStack.push({ body: painted, caret: lastCaret });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    painted = md;
    onBodyChange(md);
    paint(md, position);
  }

  function schedule() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  }

  function apply(body) {
    clearTimeout(settleTimer);
    settleTimer = null;
    undoStack.length = 0;
    redoStack.length = 0;
    lastCaret = null;
    paint(body || '', null);
  }

  function step(from, to) {
    const entry = from.pop();
    if (!entry) return false;
    to.push({ body: painted, caret: lastCaret });
    painted = entry.body;
    onBodyChange(entry.body);
    paint(entry.body, entry.caret);
    return true;
  }

  function undo() {
    return step(undoStack, redoStack);
  }

  function redo() {
    return step(redoStack, undoStack);
  }

  // ---- formatting -----------------------------------------------------------
  //
  // execCommand is deprecated, but it is still the only way to apply a
  // rich-text command to a contenteditable without shipping a selection model,
  // and it emits exactly the tags Turndown already knows how to read back. The
  // toolbar is @mousedown.prevent, so the selection survives the click.

  const PLACEHOLDER = 'text';
  const inHost = (fn) => (currentRange(host) ? fn() : false);

  /** Insert `html` over the selection, leaving the given text selected. */
  function insertAndSelect(html, tag, text) {
    document.execCommand('insertHTML', false, html);
    const el = document.getSelection().getRangeAt(0).startContainer;
    const target = el.nodeType === 3 ? el.parentNode : el;
    const inner = target.querySelector(tag) || target;
    const start = (inner.textContent || '').indexOf(text);
    const selection = document.getSelection();
    const range = document.createRange();
    if (start < 0) {
      range.selectNodeContents(target);
    } else {
      const node = inner.firstChild || inner;
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  /** Wrap the selection in `tag`. A collapsed selection seeds a placeholder
   * and leaves it selected, matching the source editor's affordance. */
  function wrap(tag, open, close) {
    const selected = currentRange(host).toString();
    const inner = selected || PLACEHOLDER;
    return insertAndSelect(`<${tag}>${escapeHtml(open + inner + close)}</${tag}>`, tag, inner);
  }

  /** execCommand with nothing selected is a no-op, so seed a placeholder,
   * apply the command, then re-select the placeholder for typing over. */
  function execOrPlaceholder(command, tag) {
    if (currentRange(host).toString()) return document.execCommand(command);
    insertAndSelect(`<${tag}></${tag}>`, tag, '');
    return document.execCommand(command);
  }

  /** formatBlock, toggling off when the caret is already inside that block. */
  function toggleBlock(tag) {
    const anchor = currentRange(host).startContainer;
    const el = anchor.nodeType === 3 ? anchor.parentNode : anchor;
    const current = el && el.closest ? el.closest(tag.toLowerCase()) : null;
    document.execCommand('formatBlock', false, current ? 'P' : tag);
    return true;
  }

  function insertLink(isImage) {
    const selected = currentRange(host).toString();
    const label = selected || PLACEHOLDER;
    const url = window.prompt(isImage ? 'Image URL' : 'Link URL', 'https://');
    if (!url) return false;
    return insertAndSelect(
      isImage
        ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(label)}">`
        : `<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`,
      isImage ? 'img' : 'a',
      isImage ? '' : label,
    );
  }

  const ACTIONS = {
    bold: () => inHost(() => execOrPlaceholder('bold', 'B')),
    italic: () => inHost(() => execOrPlaceholder('italic', 'I')),
    strike: () => inHost(() => execOrPlaceholder('strikeThrough', 'STRIKE')),
    code: () => inHost(() => wrap('code', '`', '`')),
    h1: () => inHost(() => toggleBlock('H1')),
    h2: () => inHost(() => toggleBlock('H2')),
    h3: () => inHost(() => toggleBlock('H3')),
    ul: () => inHost(() => document.execCommand('insertUnorderedList')),
    ol: () => inHost(() => document.execCommand('insertOrderedList')),
    quote: () => inHost(() => toggleBlock('BLOCKQUOTE')),
    codeblock: () => inHost(() => wrap('pre', '```\n', '\n```')),
    link: () => inHost(() => insertLink(false)),
    image: () => inHost(() => insertLink(true)),
    hr: () => inHost(() => document.execCommand('insertHorizontalRule')),
  };

  // ---- events ---------------------------------------------------------------

  host.addEventListener('input', () => {
    if (repainting) return;
    lastCaret = readCaret(host);
    schedule();
  });

  // Ctrl/Cmd-click follows the link out of the app; a plain click must place the
  // caret instead of navigating away and losing the note.
  host.addEventListener('click', (e) => {
    const link = e.target && e.target.closest ? e.target.closest('a') : null;
    if (link && !(e.metaKey || e.ctrlKey)) e.preventDefault();
    lastCaret = readCaret(host);
  });

  // Task-list checkboxes: let the browser own the toggle (it fires `change`
  // after the checked state has actually flipped) and just re-serialize.
  // Doing the flip by hand after preventDefault() raced the browser's own
  // activation behaviour and left the box in its original state.
  //
  // The checked ATTRIBUTE is what Turndown's gfm task-list rule reads, not the
  // `checked` property, and clicking a box only moves the property. Mirror one
  // onto the other before serializing or the flip is silently lost.
  host.addEventListener('change', (e) => {
    const box = e.target;
    if (!box || box.tagName !== 'INPUT' || box.type !== 'checkbox') return;
    box.toggleAttribute('checked', box.checked);
    settle();
  });

  // Pasting foreign HTML would import its styles and classes, so paste the
  // Markdown instead: rich text becomes Markdown, and the next settle renders
  // it back through marked.
  host.addEventListener('paste', (e) => {
    e.preventDefault();
    const clipboard = e.clipboardData;
    const html = clipboard && clipboard.getData('text/html');
    const text = clipboard && clipboard.getData('text/plain');
    if (html) {
      document.execCommand('insertText', false, tidy(getSerializer().turndown(html)));
    } else if (text) {
      document.execCommand('insertText', false, text);
    }
    lastCaret = readCaret(host);
    schedule();
  });

  host.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    // Re-rendering wipes the browser's contenteditable history, so undo/redo is
    // owned here — but only while Write mode has focus. The global handler in
    // app.js otherwise answers the same keys for the source editor.
    if (!host.contains(document.activeElement)) return;
    if (key === 'b') {
      e.preventDefault();
      ACTIONS.bold();
      settle();
    } else if (key === 'i') {
      e.preventDefault();
      ACTIONS.italic();
      settle();
    } else if (key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  });

  apply(getBody() || '');

  return {
    element: host,

    /** Run a named formatting action, matching ui/editor.js. No-op if unknown. */
    runAction(name) {
      const action = ACTIONS[name];
      if (!action) return;
      action();
      // A toolbar click is discrete, not typing: commit immediately so the
      // result is visible without waiting out the debounce.
      settle();
    },

    /** Replace the body wholesale (used when switching notes). Resets undo. */
    setBody(body) {
      apply(body || '');
    },

    /** Commit any pending edit right now (used when leaving Write mode). */
    flush() {
      if (settleTimer) settle();
    },

    focus() {
      host.focus();
    },

    /** Re-place the caret if the host became visible. The mount-time paint runs
     * while the host is still hidden (other view mode), so offsetParent is null
     * and no caret is placed; entering Write mode must redo it. */
    ensureCaret() {
      const sel = document.getSelection();
      if (sel && sel.rangeCount && host.contains(sel.anchorNode)) return;
      placeCaretAtEnd(host);
    },

    destroy() {
      clearTimeout(settleTimer);
      settleTimer = null;
      // The host is the mount element, so it must not be removed from the DOM —
      // Alpine owns it. Just detach the listeners and clear the surface.
      host.contentEditable = 'false';
      host.innerHTML = '';
      host.classList.remove('markdown-body');
    },
  };
}
