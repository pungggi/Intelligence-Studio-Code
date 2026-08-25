//! VS Code variant of `corecode-bridge.js` — injected into `.vsix` webview assets.
//! Uses `acquireVsCodeApi()` instead of Tauri's `__TAURI__` IPC.

pub const BRIDGE: &str = r#"// corecode-bridge.js — VS Code variant (generated into .vsix)
(function () {
  'use strict';
  const vscodeApi = acquireVsCodeApi();

  window.coreCode = {
    postMessage: function (data) {
      vscodeApi.postMessage(data);
    },
    request: function (data) {
      return new Promise(function (resolve) {
        var id = Math.random().toString(36).slice(2);
        var wrapped = Object.assign({}, data, { __requestId: id });
        var handler = function (event) {
          if (event.data && event.data.__requestId === id) {
            window.removeEventListener('message', handler);
            resolve(event.data);
          }
        };
        window.addEventListener('message', handler);
        vscodeApi.postMessage(wrapped);
      });
    },
    onMessage: function (callback) {
      window.addEventListener('message', function (event) {
        if (event.data && !event.data.__requestId) {
          callback(event.data);
        }
      });
    },
  };
})();
"#;
