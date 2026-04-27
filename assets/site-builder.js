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
// Image Processing Functions (kept from original)
// ============================================

function isHeicFile(file) {
  const type = (file.type || '').toLowerCase();
  if (type === 'image/heic' || type === 'image/heif') return true;
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif');
}

async function convertHeicToJpeg(file) {
  const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(blob) ? blob[0] : blob;
}

async function processImage(file) {
  if (isHeicFile(file)) {
    file = await convertHeicToJpeg(file);
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.src = e.target.result;
    };

    img.onload = async () => {

      // Downsize if exceeds max dimensions
      let width = img.width;
      let height = img.height;
      const maxWidth = 1080; // 1920 / 1.777...
      const maxHeight = 607; // 1080 / 1.777...
      
      if (width > maxWidth || height > maxHeight) {
        const widthRatio = maxWidth / width;
        const heightRatio = maxHeight / height;
        const scaleFactor = Math.min(widthRatio, heightRatio);
        width = Math.floor(width * scaleFactor);
        height = Math.floor(height * scaleFactor);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to convert image to WebP'));
          }
        },
        'image/webp',
        0.75
      );
    };

    img.onerror = () => reject(new Error('Failed to load image'));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function processAndUploadImage(file) {
  try {
    const processedBlob = await processImage(file);
    let originalName = file.name.replace(/\.[^/.]+$/, '');
    if (originalName === "image") {
      originalName = `uploaded-image-${Date.now()}`;
    }
    const sanitizedName = originalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    const filename = `${sanitizedName}.webp`;

    const base64Content = await blobToBase64(processedBlob);
    const success = await uploadImage(currentSiteId, filename, base64Content);

    if (success) {
      addImageToCache(filename);
      console.log('Image uploaded successfully:', filename);
      return filename;
    } else {
      throw new Error('Failed to upload image to repository');
    }
  } catch (error) {
    console.error('Error uploading image:', error);
    throw error;
  }
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

    // Check for embed block
    const embedMatch = trimmed.match(/^```embed\n([\s\S]*?)\n```$/);
    if (embedMatch) {
      blocks.push({
        id: generateBlockId(),
        type: 'embed',
        content: embedMatch[1].trim()
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

    // Check for standalone image
    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imageMatch) {
      blocks.push({
        id: generateBlockId(),
        type: 'image',
        content: trimmed
      });
      continue;
    }

    // Default: panel block
    blocks.push({
      id: generateBlockId(),
      type: 'panel',
      content: trimmed
    });
  }

  return blocks;
}

function blocksToMarkdown(blocks) {
  const parts = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'embed':
        parts.push(`\`\`\`embed\n${block.content}\n\`\`\``);
        break;
      case 'link-button':
        parts.push(`\`\`\`link-button\n${block.content}\n\`\`\``);
        break;
      case 'image':
      case 'panel':
      default:
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

  // Remove blog-mode class from editorSection if present
  const editorSection = document.getElementById('editorSection');
  if (editorSection) {
    editorSection.classList.remove('blog-mode');
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
    case 'image':
      return renderImagePreview(block.content);
    case 'embed':
      return renderEmbedPreview(block.content);
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
  let sanitized = DOMPurify.sanitize(parsed, { ADD_ATTR: ["data-target"] });
  if (mathPlaceholders.length > 0) {
    sanitized = AgoraMath.restoreMath(sanitized, mathPlaceholders);
  }
  return `<article class="h-entry"><div class="e-content">${sanitized}</div></article>`;
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

function renderImagePreview(content) {
  // Extract image URL and optional caption from markdown
  // Format: ![alt](url) or ![alt](url "caption")
  const match = content.match(/!\[([^\]]*)\]\(([^\s"]+)(?:\s+"([^"]*)")?\)/);
  if (match) {
    const alt = match[1];
    const url = match[2];
    const caption = match[3] || '';
    let html = `<div class="embed-container"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" style="max-width:100%;">`;
    if (caption) {
      html += `<p class="image-caption">${escapeHtml(caption)}</p>`;
    }
    html += '</div>';
    return html;
  }
  return '<div class="embed-container"><p>Invalid image</p></div>';
}

function renderEmbedPreview(content) {
  // YouTube
  if (content.includes('youtube.com') || content.includes('youtu.be')) {
    const videoId = extractYouTubeVideoId(content);
    if (videoId) {
      return `<div class="embed-container"><iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allowfullscreen style="max-width:100%;"></iframe></div>`;
    }
  }

  // SoundCloud
  if (content.includes('soundcloud.com')) {
    const encodedUrl = encodeURIComponent(content);
    return `<div class="embed-container"><iframe width="100%" height="166" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=${encodedUrl}&color=%23ff5500&auto_play=false"></iframe></div>`;
  }

  // Raw HTML embed
  const sanitized = DOMPurify.sanitize(content, {
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'src', 'width', 'height']
  });
  return `<div class="embed-container">${sanitized}</div>`;
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
    { type: 'image', icon: '🖼️', label: 'Image' },
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
  const newBlock = {
    id: generateBlockId(),
    type: type,
    content: ''
  };

  // Insert at correct position
  const insertIndex = afterIndex + 1;
  currentBlocks.splice(insertIndex, 0, newBlock);

  // Save and re-render
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
    case 'image':
      // Parse current caption from existing content
      const captionMatch = block.content.match(/!\[[^\]]*\]\([^)]+\s+"([^"]+)"\)/);
      const currentCaption = captionMatch ? captionMatch[1] : '';
      showImageUploadPopup(({ filename, caption }) => {
        const imageUrl = `/s/${currentSitePathFull}/attachments/${filename}`;
        if (caption) {
          block.content = `![${filename}](${imageUrl} "${caption}")`;
        } else {
          block.content = `![${filename}](${imageUrl})`;
        }
        saveBlocksToCache();
        renderAllBlocks();
      }, currentCaption);
      break;
    case 'embed':
      showEmbedPopup(block.content, (newContent) => {
        block.content = newContent;
        saveBlocksToCache();
        renderAllBlocks();
      });
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

  // Force markdown mode for math content. Toast UI's WYSIWYG parser/serializer
  // mangles LaTeX in non-recoverable ways (consumes `\\` line breaks as
  // markdown hard breaks, collapses multi-line `\begin{aligned}` blocks into
  // a single row, drops markdown-spec backslash escapes inside math, etc.).
  // Editing math as raw markdown sidesteps all of that and is the natural
  // workflow for LaTeX anyway.
  const hasMath = typeof AgoraMath !== "undefined" && AgoraMath.containsMath(block.content);
  const initialEditType = hasMath ? 'markdown' : 'wysiwyg';
  // Pre-escape only matters for WYSIWYG mode — markdown mode shows the source
  // verbatim, so we hand it the original block content unchanged.
  const initialValue = hasMath ? block.content : escapeMathForEditor(block.content);

  // Initialize ToastUI editor inline
  panelEditor = new toastui.Editor({
    el: editorEl,
    initialEditType: initialEditType,
    previewStyle: 'vertical',
    theme: 'dark',
    height: '300px',
    initialValue: initialValue,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'link', 'code', 'codeblock'],
      [{
        name: 'image',
        tooltip: 'Insert image',
        className: 'toastui-editor-toolbar-icons image',
        command: 'insertImage'
      }, {
        name: 'wikilink',
        tooltip: 'Insert wikilink (Cmd/Ctrl+K)',
        text: '[[ ]]',
        className: 'toastui-editor-toolbar-icons wikilink-toolbar-btn',
        command: 'insertWikilink'
      }]
    ]
  });

  activeInlineEditorInstance = panelEditor;

  function insertImageIntoPanelEditor({ filename, caption }) {
    const url = `/s/${currentSitePathFull}/attachments/${filename}`;
    const alt = caption || filename;
    const wasWysiwyg = panelEditor.isWysiwygMode();
    if (wasWysiwyg) panelEditor.changeMode('markdown');
    panelEditor.insertText(`![${alt}](${url})`);
    if (wasWysiwyg) panelEditor.changeMode('wysiwyg');
  }

  panelEditor.addCommand('wysiwyg', 'insertImage', () => {
    showImageUploadPopup(insertImageIntoPanelEditor);
    return true;
  });

  panelEditor.addCommand('markdown', 'insertImage', () => {
    showImageUploadPopup(insertImageIntoPanelEditor);
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

  // Check if click is inside the editing block, or inside a popup (image upload, etc.)
  if (blockItem.contains(e.target)) return;
  if (e.target.closest('.block-popup')) return;
  if (e.target.closest('.image-upload-popup')) return;
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
// Image Upload Popup (for blocks)
// ============================================

let selectedImageFilename = null;

function showImageUploadPopup(callback, currentCaption = '') {
  pendingBlockCallback = callback;
  selectedImageFilename = null;

  const existingPopup = document.querySelector('.image-upload-popup');
  if (existingPopup) existingPopup.remove();

  const popup = document.createElement('div');
  popup.className = 'block-popup image-upload-popup';

  popup.innerHTML = `
    <div class="popup-content">
      <div class="popup-header">
        <h3>Select Image</h3>
        <button class="popup-close">&times;</button>
      </div>
      <div class="image-upload-dropzone" id="imageDropzone">
        <input type="file" id="imageFileInput" accept="image/*,.heic,.heif" style="display: none;" />
        <div class="dropzone-content">
          <p class="dropzone-icon">&#x1F4C1;</p>
          <p>Click to upload a new image or drag and drop here</p>
        </div>
      </div>
      <div class="image-upload-progress" style="display: none;">
        <div class="progress-bar"><div class="progress-fill"></div></div>
        <p class="progress-text">Processing and uploading...</p>
      </div>
      <div class="image-caption-section">
        <label for="imageCaptionInput">Caption (optional):</label>
        <input type="text" id="imageCaptionInput" placeholder="Enter a caption for the image...">
      </div>
      <div class="image-gallery-section">
        <h4>Image Gallery</h4>
        <div class="image-gallery" id="imageGallery"></div>
      </div>
      <div class="popup-buttons">
        <button class="popup-cancel">Cancel</button>
        <button class="popup-confirm" disabled>Confirm</button>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  const dropzone = popup.querySelector('#imageDropzone');
  const fileInput = popup.querySelector('#imageFileInput');
  const closeButton = popup.querySelector('.popup-close');
  const progressContainer = popup.querySelector('.image-upload-progress');
  const imageGallery = popup.querySelector('#imageGallery');
  const captionInput = popup.querySelector('#imageCaptionInput');
  const confirmBtn = popup.querySelector('.popup-confirm');
  const cancelBtn = popup.querySelector('.popup-cancel');

  // Set current caption if editing
  captionInput.value = currentCaption;

  populateImageGalleryForBlock(imageGallery, popup, captionInput, confirmBtn);

  closeButton.addEventListener('click', () => {
    popup.remove();
    pendingBlockCallback = null;
    selectedImageFilename = null;
  });

  cancelBtn.addEventListener('click', () => {
    popup.remove();
    pendingBlockCallback = null;
    selectedImageFilename = null;
  });

  confirmBtn.addEventListener('click', () => {
    if (selectedImageFilename && pendingBlockCallback) {
      const caption = captionInput.value.trim();
      popup.remove();
      pendingBlockCallback({ filename: selectedImageFilename, caption });
      pendingBlockCallback = null;
      selectedImageFilename = null;
    }
  });

  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await handleImageUploadForBlock(file, popup, progressContainer, imageGallery, captionInput, confirmBtn);
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && (file.type.startsWith('image/') || isHeicFile(file))) {
      await handleImageUploadForBlock(file, popup, progressContainer, imageGallery, captionInput, confirmBtn);
    } else {
      alert('Please drop an image file');
    }
  });
}

function populateImageGalleryForBlock(galleryElement, popup, captionInput, confirmBtn) {
  galleryElement.innerHTML = '';

  if (imageCache.length === 0) {
    galleryElement.innerHTML = '<p class="gallery-empty">No images uploaded yet</p>';
    return;
  }

  imageCache.forEach(filename => {
    const imageUrl = `/s/${currentSitePathFull}/attachments/${filename}`;

    const itemDiv = document.createElement('div');
    itemDiv.className = 'image-gallery-item';
    itemDiv.dataset.filename = filename;

    // Check if this image is currently selected
    if (selectedImageFilename === filename) {
      itemDiv.classList.add('selected');
    }

    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = filename;

    itemDiv.addEventListener('click', () => {
      // Deselect all items
      galleryElement.querySelectorAll('.image-gallery-item').forEach(item => {
        item.classList.remove('selected');
      });
      // Select this item
      itemDiv.classList.add('selected');
      selectedImageFilename = filename;
      // Enable confirm button
      if (confirmBtn) {
        confirmBtn.disabled = false;
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'image-delete-btn';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${filename}"?`)) return;
      try {
        await deleteImage(currentSiteId, filename);
        removeImageFromCache(filename);
        // Clear selection if deleted image was selected
        if (selectedImageFilename === filename) {
          selectedImageFilename = null;
          if (confirmBtn) confirmBtn.disabled = true;
        }
        populateImageGalleryForBlock(galleryElement, popup, captionInput, confirmBtn);
      } catch (error) {
        alert('Failed to delete image');
      }
    });

    itemDiv.appendChild(img);
    itemDiv.appendChild(deleteBtn);
    galleryElement.appendChild(itemDiv);
  });
}

