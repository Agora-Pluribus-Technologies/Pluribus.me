let editor; // Global variable to store editor instance

function loadToastEditor() {
  editor = new toastui.Editor({
    el: document.querySelector("#editor"),
    initialEditType: "wysiwyg",
    previewStyle: "vertical",
    theme: "dark",
  });

  editorDiv = document.getElementById("editor");
  editorDiv.height = "100%";
  editorDiv.width = "80%";
}
