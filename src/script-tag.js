/**
 * Firefox can't use Playwright's `page.addScriptTag` on the pages under test
 * (it's blocked by their CSP), so inject the script's contents via evaluate()
 * instead. Works on a Page or a Frame.
 *
 * Known divergences from Playwright's addScriptTag: resolves with undefined
 * rather than an ElementHandle for the injected <script>, and the `type` option
 * is ignored (path/content/url are supported).
 */
const fs = require('fs/promises');

async function addScriptTagFirefox(context, options) {
    let scriptContent;
    if (options.path) {
        scriptContent = await fs.readFile(options.path, 'utf8');
    } else if (options.content) {
        scriptContent = options.content;
    } else if (options.url) {
        scriptContent = await context.evaluate(async (u) => (await fetch(u)).text(), options.url);
    } else {
        throw new Error('addScriptTag requires path, content, or url option');
    }
    await context.evaluate((code) => {
        const script = document.createElement('script');
        script.textContent = code;
        document.head.appendChild(script);
    }, scriptContent);
}

let _patched = false;

/**
 * Patch `addScriptTag` on the Page and Frame prototypes (once) so the shared
 * `addScriptTag` test helper can call `context.addScriptTag(options)` unchanged
 * on Firefox and transparently get the CSP-bypass — on a page or on a frame from
 * `page.frames()`. We store the original and replace only `addScriptTag`, so
 * every other Page/Frame method is untouched. Installed only on Firefox (by the
 * harness), so the wrapper always takes the bypass path.
 *
 * @param {import('@playwright/test').Page} page - any live page (to reach the
 *   Page/Frame prototypes; Playwright doesn't export the classes).
 */
function installAddScriptTagPatch(page) {
    if (_patched) return;
    _patched = true;
    const prototypes = [Object.getPrototypeOf(page), Object.getPrototypeOf(page.mainFrame())];
    for (const proto of prototypes) {
        if (!proto || typeof proto.addScriptTag !== 'function' || proto._fxHarnessOriginalAddScriptTag) continue;
        proto._fxHarnessOriginalAddScriptTag = proto.addScriptTag;
        proto.addScriptTag = function (options) {
            return addScriptTagFirefox(this, options);
        };
    }
}

module.exports = { addScriptTagFirefox, installAddScriptTagPatch };