async function handleImageUploadForBlock(file, popup, progressContainer, imageGallery, captionInput, confirmBtn) {
  try {
    progressContainer.style.display = 'block';
    const filename = await processAndUploadImage(file);
    progressContainer.style.display = 'none';
    // Auto-select the newly uploaded image
    selectedImageFilename = filename;
    if (confirmBtn) confirmBtn.disabled = false;
    populateImageGalleryForBlock(imageGallery, popup, captionInput, confirmBtn);
  } catch (error) {
    progressContainer.style.display = 'none';
    alert('Failed to upload image: ' + error.message);
  }
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
        </div>
        <div id="soundcloudEmbedSection" style="display:none;">
          <label>SoundCloud URL:</label>
          <input type="text" id="soundcloudUrlInput" placeholder="https://soundcloud.com/...">
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
          <input type="text" id="linkButtonUrl" placeholder="/s/username/site/page or https://example.com" value="${escapeHtml(currentUrl)}">
          <p class="form-hint">Local links start with /s/ • External links start with https://</p>
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
// Blog Post Editor
// ============================================

let blogPostEditor = null;

// Parse blog post frontmatter from markdown
function parseBlogPostFrontmatter(markdown) {
  const result = {
    title: '',
    date: new Date().toISOString().split('T')[0],
    tags: '',
    image: '',
    embed: '',
    body: markdown || ''
  };

  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    result.body = frontmatterMatch[2];

    const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
    if (titleMatch) result.title = titleMatch[1].trim();

    const dateMatch = frontmatter.match(/^date:\s*(.+)$/m);
    if (dateMatch) result.date = dateMatch[1].trim();

    const tagsMatch = frontmatter.match(/^tags:\s*(.+)$/m);
    if (tagsMatch) {
      const raw = tagsMatch[1].trim();
      if (raw.includes("#")) {
        result.tags = raw;
      } else {
        // Convert legacy comma format to hashtag format
        result.tags = raw.split(",").map(t => t.trim()).filter(t => t).map(t => `#${t}`).join(" ");
      }
    }

    const imageMatch = frontmatter.match(/^image:\s*(.+)$/m);
    if (imageMatch) result.image = imageMatch[1].trim();

    const embedMatch = frontmatter.match(/^embed:\s*(.+)$/m);
    if (embedMatch) result.embed = embedMatch[1].trim();
  }

  return result;
}

