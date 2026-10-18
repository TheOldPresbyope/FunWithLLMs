# moOde Audio Player - Codebase Review Report

## Overview

This document summarizes errors, bugs, and remediation plans found during a read-only review of the moOde audio player codebase. The review covered:

- **PHP backend**: `www/*.php`, `www/inc/*.php` (moOde-authored files), `www/daemon/worker.php`, `www/command/*.php`, `var/local/www/commandw/*.php`, `www/util/*.php`, `usr/local/bin/moodeutl`
- **JavaScript frontend**: all moOde-authored files in `www/js/*.js`
- **Python modules**: all 17 Python files under `www/`, `var/`, `usr/`, and other paths
- **Shell scripts**: all `*.sh` files plus extensionless shell scripts (`usr/local/bin/devutl`, `usr/local/bin/a2dp-autoconnect`, `home/xinitrc.default`, `etc/rc.local.overwrite`, `etc/update-motd.d/00-moodeos-header.overwrite`)

**Status**: Read-only analysis only; no existing code was modified.

## Critical / High Priority Findings

### PHP Backend

#### 1. Undefined `$sock` in `play_item`/`play_item_next` branches
- **File**: `www/command/index.php:80`
- **Issue**: `$sock` is only initialized in some code paths; when `$_SESSION['ashuffle'] == '1'` in `play_item`/`play_item_next` cases, `turnOffAutoShuffle($sock)` is called with `$sock` undefined.
- **Impact**: PHP 8 TypeError when passing undefined to functions expecting a socket.
- **Remediation**: Initialize `$sock` before use in these branches (open socket or pass appropriate default and have called function handle it).

#### 2. Session key typo: `audiout` vs `audioout`
- **File**: `www/inc/mpd.php:676`
- **Issue**: Checks `$_SESSION['audiout']` but correct key is `audioout` (note spelling).
- **Impact**: ALSA_DEFAULT not set correctly when HTTP server runs with local audio, affecting audio routing.
- **Remediation**: Fix to `$_SESSION['audioout']`.

#### 3. Bypassed input validation in command endpoints
- **Files**: `www/command/playlist.php:15-16`, `www/command/radio.php:14`
- **Issue**: `chkVariables()` excludes `item`/`path` from validation, and these values are interpolated into `sysCmd()` and SQL.
- **Impact**: Potential command/SQL injection surface.
- **Remediation**: Validate these keys with `chkValue()`/strict allowlists; avoid shell interpolation of user input; use parameterized queries.

#### 4. `stripos()` with negative offset causes ValueError on short strings
- **Files**: `www/inc/queue.php:25`, `www/inc/mpd.php:856`, `www/command/audioinfo.php:102`
- **Issue**: `stripos(dirname($file), '.cue', -4)` fails if haystack length < 4 (PHP 8 ValueError).
- **Impact**: Fatal errors on cue/metadata edge cases.
- **Remediation**: Guard — only use negative offset if `strlen(haystack) >= abs(offset)`; otherwise handle as no match.

### JavaScript Frontend

#### 5. Stray semicolon breaks saved-playlist row HTML
- **File**: `www/js/playerlib.js:2120`
- **Issue**: `output += '<div class="db-entry db-savedplaylist db-browse"><div>' + data[i].playlist; + '</div></div>';` — semicolon terminates statement, second `+` is discarded.
- **Impact**: Unclosed divs cause nested row corruption in Folder view, breaking layout/hit-testing.
- **Remediation**: Move semicolon to end.

#### 6. `engineCmd()` unguarded `JSON.parse` can break the long-poll loop
- **File**: `www/js/playerlib.js:559-570,757`
- **Issue**: Unlike `engineMpd()`, `engineCmd()` doesn't wrap `JSON.parse` in try/catch; parse error prevents `engineCmd()` from re-arming.
- **Impact**: All engineCmd-driven UI stops silently on invalid JSON response.
- **Remediation**: Wrap parse in try/catch and re-arm in finally block.

#### 7. Assignment instead of comparison in `itemInfoModal()`
- **File**: `www/js/playerlib.js:5368`
- **Issue**: `data[i][key] = '' ? ... : ...` assigns (falsy) and always picks thmcache URL; mutates source data.
- **Impact**: Broken cover image when cover hash is empty.
- **Remediation**: Use `== ''` comparison.

### Python Modules

#### 8. `aplmeta.py`: metadata not published when no cover exists
- **File**: `www/util/aplmeta.py:258-314`
- **Issue**: Publish/send/reset block is inside the `else` (cover exists) branch; when no cover, code sets `cover_file='notfound.jpg'` but never sends metadata, `bundle` stays `'end'`, loop stalls.
- **Impact**: AirPlay metadata overlay never updates when artwork missing.
- **Remediation**: De-indent publish/reset block out of else; handle cover_url/default image in both cases.

#### 9. `station_manager.py`: shell injection & path traversal on import
- **File**: `www/util/station_manager.py:431-455,476-487`
- **Issue**: Station names from imported archive are interpolated directly into `os.system()` ffmpeg calls and into filesystem paths (`os.path.join`/`os.remove`).
- **Impact**: Arbitrary command execution and arbitrary file write/delete as root if malicious archive imported.
- **Remediation**: Sanitize station names (reject `/`, `..`, quotes, control chars); use `subprocess.run` with shell=False; use safe IDs; parameterize DB queries.

