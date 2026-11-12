**My input**
Oops, the new links.js file fixed the problem with the Configure modal in iOS 27 but has introduced a new problem. Now, selecting either Dashboard or
Audio info from the ’m' menu results in no reponse on any browser in any O/S. 

-------------

Found it — and it's a direct consequence of the previous change, not a regression in the modal fix.

## What broke

`Dashboard` and `Audio info` are `javascript:` anchors:

```html
<a href="javascript:$('#dashboard-modal .modal-body').load('dashboard.php',…); void 0">Dashboard</a>
<a href="javascript:audioInfoPlayback()">Audio info</a>
```

For that kind of link, **the default action of the click *is* running the script.** The previous patch put `javascript:` in the same branch as fragments:

```js
if (href == '' || href.charAt(0) == '#' || href.indexOf('javascript:') === 0) {
    event.preventDefault();   // ← cancels the anchor's default action
    return;
}
```

`event.preventDefault()` on `<a href="javascript:…">` cancels the only thing that would have executed the URL, so the click becomes a no-op. The old code looked like it worked only by accident: it also called `preventDefault()`, but then immediately did `location.href = href`, which re-ran the `javascript:` URL. That re-entry through `location` is what produced the hostless `!! ERROR Script error. @ :0:0` lines in your diagnostics.

Affected by this were every `javascript:` anchor in the UI: Dashboard, Audio info, System info (config pages), Refresh in both menus, and the three reconnect buttons in `footer.php`.

## The fix (applied to `www/js/links.js`)

The two cases are now separate — fragments get `preventDefault()`, `javascript:` is left completely alone:

```js
// Fragment links (#...) are owned by the component that rendered them.
// Keep the hash out of the URL and let the owner do its job.
if (href == '' || href.charAt(0) == '#') {
    event.preventDefault();
    return;
}

// javascript: links are run by the browser as the anchor's default action.
// Do NOT preventDefault() here: that cancels the default action and the link
// does nothing. Do NOT assign location.href to it either: re-entering a
// javascript: URL through location loses the trusted activation and reports
// errors as hostless "Script error.". Leave the click completely alone.
if (href.indexOf('javascript:') === 0) {
    return;
}
```

`node --check` passes. Diff is 28 insertions / 8 deletions against the original file.

## Deploy and verify

```sh
cd /home/thanos/repos/moode.deepseek
npm ci                        # only if node_modules is missing
node_modules/.bin/gulp deploy # or: gulp build && gulp deploy --test
```

The `?t=` cache-buster changes on rebuild, so no manual cache clearing is needed on the iPad/iPhone.

Checklist after deploy:

- **m → Dashboard** → modal opens with the dashboard content
- **m → Audio info** → audio info modal opens
- **m → Configure** → still stays open (the iOS 27 fix must not regress)
- **m → Power** → still stays open
- **m → Refresh** → page reloads exactly once
- **Library / Update library / Play history / Quick help** (`#notarget` + `data-cmd`) → still respond, and the URL does not gain `#notarget`
- Config page → **m → System info** → opens
- A real navigation, e.g. Configure → **Library** → loads `lib-config.php`

One small robustness note for later: the check is case-sensitive (`javascript:`), while URL schemes are case-insensitive. Every href in the tree is lowercase, so it's fine today; if you want it bulletproof, normalise with `href.toLowerCase().indexOf('javascript:') === 0`. The cleaner long-term fix is to convert those `javascript:` hrefs to `data-cmd` handlers like the rest of the menu, which removes inline JS and makes the link behaviour uniform — but that's a separate refactor, not needed to restore the menu.
