// Block-based editor state
let currentBlocks = [];
let blockIdCounter = 0;
let pendingBlockCallback = null;

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
  wrapper.draggable = true;

  // Drag handle and controls
  const controls = document.createElement('div');
  controls.className = 'block-controls';

  const controlsLeft = document.createElement('div');
  controlsLeft.className = 'block-controls-left';

  const dragHandle = document.createElement('span');
  dragHandle.className = 'block-drag-handle';
  dragHandle.innerHTML = '&#x2630;';
  dragHandle.title = 'Drag to reorder';

  const typeLabel = document.createElement('span');
  typeLabel.className = 'block-type-label';
  typeLabel.textContent = block.type.charAt(0).toUpperCase() + block.type.slice(1);

  controlsLeft.appendChild(dragHandle);
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

  // Preview content
  const preview = document.createElement('div');
  preview.className = 'block-preview';
  preview.innerHTML = renderBlockPreview(block);

  wrapper.appendChild(controls);
  wrapper.appendChild(preview);

  // Drag and drop events
  wrapper.addEventListener('dragstart', handleDragStart);
  wrapper.addEventListener('dragend', handleDragEnd);
  wrapper.addEventListener('dragover', handleDragOver);
  wrapper.addEventListener('drop', handleDrop);

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
  const parsed = marked.parse(markdown);
  const sanitized = DOMPurify.sanitize(parsed);
  return `<article class="h-entry"><div class="e-content">${sanitized}</div></article>`;
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
  const isExternal = url.startsWith('https://');
  const icon = isExternal ? '&#x1F310;' : '&#x1F517;'; // Globe for external, link for local
  const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<div class="link-button-container"><a href="${escapeHtml(url)}" class="link-button"${target}><span class="link-icon">${icon}</span> ${escapeHtml(label)}</a></div>`;
}

function extractYouTubeVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/v\/|youtube\.com\/watch\?.*&v=)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
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
      showPanelEditModal(block, (newContent) => {
        block.content = newContent;
        saveBlocksToCache();
        renderAllBlocks();
      });
      break;
    case 'image':
      // Parse current caption from existing content
      const captionMatch = block.content.match(/!\[[^\]]*\]\([^)]+\s+"([^"]+)"\)/);
      const currentCaption = captionMatch ? captionMatch[1] : '';
      showImageUploadPopup(({ filename, caption }) => {
        const imageUrl = `/s/${currentSitePathFull}/${filename}`;
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

  currentBlocks.splice(index, 1);
  saveBlocksToCache();
  renderAllBlocks();
}

// ============================================
// Drag and Drop
// ============================================

let draggedIndex = null;

function handleDragStart(e) {
  draggedIndex = parseInt(e.currentTarget.dataset.index);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.block-item').forEach(el => {
    el.classList.remove('drag-over');
  });
  draggedIndex = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.currentTarget;
  if (target.classList.contains('block-item')) {
    target.classList.add('drag-over');
  }
}

function handleDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  target.classList.remove('drag-over');

  const targetIndex = parseInt(target.dataset.index);
  if (draggedIndex === null || draggedIndex === targetIndex) return;

  // Reorder blocks
  const [movedBlock] = currentBlocks.splice(draggedIndex, 1);
  currentBlocks.splice(targetIndex, 0, movedBlock);

  saveBlocksToCache();
  renderAllBlocks();
}

// ============================================
// Panel Edit Modal
// ============================================

let panelEditor = null;

function showPanelEditModal(block, callback) {
  // Remove existing modal
  const existingModal = document.querySelector('.panel-edit-modal-overlay');
  if (existingModal) existingModal.remove();

  const overlay = document.createElement('div');
  overlay.className = 'panel-edit-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'panel-edit-modal';

  modal.innerHTML = `
    <div class="panel-edit-header">
      <h3>Edit Panel</h3>
      <button class="panel-edit-close">&times;</button>
    </div>
    <div class="panel-edit-body">
      <div id="panelEditor"></div>
    </div>
    <div class="panel-edit-footer">
      <button class="panel-edit-cancel">Cancel</button>
      <button class="panel-edit-confirm">Confirm</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Initialize ToastUI editor
  panelEditor = new toastui.Editor({
    el: document.querySelector('#panelEditor'),
    initialEditType: 'wysiwyg',
    previewStyle: 'vertical',
    theme: 'dark',
    height: '300px',
    initialValue: block.content,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'link']
    ]
  });

  // Event handlers
  modal.querySelector('.panel-edit-close').addEventListener('click', () => {
    overlay.remove();
    panelEditor = null;
  });

  modal.querySelector('.panel-edit-cancel').addEventListener('click', () => {
    overlay.remove();
    panelEditor = null;
  });

  modal.querySelector('.panel-edit-confirm').addEventListener('click', () => {
    const newContent = panelEditor.getMarkdown().replace(/<br\s*\/?>/gi, '').trim();
    overlay.remove();
    panelEditor = null;
    if (callback) callback(newContent);
  });

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
    const imageUrl = `/s/${currentSitePathFull}/${filename}`;

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
    initialValue: postData.body,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'link']
    ]
  });

  // Image select button
  modal.querySelector('#blogPostImageSelect').addEventListener('click', () => {
    showImageUploadPopup(({ filename }) => {
      document.getElementById('blogPostImage').value = filename;
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
      body: blogPostEditor.getMarkdown().replace(/<br\s*\/?>/gi, '').trim()
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
