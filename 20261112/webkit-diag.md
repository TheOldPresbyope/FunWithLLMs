Short version: the old `links.js` was a **second navigator on every anchor click**. It let Bootstrap (or the browser, or a `data-cmd` handler) do its job, then immediately ran `location.href = <same href>` on top of it. For the two anchors in the main menu that open modals, that stacked a *second navigation* onto a tap that had already been handled. On desktop engines the second navigation resolves benignly as a same-document hash change; on iOS 27 WebKit it resolves as a document load, which is why the freshly-opened Configure/Power modal (and the menu) disappeared. The diff deletes that second navigation for exactly the href types that don't need it.

## 1. What a tap actually did before the fix

`links.js` is a jQuery delegated handler: `$(document).on('click', 'a', …)`. Bootstrap's data-api handlers are *also* delegated on `document`. A tap on

```html
<a href="#configure-modal" data-toggle="modal"><i class="fa-solid … fa-gear-complex"></i>Configure</a>
```

produces one `click` that bubbles to `document`, and jQuery 1.8.2 runs **both** matching handlers at the `<a>` level, in registration order (`bootstrap.js` loads before `links.js` in the lib bundle, so Bootstrap is first):

1. **Bootstrap modal data-api** (`bootstrap.js:112`) — reads `href="#configure-modal"`, calls `b.preventDefault()`, then `$('#configure-modal').modal('show')`.
2. **`links.js`** — sees `!hasClass('external')`, calls `event.preventDefault()` again, then `location.href = '#configure-modal'`.

`preventDefault()` is not `stopPropagation()`: it cancels the *default action*, not the dispatch to other handlers. And Bootstrap 2 doesn't call `stopImmediatePropagation()` either — nor could it without breaking sibling handlers. So `links.js` always ran second, on every anchor, after the owner had already acted.

## 2. Why that was wrong, by href class

| href | Owner who already handled it | What the extra `location.href` did |
|---|---|---|
| `#configure-modal`, `#power-modal`, `#notarget` | Bootstrap modal/dropdown data-api, the `data-cmd` handlers, `data-toggle="context"` | Pushed a **second navigation** for the same tap: a history entry, a `hashchange`, and a scroll to the target. `#notarget` doesn't even exist — pure URL noise. |
| `javascript:…` (Dashboard, Audio info, System info, Refresh) | the browser's own link activation | Re-entered the URL *through `location`*, turning a trusted link activation into a scripted navigation to a `javascript:` URL. That path has different rules in WebKit (user-gesture checks, hostless error reporting) — and it's exactly what produced the `!! ERROR Script error. @ :0:0` lines in your diag: errors thrown from a `javascript:` URL have no source document to attribute them to. |
| `href=""` / no href | nobody | Old code fell back to `$(event.target).parent().attr('href')`, which can be `undefined` → `location.href = undefined` → a **real navigation to `/undefined`**. A genuine full page load, UI gone. |
| real URLs (`lib-config.php`, …) | nobody, this is what links.js is for | fine |

The patch's four moved lines map one-to-one onto that table:

```js
var href = $(this).attr('href') || '';                 // always the anchor, never event.target
…
if (href == '' || href.charAt(0) == '#' ||             // empty  → don't navigate
    href.indexOf('javascript:') === 0) {               // #frag  → owner already acted
    event.preventDefault();                            // javascript: → browser runs it itself
    return;                                            // wait, not a navigation
}
event.preventDefault();
location.href = href;                                  // real links: unchanged behaviour
```

Using `$(this)` instead of `$(event.target)` is also a real fix, not cosmetics: when the tap lands on the `<i>` icon or a nested `<span>`, `$(event.target).attr('href')` is `undefined` and the old `parent()` fallback only works if the href happens to be exactly one level up. Any deeper wrapper produced `location.href = undefined`.

## 3. Why it appeared only on iOS 27, and why it now works everywhere

Two things were racing on the same tap: Bootstrap *opening* a fixed-position modal (`.modal {position:fixed; top:0; …}` — `moode.css:25`), and `links.js` *navigating* the document to the fragment that anchors at that same element — an element that lives at the very end of the document, in `footer.php`. In Chromium/Gecko the second one is a cheap same-document hash change and the modal survives (that's why Linux/Android looked OK). In WebKit 27 that extra navigation was resolved as a document load — your diagnostic caught it as `---- this is load #2 ----` with `navType=navigate`, i.e. the document was replaced, not just hashed. A plausible amplifier is the scroll-to-fragment churn collapsing/expanding iOS's toolbar and firing a spurious `orientationchange`, which `header.php:137` answers with `location.reload(true)` — but even without that, the load counter already proves the extra navigation was the thing tearing the page down.

Once the second navigation is gone, the behaviour no longer depends on:

- handler registration order between Bootstrap and `links.js`,
- how a given engine classifies a programmatic fragment assignment,
- whether a `javascript:` URL is re-entered through `location`,
- whether the tap target was the anchor or a nested icon.

That's why the same build behaves on iPad, iPhone, Android and Linux: each click now has exactly **one** owner.

## 4. Corroborating evidence in the repo

This bug had already been worked around link-by-link before you hit it. Commit `a9bddd22` ("[links.js] Convert to universal target-blank-link class") is precisely that: a CSS class used as an opt-out list, because anchors whose clicks `links.js` navigated were misbehaving. Look at `header.php:212` — the menu button itself carries `target-blank-link`:

```html
<a … class="dropdown-toggle btn target-blank-link" id="menu-settings" … href="#notarget">
```

So the "m" button that opens the menu was **excluded** (the first thing in `links.js` returns early for `target-blank-link`), while every item *inside* the menu was not. That matches your report exactly: the menu opens fine, then Configure/Power break. The patch generalises that class-based workaround to the whole category of anchors that must never be JS-navigated.

## 5. What the patch deliberately keeps

- `target-blank-link` exclusion and the `active`/`tabindex=0` dropdown exclusion — untouched, first thing in the handler.
- `external` class branch — untouched.
- Real navigations still go through `event.preventDefault(); location.href = href` exactly as before, so moOde's single-navigation path is preserved.

Side benefit: the URL no longer accumulates `#configure-modal` / `#notarget` fragments, so Back no longer walks a trail of dead hash entries on any platform.

## Caveat on the "why" — what is proven vs. inferred

Proven from the code: the double handling, the handler ordering, the `preventDefault` vs `stopPropagation` detail, and the three href classes that don't need navigation. Proven from your run: the UI was healthy at `t+3s`, and the document loaded a second time. Inferred: the exact WebKit-internal reason that redundant fragment assignment became a document load in iOS 27 (I can't prove that from the source). But the fix removes the *only* secondary navigation in that code path, and the symptom went away across all four platforms — which is the practical proof that the second navigation was the cause.
