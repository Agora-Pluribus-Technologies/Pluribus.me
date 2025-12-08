let editor; // Global variable to store editor instance

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

// Function to upload image to repository
async function uploadImage(file) {
  try {
    // Process image (convert to AVIF and resize)
    const processedBlob = await processImage(file);

    // Generate filename (sanitize to lowercase letters and dashes, then change extension to .avif)
    const originalName = file.name.replace(/\.[^/.]+$/, '');
    const sanitizedName = originalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric chars with dashes
      .replace(/^-+|-+$/g, '')       // Remove leading/trailing dashes
      .replace(/-+/g, '-');           // Replace multiple dashes with single dash
    const filename = `${sanitizedName}.avif`;

    // Convert to base64
    const base64Content = await blobToBase64(processedBlob);

    // Upload to repository
    let success = false;
    if (getOauthTokenGitlab() !== null) {
      success = await uploadImageGitlab(currentSiteId, filename, base64Content);
    } else if (getOauthTokenGithub() !== null) {
      success = await uploadImageGithub(currentSiteId, filename, base64Content);
    }

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
          tooltip: 'Insert HTML embed',
          name: 'customHtmlEmbed'
        }
      ]
    ],
    customHTMLRenderer: {
      // Override soft line breaks ("softbreak")
      softbreak() {
        return {
          html: '' // empty = NO <br>
        };
      }
    }
  });

  // Add blur event listener to all toolbar buttons
  setTimeout(() => {
    const toolbarButtons = document.querySelectorAll('.toastui-editor-toolbar-icons');
    toolbarButtons.forEach(button => {
      button.addEventListener('click', () => {
        button.blur();
      });
    });
  }, 100);
}

// Create custom image toolbar button
function createImageButton() {
  const button = document.createElement('button');
  button.classList.add('toastui-editor-toolbar-icons');
  button.classList.add('image');
  button.type = 'button';

  button.addEventListener('click', () => {
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
      const currentMarkdown = editor.getMarkdown();
      const imageMarkdown = `![${filename}](${imageUrl})`;
      editor.setMarkdown(currentMarkdown + '\n' + imageMarkdown);

      // Close the popup
      const popup = document.querySelector('.image-upload-popup');
      if (popup) popup.remove();

      showAlertBar('Image inserted into editor!', true);
    });

    // Delete button handler
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();

      if (!confirm(`Are you sure you want to delete "${filename}"?`)) {
        return;
      }

      try {
        let success = false;
        if (getOauthTokenGitlab() !== null) {
          success = await deleteImageGitlab(currentSiteId, filename);
        } else if (getOauthTokenGithub() !== null) {
          success = await deleteImageGithub(currentSiteId, filename);
        }

        if (success) {
          removeImageFromCache(filename);
          populateImageGallery(galleryElement);
          showAlertBar('Image deleted successfully!', true);
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

    // Upload image
    const filename = await uploadImage(file);

    // Hide progress
    progressContainer.style.display = 'none';

    // Refresh the image gallery
    populateImageGallery(imageGallery);

    // Insert image into editor (use setMarkdown to avoid escaping)
    const imageUrl = `${document.location.origin}/s/${currentSitePathFull}/${filename}`;
    const currentMarkdown = editor.getMarkdown();
    const imageMarkdown = `![${filename}](${imageUrl})`;
    editor.setMarkdown(currentMarkdown + '\n' + imageMarkdown);

    // Close popup
    popup.remove();

    // Show success message
    showAlertBar('Image uploaded successfully!', true);
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
          <h3>Insert HTML Embed</h3>
          <button class="html-embed-close">×</button>
        </div>
        <div class="html-embed-form">
          <label for="htmlEmbedTextarea">Paste your HTML code:</label>
          <textarea id="htmlEmbedTextarea" rows="10" placeholder="<iframe src=&quot;...&quot;></iframe>"></textarea>
          <div class="html-embed-buttons">
            <button class="html-embed-insert-btn toastui-editor-ok-button">Insert HTML</button>
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
  const closeButton = popup.querySelector('.html-embed-close');
  const insertButton = popup.querySelector('.html-embed-insert-btn');
  const cancelButton = popup.querySelector('.html-embed-cancel-btn');

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
    const htmlCode = textarea.value.trim();

    if (!htmlCode) {
      alert('Please enter HTML code');
      return;
    }

    // Insert HTML into editor as code-block-enclosed HTML block
    let currentMarkdown = editor.getMarkdown();

    while (!currentMarkdown.endsWith("\n\n")) {
      currentMarkdown = `${currentMarkdown}\n`
    }

    editor.setMarkdown(`${currentMarkdown}\`\`\`embed\n${htmlCode}\n\`\`\``);

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

  // Prevent blur when clicking inside the popup (but not on buttons)
  popup.addEventListener('mousedown', (e) => {
    // Don't prevent default on buttons to allow clicks to work
    if (e.target.tagName !== 'BUTTON') {
      e.preventDefault();
    }
  });

  // Focus the textarea
  setTimeout(() => {
    textarea.focus();
  }, 100);
}
