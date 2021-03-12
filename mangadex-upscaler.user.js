// ==UserScript==
// @name        MangaDex-Upscaler
// @description Upscale mangadex images using https://github.com/awused/manga-upscaler.
// @include     https://mangadex.org/*
// @include     https://mangadex.cc/*
// @version     1.1.0
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
- Key cached images by the chapter hash + page instead of the full URL

*/
const BLOB_REGEX = /^blob:https:\/\/mangadex\.(org|cc)\/[a-zA-Z0-9-]+$/
const IMAGE_REGEX = /^(https:\/\/([a-zA-Z0-9]+\.)*mangadex\.((org|cc)|network(:\d+)?\/[a-zA-Z0-9-_]+)\/data\/)([a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+\.(jpg|png|jpeg))$/i;
const LOCALHOST_REGEX = new RegExp(`^http:\/\/localhost:${port}\/([^?]+)`);
const API_ROOT = window.location.origin + '/api';

let upscaleEnabled = null;

const preloadedUpscaledImages = new Map();
const preloadedNormalImages = new Map();

let imageServer = localStorage.getItem('reader.imageServer');
if (!imageServer || imageServer === '0') {
  imageServer = 'null';
}

let currentMangaId = undefined;
let currentMangaPromise = Promise.resolve(undefined);

const chapterPromiseMap = new Map();  // Keep all chapter metadata on hand

const srcToKey = (src) => {
  return src.match(IMAGE_REGEX)[6];
};

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
    console.log(`Retrying ${chapter}-${page}`);
    img.onerror = () => {
      const key = srcToKey(src);
      if (preloadedUpscaledImages.has(key)) {
        preloadedUpscaledImages.delete(key);
      }
    };
    img.src = img.src;
  };
  return img;
};

const replace = async (img) => {
  const content = document.getElementById('content');
  if (!content) {
    return;
  }

  const mangaId = content.getAttribute('data-manga-id');
  const chapterId = content.getAttribute('data-chapter-id');
  const currentPage = content.getAttribute('data-current-page');
  if (!mangaId || !chapterId || !currentPage) {
    return;
  }

  const chapter = await getOrFetchChapter(chapterId);

  const key = chapter.hash + '/' + chapter.page_array[currentPage - 1];
  const imgSrc = chapter.server + key;

  let newElement = preloadedUpscaledImages.get(key);
  if (!newElement) {
    newElement = newUpscaledImage(imgSrc);
  }

  // Delete the old image and attach a new one to avoid visible transitions.
  img.insertAdjacentElement('afterend', newElement);
  // Insert a clone into the map so it doesn't get mutated.
  // We display the "original" since it will display instantly if loaded.
  preloadedUpscaledImages.set(key, newElement.cloneNode());
  img.parentElement.removeChild(img);
};


// Preloading

const getOrFetchChapter = (id) => {
  if (!chapterPromiseMap.has(id)) {
    chapterPromiseMap
        .set(
            id,
            fetch(`${API_ROOT}?id=${id}&server=${imageServer}&saver=0&type=chapter`)
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
      preloadKey = chapter.hash + '/' + chapter.page_array[page];
      preloadSrc = chapter.server + preloadKey;
      if (chapter.server === '/data/') {
        preloadSrc = window.location.origin + preloadSrc;
      }

      let actions = [];

      if (upscaleEnabled && !preloadedUpscaledImages.has(preloadKey)) {
        preloadedUpscaledImages.set(
            preloadKey,
            newUpscaledImage(preloadSrc, chapter.chapter, page));
        actions.push('upscaling');
      }

      if (actions.length) {
        console.log(chapter.chapter + '-' + page + ' [' + actions.join(', ') + ']: ' + preloadKey + ' (' + chapter.server + ')');
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
  const manga = await currentMangaPromise;
  if (!manga) {
    console.log('Unable to fetch manga metadata from API. Giving up.');
    changeEnabled(false, false);
    return;
  }

  preload(manga, chapterId, currentPage);
};

// Enabling/disabling

const handleMutation = async () => {
  // Add a toggle button if not present
  let upscaleDiv = document.getElementById('mangadex-upscaler-toggle');
  if (upscaleDiv) {
    if (upscaleDiv.enabled != upscaleEnabled) {
      upscaleDiv.enabled = upscaleEnabled;
      upscaleDiv.innerText = 'Toggle Upscaling ' + (upscaleEnabled ? '[on]' : '[off]');
    }
  } else {
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
  }

  // Currently broken except in single page mode. Thanks mangadex.
  if (!document.getElementsByClassName('show-single-page')[0].offsetParent) {
    return;
  }

  for (let img of document.images) {
    if ((img.src.match(BLOB_REGEX) || img.src.match(IMAGE_REGEX)) && upscaleEnabled) {
      await replace(img);
    } else if (!upscaleEnabled) {
      const match = img.src.match(LOCALHOST_REGEX);
      if (match) {
        img.src = atob(decodeURIComponent(match[1]));
      }
    }
  }

  if (upscaleEnabled) {
    // Returns a promise that we do not need to wait on
    checkCurrentStateAndPreload();
  }
};

let mutationTimeout = undefined;
let lastChapterId = undefined;
let running = false;

// Avoid prefetching from the end of the next chapter when transitioning between chapters.
const debounceChapterChangeMutations = async () => {
  if (running) {
    if (!mutationTimeout) {
      mutationTimeout = setTimeout(() => {
        handleMutation();
        mutationTimeout = undefined;
      }, 0);
    }
    return;
  }

  if (!mutationTimeout) {
    const content = document.getElementById('content');
    if (!content) {
      return;
    }
    const chapterId = content.getAttribute('data-chapter-id');

    if (chapterId === lastChapterId) {
      running = true;
      try {
        await handleMutation();
      } catch (e) {
        console.log(e);
      }
      running = false;
    } else {
      lastChapterId = chapterId;
      mutationTimeout = setTimeout(() => {
        handleMutation();
        mutationTimeout = undefined;
      }, 0);
    }
  }
};

const mutationObserver = new MutationObserver(debounceChapterChangeMutations);

const changeEnabled = (upscale) => {
  if (upscaleEnabled === upscale) {
    return;
  }

  upscaleEnabled = upscale;

  if (upscaleEnabled) {
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
  changeEnabled(!upscaleEnabled);
  GM.setValue('mangadex-upscaler-enabled', upscaleEnabled);
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
       ])
    .then(values => changeEnabled(...values));
