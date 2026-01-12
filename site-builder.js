let editor; // Global variable to store editor instance
let savedMarkdownBeforeCursor = null;
let savedMarkdownAfterCursor = null;

// Helper function to save cursor position by storing markdown split at cursor
function saveCursorPosition() {
  if (!editor) return;

  try {
    // Get current markdown
    const markdown = editor.getMarkdown();

    // Get selection - ToastUI returns [start, end] where each is [line, ch]
    const selection = editor.getSelection();

    if (selection && Array.isArray(selection) && selection.length >= 1) {
      const startPos = selection[0];
      let line, ch;

      // Handle both array format [line, ch] and object format {line, ch}
      if (Array.isArray(startPos)) {
        [line, ch] = startPos;
      } else if (startPos && typeof startPos === 'object') {
        line = startPos.line || startPos.row || 0;
        ch = startPos.ch || startPos.column || 0;
      } else {
        // Fallback - append to end
        savedMarkdownBeforeCursor = markdown.replace("<br>", "").trim();
        savedMarkdownAfterCursor = "";
        return;
      }

      // Calculate character offset in markdown string
      const lines = markdown.split('\n');
      let offset = 0;

      // Line numbers are 1-based in ToastUI
      const targetLine = Math.max(0, line - 1);
      for (let i = 0; i < targetLine && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for newline
      }
      offset += Math.min(ch, lines[targetLine]?.length || 0);

      // Clamp offset to valid range
      offset = Math.max(0, Math.min(offset, markdown.length));

      savedMarkdownBeforeCursor = markdown.substring(0, offset);
      savedMarkdownAfterCursor = markdown.substring(offset);
    } else {
      // No valid selection, append to end
      savedMarkdownBeforeCursor = markdown.replace("<br>", "").trim();
      savedMarkdownAfterCursor = "";
    }
  } catch (error) {
    console.error("Error saving cursor position:", error);
    // Fallback - append to end
    const markdown = editor.getMarkdown();
    savedMarkdownBeforeCursor = markdown.replace("<br>", "").trim();
    savedMarkdownAfterCursor = "";
  }
}

// Helper function to insert content at saved cursor position
function insertAtCursor(content) {
  if (!editor) return;

  const wrappedContent = `\n\n${content}\n\n`;

  if (savedMarkdownBeforeCursor !== null) {
    editor.setMarkdown(savedMarkdownBeforeCursor + wrappedContent + savedMarkdownAfterCursor);
  } else {
    // Fallback: append to end
    const markdown = editor.getMarkdown().replace("<br>", "").trim();
    editor.setMarkdown(markdown + wrappedContent);
  }

  // Reset saved positions
  savedMarkdownBeforeCursor = null;
  savedMarkdownAfterCursor = null;
}

// Helper function to convert image to AVIF and resize
async function processImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.src = e.target.result;
    };

    img.onload = async () => {
      // Calculate new dimensions (max 1080px)
      let width = img.width;
      let height = img.height;
      const maxSize = 1080;

      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = (height / width) * maxSize;
          width = maxSize;
        } else {
          width = (width / height) * maxSize;
          height = maxSize;
        }
      }

      // Create canvas and draw resized image
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Convert to AVIF using canvas.toBlob
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to convert image to AVIF'));
          }
        },
        'image/avif',
        0.85 // Quality
      );
    };

    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    reader.readAsDataURL(file);
  });
}

