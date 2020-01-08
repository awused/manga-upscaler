// ==UserScript==
// @name        MangaDex-Upscaler
// @description Upscale mangadex images using https://github.com/awused/manga-upscaler.
// @include     https://mangadex.org/*
// @include     https://mangadex.cc/*
// @version     0.4
// @grant       unsafeWindow
// @grant       GM.setValue
// @grant       GM.getValue
// @updateURL   https://raw.githubusercontent.com/awused/manga-upscaler/master/mangadex-upscaler.user.js
// @downloadURL https://raw.githubusercontent.com/awused/manga-upscaler/master/mangadex-upscaler.user.js
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

*/

const IMAGE_REGEX = /^(https:\/\/([a-zA-Z0-9]+\.)?mangadex\.(org|cc)\/data\/[a-zA-Z0-9]+\/[a-zA-Z]*)([0-9]+)\.(jpg|png|jpeg)$/i;
const API_ROOT = window.location.origin + '/api';

let enabled = null;
let currentOriginalSrc = '';
let currentImage = null;

const preloadedImageMap = new Map();  // Keep a few image elements on hand

let imageServer = localStorage.getItem('reader.imageServer');
if (!imageServer || imageServer === '0') {
  imageServer = 'null';
}

let currentMangaId = undefined;
let currentMangaPromise = Promise.resolve(undefined);

const chapterPromiseMap = new Map();  // Keep all chapter metadata on hand

// Replacing the current image

const newImage = (src, chapter, page) => {
  const img = new Image();
  let newSrc = `http://localhost:${port}/${btoa(src)}`;
  if (chapter) {
    newSrc += `?chapter=${chapter}&page=${page}`;
  }
  img.src = newSrc;
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


// Preloading

const getOrFetchChapter = (id) => {
  if (!chapterPromiseMap.has(id)) {
    chapterPromiseMap
        .set(
            id,
            fetch(`${API_ROOT}?id=${id}&server=${imageServer}&type=chapter`)
                .then((response) => response.json(), () => undefined));
  }
  return chapterPromiseMap.get(id);
};

const getNextChapterId = (manga, id) => {
  // TODO -- handle group changes when one group stops and another takes over
  // For now we're only concerned with exact matches; same language, same group
  const currentChapter = manga.chapter[id];
  if (!currentChapter) {
    return;
  }

  let nextChapterId = undefined;
  let nextChapter = undefined;

  Object.keys(manga.chapter).forEach((chapterId) => {
    const chapter = manga.chapter[chapterId];
    if (chapter.lang_code !== currentChapter.lang_code ||
        // Only bother checking one group id
        chapter.group_id !== currentChapter.group_id) {
      return;
    }

    // Chapters can be in any order, so we're looking for the smallest chapter
    // greater than the current chapter. Chapter IDs can be floats, but
    // hopefully not anything weirder.
    if (parseFloat(currentChapter.chapter) >= parseFloat(chapter.chapter)) {
      return;
    }

    if (nextChapter && parseFloat(nextChapter.chapter) < parseFloat(chapter.chapter)) {
      return;
    }

    nextChapterId = chapterId;
    nextChapter = chapter;
  });

  return nextChapterId;
};

const preload = async (manga, currentChapterId, currentPage) => {
  let page = parseInt(currentPage);  // This is 1-indexed so it's actually the next page
  let chapterId = currentChapterId;
  let chapter = await getOrFetchChapter(chapterId);

  let preloadRemaining = preloadLimit;

  while (chapter) {
    for (; chapter.page_array.length > page && preloadRemaining >= 0; page++) {
      preloadRemaining--;
      preloadSrc = chapter.server + chapter.hash + '/' + chapter.page_array[page];
      if (chapter.server === '/data/') {
        preloadSrc = 'https://mangadex.org' + preloadSrc;
      }

      if (preloadedImageMap.has(preloadSrc)) {
        continue;
      }

      preloadedImageMap.set(preloadSrc, newImage(preloadSrc, chapter.chapter, page));
      console.log('Preloading: ' + preloadSrc);
    }
    page = 0;

    if (preloadRemaining <= 0) {
      break;
    }

    chapterId = getNextChapterId(manga, chapterId);
    chapter = chapterId && await getOrFetchChapter(chapterId);
  }

  while (preloadedImageMap.size > 2 * preloadLimit) {
    preloadedImageMap.delete(preloadedImageMap.keys().next().value);
  }
};

const checkCurrentStateAndPreload = async () => {
  const content = document.getElementById('content');
  if (!content) {
    return;
  }

  const mangaId = content.getAttribute('data-manga-id');
  const chapterId = content.getAttribute('data-chapter-id');
  const currentPage = content.getAttribute('data-current-page')
  if (!mangaId || !chapterId || !currentPage) {
    return;
  }

  if (currentMangaId !== mangaId) {
    currentMangaId = mangaId;

    chapterPromiseMap.clear();
    currentMangaPromise =
        fetch(`${API_ROOT}?id=${mangaId}&type=manga`)
            .then((response) => response.json(), () => undefined);
  }
  manga = await currentMangaPromise;
  if (!manga) {
    console.log('Unable to fetch manga metadata from API. Giving up.');
    changeEnabled(false);
    return;
  }

  preload(manga, chapterId, currentPage);
};

// Enabling/disabling

const handleMutation = () => {
  let matched = false;

  if (enabled) {
    let match;
    for (let img of document.images) {
      if (img.src.match(IMAGE_REGEX)) {
        matched = true;
        replace(img);
      }
    }
  } else {
    if (currentImage && currentImage.src != currentOriginalSrc) {
      currentImage.src = currentOriginalSrc;
    }
  }

  if (matched) {
    // Returns a promise that we do not need to wait on
    checkCurrentStateAndPreload();
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
