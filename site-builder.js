let editor; // Global variable to store editor instance

function loadToastEditor() {
  editor = new toastui.Editor({
    el: document.querySelector("#editor"),
    initialEditType: "wysiwyg",
    previewStyle: "vertical",
    theme: "dark",
  });

  const editorDiv = document.getElementById("editor");
  editorDiv.style.height = "100%";
  editorDiv.style.maxWidth = "100%";
}