// Helper function to convert Blob to base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Remove the data URL prefix to get just the base64 string
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Function to process and upload image to R2 storage
async function processAndUploadImage(file) {
  try {
    // Process image (convert to AVIF and resize)
    const processedBlob = await processImage(file);

    // Generate filename (sanitize to lowercase letters and dashes, then change extension to .avif)
    let originalName = file.name.replace(/\.[^/.]+$/, '');
    if (originalName === "image") {
      originalName = `uploaded-image-${Date.now()}`;
    }
    const sanitizedName = originalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric chars with dashes
      .replace(/^-+|-+$/g, '')       // Remove leading/trailing dashes
      .replace(/-+/g, '-');           // Replace multiple dashes with single dash
    const filename = `${sanitizedName}.avif`;

    // Convert to base64
    const base64Content = await blobToBase64(processedBlob);

    // Upload to R2 storage
    const success = await uploadImage(currentSiteId, filename, base64Content);

    if (success) {
      // Add to imageCache
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

function loadToastEditor() {
  editor = new toastui.Editor({
    el: document.querySelector("#editor"),
    initialEditType: "wysiwyg",
    previewStyle: "vertical",
    theme: "dark",
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['hr', 'quote'],
      ['ul', 'ol', 'task', 'indent', 'outdent'],
      ['table', 'link'],
      [
        {
          el: createImageButton(),
          tooltip: 'Insert image',
          name: 'customImage'
        },
        {
          el: createHtmlEmbedButton(),
          tooltip: 'Insert embed (YouTube, SoundCloud, or HTML)',
          name: 'customHtmlEmbed'
        },
        {
          el: createPdfAttachButton(),
          tooltip: 'Attach Document (PDF or DOCX)',
          name: 'customPdfAttach'
        }
      ]
    ]
  });
}

// Create custom image toolbar button
function createImageButton() {
  const button = document.createElement('button');
  button.classList.add('toastui-editor-toolbar-icons');
  button.classList.add('image');
  button.type = 'button';

  button.addEventListener('click', () => {
    saveCursorPosition();
    showImageUploadPopup();
  });

  return button;
}

// Create custom HTML embed toolbar button
function createHtmlEmbedButton() {
  const button = document.createElement('button');
  button.classList.add('toastui-editor-toolbar-icons');
  button.classList.add('code');
  button.type = 'button';

  button.addEventListener('click', () => {
    saveCursorPosition();
    showHtmlEmbedPopup();
  });

  return button;
}

// Populate image gallery
function populateImageGallery(galleryElement) {
  galleryElement.innerHTML = '';

  imageCache.forEach(filename => {
    const imageUrl = `${document.location.origin}/s/${currentSitePathFull}/${filename}`;

    const itemDiv = document.createElement('div');
    itemDiv.className = 'image-gallery-item';

    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = filename;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'image-delete-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = 'Delete image';

    // Click image to insert into editor
    img.addEventListener('click', () => {
      const imageMarkdown = `![${filename}](${imageUrl})`;
      insertAtCursor(imageMarkdown);

      // Close the popup
      const popup = document.querySelector('.image-upload-popup');
      if (popup) popup.remove();
    });

    // Delete button handler
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      if (!confirm(`Are you sure you want to delete "${filename}"?`)) {
        return;
      }

      try {
        const success = await deleteImage(currentSiteId, filename);

        if (success) {
          removeImageFromCache(filename);
          populateImageGallery(galleryElement);
        } else {
          throw new Error('Failed to delete image from repository');
        }
      } catch (error) {
        console.error('Error deleting image:', error);
        alert('Failed to delete image: ' + error.message);
      }
    });

    itemDiv.appendChild(img);
    itemDiv.appendChild(deleteBtn);
    galleryElement.appendChild(itemDiv);
  });
}

