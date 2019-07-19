// ==UserScript==
// @name        MangaDex-Upscaler
// @description Upscale mangadex images using https://github.com/awused/mangadex-upscaler.
// @include     https://mangadex.org/*
// @version     0.1
// @grant       unsafeWindow
// @grant       GM.setValue
// @grant       GM.getValue
// @updateURL   https://raw.githubusercontent.com/awused/mangadex-upscaler/master/mangadex-upscaler.user.js
// @downloadURL https://raw.githubusercontent.com/awused/mangadex-upscaler/master/mangadex-upscaler.user.js
// ==/UserScript==

// Configuration options
// You probably don't want to change these unless you know what you're doing.

const port = 8080;

// The maximum number of images preloaded per-tab.
// Multiple tabs will compete for the limited cache slots (controlled by CacheLimit) on the server.
const preloadLimit = 10;

// End configuration options

/**

TODOs

- Add error handling.
- Move to server-side preloading using the mangadex API but This Is Fine for now.

*/

const IMAGE_REGEX = /^(https:\/\/([a-zA-Z0-9]+\.)?mangadex\.org\/data\/[a-zA-Z0-9]+\/[a-zA-Z]+)([0-9]+)\.(jpg|png|jpeg)$/i;

let enabled = null;
let currentOriginalSrc = '';
let currentImage = null;

const preloadedImageMap = new Map();  // Keep a few image elements on hand

// Replacing the current image

const newImage = (src) => {
  const img = new Image();
  img.src = `http://localhost:${port}/${btoa(src)}`;
  img.href = src;
  return img;
};

const replace = (img) => {
  let newElement = preloadedImageMap.get(img.src);
  if (!newElement) {
    newElement = newImage(img.src);
  }

  // Delete the old image and attach a new one to avoid visible transitions.
  img.insertAdjacentElement('afterend', newElement);
  // Insert a clone into the map so it doesn't get mutated.
  // We display the "original" since it will display instantly if loaded.
  preloadedImageMap.set(img.src, newElement.cloneNode());
  img.parentNode.removeChild(img);

  currentImage = newElement;
  currentOriginalSrc = img.src;
};

// Pre-loading

function getNumberFromElement(cls) {
  const element = document.getElementsByClassName(cls)[0];
  if (!element) {
    return null;
  }

  if (isNaN(element.innerText)) {
    return null;
  }
  return Number(element.innerText);
};

// The mangadex API has all this information but it'd be better to do that on the server.
// TODO -- Do server side preloading instead.
const preload = (srcMatch) => {
  if (isNaN(srcMatch[3])) {
    return;
  }
  const currentFile = Number(srcMatch[3]);

  // currentFile and currentPage may not match
  const currentPage = getNumberFromElement('current-page');
  const totalPages = getNumberFromElement('total-pages');
  if (currentPage === null || totalPages === null) {
    console.log('Could not determine currentPages/totalPages.');
    return;
  }
  const pageOffset = currentFile - currentPage;


  for (let i = currentFile + 1; i <= totalPages + pageOffset && i <= currentFile + preloadLimit; i++) {
    const preloadSrc = srcMatch[1] + i + '.' + srcMatch[4];
    if (preloadedImageMap.has(preloadSrc)) {
      continue;
    }

    preloadedImageMap.set(preloadSrc, newImage(preloadSrc));
    console.log('Preloading: ' + preloadSrc);
  }

  while (preloadedImageMap.size > 2 * preloadLimit) {
    preloadedImageMap.delete(preloadedImageMap.keys().next().value);
  }
};

// Enabling/disabling

const handleMutation = () => {
  let matched = false;

  if (enabled) {
    let match;
    for (let img of document.images) {
      if (match = img.src.match(IMAGE_REGEX)) {
        matched = true;
        replace(img);
        preload(match);
      }
    }
  } else {
    if (currentImage && currentImage.src != currentOriginalSrc) {
      currentImage.src = currentOriginalSrc;
    }
  }

  if (matched || !enabled) {
    // Add a toggle button if not present
    let div = document.getElementById('mangadex-upscaler-toggle');
    if (div) {
      if (div.enabled != enabled) {
        div.enabled = enabled;
        div.innerText = 'Toggle Upscaling ' + (enabled ? '[on]' : '[off]');
      }
      return;
    }

    const targetDiv = document.getElementsByClassName('reader-controls-mode')[0];
    if (!targetDiv) {
      return;
    }

    div = document.createElement('div');
    div.setAttribute('id', 'mangadex-upscaler-toggle');
    div.setAttribute('class', 'reader-controls-mode-direction w-100 cursor-pointer pb-2 px-2');
    div.enabled = enabled;
    div.innerText = 'Toggle Upscaling ' + (enabled ? '[on]' : '[off]');
    div.onclick = toggleEnabled;
    targetDiv.appendChild(div);
  }
};

const mutationObserver = new MutationObserver(handleMutation);

const changeEnabled = (value) => {
  if (enabled === value) {
    return;
  }

  enabled = value;

  if (enabled) {
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  } else {
    handleMutation();
    mutationObserver.disconnect();
  }
};

const toggleEnabled = () => {
  changeEnabled(!enabled);
  GM.setValue('mangadex-upscaler-enabled', enabled);
  handleMutation();
};

GM.getValue('mangadex-upscaler-enabled', true).then(changeEnabled);
