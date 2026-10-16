# Nurupuru Anywhere

English | [日本語](README_JA.md)

Make web images wobble like jelly. Paint an area, grab it, and watch it bounce back.
A Chrome / Edge extension powered by the physics engine from [Nurupuru](https://github.com/akeit0/nurupuru).

Work with one image at a time. The effect stays over the original image and follows page scrolling.
The interface uses Japanese when your browser's display language is Japanese, and English otherwise.

## Installation

1. Download **`nurupuru-anywhere-0.1.1.zip`** from [Releases](https://github.com/akeit0/nurupuru-anywhere/releases/latest). `Source code (zip)` is for development.
2. Extract the ZIP to a folder you can keep.
3. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
4. Turn on **Developer mode**.
5. Click **Load unpacked** and select the extracted folder containing **`manifest.json`**.

No Node.js installation or build step is needed. Keep the extracted folder after installation.
Updates are manual: replace the contents of that folder with the new ZIP's contents, reload the extension on the extensions page, and reload the web page too.

## Usage

1. Open a regular web page and click the extension's toolbar button.
2. Click the image you want to animate.
3. Use **Paint** to mark the areas that should move. **Mobility** ranges from 0 (fixed) to 255 (most movable).
4. Use **Grab** to pull a painted area, then release it.

Under **Material**, choose a preset or adjust softness, return speed, and damping.
Brush and material settings carry over when you select another image. Settings are not saved per image.

| Control | Action |
| --- | --- |
| B / E / G | Paint / Erase / Grab |
| I | Select or change the image. Press again to cancel |
| Right-drag while painting | Temporarily erase |
| Esc | Cancel image selection |
| ON / OFF | Toggle the effect. OFF restores the original image and page interaction while keeping the mask |
| Fold / Expand | Collapse or expand the detailed controls |
| Release image | Restore the current image and remove its mask. Keep the panel and shared settings |
| Close | Restore the image and close the extension controls |

The current status, ON/OFF, and Release image remain available while the panel is folded.
Click the extension's toolbar button again to expand the panel.
The image selection state appears inside the Select image button.
While changing images, click Selecting image / Cancel again or press Esc to return to the previous mask and effect.

States are shown with text and color: purple for image selection, green for Paint, orange for Erase, blue for Grab, and gray for OFF.

## Supported images and data handling

- Supports regular `img` elements on the page. CSS backgrounds, videos, images inside iframes, and complex transforms such as rotation are not supported.
- When reading an image directly, CSS backgrounds, borders, and shadows on the `img` itself are not included in the effect. Decorations on its parent remain visible.
- If image pixels cannot be read directly, for example because the image is on another domain, the extension captures the visible area using the browser's screen capture API. This includes the background and any overlapping elements, and does not preserve transparency.
- If the image size or visible area changes after capture, the original image is restored. Select it again to continue. Animated images are treated as a still image at selection time.
- Browser settings pages, extension stores, and other pages that block extensions are not supported.

Processing takes place in your browser. Images and screen capture data are not sent to or stored on external servers.
The extension makes no additional requests to the original image URL.
It only requests `activeTab` and `scripting` permissions to run in the tab where you activate it.

See the [Privacy Policy](PRIVACY.md) for details.

## Usage notice

- Check the copyright, portrait rights, and other rights associated with the images, as well as the site's terms. You are responsible for your use of the extension. Do not use it illegally or infringe third-party rights.
- The extension is provided "as is," without guarantees regarding functionality or results.
- To the extent permitted by applicable law, the developer is not liable for damages arising from use of the extension.

## Development

With Node.js 22 or later, run:

```sh
npm ci
npm run build
```

To run the extension, load the **`dist` folder** from your browser's extensions page.
After rebuilding, reload both the extension and the web page.

You can also try the actual interface in the [development HTML preview](dev/index.html) without installing the extension.
Run `npm run build` first, then open the HTML file directly or start the development server:

```sh
npm run dev
```

Open `http://127.0.0.1:4174/dev/`. Source changes rebuild automatically; reload the page to see them.
The buttons at the top let you preview idle, image selection, Paint, Erase, Grab, OFF, and folded states.
The preview uses the same code as the extension, including mask painting and physics. Development HTML is not included in `dist`.

Run the tests:

```sh
npx playwright install chromium
npm test
```

Tests load the actual extension in Chromium and check image selection, screen capture, painting, grabbing,
scroll tracking, folding, ON/OFF, release, cancellation during capture, viewport changes, and restoration of the original image.
Screenshots are written to `test-results`.

`src/core` contains the physics and rendering code from Nurupuru 1.0.1.
It uses scalar Wasm with a JavaScript fallback. A C compiler is not needed for a normal build.

Licensed under the [Unlicense](LICENSE). See [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)
for third-party code included in the Wasm module.