// Show image upload popup
function showImageUploadPopup() {
  // Remove existing popup if any
  const existingPopup = document.querySelector('.image-upload-popup');
  if (existingPopup) {
    existingPopup.remove();
  }

  // Create popup container
  const popup = document.createElement('div');
  popup.className = 'toastui-editor-popup image-upload-popup';
  popup.style.display = 'block';
  popup.style.zIndex = '10000';

  // Create popup content
  popup.innerHTML = `
    <div class="toastui-editor-popup-body">
      <div class="image-upload-container">
        <div class="image-upload-header">
          <h3>Upload Image</h3>
          <button class="image-upload-close">×</button>
        </div>
        <div class="image-upload-dropzone" id="imageDropzone">
          <input type="file" id="imageFileInput" accept="image/*" style="display: none;" />
          <div class="dropzone-content">
            <p class="dropzone-icon">📁</p>
            <p>Click to select an image or drag and drop here</p>
          </div>
        </div>
        <div class="image-upload-progress" style="display: none;">
          <div class="progress-bar">
            <div class="progress-fill"></div>
          </div>
          <p class="progress-text">Processing and uploading...</p>
        </div>
        <div class="image-gallery-section">
          <h4>Image Gallery</h4>
          <div class="image-gallery" id="imageGallery">
            <!-- Images will be populated here -->
          </div>
        </div>
      </div>
    </div>
  `;

  // Append to editor container
  const toolbarContainer = document.getElementsByClassName("toastui-editor-toolbar")[0];
  toolbarContainer.appendChild(popup);

  // Get elements
  const dropzone = popup.querySelector('#imageDropzone');
  const fileInput = popup.querySelector('#imageFileInput');
  const closeButton = popup.querySelector('.image-upload-close');
  const progressContainer = popup.querySelector('.image-upload-progress');
  const imageGallery = popup.querySelector('#imageGallery');

  // Populate image gallery
  populateImageGallery(imageGallery);

  // Close button handler
  closeButton.addEventListener('click', () => {
    popup.remove();
  });

  // Blur event handler to hide popup when clicking outside
  popup.addEventListener('blur', (e) => {
    // Don't hide if the blur is caused by clicking within the popup
    setTimeout(() => {
      if (!popup.contains(document.activeElement)) {
        popup.style.display = 'none';
      }
    }, 0);
  }, true);

  // Make popup focusable and focus it
  popup.setAttribute('tabindex', '-1');
  popup.focus();

  // Prevent blur when clicking inside the popup
  popup.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  // Click to select file
  dropzone.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  // File input change handler
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await handleImageUpload(file, popup, progressContainer, imageGallery);
    }
  });

  // Drag and drop handlers
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.style.borderColor = '#1890ff';
    dropzone.style.backgroundColor = 'rgba(24, 144, 255, 0.1)';
  });

  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.style.borderColor = '#555';
    dropzone.style.backgroundColor = 'transparent';
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.style.borderColor = '#555';
    dropzone.style.backgroundColor = 'transparent';

    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      await handleImageUpload(file, popup, progressContainer, imageGallery);
    } else {
      alert('Please drop an image file');
    }
  });
}

// Handle image upload
async function handleImageUpload(file, popup, progressContainer, imageGallery) {
  try {
    // Show progress
    progressContainer.style.display = 'block';

    // Process and upload image
    const filename = await processAndUploadImage(file);

    // Hide progress
    progressContainer.style.display = 'none';

    // Refresh the image gallery
    populateImageGallery(imageGallery);

    // Insert image into editor at cursor position
    const imageUrl = `${document.location.origin}/s/${currentSitePathFull}/${filename}`;
    const imageMarkdown = `![${filename}](${imageUrl})`;
    insertAtCursor(imageMarkdown);

    // Close popup
    popup.remove();
  } catch (error) {
    console.error('Error handling image upload:', error);
    progressContainer.style.display = 'none';
    alert('Failed to upload image: ' + error.message);
  }
}

