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

async function processImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.src = e.target.result;
    };

    img.onload = async () => {

      // Downsize if larger than 1 megapixel or exceeds max dimensions
      let width = img.width;
      let height = img.height;
      const maxPixels = 1000000; // 1 million pixels
      const totalPixels = width * height;
      const maxWidth = 1536; // 1920 * 0.8
      const maxHeight = 864; // 1080 * 0.8
      if (totalPixels > maxPixels) {
        const scaleFactor = Math.sqrt(maxPixels / totalPixels);
        width = Math.floor(width * scaleFactor);
        height = Math.floor(height * scaleFactor);
      }
      width = Math.min(width, maxWidth);
      height = Math.min(height, maxHeight);

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
            reject(new Error('Failed to convert image to AVIF'));
          }
        },
        'image/avif',
        0 // minimum quality
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
    const filename = `${sanitizedName}.avif`;

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

    // Check for document attachment block
    const docMatch = trimmed.match(/^```doc-attachment\n([\s\S]*?)\n```$/);
    if (docMatch) {
      blocks.push({
        id: generateBlockId(),
        type: 'document',
        content: docMatch[1].trim()
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
      case 'document':
        parts.push(`\`\`\`doc-attachment\n${block.content}\n\`\`\``);
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
    case 'document':
      return renderDocumentPreview(block.content);
    default:
      return `<div class="h-entry"><p>${escapeHtml(block.content)}</p></div>`;
  }
}

function renderPanelPreview(markdown) {
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

function renderDocumentPreview(filename) {
  const isDocx = filename.toLowerCase().endsWith('.docx');
  const icon = isDocx ? '&#x1F4DD;' : '&#x1F4C4;';
  const url = `${document.location.origin}/s/${currentSitePathFull}/${filename}`;
  return `<div class="pdf-download-container"><a href="${escapeHtml(url)}" class="pdf-download-button" target="_blank" download="${escapeHtml(filename)}"><span class="pdf-icon">${icon}</span> Download ${escapeHtml(filename)}</a></div>`;
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
    { type: 'image', icon: '🖼️', label: 'Image' },
    { type: 'embed', icon: '&#x1F3AC;', label: 'Embed' },
    { type: 'document', icon: '&#x1F4C4;', label: 'Document' }
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
        const imageUrl = `${document.location.origin}/s/${currentSitePathFull}/${filename}`;
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
    case 'document':
      showDocumentUploadPopup((filename) => {
        block.content = filename;
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
    height: '400px',
    initialValue: block.content,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['hr', 'quote'],
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

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      panelEditor = null;
    }
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
        <input type="file" id="imageFileInput" accept="image/*" style="display: none;" />
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
    if (file && file.type.startsWith('image/')) {
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
    const imageUrl = `${document.location.origin}/s/${currentSitePathFull}/${filename}`;

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
// Document Upload Popup (for blocks)
// ============================================

function showDocumentUploadPopup(callback) {
  pendingBlockCallback = callback;

  const existingPopup = document.querySelector('.document-upload-popup');
  if (existingPopup) existingPopup.remove();

  const popup = document.createElement('div');
  popup.className = 'block-popup document-upload-popup';

  popup.innerHTML = `
    <div class="popup-content">
      <div class="popup-header">
        <h3>Upload Document</h3>
        <button class="popup-close">&times;</button>
      </div>
      <div class="document-upload-dropzone" id="docDropzone">
        <input type="file" id="docFileInput" accept=".pdf,.docx" style="display: none;" />
        <div class="dropzone-content">
          <p class="dropzone-icon">&#x1F4C4;</p>
          <p>Click to select a PDF or DOCX file</p>
          <p style="font-size: 12px; color: #888;">Max file size: 10 MB</p>
        </div>
      </div>
      <div class="document-upload-progress" style="display: none;">
        <div class="progress-bar"><div class="progress-fill"></div></div>
        <p class="progress-text">Uploading...</p>
      </div>
      <div class="document-list-section">
        <h4>Uploaded Documents</h4>
        <div class="document-list" id="documentList"></div>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  const dropzone = popup.querySelector('#docDropzone');
  const fileInput = popup.querySelector('#docFileInput');
  const closeButton = popup.querySelector('.popup-close');
  const progressContainer = popup.querySelector('.document-upload-progress');
  const documentList = popup.querySelector('#documentList');

  populateDocumentListForBlock(documentList, popup);

  closeButton.addEventListener('click', () => {
    popup.remove();
    pendingBlockCallback = null;
  });

  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await handleDocumentUploadForBlock(file, popup, progressContainer, documentList);
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
    if (file) {
      await handleDocumentUploadForBlock(file, popup, progressContainer, documentList);
    }
  });
}

function populateDocumentListForBlock(listElement, popup) {
  listElement.innerHTML = '';

  if (documentCache.length === 0) {
    listElement.innerHTML = '<p class="list-empty">No documents uploaded yet</p>';
    return;
  }

  documentCache.forEach(filename => {
    const isDocx = filename.toLowerCase().endsWith('.docx');
    const icon = isDocx ? '&#x1F4DD;' : '&#x1F4C4;';

    const itemDiv = document.createElement('div');
    itemDiv.className = 'document-list-item';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'document-icon';
    iconSpan.innerHTML = icon;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'document-name';
    nameSpan.textContent = filename;

    const selectBtn = document.createElement('button');
    selectBtn.className = 'document-select-btn';
    selectBtn.textContent = 'Select';
    selectBtn.addEventListener('click', () => {
      popup.remove();
      if (pendingBlockCallback) {
        pendingBlockCallback(filename);
        pendingBlockCallback = null;
      }
    });

    itemDiv.appendChild(iconSpan);
    itemDiv.appendChild(nameSpan);
    itemDiv.appendChild(selectBtn);
    listElement.appendChild(itemDiv);
  });
}

async function handleDocumentUploadForBlock(file, popup, progressContainer, documentList) {
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    alert('File is too large. Maximum size is 10 MB.');
    return;
  }

  try {
    progressContainer.style.display = 'block';

    const originalExtension = file.name.toLowerCase().endsWith('.docx') ? '.docx' : '.pdf';
    const contentType = originalExtension === '.docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf';

    let originalName = file.name.replace(/\.(pdf|docx)$/i, '');
    const sanitizedName = originalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    const filename = `${sanitizedName}${originalExtension}`;

    const base64Content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const success = await saveFileToR2(currentSiteId, `public/${filename}`, base64Content, {
      encoding: 'base64',
      contentType: contentType
    });

    if (!success) throw new Error('Upload failed');

    addDocumentToCache(filename);
    progressContainer.style.display = 'none';
    populateDocumentListForBlock(documentList, popup);

    popup.remove();
    if (pendingBlockCallback) {
      pendingBlockCallback(filename);
      pendingBlockCallback = null;
    }
  } catch (error) {
    progressContainer.style.display = 'none';
    alert('Failed to upload: ' + error.message);
  }
}
