Manga-Upscaler
==============

# Installation

Add [mangadex-upscaler.user.js](https://raw.githubusercontent.com/awused/manga-upscaler/master/mangadex-upscaler.user.js) to your browser as a user script.
Toggle upscaling with the u key or by clicking the toggle added to the display controls.

## Prefetching

There's a second option to just enable prefetching of normal resolution images. When using this you should decrease the preload setting in Mangadex to just one image, since it will be redundant. Prefetching from this script will cross chapter boundaries when the sub groups remain the same.

Prefetching without upscaling does not require the server to be running or installed.

## Running the Server

The server is only necessary for upscaling.

`go get -u github.com/awused/manga-upscaler`

Copy `manga-upscaler.toml.sample` to `~/.config/manga-upscaler/manga-upscaler.toml` or `~/.manga-upscaler.toml` and fill it out according to the instructions.

Run the manga-upscaler server on the same machine as your browser. Manga-Upscaler does not support running it on a separate machine.


# Requirements

* Waifu2x
    * [waifu2x-ncnn-vulkan](https://github.com/nihui/waifu2x-ncnn-vulkan). Use the cunet model.
* A browser extension capatable of running user scripts.
    * I've developed against Greasemonkey on Firefox. The script may need tweaking for other extensions or browsers.

# TODOs

* Add a maximum resolution feature to avoid wasting time and memory unnecessarily
* POST image data from the browser to the server to avoid double-fetching images and avoid cloudflare.
* Handle cloudflare using cloudscraper
* Start prefetching immediately, not just once the first image has finished loading.