// Show HTML embed popup
function showHtmlEmbedPopup() {
  // Remove existing popup if any
  const existingPopup = document.querySelector('.html-embed-popup');
  if (existingPopup) {
    existingPopup.remove();
  }

  // Create popup container
  const popup = document.createElement('div');
  popup.className = 'toastui-editor-popup html-embed-popup';
  popup.style.display = 'block';
  popup.style.zIndex = '10000';

  // Create popup content
  popup.innerHTML = `
    <div class="toastui-editor-popup-body">
      <div class="html-embed-container">
        <div class="html-embed-header">
          <h3>Insert Embed</h3>
          <button class="html-embed-close">×</button>
        </div>
        <div class="html-embed-form">
          <div class="embed-type-selector" style="margin-bottom: 12px;">
            <label style="display: inline; margin-right: 15px; cursor: pointer;">
              <input type="radio" name="embedType" value="youtube" checked style="margin-right: 5px;">
              YouTube
            </label>
            <label style="display: inline; margin-right: 15px; cursor: pointer;">
              <input type="radio" name="embedType" value="soundcloud" style="margin-right: 5px;">
              SoundCloud
            </label>
            <label style="display: inline; cursor: pointer;">
              <input type="radio" name="embedType" value="html" style="margin-right: 5px;">
              HTML
            </label>
          </div>
          <div id="youtubeEmbedSection">
            <label for="youtubeUrlInput">Paste YouTube video URL:</label>
            <input type="text" id="youtubeUrlInput" placeholder="https://youtu.be/..." style="width: 100%; padding: 8px; margin-top: 5px; border: 1px solid #555; border-radius: 4px; background: #2d2d2d; color: #fff;">
          </div>
          <div id="soundcloudEmbedSection" style="display: none;">
            <label for="soundcloudUrlInput">Paste SoundCloud URL:</label>
            <input type="text" id="soundcloudUrlInput" placeholder="https://soundcloud.com/artist/track" style="width: 100%; padding: 8px; margin-top: 5px; border: 1px solid #555; border-radius: 4px; background: #2d2d2d; color: #fff;">
          </div>
          <div id="htmlEmbedSection" style="display: none;">
            <label for="htmlEmbedTextarea">Paste your HTML code:</label>
            <textarea id="htmlEmbedTextarea" rows="3" placeholder="<iframe src=&quot;...&quot;></iframe>"></textarea>
          </div>
          <div class="html-embed-buttons">
            <button class="html-embed-insert-btn toastui-editor-ok-button">Insert</button>
            <button class="html-embed-cancel-btn toastui-editor-close-button">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Append to editor container
  const toolbarContainer = document.getElementsByClassName("toastui-editor-toolbar")[0];
  toolbarContainer.appendChild(popup);

  // Get elements
  const textarea = popup.querySelector('#htmlEmbedTextarea');
  const youtubeInput = popup.querySelector('#youtubeUrlInput');
  const soundcloudInput = popup.querySelector('#soundcloudUrlInput');
  const youtubeSection = popup.querySelector('#youtubeEmbedSection');
  const soundcloudSection = popup.querySelector('#soundcloudEmbedSection');
  const htmlSection = popup.querySelector('#htmlEmbedSection');
  const embedTypeRadios = popup.querySelectorAll('input[name="embedType"]');
  const closeButton = popup.querySelector('.html-embed-close');
  const insertButton = popup.querySelector('.html-embed-insert-btn');
  const cancelButton = popup.querySelector('.html-embed-cancel-btn');

  // Handle embed type radio change
  embedTypeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      youtubeSection.style.display = 'none';
      soundcloudSection.style.display = 'none';
      htmlSection.style.display = 'none';

      if (e.target.value === 'youtube') {
        youtubeSection.style.display = 'block';
        youtubeInput.focus();
      } else if (e.target.value === 'soundcloud') {
        soundcloudSection.style.display = 'block';
        soundcloudInput.focus();
      } else {
        htmlSection.style.display = 'block';
        textarea.focus();
      }
    });
  });

  // Close button handler
  closeButton.addEventListener('click', () => {
    popup.remove();
  });

  // Cancel button handler
  cancelButton.addEventListener('click', () => {
    popup.remove();
  });

  // Insert button handler
  insertButton.addEventListener('click', () => {
    const selectedType = popup.querySelector('input[name="embedType"]:checked').value;
    let embedContent;

    if (selectedType === 'youtube') {
      const youtubeUrl = youtubeInput.value.trim();
      if (!youtubeUrl) {
        alert('Please enter a YouTube URL');
        return;
      }
      embedContent = youtubeUrl;
    } else if (selectedType === 'soundcloud') {
      const soundcloudUrl = soundcloudInput.value.trim();
      if (!soundcloudUrl) {
        alert('Please enter a SoundCloud URL');
        return;
      }
      embedContent = soundcloudUrl;
    } else {
      const htmlCode = textarea.value.trim();
      if (!htmlCode) {
        alert('Please enter HTML code');
        return;
      }
      embedContent = htmlCode;
    }

    // Insert into editor as code-block-enclosed embed at cursor position
    const htmlEmbed = `\`\`\`embed\n${embedContent}\n\`\`\``;
    insertAtCursor(htmlEmbed);

    // Close popup
    popup.remove();
  });

  // Blur event handler to hide popup when clicking outside
  popup.addEventListener('blur', (e) => {
    setTimeout(() => {
      if (!popup.contains(document.activeElement)) {
        popup.style.display = 'none';
      }
    }, 0);
  }, true);

  // Make popup focusable and focus it
  popup.setAttribute('tabindex', '-1');
  popup.focus();

  // Prevent blur when clicking inside the popup (but not on interactive elements)
  popup.addEventListener('mousedown', (e) => {
    // Don't prevent default on interactive elements to allow them to work
    const interactiveTags = ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'];
    if (!interactiveTags.includes(e.target.tagName)) {
      e.preventDefault();
    }
  });

  // Focus the YouTube input (default selection)
  setTimeout(() => {
    youtubeInput.focus();
  }, 100);
}

