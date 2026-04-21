# Fourier Epicycles

Small browser app that draws shapes with Fourier epicycles.

You can:

- Upload an image or SVG and let the app extract a contour
- Draw a shape by hand on the canvas
- Load built-in samples (Star, One Piece flag)
- Change harmonics and speed in real time
- Pause and reset the trace
- Switch between dark and light theme

## What this project is

This is a no-build, vanilla JavaScript project. Open it in a browser through a local server and it works.

The app computes Fourier coefficients from sampled points and animates two epicycle chains (X and Y) to recreate the path.

## Run locally

From the project root, start any static file server.

Option 1 (Python):

- python -m http.server 5173

Option 2 (Node):

- npx serve -l 5173

Then open:

- http://localhost:5173

## How to use

### 1) Pick input mode

- Image: upload a file (raster image or SVG)
- Draw: draw directly on the canvas, then press Accept

### 2) If using Image mode

- Use the file picker for your own file
- Or choose a built-in sample from the dropdown and click Load sample

### 3) Adjust animation

- Harmonics: more terms gives more detail
- Speed: controls how fast the phase advances
- Pause: pause/resume the animation
- Reset: clears only the trace and starts the cycle again

## Notes and limits

- Supported uploads: SVG and common image formats (PNG, JPG, etc.)
- SVG max size: 2 MB
- Raster image max size: 10 MB
- Very small or very noisy inputs may fail contour extraction

## Handy debug shortcut

- Alt + D toggles bridge debug mode
- In debug mode, red segments show pen-up travel between disconnected contours

## Project structure

- index.html: app layout and controls
- css/app.css: styles
- js/main.js: app bootstrap
- js/fourier-app.js: UI state, canvas rendering, interaction logic
- js/fourier-utils.js: Fourier math, SVG parsing, resampling
- js/image-processing.js: raster edge detection and contour extraction
- js/config.js: constants and defaults

## Why a local server is recommended

SVG loading for built-in samples uses fetch, which is more reliable over http://localhost than opening the file directly with file://.

## License