// Generate markdown with frontmatter from blog post data
function generateBlogPostMarkdown(postData) {
  let frontmatter = '---\n';
  frontmatter += `title: ${postData.title || 'Untitled'}\n`;
  frontmatter += `date: ${postData.date || new Date().toISOString().split('T')[0]}\n`;
  if (postData.tags) {
    frontmatter += `tags: ${postData.tags}\n`;
  }
  if (postData.image) {
    frontmatter += `image: ${postData.image}\n`;
  }
  if (postData.embed) {
    frontmatter += `embed: ${postData.embed}\n`;
  }
  frontmatter += '---\n';

  return frontmatter + (postData.body || '');
}

// Show blog post edit modal
function showBlogPostEditModal(content, displayName, callback) {
  const existingModal = document.querySelector('.blog-post-modal-overlay');
  if (existingModal) existingModal.remove();

  const postData = parseBlogPostFrontmatter(content);
  // Use displayName as title if no title in frontmatter
  if (!postData.title && displayName) {
    postData.title = displayName;
  }

  const overlay = document.createElement('div');
  overlay.className = 'blog-post-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'blog-post-modal';

  modal.innerHTML = `
    <div class="blog-post-header">
      <h3>Edit Blog Post</h3>
      <button class="blog-post-close">&times;</button>
    </div>
    <div class="blog-post-form">
      <div class="blog-post-field">
        <label for="blogPostTitle">Title</label>
        <input type="text" id="blogPostTitle" placeholder="Post title..." value="${escapeHtml(postData.title)}">
      </div>
      <div class="blog-post-field-row">
        <div class="blog-post-field">
          <label for="blogPostDate">Date</label>
          <input type="date" id="blogPostDate" value="${postData.date}">
        </div>
        <div class="blog-post-field" style="flex: 2;">
          <label for="blogPostTags">Tags</label>
          <input type="text" id="blogPostTags" placeholder="#tag1 #tag2 #tag3" value="${escapeHtml(postData.tags)}">
        </div>
      </div>
      <div class="blog-post-field-row">
        <div class="blog-post-field">
          <label for="blogPostImage">Featured Image</label>
          <div class="blog-post-media-input">
            <input type="text" id="blogPostImage" placeholder="image-filename.webp" value="${escapeHtml(postData.image)}" readonly>
            <button type="button" id="blogPostImageSelect" class="blog-post-media-btn">Select</button>
            <button type="button" id="blogPostImageClear" class="blog-post-media-clear">&times;</button>
          </div>
        </div>
        <div class="blog-post-field">
          <label for="blogPostEmbed">Or Embed URL</label>
          <input type="text" id="blogPostEmbed" placeholder="https://youtube.com/..." value="${escapeHtml(postData.embed)}">
        </div>
      </div>
      <div class="blog-post-field">
        <label>Body</label>
        <div id="blogPostBodyEditor"></div>
      </div>
    </div>
    <div class="blog-post-footer">
      <button class="blog-post-cancel">Cancel</button>
      <button class="blog-post-save">Save Post</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Initialize ToastUI editor for body
  blogPostEditor = new toastui.Editor({
    el: document.querySelector('#blogPostBodyEditor'),
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    theme: 'dark',
    height: '300px',
    initialValue: escapeMathForEditor(postData.body),
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'link', 'code', 'codeblock'],
      [{
        name: 'image',
        tooltip: 'Insert image',
        className: 'toastui-editor-toolbar-icons image',
        command: 'insertImage'
      }]
    ]
  });

  function insertImageIntoBlogEditor({ filename, caption }) {
    const url = `/s/${currentSitePathFull}/attachments/${filename}`;
    const alt = caption || filename;
    const wasWysiwyg = blogPostEditor.isWysiwygMode();
    if (wasWysiwyg) blogPostEditor.changeMode('markdown');
    blogPostEditor.insertText(`![${alt}](${url})`);
    if (wasWysiwyg) blogPostEditor.changeMode('wysiwyg');
  }

  blogPostEditor.addCommand('wysiwyg', 'insertImage', () => {
    showImageUploadPopup(insertImageIntoBlogEditor);
    return true;
  });

  blogPostEditor.addCommand('markdown', 'insertImage', () => {
    showImageUploadPopup(insertImageIntoBlogEditor);
    return true;
  });

  // Image select button — store the path with the `attachments/` prefix
  // so the published blog template (`${basePath}/${post.image}`) resolves
  // to the file's actual location in R2.
  modal.querySelector('#blogPostImageSelect').addEventListener('click', () => {
    showImageUploadPopup(({ filename }) => {
      document.getElementById('blogPostImage').value = `attachments/${filename}`;
      // Clear embed if image is selected
      document.getElementById('blogPostEmbed').value = '';
    });
  });

  // Image clear button
  modal.querySelector('#blogPostImageClear').addEventListener('click', () => {
    document.getElementById('blogPostImage').value = '';
  });

  // Close button
  modal.querySelector('.blog-post-close').addEventListener('click', () => {
    overlay.remove();
    blogPostEditor = null;
  });

  // Cancel button
  modal.querySelector('.blog-post-cancel').addEventListener('click', () => {
    overlay.remove();
    blogPostEditor = null;
  });

  // Save button
  modal.querySelector('.blog-post-save').addEventListener('click', () => {
    const newPostData = {
      title: document.getElementById('blogPostTitle').value.trim(),
      date: document.getElementById('blogPostDate').value,
      tags: document.getElementById('blogPostTags').value.trim(),
      image: document.getElementById('blogPostImage').value.trim(),
      embed: document.getElementById('blogPostEmbed').value.trim(),
      body: readMarkdownFromEditor(blogPostEditor)
    };

    const newMarkdown = generateBlogPostMarkdown(newPostData);
    overlay.remove();
    blogPostEditor = null;

    if (callback) callback(newMarkdown, newPostData.title);
  });
}

// Initialize blog editor (called for blog sites)
function initBlogEditor() {
  const editorContainer = document.getElementById('editor');
  if (!editorContainer) {
    console.error('Editor container not found');
    return;
  }

  // Add blog-mode class to editorSection for proper scrolling
  const editorSection = document.getElementById('editorSection');
  if (editorSection) {
    editorSection.classList.add('blog-mode');
  }

  // Hide the publish button for blog sites (auto-publish on save)
  const deployButton = document.getElementById('deployButton');
  if (deployButton) {
    deployButton.style.display = 'none';
  }

  // Hide the publish status for blog sites
  const publishStatus = document.getElementById('publishStatus');
  if (publishStatus) {
    publishStatus.style.display = 'none';
  }

  // Set top margin based on editor-topbar height
  const editorTopbar = document.getElementById('editor-topbar');
  if (editorTopbar) {
    const topbarHeight = editorTopbar.getBoundingClientRect().height;
    editorContainer.style.marginTop = topbarHeight + 'px';
  }

  editorContainer.innerHTML = '';
  editorContainer.className = 'blog-editor';

  // Hide footer text links in the block editor
  document.querySelectorAll('.footer-text').forEach(el => el.style.display = 'none');

  // Hide the Ko-fi button in the block editor
  document.querySelectorAll('.floatingchat-container-wrap').forEach(el => el.style.display = 'none');

  // Reduce footer padding to prevent excessive whitespace in block editor on mobile
  document.querySelector('#footer').style.paddingBottom = '10px';

  console.log('Blog editor initialized, rendering posts...');
  renderBlogPostsList();
}

// Render list of blog posts for editing
function renderBlogPostsList() {
  const container = document.getElementById('editor');
  console.log('renderBlogPostsList called, markdownCache length:', markdownCache.length);
  container.innerHTML = '';

  // Add new post button at top
  const addBtn = document.createElement('button');
  addBtn.className = 'blog-add-post-btn';
  addBtn.innerHTML = '+ New Post';
  addBtn.addEventListener('click', () => {
    addNewBlogPost();
  });
  container.appendChild(addBtn);

  // Sort posts by date (newest first) for display
  const sortedIndices = markdownCache
    .map((cacheItem, index) => ({
      index,
      date: parseBlogPostFrontmatter(cacheItem.content).date
    }))
    .sort((a, b) => {
      const dateA = a.date ? new Date(a.date) : new Date(0);
      const dateB = b.date ? new Date(b.date) : new Date(0);
      return dateB - dateA;
    });

  // Render each post
  sortedIndices.forEach(({ index }) => {
    const cacheItem = markdownCache[index];
    const postData = parseBlogPostFrontmatter(cacheItem.content);
    const postCard = document.createElement('div');
    postCard.className = 'blog-post-card';

    const postInfo = document.createElement('div');
    postInfo.className = 'blog-post-card-info';

    const title = document.createElement('div');
    title.className = 'blog-post-card-title';
    title.textContent = postData.title || cacheItem.displayName || 'Untitled';
    postInfo.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'blog-post-card-meta';
    meta.textContent = postData.date || '';
    if (postData.tags) {
      meta.textContent += ' | ' + postData.tags;
    }
    postInfo.appendChild(meta);

    postCard.appendChild(postInfo);

    const actions = document.createElement('div');
    actions.className = 'blog-post-card-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'blog-post-card-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => editBlogPost(index));
    actions.appendChild(editBtn);

    if (markdownCache.length > 1) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'blog-post-card-delete';
      deleteBtn.innerHTML = '&times;';
      deleteBtn.title = 'Delete post';
      deleteBtn.addEventListener('click', () => deleteBlogPost(index));
      actions.appendChild(deleteBtn);
    }

    postCard.appendChild(actions);
    container.appendChild(postCard);
  });
}

// Add new blog post
function addNewBlogPost() {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const displayName = `Post ${now.getTime()}`;
  const fileName = `public/${displayName.toLowerCase().replace(/\s+/g, '-')}.md`;

  const defaultContent = generateBlogPostMarkdown({
    title: 'New Post',
    date: dateStr,
    tags: '',
    image: '',
    embed: '',
    body: 'Write your post content here...'
  });

  showBlogPostEditModal(defaultContent, 'New Post', async (newContent, newTitle) => {
    const sanitizedFileName = `public/${newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.md`;

    addOrUpdateCache(sanitizedFileName, newTitle, newContent);
    renderBlogPostsList();

    // Auto-publish for blog sites - only send the new post
    await autoPublishBlogChanges({
      fileName: sanitizedFileName,
      content: newContent,
    });

    // Notify subscribers about the new post
    notifySubscribersOfNewPost(currentSiteId, newTitle, newContent);
  });
}

// Edit existing blog post
function editBlogPost(index) {
  const cacheItem = markdownCache[index];
  if (!cacheItem) return;

  const oldFileName = cacheItem.fileName;
  showBlogPostEditModal(cacheItem.content, cacheItem.displayName, async (newContent, newTitle) => {
    // Update cache
    cacheItem.content = newContent;
    cacheItem.displayName = newTitle;
    cacheItem.modifiedAt = new Date().toISOString();

    // Update filename if title changed
    const newFileName = `public/${newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.md`;
    const renamed = newFileName !== oldFileName;
    if (renamed) {
      cacheItem.fileName = newFileName;
    }

    renderBlogPostsList();

    // Auto-publish for blog sites - only send the modified post
    await autoPublishBlogChanges({
      fileName: newFileName,
      content: newContent,
      oldFileName: renamed ? oldFileName : null,
    });
  });
}

// Delete blog post
async function deleteBlogPost(index) {
  const cacheItem = markdownCache[index];
  if (!cacheItem) return;

  const postData = parseBlogPostFrontmatter(cacheItem.content);
  const title = postData.title || cacheItem.displayName || 'this post';

  if (!confirm(`Are you sure you want to delete "${title}"?`)) return;

  const deletedFileName = cacheItem.fileName;
  markdownCache.splice(index, 1);
  renderBlogPostsList();

  // Auto-publish for blog sites - only delete the removed post
  await autoPublishBlogChanges({
    fileName: deletedFileName,
    action: 'delete',
  });
}

// Auto-publish changes for blog sites
// changedPost: { fileName, content?, oldFileName?, action? }
async function autoPublishBlogChanges(changedPost) {
  // Show publishing indicator
  showBlogPublishingIndicator(true);

  try {
    // Commit changes to git
    await gitCommit(currentSiteId, "Update blog post");

    // Deploy only the changed post to R2
    const success = await deployBlogPost(currentSiteId, changedPost);

    if (success) {
      console.log("Blog changes auto-published successfully");
      // Enable visit site button after first publish
      setSiteAvailable(true);
    } else {
      console.error("Failed to auto-publish blog changes");
      alert("Failed to publish changes. Please try again.");
    }
  } catch (error) {
    console.error("Error auto-publishing blog changes:", error);
    alert("Error publishing changes: " + error.message);
  } finally {
    // Hide publishing indicator
    showBlogPublishingIndicator(false);
  }
}

// Show/hide publishing indicator for blog sites
function showBlogPublishingIndicator(show) {
  let indicator = document.getElementById('blogPublishingIndicator');

  if (show) {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'blogPublishingIndicator';
      indicator.className = 'blog-publishing-indicator';
      indicator.innerHTML = '<span class="publishing-spinner"></span> Publishing...';
      document.body.appendChild(indicator);
    }
    indicator.style.display = 'flex';
  } else if (indicator) {
    indicator.style.display = 'none';
  }
}

// Auto-publish site settings changes for blog sites
async function autoPublishBlogSettings() {
  showBlogPublishingIndicator(true);

  try {
    await gitCommit(currentSiteId, "Update site settings");
    const success = await deployChanges(currentSiteId);

    if (success) {
      console.log("Blog settings auto-published successfully");
      setSiteAvailable(true);
    } else {
      console.error("Failed to auto-publish blog settings");
      showAlertBar("Failed to publish settings. Please try again.", false);
    }
  } catch (error) {
    console.error("Error auto-publishing blog settings:", error);
    showAlertBar("Error publishing settings: " + error.message, false);
  } finally {
    showBlogPublishingIndicator(false);
  }
}

// Notify subscribers when a new blog post is published (fire-and-forget)
async function notifySubscribersOfNewPost(siteId, postTitle, postContent) {
  if (!siteId || !postTitle) return;

  // Read custom blog URL from site.json, fall back to AgoraPages URL
  let postUrl = `https://agorapages.com/s/${siteId}/`;
  try {
    const siteJsonContent = await getFileContent(siteId, "public/site.json");
    if (siteJsonContent) {
      const siteJson = JSON.parse(siteJsonContent);
      if (siteJson.blogEmailUrl) {
        // Ensure trailing slash
        postUrl = siteJson.blogEmailUrl.replace(/\/?$/, "/");
      }
    }
  } catch (e) {
    // Use default URL
  }

  // Extract excerpt from post body
  let excerpt = "";
  const bodyMatch = postContent.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
  const body = bodyMatch ? bodyMatch[1] : postContent;
  excerpt = body.replace(/[#*_`\[\]()]/g, "").trim().substring(0, 200);
  if (body.trim().length > 200) excerpt += "...";

  // Fire-and-forget — don't block the UI
  notifySubscribers(siteId, postTitle, excerpt, postUrl)
    .then(result => {
      if (result.sent > 0) {
        console.log(`Notified ${result.sent} subscriber(s) about "${postTitle}"`);
      }
    })
    .catch(err => {
      console.error("Failed to notify subscribers:", err);
    });
}

// Load blog posts into editor (called from on-load.js)
function loadBlogPostsIntoEditor(content) {
  // For blog sites, we show the posts list, not the block editor
  renderBlogPostsList();
}
