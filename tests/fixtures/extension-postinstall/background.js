// Opens a tab on startup, mimicking extensions that show a post-install page.
// post-install.spec.mjs uses this to cover the page fixture's postInstallPages wait.
browser.tabs.create({ url: browser.runtime.getURL('post-install.html') });
