let editor; // Global variable to store editor instance

function loadToastEditor() {
  editor = new toastui.Editor({
    el: document.querySelector("#editor"),
    height: "500px",
    initialEditType: "wysiwyg",
    previewStyle: "vertical",
  });
}
