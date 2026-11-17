/**
 * Background service worker.
 *
 * Deliberately tiny: the extension does all real work in the content script, on the
 * page, so chat data never has to cross into another context. This worker only keeps
 * storage tidy and makes `chrome.storage.session` readable from the content script.
 */
importScripts('/src/lib/namespace.js');

var WAEx = self.WAEx;

/** Content scripts need explicit permission to see session storage. */
function allowSessionStorageForContent() {
  if (!chrome.storage || !chrome.storage.session || !chrome.storage.session.setAccessLevel) return;
  try {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }, function () {
      void chrome.runtime.lastError;
    });
  } catch (err) {
    /* older Chrome: the popup still gets live state via ping */
  }
}

/** Seed defaults once, and drop a stale export state from a previous browser session. */
function bootstrap() {
  allowSessionStorageForContent();

  chrome.storage.local.get([WAEx.STORAGE_KEY, WAEx.HISTORY_KEY], function (data) {
    void chrome.runtime.lastError;
    var patch = {};

    if (!data || !data[WAEx.STORAGE_KEY]) {
      patch[WAEx.STORAGE_KEY] = WAEx.DEFAULT_SETTINGS;
    }
    if (!data || !Array.isArray(data[WAEx.HISTORY_KEY])) {
      patch[WAEx.HISTORY_KEY] = [];
    }
    if (Object.keys(patch).length) {
      chrome.storage.local.set(patch, function () {
        void chrome.runtime.lastError;
      });
    }
  });

  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.get([WAEx.STATE_KEY], function (data) {
      void chrome.runtime.lastError;
      var state = data && data[WAEx.STATE_KEY];
      var stale = !state || (state.finishedAt && Date.now() - state.finishedAt > 24 * 60 * 60 * 1000);
      if (stale && state) {
        chrome.storage.session.remove([WAEx.STATE_KEY], function () {
          void chrome.runtime.lastError;
        });
      }
    });
  }
}

chrome.runtime.onInstalled.addListener(function (details) {
  bootstrap();
  if (details && details.reason === 'install') {
    // No onboarding tab: a first-run popup is already self-explanatory.
    allowSessionStorageForContent();
  }
});

chrome.runtime.onStartup.addListener(function () {
  bootstrap();
});

// Keep the session access level in place after an extension update.
allowSessionStorageForContent();