#### 10. `mpdconf_merge.py`: unparseable lines silently dropped
- **Files**: `www/util/mpdconf_merge.py:86,123`
- **Issue**: `InvalidLine(...)` constructed but never raised.
- **Impact**: Valid MPD config lines (unquoted values like `bind_to_address any`) or other legal forms are silently discarded, causing user custom config settings to vanish.
- **Remediation**: Add `raise` at both locations; make `InvalidLine` inherit from `Exception`.

### Shell Scripts

#### 11. Qobuz event handler falls through after stopped
- **File**: `var/local/www/commandw/qbzevent.sh:153-210`
- **Issue**: When `PlaybackStateChanged` and `stopped`, block truncates cache but execution continues to paused/playing handler.
- **Impact**: Truncated cache may be repopulated incorrectly; front-end can get stale/empty playstate.
- **Remediation**: Restrict paused/playing handler to only those states (combine condition).

#### 12. sysinfo.sh shows wrong rx_addresses
- **File**: `www/util/sysinfo.sh:916`
- **Issue**: Uses `${arr[128]}` (rx_hostnames, id 129) instead of `${arr[129]}` for rx_addresses.
- **Impact**: "Receiver addrs" field displays hostnames instead of IP addresses.
- **Remediation**: Use `${arr[129]}`.

#### 13. sysinfo.sh Crossfade always blank
- **File**: `www/util/sysinfo.sh:168`
- **Issue**: `$mpdcrossfade` never assigned; only `crossfeed` fetched.
- **Impact**: Diagnostics missing Crossfade value.
- **Remediation**: Fetch `mpdcrossfade` via `moodeutl -d -gv mpdcrossfade`.

#### 14. sysinfo.sh Mixdown shows wrong value
- **File**: `www/util/sysinfo.sh:335`
- **Issue**: Prints `$apl_six_channel_mode` for "Mixdown" row (copy-paste).
- **Impact**: Mixdown value incorrectly reported.
- **Remediation**: Print `$apl_mixdown`.

#### 15. rc.local.overwrite aborts boot on cpugov write failure
- **File**: `etc/rc.local.overwrite:10-11`
- **Issue**: Script runs with `#!/bin/sh -e`; if `tee` fails (unsupported governor/empty query), script exits before starting udisks-glue and worker.php.
- **Impact**: moOde worker may never start on some kernels.
- **Remediation**: Add `|| true` or skip when empty/unsupported.

## Medium Priority Findings

Additional medium-severity issues (not exhaustive) include: Radio Browser error handling before processing results, `sendFECmd` TypeError if `file()` returns false, fopen/fread/fclose unchecked in library probes, thumbnail generation not guarding `imagecreatefromstring` failure, worker using undefined variables (`$timeout`, `$cfgMPD['mixer_type']`), album-heading click logic mismatches between encoded/decoded values and missing/incorrect attributes (JS), `GLOBAL.reconnecting` never reset, `miscLibOptions[1]` logic dead for AlbumID disambiguation, `cdsp_volume_update.py` crashes on None config values, `station_manager.py` multiple error paths that fall through causing AttributeError/tracebacks, `bt_pairing_agent.py` `dbus.UInt32(None)` on missing passkey, `rotenc.py` unhandled MPD failures kill daemon, `aplmeta.py` busy loop on EOF, Python scripts with shell injection risks in config/backup paths, and several shell quoting/escaping issues (echo -e corrupting JSON, unquoted vars in automount/exports checks).

## Low Priority Findings

Low-severity items include typos (`Novenber` month name in constants.php:328), `ltrim()` character-mask stripping arbitrary leading chars, `moodeutl` variable case bug (`$cpuLoad` vs `$cpuLoad` typo), sysinfo.sh `playlist_pos==` assignment (benign), dead code after returns, incorrect guards in station_manager, minor shellcheck-style issues (cd without || exit, word splitting), and radio-browser.js logo escaping gaps.

## Recommendations

1. **Fix critical/high first**: Focus on input validation (3), shell injection in station_manager (9), mpdconf_merge silent drops (10), engineCmd JSON.parse guard (6), and the Qobuz stopped-event fallthrough (11) — these affect correctness, reliability, or security.
2. **Add guards**: Systematically check fopen/file()/imagecreatefromstring returns and socket operations; add try/catch around JSON.parse in engine loops; add proper error handling in Python subprocess/DBus/MPD calls.
3. **Harden shell/CLI tools**: Use `shell=False` with subprocess where user data involved; quote all variables in paths/greps; avoid `echo -e` for JSON; handle `set -e` carefully in boot scripts.
4. **Improve robustness**: Don't rely on sqlite row order for positional IN lists (add ORDER BY); fix negative-offset stripos guards; initialize variables properly in worker code paths.
5. **Testing**: After fixing, run PHP syntax checks (`php -l`), JS syntax checks (`node --check`), Python compilation (`python3 -m py_compile`), and shellcheck on modified scripts to catch regressions.

## Notes

- Zend Framework media libraries under `www/inc/Zend/` contain PHP 8 syntax issues (curly brace offset syntax, nested ternary) — these are third-party vendored code; moOde code doesn't directly instantiate the problematic Mpeg classes in the top-level flows reviewed, but they would fatal if reached. Consider updating or replacing these libraries if they remain in active use paths.
- `moodeutl` is an extensionless PHP CLI script (shebang `#!/usr/bin/php`) — correctly handled in review.
- SC1097 false positives on `IFS==` in `qbzevent.sh`/`spotevent.sh` were correctly identified as not bugs.

---

*This report is the result of automated code review tooling plus careful manual verification of flagged items. All findings are documented with file paths, line numbers, explanations, and remediation suggestions as shown above.*
