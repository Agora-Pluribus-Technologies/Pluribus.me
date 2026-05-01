// Block-based editor state
let currentBlocks = [];
let blockIdCounter = 0;
let pendingBlockCallback = null;
let activeInlineEditIndex = null;
let activeInlineEditorInstance = null;

// Generate unique block ID
function generateBlockId() {
  return `block-${Date.now()}-${blockIdCounter++}`;
}

// ============================================
// Markdown <-> Blocks Conversion
// ============================================

function parseMarkdownToBlocks(markdown) {
  if (!markdown || !markdown.trim()) {
    return [];
  }

  // Clean up <br> tags
  markdown = markdown.replace(/<br\s*\/?>/gi, '');

  // Split by horizontal rules
  const sections = markdown.split(/\n---\n|\n---$|^---\n/);
  const blocks = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Legacy embed block (```embed\n<URL or HTML>\n```). The editor no
    // longer emits this — embeds are now raw <iframe> HTML inside a
    // panel block. Convert on load so saving the page rewrites the
    // legacy syntax to the new form, while published sites keep working
    // via the renderer's backwards-compat branch in the meantime.
    const embedMatch = trimmed.match(/^```embed\n([\s\S]*?)\n```$/);
    if (embedMatch) {
      const iframeHtml = embedContentToIframeHtml(embedMatch[1].trim());
      blocks.push({
        id: generateBlockId(),
        type: 'panel',
        content: iframeHtml,
      });
      continue;
    }

    // Check for link-button block
    const linkButtonMatch = trimmed.match(/^```link-button\n([\s\S]*?)\n```$/);
    if (linkButtonMatch) {
      blocks.push({
        id: generateBlockId(),
        type: 'link-button',
        content: linkButtonMatch[1].trim()
      });
      continue;
    }

    // Default: panel block. Panels can hold prose, iframes (raw HTML),
    // images by URL, math, wikilinks, etc. Standalone-image markdown
    // used to be a dedicated `image` block type, but the in-editor
    // image upload feature was removed; existing image markdown now
    // lives inside panel blocks and renders normally through marked.
    blocks.push({
      id: generateBlockId(),
      type: 'panel',
      content: trimmed
    });
  }

  return blocks;
}

// Convert legacy embed-block content (a YouTube URL, a SoundCloud URL,
// or raw iframe HTML) to the iframe HTML the published-site renderer
// understands. Mirrors the renderer-side helpers in owo-template.js
// (youtubeUrlToEmbed / soundcloudUrlToEmbed) so a converted block
// renders identically before and after the parser change. The output
// is wrapped in a `<div class="embed-container">` so:
//   1. Existing `.embed-container { text-align: center }` CSS keeps
//      working — bare iframes wouldn't pick that up.
//   2. The block starts with a `<div>`, which marked parses as a
//      block-level HTML block reliably (a bare `<iframe>` straddles
//      the inline-vs-block-level grey area in some marked versions).
function embedContentToIframeHtml(content) {
  if (!content) return '';
  const trimmed = content.trim();
  let iframe;
  if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
    const videoId = extractYouTubeVideoId(trimmed);
    if (videoId) {
      iframe = `<iframe sandbox="allow-scripts allow-same-origin" width="560" height="315" src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
    }
  } else if (trimmed.includes('soundcloud.com')) {
    const encodedUrl = encodeURIComponent(trimmed);
    iframe = `<iframe sandbox="allow-scripts allow-same-origin" width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodedUrl}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true"></iframe>`;
  }
  // Not a recognized URL — assume the user already supplied raw HTML.
  // Pass through verbatim; the renderer's body-level sanitize +
  // injectIframeSandbox will lock down whatever they wrote.
  if (!iframe) return trimmed;
  return `<div class="embed-container">${iframe}</div>`;
}

function blocksToMarkdown(blocks) {
  const parts = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'link-button':
        parts.push(`\`\`\`link-button\n${block.content}\n\`\`\``);
        break;
      case 'panel':
      default:
        // Embeds are panel blocks containing raw <iframe> HTML — they
        // round-trip through this default branch unchanged.
        parts.push(block.content);
        break;
    }
  }

  return parts.join('\n\n---\n\n');
}

// ============================================
// Block Editor Initialization
// ============================================

function initBlockEditor() {
  const editorContainer = document.getElementById('editor');
  if (!editorContainer) {
    console.error('Editor container not found');
    return;
  }

  // Show the publish button for pages sites
  const deployButton = document.getElementById('deployButton');
  if (deployButton) {
    deployButton.style.display = '';
  }

  // Show the publish status for pages sites
  const publishStatus = document.getElementById('publishStatus');
  if (publishStatus) {
    publishStatus.style.display = '';
  }

  // Hide footer text links in the block editor
  document.querySelectorAll('.footer-text').forEach(el => el.style.display = 'none');

  // Hide the Ko-fi button in the block editor
  document.querySelectorAll('.floatingchat-container-wrap').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.floatingchat-container-wrap-mobi').forEach(el => el.style.display = 'none');

  // Reduce footer padding to prevent excessive whitespace in block editor on mobile
  document.querySelector('#footer').style.paddingBottom = '10px';

  editorContainer.innerHTML = '';
  editorContainer.className = 'block-editor';

  renderAllBlocks();
}

function loadBlocksFromCache() {
  const cacheItem = getCacheByFileName(currentSitePath);
  if (cacheItem && cacheItem.content) {
    currentBlocks = parseMarkdownToBlocks(cacheItem.content);
  } else {
    currentBlocks = [];
  }
}

// Load page content into block editor (called from on-load.js)
function loadPageIntoBlockEditor(content) {
  currentBlocks = parseMarkdownToBlocks(content);
  renderAllBlocks();
}

function saveBlocksToCache() {
  const markdown = blocksToMarkdown(currentBlocks);
  const cacheItem = getCacheByFileName(currentSitePath);
  if (cacheItem) {
    cacheItem.content = markdown;
    cacheItem.modifiedAt = new Date().toISOString();
    modified = true;
    if (typeof rescanForConflictMarkers === "function") {
      rescanForConflictMarkers();
    }
    if (typeof checkPageSizeLimit === "function") {
      checkPageSizeLimit();
    }
    updateDeployButtonState();
  }
}

// ============================================
// Block Rendering
// ============================================

function renderAllBlocks() {
  const container = document.getElementById('editor');
  container.innerHTML = '';

  // Add initial plus button
  container.appendChild(createAddBlockButton(-1));

  // Render each block with plus button after
  currentBlocks.forEach((block, index) => {
    container.appendChild(renderBlock(block, index));
    container.appendChild(createAddBlockButton(index));
  });
}

