// Background page for the background.page harness fixture. There is nothing to set up
// here — launch-extension-background.test.mjs only needs a background context to
// evaluate in, exercising the manifest background.page target-matching path.
globalThis.__ready = true;
