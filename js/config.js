export const MAX_SVG_SIZE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
export const STORAGE_THEME_KEY = "fourier-theme";
export const HARMONICS_UI_MIN = 1;
export const HARMONICS_UI_MAX = 1000;
export const HARMONICS_UI_STEP = 1;
export const HARMONICS_UI_DEFAULT = 20;
export const SPEED_UI_MIN = 1;
export const SPEED_UI_MAX = 10;
export const SPEED_UI_STEP = 1;
export const SPEED_UI_DEFAULT = 3;
export const SPEED_INTERNAL_MIN = 0.02;
export const SPEED_INTERNAL_MAX = 0.5;
export const EDGE_BASE_GAP = 12;
export const EDGE_EXTRA_GAP = 26;
export const MIN_TOP_MARGIN = 56;
export const MIN_LEFT_MARGIN = 56;
export const MAX_TOP_MARGIN_RATIO = 0.42;
export const MAX_LEFT_MARGIN_RATIO = 0.34;
export const FRAME_PADDING = 18;
export const DRAW_SCALE_FACTOR = 0.4;

export const STAR_SVG = `
  <svg viewBox="0 0 1000 1000">
    <path d="M500 50 L610 380 L960 380 L680 580 L790 910 L500 710 L210 910 L320 580 L40 380 L390 380 Z" 
    fill="currentColor" 
    stroke="none"/>
  </svg>
`;
