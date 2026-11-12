/*!
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright 2014 The moOde audio player project / Tim Curtis
 * Copyright 2013 The tsunamp player ui / Andrea Coiutti & Simone De Gregori
*/

$(document).on('click', 'a', function(event) {
		//debugLog('links.js: this.id: ' + this.id);
		//debugLog('links.js: this.className(s): ' + this.className);
		//debugLog('links.js: includes target-blank-link: ' + this.className.includes('target-blank-link'));
		//debugLog('links.js: this.attributes: ' + this.attributes);
		//debugLog('links.js: $(this).attr(tabindex): ' + $(this).attr('tabindex'));
		//return;

		var href = $(this).attr('href') || '';

	    // Don't modify link if matches condition below
		if (
			// Specific links
			this.className.includes('target-blank-link') ||
			// Input dropdowns on config pages
			(this.className == 'active' && $(this).attr('tabindex') == 0)
		) {
			//debugLog('links.js: link not modified, match found in exclusion list');
			return;
		}

	    if (!$(this).hasClass('external')) {
			// Fragment links (#...) are owned by the component that rendered
			// them (Bootstrap modal/dropdown/tab, the data-cmd handlers).
			// Assigning location.href here stacks a same-document navigation on
			// top of that component's own action; iOS 27 / WebKit resolves it
			// as a full page reload, which closed the Configure modal and the
			// Library menu immediately after they opened (issue #844).
			// Just keep the hash out of the URL and let the owner do its job.
			if (href == '' || href.charAt(0) == '#') {
				//debugLog('links.js: link not modified, owned by component: ' + href);
				event.preventDefault();
				return;
			}

			// javascript: links (Dashboard, Audio info, System info, Refresh,
			// reconnect) are run by the browser as the anchor's default action.
			// Do NOT preventDefault() here: that cancels the default action and
			// the link does nothing. Do NOT assign location.href to it either:
			// re-entering a javascript: URL through location loses the trusted
			// activation and reports errors as hostless "Script error.".
			// Leave the click completely alone.
			if (href.indexOf('javascript:') === 0) {
				//debugLog('links.js: javascript: link, left to browser: ' + href);
				return;
			}

			//debugLog('links.js: link will be modified, does not have class external');
	        event.preventDefault();
			location.href = href;
	    }
        else {
			//debugLog('links.js: link not modified, not in exclusion list but has class external');
			// Placeholder
	    }
    }
);
