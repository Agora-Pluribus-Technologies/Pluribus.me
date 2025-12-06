let editor; // Global variable to store editor instance
let turndownService; // For converting HTML to Markdown

// Custom Image Blot that auto-resizes and converts to AVIF
const BlockEmbed = Quill.import('blots/block/embed');

class ImageBlot extends BlockEmbed {
  static blotName = 'image';
  static tagName = 'img';

  static create(value) {
    const node = super.create();
    node.setAttribute('src', value.src || value);
    if (value.alt) {
      node.setAttribute('alt', value.alt);
    }
    node.setAttribute('style', 'max-width: 100%; height: auto;');
    return node;
  }

  static value(node) {
    return {
      src: node.getAttribute('src'),
      alt: node.getAttribute('alt')
    };
  }
}

Quill.register(ImageBlot);

// Function to resize and convert image to AVIF
async function processImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Calculate new dimensions maintaining aspect ratio
        let width = img.width;
        let height = img.height;
        const maxWidth = 1920;
        const maxHeight = 1080;

        if (width > maxWidth || height > maxHeight) {
          const aspectRatio = width / height;
          if (width > height) {
            width = maxWidth;
            height = width / aspectRatio;
            if (height > maxHeight) {
              height = maxHeight;
              width = height * aspectRatio;
            }
          } else {
            height = maxHeight;
            width = height * aspectRatio;
            if (width > maxWidth) {
              width = maxWidth;
              height = width / aspectRatio;
            }
          }
        }

        // Create canvas and resize
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to AVIF (fallback to WebP if not supported, then JPEG)
        canvas.toBlob(
          (blob) => {
            if (blob) {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            } else {
              // Fallback to WebP
              canvas.toBlob(
                (blob) => {
                  if (blob) {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                  } else {
                    // Final fallback to JPEG
                    canvas.toBlob(
                      (blob) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                      },
                      'image/jpeg',
                      0.9
                    );
                  }
                },
                'image/webp',
                0.9
              );
            }
          },
          'image/avif',
          0.9
        );
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadQuillEditor() {
  // Initialize Turndown for HTML to Markdown conversion
  turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
  });

  // Initialize Quill editor
  editor = new Quill('#editor', {
    theme: 'snow',
    modules: {
      toolbar: [
        [{ 'header': [1, 2, 3, false] }],
        ['bold', 'italic', 'strike'],
        ['blockquote', 'code-block'],
        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
        ['image', 'link']
      ]
    }
  });

  // Handle image insertion
  const toolbar = editor.getModule('toolbar');
  toolbar.addHandler('image', () => {
    const input = document.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', 'image/*');
    input.click();

    input.onchange = async () => {
      const file = input.files[0];
      if (file) {
        try {
          const processedDataUrl = await processImage(file);
          const range = editor.getSelection(true);
          editor.insertEmbed(range.index, 'image', processedDataUrl);
          editor.setSelection(range.index + 1);
        } catch (error) {
          console.error('Error processing image:', error);
          alert('Failed to process image. Please try again.');
        }
      }
    };
  });
}

// Convert Quill Delta/HTML to Markdown
function getMarkdown() {
  const html = editor.root.innerHTML;
  return turndownService.turndown(html);
}

// Set Markdown content in Quill (convert from Markdown to HTML first)
function setMarkdown(markdown) {
  // Simple markdown to HTML conversion for basic formatting
  let html = markdown
    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Code blocks
    .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
    // Inline code
    .replace(/`(.+?)`/g, '<code>$1</code>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Line breaks
    .replace(/\n/g, '<br>');

  editor.root.innerHTML = html;
}
