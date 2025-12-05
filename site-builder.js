let editor; // Global variable to store editor instance
let turndownService; // For converting HTML to Markdown

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
        ['link'],
        ['clean']
      ]
    }
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
