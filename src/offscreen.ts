chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") {
    return false;
  }
  if (message.type === "clipboard-write") {
    const textEl = document.createElement("textarea");
    textEl.value = message.text || "";
    document.body.appendChild(textEl);
    textEl.select();
    document.execCommand("copy");
    textEl.remove();
    sendResponse({ status: "ok" });
  } else if (message.type === "clipboard-read") {
    const textEl = document.createElement("textarea");
    document.body.appendChild(textEl);
    textEl.focus();
    document.execCommand("paste");
    const text = textEl.value;
    textEl.remove();
    sendResponse({ text });
  }
  return true;
});