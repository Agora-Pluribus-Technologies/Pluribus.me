let editor; // Global variable to store editor instance

function loadToastEditor() {
  editor = new toastui.Editor({
    el: document.querySelector("#editor"),
    initialEditType: "wysiwyg",
    previewStyle: "vertical",
    theme: "dark",
    toolbarItems: [
    'heading',
    'bold',
    'italic',
    'strike',
    'hr',
    'quote',
    'ul',
    'ol',
    'task',
    'table',
    'link',
    'code',
    ]
  });
}