function renderBlock(block, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'block-item';
  wrapper.dataset.index = index;
  wrapper.dataset.id = block.id;

  const controls = document.createElement('div');
  controls.className = 'block-controls';

  const controlsLeft = document.createElement('div');
  controlsLeft.className = 'block-controls-left';

  const moveUpBtn = document.createElement('button');
  moveUpBtn.className = 'block-move-btn';
  moveUpBtn.innerHTML = '&#x25B2;';
  moveUpBtn.title = 'Move up';
  moveUpBtn.disabled = index === 0;
  moveUpBtn.addEventListener('click', () => moveBlockUp(index));

  const moveDownBtn = document.createElement('button');
  moveDownBtn.className = 'block-move-btn';
  moveDownBtn.innerHTML = '&#x25BC;';
  moveDownBtn.title = 'Move down';
  moveDownBtn.disabled = index === currentBlocks.length - 1;
  moveDownBtn.addEventListener('click', () => moveBlockDown(index));

  const typeLabel = document.createElement('span');
  typeLabel.className = 'block-type-label';
  typeLabel.textContent = block.type.charAt(0).toUpperCase() + block.type.slice(1);

  controlsLeft.appendChild(moveUpBtn);
  controlsLeft.appendChild(moveDownBtn);
  controlsLeft.appendChild(typeLabel);

  const controlsRight = document.createElement('div');
  controlsRight.className = 'block-controls-right';

  const editBtn = document.createElement('button');
  editBtn.className = 'block-edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => editBlock(index));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'block-delete-btn';
  deleteBtn.innerHTML = '&times;';
  deleteBtn.title = 'Delete block';
  deleteBtn.addEventListener('click', () => deleteBlock(index));

  controlsRight.appendChild(editBtn);
  controlsRight.appendChild(deleteBtn);

  controls.appendChild(controlsLeft);
  controls.appendChild(controlsRight);

  const preview = document.createElement('div');
  preview.className = 'block-preview';
  preview.innerHTML = renderBlockPreview(block);

  if (block.type === 'panel') {
    preview.classList.add('block-preview-clickable');
    preview.addEventListener('click', (e) => {
      // Wikilinks in the preview should not navigate; they only enter edit mode.
      if (e.target.closest && e.target.closest('.wikilink')) {
        e.preventDefault();
      }
      if (activeInlineEditIndex === index) return;
      startInlineEdit(index, e);
    });
  }

  wrapper.appendChild(controls);
  wrapper.appendChild(preview);

  return wrapper;
}

function renderBlockPreview(block) {
  switch (block.type) {
    case 'panel':
      return renderPanelPreview(block.content);
    case 'link-button':
      return renderLinkButtonPreview(block.content);
    default:
      return `<div class="h-entry"><p>${escapeHtml(block.content)}</p></div>`;
  }
}

function renderPanelPreview(markdown) {
  marked.setOptions({ gfm: true, breaks: true });
  let source = markdown;
  if (typeof AgoraWikilinks !== "undefined") {
    const pages = AgoraWikilinks.pagesFromCache(typeof markdownCache !== "undefined" ? markdownCache : []);
    const folders = typeof folderMeta !== "undefined" ? folderMeta : null;
    source = AgoraWikilinks.preprocessWikilinks(markdown, pages, "", folders);
  }

  // If math is present, lazy-load KaTeX. If it's not loaded yet, preview
  // renders math as raw text for now — the load promise re-renders blocks
  // once KaTeX is ready (see renderAllBlocksAfterKaTeX below).
  let mathPlaceholders = [];
  if (typeof AgoraMath !== "undefined" && AgoraMath.containsMath(source)) {
    if (typeof window !== "undefined" && window.katex) {
      const pre = AgoraMath.preprocessMath(source);
      source = pre.markdown;
      mathPlaceholders = pre.placeholders;
    } else {
      ensureKaTeXLoadedForEditor();
    }
  }

  const parsed = marked.parse(source);
  // Mirror the published-site body sanitizer profile: allow <iframe>
  // (panels can hold raw iframe HTML for embeds) and the iframe attribute
  // allowlist. Then force the enforced sandbox value into every iframe
  // before the preview HTML enters the editor DOM — same security
  // boundary as the live renderer in owo-template.js.
  let sanitized = DOMPurify.sanitize(parsed, {
    ADD_TAGS: ["iframe"],
    ADD_ATTR: [
      "data-target",
      "allow", "allowfullscreen", "frameborder", "referrerpolicy",
      "scrolling", "src", "width", "height", "sandbox",
    ],
    FORBID_TAGS: ["script", "style"],
    FORBID_ATTR: ["onerror", "onload"],
  });
  sanitized = injectIframeSandboxForEditor(sanitized);
  if (mathPlaceholders.length > 0) {
    sanitized = AgoraMath.restoreMath(sanitized, mathPlaceholders);
  }
  return `<article class="h-entry"><div class="e-content">${sanitized}</div></article>`;
}

