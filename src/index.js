export { Flicker } from './flicker.js';
export { NocapSecret, STRENGTHS } from './secret.js';
export { suggestConfig, placeInBand, luma, toRgb, toHex, codeSwing, checkPalette, toLight, toCode } from './palette.js';
export { detectFormat, fakeLike, passesLuhn } from './fake.js';
export { auditPage } from './audit.js';
export {
  splitFrames,
  averageFrames,
  expandRange,
  planeRange,
  leakScore,
  boxBlur,
  denoisedLeak,
  maxAmplitudeFor,
} from './splitter.js';