// Create custom PDF attach toolbar button
function createPdfAttachButton() {
  const button = document.createElement('button');
  button.classList.add('toastui-editor-toolbar-icons');
  button.type = 'button';
  button.innerHTML = '📄';
  button.style.backgroundImage = 'none';
  button.style.fontSize = '16px';

  button.addEventListener('click', () => {
    saveCursorPosition();
    showPdfUploadPopup();
  });

  return button;
}

// Show PDF/DOCX upload popup
function showPdfUploadPopup() {
  // Remove existing popup if any
  const existingPopup = document.querySelector('.pdf-upload-popup');
  if (existingPopup) {
    existingPopup.remove();
  }

  // Create popup container
  const popup = document.createElement('div');
  popup.className = 'toastui-editor-popup pdf-upload-popup';
  popup.style.display = 'block';
  popup.style.zIndex = '10000';

  // Create popup content
  popup.innerHTML = `
    <div class="toastui-editor-popup-body">
      <div class="pdf-upload-container">
        <div class="pdf-upload-header">
          <h3>Attach Document</h3>
          <button class="pdf-upload-close">×</button>
        </div>
        <div class="pdf-upload-dropzone" id="pdfDropzone">
          <input type="file" id="pdfFileInput" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" style="display: none;" />
          <div class="dropzone-content">
            <p class="dropzone-icon">📄</p>
            <p>Click to select a PDF or DOCX file, or drag and drop here</p>
            <p style="font-size: 12px; color: #888;">Max file size: 10 MB</p>
          </div>
        </div>
        <div class="pdf-upload-progress" style="display: none;">
          <div class="progress-bar">
            <div class="progress-fill"></div>
          </div>
          <p class="progress-text">Uploading document...</p>
        </div>
        <div class="document-list-section">
          <h4>Uploaded Documents</h4>
          <div class="document-list" id="documentList">
            <!-- Documents will be populated here -->
          </div>
        </div>
      </div>
    </div>
  `;

  // Append to editor container
  const toolbarContainer = document.getElementsByClassName("toastui-editor-toolbar")[0];
  toolbarContainer.appendChild(popup);

  // Get elements
  const dropzone = popup.querySelector('#pdfDropzone');
  const fileInput = popup.querySelector('#pdfFileInput');
  const closeButton = popup.querySelector('.pdf-upload-close');
  const progressContainer = popup.querySelector('.pdf-upload-progress');
  const documentList = popup.querySelector('#documentList');

  // Populate document list
  populateDocumentList(documentList);

  // Close button handler
  closeButton.addEventListener('click', () => {
    popup.remove();
  });

  // Blur event handler to hide popup when clicking outside
  popup.addEventListener('blur', (e) => {
    setTimeout(() => {
      if (!popup.contains(document.activeElement)) {
        popup.style.display = 'none';
      }
    }, 0);
  }, true);

  // Make popup focusable and focus it
  popup.setAttribute('tabindex', '-1');
  popup.focus();

  // Prevent blur when clicking inside the popup
  popup.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  // Click to select file
  dropzone.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  // File input change handler
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      await handlePdfUpload(file, popup, progressContainer);
    }
  });

  // Drag and drop handlers
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.style.borderColor = '#1890ff';
    dropzone.style.backgroundColor = 'rgba(24, 144, 255, 0.1)';
  });

  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.style.borderColor = '#555';
    dropzone.style.backgroundColor = 'transparent';
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.style.borderColor = '#555';
    dropzone.style.backgroundColor = 'transparent';

    const file = e.dataTransfer.files[0];
    const validTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    const validExtensions = ['.pdf', '.docx'];
    const hasValidType = validTypes.includes(file.type);
    const hasValidExtension = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));

    if (file && (hasValidType || hasValidExtension)) {
      await handlePdfUpload(file, popup, progressContainer);
    } else {
      alert('Please drop a PDF or DOCX file');
    }
  });
}

