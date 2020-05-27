// ==UserScript==
// @name        MangaDex-Upscaler
// @description Upscale mangadex images using https://github.com/awused/manga-upscaler.
// @include     https://mangadex.org/*
// @include     https://mangadex.cc/*
// @version     0.9.1
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
const preloadLimit = 20;

// End configuration options

/**

TODOs

- Specify target size.

*/

const IMAGE_REGEX = /^(https:\/\/([a-zA-Z0-9]+\.)?mangadex\.(org|cc)\/data\/[a-zA-Z0-9]+\/[a-zA-Z]*)([0-9]+)\.(jpg|png|jpeg)$/i;
const LOCALHOST_REGEX = new RegExp(`^http:\/\/localhost:${port}\/([^?]+)`);
const API_ROOT = window.location.origin + '/api';

let upscaleEnabled = null;
let prefetchEnabled = null;

const preloadedUpscaledImages = new Map();
const preloadedNormalImages = new Map();

let imageServer = localStorage.getItem('reader.imageServer');
if (!imageServer || imageServer === '0') {
  imageServer = 'null';
}

let currentMangaId = undefined;
let currentMangaPromise = Promise.resolve(undefined);

const chapterPromiseMap = new Map();  // Keep all chapter metadata on hand

// Replacing the current image

const newUpscaledImage = (src, chapter, page) => {
  const img = new Image();
  let newSrc = `http://localhost:${port}/${encodeURIComponent(btoa(src))}`;
  if (chapter) {
    newSrc += `?chapter=${chapter}&page=${page}`;
  }
  img.src = newSrc;
  img.href = src;
  img.onerror = (e) => {
    // Retry once automatically, but any further retries will be manual.
    console.log(`Retrying ${chapter}, ${page}`);
    img.onerror = null;
    img.src = img.src;
  };
  return img;
};

const replace = (img) => {
  let newElement = preloadedUpscaledImages.get(img.src);
  if (!newElement) {
    newElement = newUpscaledImage(img.src);
  }

  // Delete the old image and attach a new one to avoid visible transitions.
  img.insertAdjacentElement('afterend', newElement);
  // Insert a clone into the map so it doesn't get mutated.
  // We display the "original" since it will display instantly if loaded.
  preloadedUpscaledImages.set(img.src, newElement.cloneNode());
  img.parentNode.removeChild(img);
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
        preloadSrc = window.location.origin + preloadSrc;
      }

      if (upscaleEnabled && !preloadedUpscaledImages.has(preloadSrc)) {
        preloadedUpscaledImages.set(
            preloadSrc,
            newUpscaledImage(preloadSrc, chapter.chapter, page));
        console.log('Upscaling: ' + preloadSrc);
      }

      if (prefetchEnabled && !preloadedNormalImages.has(preloadSrc)) {
        const img = new Image();
        img.src = preloadSrc;
        preloadedNormalImages.set(preloadSrc, img);
        console.log('Prefetching: ' + preloadSrc);
      }
    }
    page = 0;

    if (preloadRemaining <= 0) {
      break;
    }

    chapterId = getNextChapterId(manga, chapterId);
    chapter = chapterId && await getOrFetchChapter(chapterId);
  }

  while (preloadedUpscaledImages.size > 2 * preloadLimit) {
    preloadedUpscaledImages.delete(preloadedUpscaledImages.keys().next().value);
  }
  while (preloadedNormalImages.size > 2 * preloadLimit) {
    preloadedNormalImages.delete(preloadedNormalImages.keys().next().value);
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
    changeEnabled(false, false);
    return;
  }

  preload(manga, chapterId, currentPage);
};

// Enabling/disabling

const handleMutation = () => {
  let matched = false;

  for (let img of document.images) {
    if (!upscaleEnabled) {
      let match = img.src.match(LOCALHOST_REGEX);
      if (match) {
        img.src = atob(decodeURIComponent(match[1]));
      }
    }

    if ((upscaleEnabled || prefetchEnabled) && img.src.match(IMAGE_REGEX)) {
      matched = true;
      if (upscaleEnabled) {
        replace(img);
      }
    }
  }

  if (upscaleEnabled || prefetchEnabled) {
    // Returns a promise that we do not need to wait on
    checkCurrentStateAndPreload();
  }

  if (matched || (!upscaleEnabled && !prefetchEnabled)) {
    // Add a toggle button if not present
    let upscaleDiv = document.getElementById('mangadex-upscaler-toggle');
    let prefetchDiv = document.getElementById('mangadex-prefetch-toggle');
    if (upscaleDiv) {
      if (upscaleDiv.enabled != upscaleEnabled) {
        upscaleDiv.enabled = upscaleEnabled;
        upscaleDiv.innerText = 'Toggle Upscaling ' + (upscaleEnabled ? '[on]' : '[off]');
      }
      if (prefetchDiv.enabled != prefetchEnabled) {
        prefetchDiv.enabled = prefetchEnabled;
        prefetchDiv.innerText = 'Toggle Prefetching ' + (prefetchEnabled ? '[on]' : '[off]');
      }
      return;
    }

    const targetDiv = document.getElementsByClassName('reader-controls-mode')[0];
    if (!targetDiv) {
      return;
    }

    upscaleDiv = document.createElement('div');
    upscaleDiv.setAttribute('id', 'mangadex-upscaler-toggle');
    upscaleDiv.setAttribute('class', 'reader-controls-mode-direction w-100 cursor-pointer pb-2 px-2');
    upscaleDiv.enabled = upscaleEnabled;
    upscaleDiv.innerText = 'Toggle Upscaling ' + (upscaleEnabled ? '[on]' : '[off]');
    upscaleDiv.onclick = toggleUpscaleEnabled;
    targetDiv.appendChild(upscaleDiv);

    prefetchDiv = document.createElement('div');
    prefetchDiv.setAttribute('id', 'mangadex-prefetch-toggle');
    prefetchDiv.setAttribute('class', 'reader-controls-mode-direction w-100 cursor-pointer pb-2 px-2');
    prefetchDiv.title = 'You should turn MangaDex\'s normal preloading down to one page.'
    prefetchDiv.enabled = prefetchEnabled;
    prefetchDiv.innerText = 'Toggle Prefetching ' + (prefetchEnabled ? '[on]' : '[off]');
    prefetchDiv.onclick = togglePrefetchEnabled;
    targetDiv.appendChild(prefetchDiv);
  }
};

const mutationObserver = new MutationObserver(handleMutation);

const changeEnabled = (upscale, prefetch) => {
  if (upscaleEnabled === upscale && prefetchEnabled === prefetch) {
    return;
  }

  upscaleEnabled = upscale;
  prefetchEnabled = prefetch;

  if (upscaleEnabled || prefetchEnabled) {
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  } else {
    handleMutation();
    mutationObserver.disconnect();
  }
};

// Could do better, but this is adequate for two settings.
const toggleUpscaleEnabled = () => {
  changeEnabled(!upscaleEnabled, prefetchEnabled);
  GM.setValue('mangadex-upscaler-enabled', upscaleEnabled);
  handleMutation();
};

const togglePrefetchEnabled = () => {
  changeEnabled(upscaleEnabled, !prefetchEnabled);
  GM.setValue('mangadex-prefetch-enabled', prefetchEnabled);
  handleMutation();
};

const keyUp = (e) => {
  if (e.key === 'u') {
    toggleUpscaleEnabled();
  }
};

document.addEventListener('keyup', keyUp, false);
Promise.all([
         GM.getValue('mangadex-upscaler-enabled', true),
         GM.getValue('mangadex-prefetch-enabled', true)
       ])
    .then(values => changeEnabled(...values));