// Editor-side mirror of owo-template.js's injectIframeSandbox. Forces our
// enforced sandbox onto every <iframe> in an HTML string BEFORE the
// preview enters the editor DOM. Always overwrites an existing sandbox
// so a user with edit access can't bypass the sandbox via their own
// permissive value. Suffix `ForEditor` keeps the symbol distinct from
// the renderer-side helper (which lives in a different file/scope).
function injectIframeSandboxForEditor(html) {
  if (typeof html !== "string") return html;
  return html.replace(/<iframe\b([^>]*)>/gi, (_match, attrs) => {
    const cleaned = attrs.replace(/\s+sandbox\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<iframe${cleaned} sandbox="allow-scripts allow-same-origin">`;
  });
}

// Read markdown back from a Toast UI WYSIWYG editor and undo three
// round-trip side effects:
//   1) Markdown-spec escapes the serializer adds inside math regions
//      (`\` -> `\\`, `_` -> `\_`, `{` -> `\{`, ...), which would break
//      KaTeX rendering. See escapeMathForEditor for the matching pre-escape.
//   2) <br> tags emitted for what was originally a LaTeX `\\` line break.
//      unescapeMathRoundTrip converts these back to `\\` inside math regions
//      so multi-line `\begin{aligned}` blocks still render row-by-row.
//   3) Stray <br> tags Toast UI inserts in regular prose.
// Order matters: unescape FIRST (so math-region <br> become `\\`), then
// strip the remaining outside-math <br> globally.
function readMarkdownFromEditor(editor) {
  if (!editor) return '';
  let md = editor.getMarkdown();
  // Only undo the WYSIWYG-round-trip escapes when the editor is actually in
  // WYSIWYG mode. In markdown mode the user is typing raw text, so escape
  // sequences like `\{` in their LaTeX (or `\[\[` in literal-bracket text)
  // are intentional and must be preserved.
  const inWysiwyg = typeof editor.isWysiwygMode === "function"
    ? editor.isWysiwygMode()
    : true;
  if (inWysiwyg) {
    if (typeof AgoraMath !== "undefined") {
      md = AgoraMath.unescapeMathRoundTrip(md);
    }
    if (typeof AgoraWikilinks !== "undefined") {
      md = AgoraWikilinks.unescapeWikilinkBrackets(md);
    }
  }
  return md.replace(/<br\s*\/?>/gi, '').trim();
}

// Pre-escape math regions before handing markdown to Toast UI so the
// MARKDOWN PARSER doesn't consume `\X` escapes (`\{`, `\}`, `\\`, `\_`, ...)
// when populating the WYSIWYG ProseMirror state. Doubling every backslash
// in math regions makes the parser emit the original chars; readMarkdownFromEditor
// reverses this on the way back out.
function escapeMathForEditor(markdown) {
  if (typeof AgoraMath === "undefined") return markdown;
  return AgoraMath.escapeMathForWysiwyg(markdown);
}

// Trigger a KaTeX load once and re-render all blocks once it resolves so the
// preview catches up. Idempotent — repeated calls share the same promise.
function ensureKaTeXLoadedForEditor() {
  if (typeof AgoraMath === "undefined") return;
  if (ensureKaTeXLoadedForEditor._triggered) return;
  ensureKaTeXLoadedForEditor._triggered = true;
  AgoraMath.loadKaTeX().then(() => {
    if (typeof renderAllBlocks === "function") renderAllBlocks();
  }).catch(err => {
    console.error("KaTeX failed to load; math will render as raw LaTeX:", err);
  });
}

function renderLinkButtonPreview(content) {
  // Content format: url|label
  const parts = content.split('|');
  const url = parts[0] || '';
  const label = parts[1] || 'Link';
  // Same scheme allowlist as the published-site renderers — blocks
  // javascript:/data:/vbscript: so the preview matches what readers
  // will actually get and the author can't accidentally click their
  // own malformed URL during editing either.
  const safeUrl = isSafeButtonUrl(url) ? url : '#';
  const isExternal = safeUrl.startsWith('https://');
  const icon = isExternal ? '&#x1F310;' : '&#x1F517;'; // Globe for external, link for local
  const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<div class="link-button-container"><a href="${escapeHtml(safeUrl)}" class="link-button"${target}><span class="link-icon">${icon}</span> ${escapeHtml(label)}</a></div>`;
}

// URL-scheme allowlist for link buttons. Permitted: absolute http(s),
// mailto:, fragment-only (#), and relative paths (/, ./, ../).
function isSafeButtonUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^mailto:/i.test(trimmed)) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) return true;
  return false;
}

function extractYouTubeVideoId(url) {
  // Constrain the capture to YouTube's canonical 11-char id format
  // ([A-Za-z0-9_-]{11}) so a malicious "URL" like
  // `youtu.be/X"></iframe><script>...` can't escape the iframe src
  // attribute when the result is interpolated into HTML. The loose
  // `[^&\n?#]+` capture this replaces accepted `<>"` etc. verbatim.
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/v\/|youtube\.com\/watch\?[^#]*&v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/,
    /^([A-Za-z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = (url || '').match(pattern);
    if (match && /^[A-Za-z0-9_-]{11}$/.test(match[1])) return match[1];
  }
  return null;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// Add Block Button and Menu
// ============================================

function createAddBlockButton(afterIndex) {
  const wrapper = document.createElement('div');
  wrapper.className = 'add-block-wrapper';
  wrapper.dataset.afterIndex = afterIndex;

  const btn = document.createElement('button');
  btn.className = 'add-block-btn';
  btn.innerHTML = '+';
  btn.title = 'Add block';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    showAddBlockMenu(wrapper, afterIndex);
  });

  wrapper.appendChild(btn);
  return wrapper;
}

function showAddBlockMenu(wrapper, afterIndex) {
  // Remove any existing menu
  const existingMenu = document.querySelector('.add-block-menu');
  if (existingMenu) existingMenu.remove();

  const menu = document.createElement('div');
  menu.className = 'add-block-menu';

  const options = [
    { type: 'panel', icon: '&#x1F4DD;', label: 'Text Panel' },
    { type: 'link-button', icon: '&#x1F517;', label: 'Link Button' },
    { type: 'embed', icon: '&#x1F3AC;', label: 'Embed' },
  ];

  options.forEach(opt => {
    const item = document.createElement('button');
    item.className = 'add-block-menu-item';
    item.innerHTML = `<span class="menu-icon">${opt.icon}</span> ${opt.label}`;
    item.addEventListener('click', () => {
      menu.remove();
      addBlock(opt.type, afterIndex);
    });
    menu.appendChild(item);
  });

  wrapper.appendChild(menu);

  // Position: drop-down by default, drop-up if it would overlap with the footer
  const footer = document.getElementById('footer');
  const footerTop = footer ? footer.getBoundingClientRect().top : window.innerHeight;
  const wrapperRect = wrapper.getBoundingClientRect();
  const menuHeight = menu.offsetHeight;
  const spaceBelow = footerTop - wrapperRect.bottom;

  if (spaceBelow < menuHeight + 8) {
    menu.classList.add('drop-up');
  } else {
    menu.classList.add('drop-down');
  }

  // Close menu when clicking outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// ============================================
// Block CRUD Operations
// ============================================

function addBlock(type, afterIndex) {
  const insertIndex = afterIndex + 1;

  // The "Embed" menu option is sugar for "panel block containing raw
  // <iframe> HTML." Open the embed popup first; only insert a block
  // once the user confirms a URL or HTML, and bake the iframe into the
  // panel content. Cancelling the popup leaves the page unchanged.
  if (type === 'embed') {
    showEmbedPopup('', (rawContent) => {
      const iframeHtml = embedContentToIframeHtml(rawContent);
      currentBlocks.splice(insertIndex, 0, {
        id: generateBlockId(),
        type: 'panel',
        content: iframeHtml,
      });
      saveBlocksToCache();
      renderAllBlocks();
    });
    return;
  }

  // Same idea for link buttons: open the URL/label popup first; insert
  // a block only on confirm. Cancelling the popup leaves the page
  // unchanged (previously this dropped an empty link-button block into
  // the page that the user then had to delete by hand).
  if (type === 'link-button') {
    showLinkButtonPopup('', '', (url, label) => {
      currentBlocks.splice(insertIndex, 0, {
        id: generateBlockId(),
        type: 'link-button',
        content: `${url}|${label}`,
      });
      saveBlocksToCache();
      renderAllBlocks();
    });
    return;
  }

  const newBlock = {
    id: generateBlockId(),
    type: type,
    content: ''
  };
  currentBlocks.splice(insertIndex, 0, newBlock);
  saveBlocksToCache();
  renderAllBlocks();

  // Open editor for the new block
  editBlock(insertIndex);
}

function editBlock(index) {
  const block = currentBlocks[index];
  if (!block) return;

  switch (block.type) {
    case 'panel':
      if (activeInlineEditIndex === index) return;
      startInlineEdit(index, null);
      break;
    case 'link-button':
      // Parse current URL and label from content (format: url|label)
      const linkParts = block.content.split('|');
      const currentUrl = linkParts[0] || '';
      const currentLabel = linkParts[1] || '';
      showLinkButtonPopup(currentUrl, currentLabel, (url, label) => {
        block.content = `${url}|${label}`;
        saveBlocksToCache();
        renderAllBlocks();
      });
      break;
  }
}

function deleteBlock(index) {
  if (!confirm('Are you sure you want to delete this block?')) return;

  saveAndCleanupInlineEdit();
  currentBlocks.splice(index, 1);
  saveBlocksToCache();
  renderAllBlocks();
}

// ============================================
// Drag and Drop
// ============================================

function moveBlockUp(index) {
  if (index <= 0) return;
  saveAndCleanupInlineEdit();
  const temp = currentBlocks[index];
  currentBlocks[index] = currentBlocks[index - 1];
  currentBlocks[index - 1] = temp;
  saveBlocksToCache();
  renderAllBlocks();
}

function moveBlockDown(index) {
  if (index >= currentBlocks.length - 1) return;
  saveAndCleanupInlineEdit();
  const temp = currentBlocks[index];
  currentBlocks[index] = currentBlocks[index + 1];
  currentBlocks[index + 1] = temp;
  saveBlocksToCache();
  renderAllBlocks();
}

// ============================================
// Panel Inline Edit
// ============================================

let panelEditor = null;

function getClickedTextInfo(event) {
  if (!event) return null;

  let range;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(event.clientX, event.clientY);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }

  if (!range || !range.startContainer) return null;

  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return null;

  const text = textNode.textContent;
  const offset = range.startOffset;

  // Find the closest block-level ancestor within the preview
  let blockEl = textNode.parentElement;
  while (blockEl && blockEl.classList && !blockEl.classList.contains('block-preview')) {
    if (['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'PRE'].includes(blockEl.tagName)) {
      break;
    }
    blockEl = blockEl.parentElement;
  }

  // Get text content of the block-level element and the offset within it
  const blockText = blockEl ? blockEl.textContent : text;
  let blockOffset = offset;

  if (blockEl) {
    const treeWalker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    let node;
    let accumulated = 0;
    while ((node = treeWalker.nextNode())) {
      if (node === textNode) {
        blockOffset = accumulated + offset;
        break;
      }
      accumulated += node.textContent.length;
    }
  }

  return { blockText, blockOffset };
}

function setCursorInEditor(editor, clickInfo) {
  if (!clickInfo) return;

  try {
    let wwContainer;
    try {
      const els = editor.getEditorElements();
      wwContainer = els && els.wwEditor;
    } catch (_) {}
    if (!wwContainer) {
      wwContainer = document.querySelector('.inline-panel-editor .ProseMirror')
        || document.querySelector('.inline-panel-editor [contenteditable]');
    }
    if (!wwContainer) return;

    const { blockText, blockOffset } = clickInfo;

    // Find matching block-level element in editor by text content
    const blockSelectors = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre';
    const editorBlocks = wwContainer.querySelectorAll(blockSelectors);

    let targetBlock = null;
    let bestMatchLen = 0;

    for (const block of editorBlocks) {
      const editorBlockText = block.textContent;
      // Find the block with the longest common prefix with blockText
      if (editorBlockText === blockText) {
        targetBlock = block;
        break;
      }
      // Partial match fallback
      const commonLen = commonPrefixLength(editorBlockText, blockText);
      if (commonLen > bestMatchLen) {
        bestMatchLen = commonLen;
        targetBlock = block;
      }
    }

    if (!targetBlock) return;

    // Walk text nodes within the matched block to set cursor at the right offset
    const treeWalker = document.createTreeWalker(targetBlock, NodeFilter.SHOW_TEXT);
    let node;
    let remaining = Math.min(blockOffset, targetBlock.textContent.length);

    while ((node = treeWalker.nextNode())) {
      if (remaining <= node.textContent.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= node.textContent.length;
    }
  } catch (e) {
    // Cursor positioning is best-effort
  }
}

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// AgoraPages does not host user-uploaded image bytes (CSAM policy). The
// helpers below close every Toast UI ingestion path that would otherwise
// land image bytes in the markdown source: the documented blob hook,
// drop/paste of binary image files, and paste of text that smuggles in a
// `data:image/...` URI. The `externalImage` toolbar button (image-by-URL)
// remains the supported way to embed images.
function dataTransferHasImageFile(dt) {
  if (!dt) return false;
  if (dt.files && dt.files.length) {
    for (const f of dt.files) {
      if (f && typeof f.type === "string" && f.type.startsWith("image/")) return true;
    }
  }
  if (dt.items && dt.items.length) {
    for (const it of dt.items) {
      if (it && it.kind === "file" && typeof it.type === "string" && it.type.startsWith("image/")) return true;
    }
  }
  return false;
}

// Detect smuggled-in image bytes inside pasted text — a `data:image/...`
// URI in either the rich-text (text/html) or plain-text payload of the
// clipboard. text/html catches the common case of copying an `<img>` from
// a webpage where the browser has inlined the image as a data URI;
// text/plain catches users pasting raw markdown like `![](data:image/...)`.
function clipboardTextContainsDataImage(clipboardData) {
  if (!clipboardData) return false;
  const dataImageRe = /data:image\/[a-z0-9.+-]+;[^\s"'<>]*base64,/i;
  try {
    const html = clipboardData.getData("text/html");
    if (html && dataImageRe.test(html)) return true;
  } catch (_) {}
  try {
    const text = clipboardData.getData("text/plain");
    if (text && dataImageRe.test(text)) return true;
  } catch (_) {}
  return false;
}

function notifyImagePolicy() {
  alert("AgoraPages does not host uploaded images. Use the “Insert image from URL” toolbar button (🖼) to embed an external image.");
}

// Attach capture-phase drop+paste listeners to the editor's container so
// we run before Toast UI's own listeners. The listeners die with the
// container element (removed when inline edit ends), so no explicit
// cleanup is needed.
function installEditorImageBlockListeners(editorContainerEl) {
  if (!editorContainerEl) return;
  editorContainerEl.addEventListener("drop", (e) => {
    if (dataTransferHasImageFile(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      notifyImagePolicy();
    }
  }, true);
  editorContainerEl.addEventListener("paste", (e) => {
    if (dataTransferHasImageFile(e.clipboardData) || clipboardTextContainsDataImage(e.clipboardData)) {
      e.preventDefault();
      e.stopPropagation();
      notifyImagePolicy();
    }
  }, true);
}

// Toast UI's documented hook for image blobs entering the editor. We
// reject by simply not invoking the callback; returning false is
// belt-and-suspenders against future versions that interpret the return
// value. The capture-phase listeners above already block the underlying
// drop/paste — this hook is the API-level layer in case Toast UI ever
// surfaces a new ingest path the DOM listeners don't cover.
function rejectImageBlobHook(_blob, _callback, _source) {
  notifyImagePolicy();
  return false;
}

function startInlineEdit(index, clickEvent) {
  // Capture click info before any DOM changes
  const clickInfo = clickEvent ? getClickedTextInfo(clickEvent) : null;

  // If another panel is already being edited, save and close it first
  if (activeInlineEditIndex !== null && activeInlineEditIndex !== index) {
    stopInlineEdit();
  }

  const block = currentBlocks[index];
  if (!block || block.type !== 'panel') return;

  activeInlineEditIndex = index;

  // Find the block-item element
  const blockItem = document.querySelector(`.block-item[data-index="${index}"]`);
  if (!blockItem) return;

  const preview = blockItem.querySelector('.block-preview');
  if (!preview) return;

  // Replace preview content with editor container
  preview.classList.add('block-preview-editing');
  preview.classList.remove('block-preview-clickable');
  preview.innerHTML = '<div class="inline-panel-editor"></div>';

  const editorEl = preview.querySelector('.inline-panel-editor');

  // Force markdown mode for content Toast UI's WYSIWYG can't round-trip
  // safely:
  //   - Math (LaTeX). The serializer consumes `\\` line breaks as markdown
  //     hard breaks, collapses multi-line `\begin{aligned}` blocks into one
  //     row, drops markdown-spec backslash escapes inside math, etc.
  //   - Raw HTML iframes. ProseMirror's HTML node handling will silently
  //     drop or mangle iframe markup; the user opens an embed in WYSIWYG
  //     and the iframe is gone after the next save. Markdown mode shows
  //     the iframe HTML as text, which round-trips verbatim.
  // Either signal flips the editor to markdown mode for this block.
  const hasMath = typeof AgoraMath !== "undefined" && AgoraMath.containsMath(block.content);
  const hasIframe = /<iframe\b/i.test(block.content);
  const forceMarkdown = hasMath || hasIframe;
  const initialEditType = forceMarkdown ? 'markdown' : 'wysiwyg';
  // Pre-escape only matters for WYSIWYG mode — markdown mode shows the source
  // verbatim, so we hand it the original block content unchanged.
  const initialValue = forceMarkdown ? block.content : escapeMathForEditor(block.content);

  // Initialize ToastUI editor inline
  panelEditor = new toastui.Editor({
    el: editorEl,
    initialEditType: initialEditType,
    previewStyle: 'vertical',
    theme: 'dark',
    height: '300px',
    initialValue: initialValue,
    hooks: {
      addImageBlobHook: rejectImageBlobHook,
    },
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'link', 'code', 'codeblock'],
      [{
        name: 'externalImage',
        tooltip: 'Insert image from URL',
        text: '🖼',
        className: 'toastui-editor-toolbar-icons external-image-toolbar-btn',
        command: 'insertExternalImage'
      }, {
        name: 'wikilink',
        tooltip: 'Insert wikilink (Cmd/Ctrl+K)',
        text: '[[ ]]',
        className: 'toastui-editor-toolbar-icons wikilink-toolbar-btn',
        command: 'insertWikilink'
      }]
    ]
  });

  installEditorImageBlockListeners(editorEl);

  activeInlineEditorInstance = panelEditor;

  panelEditor.addCommand('wysiwyg', 'insertExternalImage', () => {
    insertExternalImageViaPopup(panelEditor);
    return true;
  });

  panelEditor.addCommand('markdown', 'insertExternalImage', () => {
    insertExternalImageViaPopup(panelEditor);
    return true;
  });

  panelEditor.addCommand('wysiwyg', 'insertWikilink', () => {
    insertWikilinkBrackets(panelEditor);
    return true;
  });

  panelEditor.addCommand('markdown', 'insertWikilink', () => {
    insertWikilinkBrackets(panelEditor);
    return true;
  });

  // Cmd/Ctrl+K shortcut and autocomplete dropdown
  attachWikilinkShortcuts(panelEditor, editorEl);

  // Live-sync editor markdown to currentBlocks + markdownCache so the cache
  // (and therefore auto-save / wikilink resolver) stays current during typing,
  // not only on commit.
  panelEditor.on('change', () => {
    if (activeInlineEditIndex !== index) return;
    const liveBlock = currentBlocks[index];
    if (!liveBlock) return;
    liveBlock.content = readMarkdownFromEditor(panelEditor);
    saveBlocksToCache();
  });

  // Set cursor position after editor renders
  requestAnimationFrame(() => {
    setCursorInEditor(panelEditor, clickInfo);
    // Focus the editor
    panelEditor.focus();
  });

  // Hide the edit button while editing
  const editBtn = blockItem.querySelector('.block-edit-btn');
  if (editBtn) editBtn.style.display = 'none';

  // Set up click-outside listener (delayed to avoid catching the triggering click)
  setTimeout(() => {
    document.addEventListener('mousedown', handleClickOutsideEditor);
  }, 0);
}

function handleClickOutsideEditor(e) {
  if (activeInlineEditIndex === null) return;

  const blockItem = document.querySelector(`.block-item[data-index="${activeInlineEditIndex}"]`);
  if (!blockItem) return;

  // Check if click is inside the editing block, or inside a popup
  if (blockItem.contains(e.target)) return;
  if (e.target.closest('.block-popup')) return;
  if (e.target.closest('.toastui-editor-popup')) return;
  if (e.target.closest('.wikilink-autocomplete')) return;

  // Check if clicking on another panel's preview — start editing that one directly
  const targetPreview = e.target.closest('.block-preview-clickable');
  if (targetPreview) {
    const targetBlockItem = targetPreview.closest('.block-item');
    if (targetBlockItem) {
      const targetIndex = parseInt(targetBlockItem.dataset.index, 10);
      const targetBlock = currentBlocks[targetIndex];
      if (targetBlock && targetBlock.type === 'panel') {
        e.preventDefault();
        e.stopPropagation();
        startInlineEdit(targetIndex, e);
        return;
      }
    }
  }

  stopInlineEdit();
}

function saveAndCleanupInlineEdit() {
  if (activeInlineEditIndex === null || !activeInlineEditorInstance) return;

  const block = currentBlocks[activeInlineEditIndex];
  if (block) {
    block.content = readMarkdownFromEditor(activeInlineEditorInstance);
  }

  activeInlineEditorInstance.destroy();
  activeInlineEditorInstance = null;
  panelEditor = null;
  activeInlineEditIndex = null;

  document.removeEventListener('mousedown', handleClickOutsideEditor);
}

function stopInlineEdit() {
  saveAndCleanupInlineEdit();
  saveBlocksToCache();
  renderAllBlocks();
}

// ============================================
// Wikilink helpers (toolbar, shortcut, autocomplete)
// ============================================

function insertWikilinkBrackets(editor) {
  if (!editor) return;
  const wasWysiwyg = editor.isWysiwygMode();
  if (wasWysiwyg) editor.changeMode('markdown');
  // Insert [[]] then move cursor between the brackets
  editor.insertText('[[]]');
  try {
    const sel = editor.getSelection();
    if (sel && Array.isArray(sel)) {
      // Markdown selection is [[line, ch], [line, ch]]; back up two cols
      const end = sel[1] || sel[0];
      const newPos = [end[0], Math.max(0, end[1] - 2)];
      editor.setSelection(newPos, newPos);
    }
  } catch (_) {}
  if (wasWysiwyg) editor.changeMode('wysiwyg');
  editor.focus();
}

function getWysiwygContainer(editor) {
  try {
    const els = editor.getEditorElements();
    if (els && els.wwEditor) return els.wwEditor;
  } catch (_) {}
  return document.querySelector('.toastui-editor-ww-container .ProseMirror')
    || document.querySelector('.inline-panel-editor [contenteditable]');
}

function attachWikilinkShortcuts(editor, editorEl) {
  // Keyboard shortcut handler — Cmd/Ctrl+K inserts brackets
  const onKeyDown = (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      insertWikilinkBrackets(editor);
      return;
    }
    // Autocomplete navigation
    if (wikilinkAutocomplete && wikilinkAutocomplete.visible) {
      if (e.key === 'ArrowDown') { wikilinkAutocomplete.move(1); e.preventDefault(); return; }
      if (e.key === 'ArrowUp')   { wikilinkAutocomplete.move(-1); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (wikilinkAutocomplete.commit()) { e.preventDefault(); }
        return;
      }
      if (e.key === 'Escape') { wikilinkAutocomplete.hide(); e.preventDefault(); return; }
    }
  };
  editorEl.addEventListener('keydown', onKeyDown, true);

  // Autocomplete dropdown — re-evaluate on input
  const onInput = () => {
    requestAnimationFrame(() => updateWikilinkAutocomplete(editor));
  };
  editorEl.addEventListener('input', onInput);
  editorEl.addEventListener('keyup', onInput);
  editorEl.addEventListener('click', onInput);

  // Hide the autocomplete when focus leaves the editor (clicks inside the
  // dropdown use mousedown+preventDefault so they don't trigger blur).
  const onFocusOut = (e) => {
    const next = e.relatedTarget;
    if (next && wikilinkAutocomplete && wikilinkAutocomplete.el.contains(next)) return;
    setTimeout(hideWikilinkAutocomplete, 100);
  };
  editorEl.addEventListener('focusout', onFocusOut);
}

let wikilinkAutocomplete = null;

function updateWikilinkAutocomplete(editor) {
  if (typeof AgoraWikilinks === 'undefined') return;
  if (!editor || !editor.isWysiwygMode()) {
    hideWikilinkAutocomplete();
    return;
  }
  const wwContainer = getWysiwygContainer(editor);
  if (!wwContainer) { hideWikilinkAutocomplete(); return; }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { hideWikilinkAutocomplete(); return; }
  const range = sel.getRangeAt(0);
  if (!range.collapsed) { hideWikilinkAutocomplete(); return; }
  if (!wwContainer.contains(range.startContainer)) { hideWikilinkAutocomplete(); return; }

  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) { hideWikilinkAutocomplete(); return; }
  const trigger = AgoraWikilinks.findActiveWikilinkTrigger(node.textContent, range.startOffset);
  if (!trigger) { hideWikilinkAutocomplete(); return; }

  const pages = AgoraWikilinks.pagesFromCache(typeof markdownCache !== 'undefined' ? markdownCache : []);
  const matches = AgoraWikilinks.filterPagesByQuery(pages, trigger.query);
  if (matches.length === 0) { hideWikilinkAutocomplete(); return; }

  // Position dropdown near caret
  const rect = range.getBoundingClientRect();
  const caretOffset = range.startOffset;
  showWikilinkAutocomplete(matches, { left: rect.left, top: rect.bottom + 4 }, (chosen) => {
    // Determine where the existing wikilink ends after the caret. If a "]]"
    // closer is reachable in the same text node (no intervening newline or
    // new "[[" opener), include it in the deletion so the new replacement
    // fully overwrites the previous wikilink.
    const fullText = node.textContent;
    const suffix = fullText.slice(caretOffset);
    let endOffset = caretOffset;
    const closeIdx = suffix.indexOf("]]");
    const newlineIdx = suffix.indexOf("\n");
    const nextOpenIdx = suffix.indexOf("[[");
    if (
      closeIdx >= 0 &&
      (newlineIdx < 0 || closeIdx < newlineIdx) &&
      (nextOpenIdx < 0 || closeIdx < nextOpenIdx)
    ) {
      endOffset = caretOffset + closeIdx + 2; // include the "]]"
    }

    // Restore focus to the editor first so execCommand routes through it.
    if (wwContainer && typeof wwContainer.focus === "function") {
      wwContainer.focus({ preventScroll: true });
    }

    // Select the existing wikilink range, then use execCommand('insertText')
    // so ProseMirror processes it as a real input — keeps its model, focus,
    // and selection consistent. The caret naturally lands after the inserted
    // text (i.e. after the "]]").
    const liveSel = window.getSelection();
    const replaceRange = document.createRange();
    replaceRange.setStart(node, trigger.startOffset);
    replaceRange.setEnd(node, endOffset);
    liveSel.removeAllRanges();
    liveSel.addRange(replaceRange);

    const target = shortestWikilinkTarget(chosen, pages,
      typeof folderMeta !== "undefined" ? folderMeta : null);
    const replacement = `[[${target}]]`;
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, replacement);
    } catch (_) { inserted = false; }

    if (!inserted) {
      // Fallback: direct DOM mutation + InputEvent
      replaceRange.deleteContents();
      const textNode = document.createTextNode(replacement);
      replaceRange.insertNode(textNode);
      const after = document.createRange();
      after.setStart(textNode, replacement.length);
      after.collapse(true);
      liveSel.removeAllRanges();
      liveSel.addRange(after);
      const evt = new InputEvent('input', { bubbles: true, cancelable: true });
      wwContainer.dispatchEvent(evt);
    }
  });
}

function showWikilinkAutocomplete(matches, position, onCommit) {
  if (!wikilinkAutocomplete) {
    const dropdown = document.createElement('div');
    dropdown.className = 'wikilink-autocomplete';
    // Block focus shift when the user mouses down anywhere inside the dropdown
    // (including padding/gaps between items).
    dropdown.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(dropdown);
    wikilinkAutocomplete = {
      el: dropdown,
      visible: false,
      items: [],
      selectedIndex: 0,
      onCommit: null,
      hide() { this.el.style.display = 'none'; this.visible = false; },
      move(delta) {
        if (!this.items.length) return;
        this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
        this.render();
      },
      commit() {
        if (!this.visible) return false;
        const chosen = this.items[this.selectedIndex];
        if (chosen && this.onCommit) this.onCommit(chosen);
        this.hide();
        return true;
      },
      render() {
        this.el.innerHTML = '';
        this.items.forEach((page, i) => {
          const item = document.createElement('div');
          item.className = 'wikilink-autocomplete-item' + (i === this.selectedIndex ? ' selected' : '');
          item.textContent = page.displayName || page.fileName;
          if (page.displayName && page.displayName !== page.fileName) {
            const sub = document.createElement('span');
            sub.className = 'wikilink-autocomplete-path';
            sub.textContent = page.fileName;
            item.appendChild(sub);
          }
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.selectedIndex = i;
            this.commit();
          });
          this.el.appendChild(item);
        });
      },
    };
  }
  wikilinkAutocomplete.items = matches;
  wikilinkAutocomplete.selectedIndex = 0;
  wikilinkAutocomplete.onCommit = onCommit;
  wikilinkAutocomplete.render();
  wikilinkAutocomplete.el.style.display = 'block';
  wikilinkAutocomplete.el.style.left = position.left + 'px';
  wikilinkAutocomplete.el.style.top = position.top + 'px';
  wikilinkAutocomplete.visible = true;
}

function hideWikilinkAutocomplete() {
  if (wikilinkAutocomplete && wikilinkAutocomplete.visible) {
    wikilinkAutocomplete.hide();
  }
}

// Pick the shortest wikilink target text that still resolves uniquely to
// `chosen`. Tries the displayName alone first; if that's ambiguous (or the
// page has no displayName), prepends folder display names one segment at a
// time from the immediate parent outward; falls back to the full slug if
// nothing shorter resolves uniquely.
function shortestWikilinkTarget(chosen, pages, folders) {
  if (!chosen) return "";
  if (typeof AgoraWikilinks === "undefined") return chosen.fileName || "";

  const slug = chosen.fileName || "";
  const display = chosen.displayName || slug;
  const slugParts = slug.split("/");
  const folderSlugs = slugParts.slice(0, -1);

  function folderDisplayAt(idx) {
    const path = folderSlugs.slice(0, idx + 1).join("/");
    const meta = folders && folders[path];
    if (meta && meta.displayName) return meta.displayName;
    // Humanize the slug as a last resort so the user-visible target reads
    // naturally even when no folder metadata exists.
    return folderSlugs[idx].replace(/[-_]+/g, " ");
  }

  function resolvesToChosen(target) {
    const r = AgoraWikilinks.resolveWikilink(target, pages, folders);
    return !!r && r.fileName === chosen.fileName;
  }

  // Try the displayName alone.
  if (display && resolvesToChosen(display)) return display;

  // Then prepend folder display names from the immediate parent outward.
  for (let i = folderSlugs.length - 1; i >= 0; i--) {
    const segs = [];
    for (let j = i; j < folderSlugs.length; j++) segs.push(folderDisplayAt(j));
    const candidate = segs.join("/") + "/" + display;
    if (resolvesToChosen(candidate)) return candidate;
  }

  // Last resort — slugs are guaranteed unique by construction.
  return slug;
}

// ============================================
// Embed Popup (for blocks)
// ============================================

function showEmbedPopup(currentContent, callback) {
  const existingPopup = document.querySelector('.embed-popup');
  if (existingPopup) existingPopup.remove();

  const popup = document.createElement('div');
  popup.className = 'block-popup embed-popup';

  popup.innerHTML = `
    <div class="popup-content">
      <div class="popup-header">
        <h3>Insert Embed</h3>
        <button class="popup-close">&times;</button>
      </div>
      <div class="embed-form">
        <div class="embed-type-selector">
          <label><input type="radio" name="embedType" value="youtube" checked> YouTube</label>
          <label><input type="radio" name="embedType" value="soundcloud"> SoundCloud</label>
          <label><input type="radio" name="embedType" value="html"> HTML</label>
        </div>
        <div id="youtubeEmbedSection">
          <label>YouTube URL:</label>
          <input type="text" id="youtubeUrlInput" placeholder="https://youtu.be/...">
          <p class="form-hint"><a href="https://agorapages.com/s/agorapages/tutorials/how-to-embed-a-youtube-video.html" target="_blank" rel="noopener noreferrer">How to embed a YouTube video</a></p>
        </div>
        <div id="soundcloudEmbedSection" style="display:none;">
          <label>SoundCloud URL:</label>
          <input type="text" id="soundcloudUrlInput" placeholder="https://soundcloud.com/...">
          <p class="form-hint"><a href="https://agorapages.com/s/agorapages/tutorials/how-to-embed-a-soundcloud-song.html" target="_blank" rel="noopener noreferrer">How to embed a SoundCloud song</a></p>
        </div>
        <div id="htmlEmbedSection" style="display:none;">
          <label>HTML Code:</label>
          <textarea id="htmlEmbedTextarea" rows="4" placeholder="<iframe ...></iframe>"></textarea>
        </div>
        <div class="popup-buttons">
          <button class="popup-cancel">Cancel</button>
          <button class="popup-confirm">Confirm</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  const youtubeInput = popup.querySelector('#youtubeUrlInput');
  const soundcloudInput = popup.querySelector('#soundcloudUrlInput');
  const htmlTextarea = popup.querySelector('#htmlEmbedTextarea');
  const youtubeSection = popup.querySelector('#youtubeEmbedSection');
  const soundcloudSection = popup.querySelector('#soundcloudEmbedSection');
  const htmlSection = popup.querySelector('#htmlEmbedSection');

  // Pre-fill if editing
  if (currentContent) {
    if (currentContent.includes('youtube') || currentContent.includes('youtu.be')) {
      youtubeInput.value = currentContent;
    } else if (currentContent.includes('soundcloud')) {
      soundcloudInput.value = currentContent;
      popup.querySelector('input[value="soundcloud"]').checked = true;
      youtubeSection.style.display = 'none';
      soundcloudSection.style.display = 'block';
    } else {
      htmlTextarea.value = currentContent;
      popup.querySelector('input[value="html"]').checked = true;
      youtubeSection.style.display = 'none';
      htmlSection.style.display = 'block';
    }
  }

  // Type switching
  popup.querySelectorAll('input[name="embedType"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      youtubeSection.style.display = 'none';
      soundcloudSection.style.display = 'none';
      htmlSection.style.display = 'none';
      if (e.target.value === 'youtube') youtubeSection.style.display = 'block';
      else if (e.target.value === 'soundcloud') soundcloudSection.style.display = 'block';
      else htmlSection.style.display = 'block';
    });
  });

  popup.querySelector('.popup-close').addEventListener('click', () => popup.remove());
  popup.querySelector('.popup-cancel').addEventListener('click', () => popup.remove());

  popup.querySelector('.popup-confirm').addEventListener('click', () => {
    const type = popup.querySelector('input[name="embedType"]:checked').value;
    let content = '';
    if (type === 'youtube') content = youtubeInput.value.trim();
    else if (type === 'soundcloud') content = soundcloudInput.value.trim();
    else content = htmlTextarea.value.trim();

    if (!content) {
      alert('Please enter content');
      return;
    }

    popup.remove();
    if (callback) callback(content);
  });
}

// ============================================
// Link Button Popup
// ============================================

function showLinkButtonPopup(currentUrl, currentLabel, callback) {
  const existingPopup = document.querySelector('.link-button-popup');
  if (existingPopup) existingPopup.remove();

  const popup = document.createElement('div');
  popup.className = 'block-popup link-button-popup';

  popup.innerHTML = `
    <div class="popup-content">
      <div class="popup-header">
        <h3>Insert Link Button</h3>
        <button class="popup-close">&times;</button>
      </div>
      <div class="link-button-form">
        <div class="form-group">
          <label for="linkButtonUrl">URL:</label>
          <input type="text" id="linkButtonUrl" placeholder="https://example.com" value="${escapeHtml(currentUrl)}">
        </div>
        <div class="form-group">
          <label for="linkButtonLabel">Button Label:</label>
          <input type="text" id="linkButtonLabel" placeholder="Click here" value="${escapeHtml(currentLabel)}">
        </div>
        <div class="popup-buttons">
          <button class="popup-cancel">Cancel</button>
          <button class="popup-confirm">Confirm</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  const urlInput = popup.querySelector('#linkButtonUrl');
  const labelInput = popup.querySelector('#linkButtonLabel');

  // Focus on URL input
  urlInput.focus();

  popup.querySelector('.popup-close').addEventListener('click', () => popup.remove());
  popup.querySelector('.popup-cancel').addEventListener('click', () => popup.remove());

  popup.querySelector('.popup-confirm').addEventListener('click', () => {
    let url = urlInput.value.trim();
    const label = labelInput.value.trim();

    if (!url) {
      alert('Please enter a URL');
      return;
    }

    // Normalize external URLs: local links start with /s/, everything else is forced to https://
    if (!url.startsWith('/s/')) {
      if (url.startsWith('http://')) {
        url = 'https://' + url.slice(7);
      } else if (!url.startsWith('https://')) {
        url = 'https://' + url;
      }
    }

    if (!label) {
      alert('Please enter a button label');
      return;
    }

    popup.remove();
    if (callback) callback(url, label);
  });
}

// ============================================
// External Image Popup (Toast UI toolbar)
// ============================================

// Inserts `![alt](url)` at the editor's cursor. Toggles markdown mode
// briefly so insertText puts in raw markdown rather than escaping it
// in the WYSIWYG ProseMirror state. Same pattern previously used by
// the (now-removed) image-attachment uploader.
function insertExternalImageViaPopup(editor) {
  showExternalImagePopup(({ url, alt }) => {
    if (!editor) return;
    const wasWysiwyg = editor.isWysiwygMode && editor.isWysiwygMode();
    if (wasWysiwyg) editor.changeMode('markdown');
    editor.insertText(`![${alt || ''}](${url})`);
    if (wasWysiwyg) editor.changeMode('wysiwyg');
  });
}

// Imgur URLs pasted from a browser address bar typically point at the
// HTML viewer page (`https://imgur.com/<id>` or `https://i.imgur.com/<id>`),
// not the raw image — so they can't be embedded as an `<img>`. Rewrite
// to the i.imgur.com host and append `.jpeg` so we hit the canonical
// raw image (imgur transparently serves the actual format). Album,
// gallery, and tag URLs are left alone because they don't resolve to a
// single image. URLs that already carry an image extension are
// untouched. Returns the input unchanged for non-imgur URLs.
function normalizeImgurImageUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return url; }
  const host = parsed.hostname.toLowerCase();
  if (host !== "imgur.com" && host !== "i.imgur.com" && host !== "www.imgur.com") {
    return url;
  }
  // Don't touch album / gallery / tag pages — those aren't single images.
  if (/^\/(a|gallery|t|user)\//i.test(parsed.pathname)) return url;
  // Already an image asset URL.
  if (/\.(jpe?g|png|gif|webp|avif|bmp|tiff?)$/i.test(parsed.pathname)) {
    // Force the i.imgur.com host even if the user pasted plain imgur.com.
    if (host !== "i.imgur.com") parsed.hostname = "i.imgur.com";
    return parsed.toString();
  }
  // No extension and not an album path — append .jpeg and force i. host.
  parsed.hostname = "i.imgur.com";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") + ".jpeg";
  return parsed.toString();
}

// URL-only image picker. Deliberately does NOT accept file uploads —
// the upload pipeline was removed sitewide; this restores image
// embedding via external https:// links (the previewable kind a user
// would copy from another website). Insert is gated on the preview
// `<img>` actually loading, so a broken URL can't be inserted.
function showExternalImagePopup(callback) {
  const existingPopup = document.querySelector('.external-image-popup');
  if (existingPopup) existingPopup.remove();

  const popup = document.createElement('div');
  popup.className = 'block-popup external-image-popup';

  popup.innerHTML = `
    <div class="popup-content">
      <div class="popup-header">
        <h3>Insert Image from URL</h3>
        <button class="popup-close">&times;</button>
      </div>
      <div class="external-image-form">
        <div class="form-group">
          <label for="externalImageUrl">Image URL:</label>
          <input type="url" id="externalImageUrl" placeholder="https://example.com/image.jpg" autocomplete="off" spellcheck="false">
          <p class="form-hint">Only external https:// image URLs are supported. <a href="https://agorapages.com/s/agorapages/tutorials/how-to-add-images-to-your-site" target="_blank" rel="noopener noreferrer">How to add images to your site</a></p>
        </div>
        <div class="form-group">
          <label for="externalImageAlt">Alt text (optional):</label>
          <input type="text" id="externalImageAlt" placeholder="Description of the image">
        </div>
        <div class="external-image-preview-wrap">
          <div class="external-image-preview-status">Enter a URL to preview the image</div>
          <img class="external-image-preview" alt="" style="display: none;">
        </div>
        <div class="popup-buttons">
          <button class="popup-cancel">Cancel</button>
          <button class="popup-confirm" disabled>Insert</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  const urlInput = popup.querySelector('#externalImageUrl');
  const altInput = popup.querySelector('#externalImageAlt');
  const preview = popup.querySelector('.external-image-preview');
  const status = popup.querySelector('.external-image-preview-status');
  const confirmBtn = popup.querySelector('.popup-confirm');

  urlInput.focus();

  let debounceTimer = null;
  let validUrl = '';
  let pendingSrc = '';

  function setStatus(text) {
    status.textContent = text;
    status.style.display = '';
    preview.style.display = 'none';
  }

  function updatePreview() {
    let raw = urlInput.value.trim();
    if (!raw) {
      validUrl = '';
      pendingSrc = '';
      confirmBtn.disabled = true;
      setStatus('Enter a URL to preview the image');
      return;
    }
    // Allow http:// inputs but force-upgrade to https — matches the
    // link-button popup's normalization.
    if (raw.startsWith('http://')) raw = 'https://' + raw.slice(7);
    if (!/^https:\/\//i.test(raw)) {
      validUrl = '';
      pendingSrc = '';
      confirmBtn.disabled = true;
      setStatus('URL must start with https://');
      return;
    }

    // Imgur URLs without an image extension serve an HTML page, which
    // can't be embedded as an <img>. Rewrite to the i.imgur.com host
    // and append .jpeg so the preview (and the inserted markdown) hit
    // the actual raw image. Reflect the normalized form back into the
    // input so the user sees what's being inserted.
    const normalized = normalizeImgurImageUrl(raw);
    if (normalized !== raw) {
      raw = normalized;
      if (urlInput.value.trim() !== raw) urlInput.value = raw;
    }

    pendingSrc = raw;
    setStatus('Loading…');
    preview.onload = () => {
      // Ignore stale loads when the user has typed a newer URL.
      if (preview.src !== pendingSrc) return;
      status.style.display = 'none';
      preview.style.display = '';
      validUrl = pendingSrc;
      confirmBtn.disabled = false;
    };
    preview.onerror = () => {
      if (preview.src !== pendingSrc) return;
      validUrl = '';
      confirmBtn.disabled = true;
      setStatus("Couldn't load that image. Check the URL.");
    };
    // Setting .src starts the load; the handlers above resolve it.
    preview.src = pendingSrc;
  }

  urlInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(updatePreview, 250);
  });
  // Immediate preview attempt when the user paste-and-blurs.
  urlInput.addEventListener('blur', () => {
    clearTimeout(debounceTimer);
    updatePreview();
  });

  function close() {
    clearTimeout(debounceTimer);
    popup.remove();
  }

  popup.querySelector('.popup-close').addEventListener('click', close);
  popup.querySelector('.popup-cancel').addEventListener('click', close);

  confirmBtn.addEventListener('click', () => {
    if (!validUrl) return;
    const alt = altInput.value.trim();
    close();
    if (callback) callback({ url: validUrl, alt });
  });

  // Enter inside the URL field triggers Insert if the preview is valid.
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !confirmBtn.disabled) {
      e.preventDefault();
      confirmBtn.click();
    }
  });
  altInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !confirmBtn.disabled) {
      e.preventDefault();
      confirmBtn.click();
    }
  });
}