// Handle PDF/DOCX upload
async function handlePdfUpload(file, popup, progressContainer) {
  // Check file size (10 MB max)
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    alert('File is too large. Maximum size is 10 MB.');
    return;
  }

  try {
    // Show progress
    progressContainer.style.display = 'block';

    // Determine file extension
    const originalExtension = file.name.toLowerCase().endsWith('.docx') ? '.docx' : '.pdf';
    const contentType = originalExtension === '.docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/pdf';

    // Sanitize filename (remove extension first, then add it back)
    let originalName = file.name.replace(/\.(pdf|docx)$/i, '');
    const sanitizedName = originalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
    const filename = `${sanitizedName}${originalExtension}`;

    // Read file as base64
    const base64Content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    // Upload to R2 storage
    const success = await saveFileToR2(currentSiteId, `public/${filename}`, base64Content, {
      encoding: 'base64',
      contentType: contentType
    });

    if (!success) {
      throw new Error('Failed to upload PDF');
    }

    // Hide progress
    progressContainer.style.display = 'none';

    // Insert document attachment markdown into editor at cursor position
    const docEmbed = `\`\`\`doc-attachment\n${filename}\n\`\`\``;
    insertAtCursor(docEmbed);

    // Close popup
    popup.remove();

    // Add to document cache
    addDocumentToCache(filename);

    console.log('Document uploaded successfully:', filename);
  } catch (error) {
    console.error('Error handling document upload:', error);
    progressContainer.style.display = 'none';
    alert('Failed to upload document: ' + error.message);
  }
}

// Populate document list
function populateDocumentList(listElement) {
  listElement.innerHTML = '';

  if (documentCache.length === 0) {
    listElement.innerHTML = '<div class="document-list-empty">No documents uploaded yet</div>';
    return;
  }

  documentCache.forEach(filename => {
    const docUrl = `${document.location.origin}/s/${currentSitePathFull}/${filename}`;
    const isDocx = filename.toLowerCase().endsWith('.docx');
    const icon = isDocx ? '📝' : '📄';

    const itemDiv = document.createElement('div');
    itemDiv.className = 'document-list-item';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'document-icon';
    iconSpan.textContent = icon;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'document-name';
    nameSpan.textContent = filename;
    nameSpan.title = filename;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'document-actions';

    // Insert button
    const insertBtn = document.createElement('button');
    insertBtn.className = 'document-insert-btn';
    insertBtn.textContent = 'Insert';
    insertBtn.title = 'Insert into editor';
    insertBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const docEmbed = `\`\`\`doc-attachment\n${filename}\n\`\`\``;
      insertAtCursor(docEmbed);

      // Close the popup
      const popup = document.querySelector('.pdf-upload-popup');
      if (popup) popup.remove();
    });

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'document-delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Delete document';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      if (!confirm(`Are you sure you want to delete "${filename}"?`)) {
        return;
      }

      try {
        const success = await deleteFileFromR2(currentSiteId, `public/${filename}`);

        if (success) {
          removeDocumentFromCache(filename);
          populateDocumentList(listElement);
        } else {
          throw new Error('Failed to delete document');
        }
      } catch (error) {
        console.error('Error deleting document:', error);
        alert('Failed to delete document: ' + error.message);
      }
    });

    actionsDiv.appendChild(insertBtn);
    actionsDiv.appendChild(deleteBtn);

    itemDiv.appendChild(iconSpan);
    itemDiv.appendChild(nameSpan);
    itemDiv.appendChild(actionsDiv);
    listElement.appendChild(itemDiv);
  });
}
