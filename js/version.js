// The app shell version shown in the About panel — bump TOGETHER with
// sw.js VERSION (a worker script can't share an ES-module import, so the
// two live side by side). Surfacing it in the UI exists for one reason:
// "is my phone on the new build or a cached one?" must never be a guess.
export const SHELL_VERSION = 'v102';
