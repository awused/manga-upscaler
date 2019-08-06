Manga-Upscaler
==============

# Running Locally

`go get -u github.com/awused/manga-upscaler`

Copy `manga-upscaler.toml.sample` to `~/.config/manga-upscaler/manga-upscaler.toml` or `~/.manga-upscaler.toml` and fill it out according to the instructions.

Add [mangadex-upscaler.user.js](https://raw.githubusercontent.com/awused/manga-upscaler/master/mangadex-upscaler.user.js) to your browser as a user script..

Run the manga-upscaler server on the same machine as your browser. Manga-Upscaler does not support running it on a separate machine.


# Requirements

* Waifu2x
    * [waifu2x-ncnn-vulkan](https://github.com/nihui/waifu2x-ncnn-vulkan). Use the cunet model.
* A browser extension capatable of running user scripts.
    * I've developed against Greasemonkey on Firefox. The script may need tweaking for other extensions or browsers.

<!--
TODO - Implement cloudflare workaround

# Cloudflare

I include some limited workarounds for cloudflare protectected feeds. I update this as necessary, it is currently using:

* python3
* [cloudscraper](https://github.com/venomous/cloudscraper)

-->

# TODOs

* Handle cloudflare using cloudscraper
* Better preloading of mangadex images using their API
* Add a maximum resolution feature to avoid wasting time and memory unnecessarily
