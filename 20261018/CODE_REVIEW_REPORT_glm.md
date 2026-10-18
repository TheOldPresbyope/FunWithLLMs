# moOde Audio Player — Code Review Report & Remediation Plan

**Repository:** `/home/thanos/repos/moode.glm` (moOde audio player, @ ee31f36b *Improve radiocover_plus.py part 2*)
**Date:** 2026-10-18
**Focus:** review of the `www/` (PHP/JS), `www/daemon/` + `www/util/` (Python/PHP), shell scripts, templates, and `etc/lib/usr/boot/osdisk` support files
**Runtime assumptions:** PHP 8.4 (verified locally as 8.4.26), Python 3.12, jQuery 1.8.2 / Bootstrap 3 front end, SQLite, MPD backend. Architecture per `../docs/moode_application.md`.

> No code was modified during this review. All findings below were read from source; the highest-severity items were independently re-verified in this review (marked ✔).

---

## 1. Scope & Method

| Step | Coverage | Result |
|---|---|---|
| `php -l` sweep of all `.php` (~440 files) | Syntax-level | **2 parse errors** (vendored Zend library), all else clean |
| `python3 -m compileall` | All `.py` | Clean |
| `bash -n` / `node --check` | All `.sh`, all non-vendor `.js` | Clean |
| Manual + assisted deep review | `www/inc`, engines/daemons, `www/*-config.php`, JS, Python/util, templates, config files | ~90 findings, consolidated below |

Findings are consolidated by severity, deduplicated across subsystems, and ordered by expected impact. "PHP 8.4" denotes behavior verified against PHP 8.4.26.

---

## 2. Executive Summary

The codebase is functional for its main paths but contains:

- **2 unresolvable PHP parse errors** in the recently-patched vendored Zend library (the whole `Zend/Media/Mpeg/Abs/*` branch — used for MP3/LAME probing by `coverart.php` / `thumb-gen.php` — cannot load under PHP 8.4 at all).
- **A cluster of shell command-injection paths** rooted in an incomplete `chkValue()` filter (blocks `` $ ` | ; < > `` but not `"`, `'`, `&`, `(`, `)`, newline) and a codebase-wide habit of interpolating user/session values into hand-quoted `sysCmd()` strings. Multiple paths reach a **root** worker.
- **SQL injection** via `sqlRead()`'s raw single-quoted WHERE clauses (`chkSQL()` does not block `'`), reachable from unauthenticated POST data (`command/cfg-table.php`, `lib-config.php`, `eqg-config.php`).
- **Arbitrary file write** in `cdsp-config.php` upload handlers (client-controlled filename, no `basename()`).
- **Path traversal / arbitrary read** in `coverart.php` (urldecoded `REQUEST_URI` prefixed with the music root, no `..` guard).
- **Numerous plain logic bugs** — copy-paste typos (`audiout`, `mpd_httpd__local_audio`, `$mixerChange,$mixerChange`, `==` used as assignment, duplicated `[128]` index in `sysinfo.sh`, inverted boolean in `worker.php`) — that silently break features (WiFi PSK generation, HTTP-stream local audio, device-change restarts, renderer state transitions, PSK-driven WiFi).
- **Resource/availability hazards**: `engine-cmd.php` has no socket timeouts (each abandoned browser long-poll parks one FPM child indefinitely — with the 60-children FPM cap this is a WebUI-wide hang); the root worker can be killed permanently by a single `fputs(false)` at boot or by garbage image data in a queued job; `lcd-updater.sh`'s inotify watch is destroyed by the very first `rename()` the worker performs.
- **Front-end JS defects** including a strict-mode `ReferenceError` that prevents the Saved Search modal from ever rendering, a long-poll engine that dies permanently on one malformed response, and several unescaped-dynamic-HTML (XSS) sinks fed by remote radio stream metadata.

Highest-priority remediations see §6 (Phase 0).

---

## 3. Critical Findings

| # | Location | Finding | Remediation |
|---|----------|---------|-------------|
| **C1** ✔ | `www/inc/Zend/Media/Mpeg/Object.php:144,150,155,194,197,202` | **PHP 8 fatal parse error** — removed curly-brace string offsets (`ord($buffer{$pos++})`). `php -l` fails: *"unexpected token `{`, expecting `)`"*. Every file that includes `Zend/Media/Mpeg/Abs/*` (LAME header parsing) fails to parse at all. | Replace all `$buffer{...}` with `$buffer[...]`. |
| **C2** ✔ | `www/inc/Zend/Media/Mpeg/Abs/VbriHeader.php:88-92` | Two bugs: (a) unparenthesized nested ternary → **parse fatal** on PHP ≥ 8; (b) `$tocCount` is read (line 88) but line 84 assigns `$tocEntries` → undefined-variable decode loop (`read(null * size)`). | Build the format string with explicit parenthesization; use `$tocEntries`. |
| **C3** ✔ | `www/inc/network.php:225-226` (`genWpaPSK`) | **Off-by-one array index.** Verified: `wpa_passphrase` emits exactly 5 lines; `psk=<hex>` is `$result[3]`. The code explodes `$result[4]` (the closing `}` line) and returns `null`. Every hotspot/WiFi-PSK caller (`net-config.php`, `autocfg.php`) stores `null` → generated connection profiles are unusable (error silently suppressed by `error_reporting(E_ERROR)`). | `explode('=', $result[3])`; also delete `/tmp/passphrase` on failure and create it with 0600. |
| **C4** | `www/inc/common.php:137` (`chkValue`) + call sites | **Command-injection umbrella.** Filter blocks only `` $ ` | ; < > `` and the word `base64`; `"`, `'`, `&`, round brackets and newline pass. Wherever values are interpolated *unquoted* or inside hand-rolled `"..."` (not `escapeshellarg()`), injection is possible. Verified exploitable sinks include: | Harden `chkValue()` (reject quotes/`&`/paren/no-newline) **and** quote every interpolated value with `escapeshellarg()` (pattern already used correctly in `inc/radio.php`). Itemized sinks: |
| C4.1 | `www/inc/music-library.php:943-951` (`startAutoShuffle`) | `ashuffle_filter` / `ashuffle_exclude` interpolated unquoted into `mpc search ... |` — `chkValueEx()` deliberately permits `|`. Root exec via session value. | Same. |
| C4.2 | `www/inc/music-source.php:101-117,304,543` (`nasSourceMount` & friends) | SMB password/user/JSON-config pieces inside hand-built `"\"...\""`; `'`, `"`, `&`, newline break out. Also **logs the full mount command with plaintext password** to `moode.log` (L137-150). | `escapeshellarg()`; redact password from debug output. |
| C4.3 | `www/daemon/worker.php:3647-3650` | SMB password (user input) interpolated unescaped into double-quoted shell in the `fs_smb_pwd` job, running **as root**. | Pass via stdin; `escapeshellarg()`. |
| C4.4 | `www/util/backup_manager.py:86` | WLAN password from `$_POST['backup_wlan0pwd']` (bkp-config.php:59, unescaped) inserted into a `sed` script executed by `system()` as root. | Build the ini replacement in Python (`re.sub` with escaped input); no shell. |
| C4.5 | `www/dashboard.php:137` | `sysCmd("echo -n '$_players' | sudo tee ...")` — dashboard cache HTML containing scanned host names; a `'`/newline in a hostname = root RCE (plus persistent XSS from the cached HTML). | Write the file with `file_put_contents()`; escape on output. |
| C4.6 | `www/blu-config.php:46-132` | BT device names (remote-controlled) into `'-P "' . name . '"'` — quoting bypass via `"`/newline; names also echoed unescaped into `<option>` HTML. | Escape shell args & HTML output. |
| C4.7 | `www/daemon/mountmon.php:26,34,40-41,52` | NAS `address`/`name` (user-entered, no charset validation at `lib-config.php:126`) unquoted into `ping`/`nmap`/`ls`/`mount`/`umount`. | `escapeshellarg()` + input validation (IP/host regexp). |
| C4.8 | `www/daemon/watchdog.sh:182-190` | `$WEBUI_DISPLAY_HOST` expanded **unquoted** into `curl http://$HOST/command/`. | Quote or validate. |
| C4.9 | `www/inc/network.php:168` | Hotspot SSID (attacker-controlled AP name) unquoted into `nmcli c down`. | `escapeshellarg()`. |
| C4.10 | `www/util/sysutil.sh:28-53` | Web-UI Hostname/Friendly-name values used as **sed regex + replacement** — `&` re-inserts match, `/` ends the replacement, `.` over-matches → corrupts `/etc/hosts`, `/etc/hostname`. | Use a different delimiter and escape `&`/`\`, or literal-match. |
| C4.11 | Other same-class holes: `www/inc/renderer.php:91-93` (airplay name inside `"…"`, " &" passes the filter), `www/inc/common.php:781-783` (`echo $brightnessValue > …`), `www/inc/autocfg.php:40,49` (`setSessVarOnlySysCmd` sprintf interpolation), `www/inc/music-source.php:465-468` (`$label` unquoted into `e2label`), `www/daemon/worker.php:3546` (`cpugov` echo/tee), `www/daemon/worker.php:1402` (sed on display URL) | Same class, single-line fixes. | `escapeshellarg()`. |
| **C5** ✔ | `www/inc/sql.php:23-38` (`sqlRead`) + `www/inc/common.php:215-227` (`chkSQL`) | **SQL injection.** `sqlRead()` string-concatenates caller args into single-quoted WHERE clauses; `chkSQL()` only rejects `"` and `--`, not `'`. Verified reachable with raw `$_GET`/`$_POST`: `www/command/cfg-table.php:146` (`theme_name`), `www/lib-config.php:121,229,306` (`mount']['name`), `www/eqg-config.php:SELECT/DELETE/INSERT`. | Route string args through `SQLite3::escapeString()` (as `sqlUpdate()` already does) or parameterize; add `'` to the `chkSQL` block list. |
| **C6** ✔ | `www/cdsp-config.php:104-106,147-148` | **Arbitrary file write:** `move_uploaded_file(tmp, dir . $_FILES[..]["name"])` for `pipeline_config` and `coeffs_file` — client-controlled name (e.g. `../../…`) overwrites www-data-writable files. | `basename()` + extension/char allowlist before the move. |
| **C7** | `www/coverart.php:172-181` (+ `inc/music-library.php::ensureAudioFile`) | **Path traversal / arbitrary file read:** `urldecode($_SERVER['REQUEST_URI'])` prefixed with `MPD_MUSICROOT`, never scanned for `..`, never passed through `chkValue()`; result also fed to the Zend tag parser. | Reject `..`; verify `realpath()` stays under `MPD_MUSICROOT`. |
| **C8** | `www/util/station_manager.py` (import path, root) | **Path traversal + shell injection from uploaded backup zip:** file names from user-supplied zip written/deleted outside `…/RADIO` (`os.join(pts_path, f'{name}.pls')` etc., `os.remove`) and unquoted into `os.system('ffmpeg -v 20 -y -i "{}"…')` (L445-455) — root code execution via crafted station name. | Reject names containing `/`, `..`, `\0`; use `subprocess.run([...])` (no shell). |
| **C9** ✔ | `www/engine-cmd.php:29-34` | **No socket timeouts.** `socket_accept()`/`socket_read()` block forever; `max_execution_time` does not apply to blocked Linux socket I/O, so an abandoned browser long-poll permanently parks a php-fpm child. This is why `watchdog.sh:73-76` must reload FPM at 60 workers — under load the pool exhausts and the whole WebUI hangs. | `socket_set_option($res, SOL_SOCKET, SO_RCVTIMEO, [sec=>300])` on the accepted socket + clean exit on timeout. |
| **C10** ✔ | `www/daemon/worker.php:938-991,1848-1853` (and every openMpdSock consumer) | **Worker death at boot.** If MPD isn't up in ~3 s, `openMpdSock()` returns `false`; the code logs and *continues*, then calls `getMpdOutputs($sock)`, `sendMpdCmd($sock, …)` → uncaught PHP 8 `TypeError` (`fputs/resource`); worker (started from `etc/rc.local.overwrite`, no supervision) dies and stays dead. | Bail out / retry on `false`; never call socket helpers without a live socket. |
| **C11** ✔ | `www/daemon/worker.php:1925-2042` (`set_ralogo_image`, `set_plcover_image`) | Worker is a bare `while(true)` loop with **no exception handler and no supervision**; garbage base64 image data → `imagecreatefromstring` returns `false` (unchecked here — the sibling `set_rblogo_image:*4018` checks) → fatal on `imagesx(false)`, daemon permanently dead. | Guard `if (!$image)`; wrap loop body in try/catch + add a systemd `Restart=` unit for worker. |
| **C12** ✔ | `lib/systemd/system/shellinabox.service:1` | Binary NUL byte embedded after `[Unit]` (`od -c` verified) → unit fails to parse; service broken since creation (746297e4). | Strip the stray byte. |
| **C13** ✔ | `etc/php/8.4/fpm/pool.d/www.sed.conf:36` vs `etc/nginx/moode-locations.conf:20` | FPM pool still listens on `/run/php/php7.3-fpm.sock` while nginx expects `php8.4-fpm.sock` (PHP 7.3→8.4 bump, 583b0dc7, updated nginx + everywhere else). **Unless image-build tooling rewrites the socket name, every page 502s.** If validated only at release-build time, fix the template. | `listen = /run/php/php8.4-fpm.sock`. |

---

## 4. High Findings

### 4.1 Functional breakage (verified logic bugs)

| # | Location | Finding | Fix |
|---|----------|---------|-----|
| H1 ✔ | `www/inc/mpd.php:676` (`setMpdHttpd`) | Typo: `$_SESSION['audiout']` — the real key is `audioout` (grep: appears nowhere else). Always undefined → `mpc disable "ALSA Default"` runs whenever the HTTP server is on, i.e. **local audio always disabled with HTTP streaming**, and ENABLED when it shouldn't be, independent of the user setting. | `$_SESSION['audioout']`. |
| H2 ✔ | `www/snd-config.php:54-56` | Copy-paste: `$queueArgs = $mixerChange . ',' . $mixerChange;` (should be `$deviceChange . ',' . $mixerChange`, as correctly done in `mpd-config.php:39`). Worker job never gets `deviceChange=1` → MPD restart flow after an output-device change is broken. | Fix concatenation. |
| H3 ✔ | `www/snd-config.php:315-317` | POST key typo `mpd_httpd__local_audio` (double underscore) — template posts `mpd_httpd_local_audio` (snd-config.html:437-440). Handler is dead code; "Local audio" HTTP-stream setting never persists correctly. | Use the single-underscore key. |
| H4 ✔ | `www/inc/queue.php:22-28` (`getPlayqueue`) | `TimeMMSS` is computed when the `file:` line is parsed, but MPD emits `Time:` *later* (in the `else` branch, Time is set but TimeMMSS is never recomputed) → `formatSongTime(null)`; **every queue row shows 00:00**. Same compute-on-tag pattern at `mpd.php:601` warns when a block has no `Time`. | Compute `TimeMMSS` after the parse loop per entry. |
| H5 | `www/inc/mpd.php:496-522` (`formatMpdStatus`) | Stop-state branch writes `$elapsed='0'`/`$time='0:0'` but lines 521-522 unconditionally overwrite them from `explode(':', $status['time'])` — `time` is *absent* in stop state → undefined-key read + dead code (clean branches are unreachable in effect). | Move the two assignments into the non-stop branches / delete. |
| H6 ✔ | `www/inc/cdsp.php:148-150` | `getQuickConvolutionConfig()` does `return $this->configFile = $this->quickConvolutionConfig;` — copy-paste of a setter: **corrupts `configFile`** with the quick-conv value, so `isQuickConvolutionActive()` and later `selectConfig()` logic see garbage. | `return $this->quickConvolutionConfig;`. |
| H7 | `www/inc/cdsp.php:87-89` (`setPlaybackDevice`) | Empties the wrong key: does `unset($ymlCfg['mixers'])` when `pipeline` is empty (the stated intent is to remove the empty `pipeline` that would break the config). Also `count(...) == 0` booleans parenthesized incorrectly (works only by loose-comparison luck). | `unset($ymlCfg['pipeline'])` and fix grouping. |
| H8 ✔ | `www/inc/alsa.php:237-238` (`getALSAOutputFormat`) | `sqlQuery()` returns a **list of rows** (confirmed in `sql.php:142-158`) but code indexes `$result['value']` — always undefined → the Bluetooth branch never runs (correct pattern `$result[0]['value']` is used elsewhere, e.g. `common.php:39`). | `$result[0]['value']`. |
| H9 ✔ | `www/daemon/worker.php:2246-2248` | Inverted renderer flag: `$_SESSION['paactive']` used truthy while every sibling is `== '0'` → `rendererNotActive` can only be true while Plexamp **is running**; RoonBridge pause/resume logic misfires. | `$_SESSION['paactive'] == '0'`. |
| H10 ✔ | `www/daemon/worker.php:164,1531` | `$_SESSION['eth0chk'] == '0';` / `$_SESSION['lcdup'] == '0';` — `==` used as assignment → defaults never written; undefined-var reads later. | `=`. |
| H11 ✔ | `www/daemon/worker.php:1619` | `$sockTimeout == 'default' ? MPD_DEFAULT_SOCKET_TIMEOUT : $timeout;` — `$timeout` is **undefined** in worker.php (copy-paste from engine-mpd.php:15) → null socket timeout when the row is anything but "default". | Use the session value. |
| H12 ✔ | `www/daemon/worker.php:87-89` | Filename mismatch on sudoers: checked `/etc/sudoers.d/010_<user>-nopasswd`, created `…-nopasswd-nopasswd` → the check never passes and the file is recreated every boot (also wrong mode for sudoers). | Drop the duplicate suffix; chmod 0440. |
| H13 | `www/inc/music-source.php:206-207` (`detectSMBVersion`) | `if (count($parts) >= 2) { $version = trim($parts[2]); }` — indexes element 3 while guaranteeing only 2 → undefined-index churn. | `>= 3`. |
| H14 | `www/util/trx-control.php` (`txStatus`, ~L118-125) | Dead statement **after** `return`: the trailing `$ipAddr[0]['value'];` never lands in the status string → tx status omits the multicast address field that `rxStatus()` includes. | Append it inside the return. |
| H15 | `www/util/renderer-onoff.php:~118` | `if (empty($onoff || $onoff != 'on' || $onoff != 'off'))` — the parenthesized boolean expression is always true; `empty(true)` is false → the `on|off` validator **never** rejects anything (and the logic is inverted: needs `&&`). | `if (empty($onoff) || ($onoff != 'on' && $onoff != 'off'))`. |
| H16 ✔ | `www/daemon/lcd-updater.sh:10` + `worker.php:2643,2692` | The worker updates `currentsong.txt` by `rename()` (tmp file → target), which **replaces the inode** the inotifywait watch is bound to (watch gets IN_IGNORED, exits silently) → LCD updater runs once, then never again. | Watch the directory (`inotifywait -e close_write /var/local/www/`) or write in place. |
| H17 | `www/inc/Zend/Media/Id3v2.php:206-214` | Hard-coded `/var/www/inc/` in `file_exists()` — any other layout makes every frame report *"bad Frame ID"* and degrade; and when `thumb-gen.php` runs without `common.php` loaded, the fallback `workerLog()` call is a fatal (undefined function); `@fopen` handle never closed. | `stream_resolve_include_path($file)`; `debugLog`-safe logging; close handle. |
| H18 | `www/js/scripts-panels.js:6,1527-1553` | `'use strict'` + bare `for (i = 0; …)` inside `updateSavedSearchModal` — **strict-mode `ReferenceError: i is not defined`** every time the Saved Search modal opens; list never renders, spinner never restored. | `for (var i = 0; …)`. |
| H19 | `www/js/playerlib.js:559-570,757` (`engineCmd`) | No try/catch around `JSON.parse(data)` / `data.includes`. One malformed/empty response throws inside `success`, the recursive `engineCmd()` never fires → the entire command-event stream **dies permanently** until reload. | try/catch; re-issue the poll in `finally`. |
| H20 | `www/js/playerlib.js:1794,1890,1897,1899` + `1706-1709`, `scripts-panels.js:1541-1546`, `scripts-library.js:807/1692` | **XSS via remote-controlled content.** Radio stream `Title`/`Name` (any stream operator) injected raw into `.html()`/`innerHTML`; `genSearchUrl()` puts raw title in `href` (song branch escapes, radio branch doesn't); user-saved-search name/filter injected raw into `data-name` attributes. | `encodeHTMLEntities()`/`rbEscapeHtml()` at every sink. |
| H21 | `www/js/scripts-library.js:807 vs 1692,1690-1696` | Attribute mismatch: heading is written with `heading-key=<mb_albumid>` but read as `attr('heading-mb-album-id')` → always undefined → MBRZ album-id filtering excludes tagged tracks. Separately, `headingAlbum` is HTML-**encoded** before comparing to raw album data → albums with `&`, `'`, `"` ("Simon & Garfunkel") never match → heading click shows wrong/empty song list. | Read `heading-key`; compare against the decoded/single-side-escaped value consistently. |
| H22 | `www/util/radiocover_plus.py:189-190` (recently modified file) | `values.get("LOG_LEVEL").upper()` — `None` if the key is commented out → `AttributeError` inside `read_global()`; unknown name → `KeyError`. Read at top of every lookup → whole cover-search utility aborts. | `values.get("LOG_LEVEL", "ERROR")` + safe dict lookup. |
| H23 | `www/util/station_manager.py:89, 446, 655-666` | `except Error as e:` — **`Error` is not defined** (should be `sqlite3.Error`); a real DB-open failure raises `NameError` mid-CLI. | `except sqlite3.Error as e:` (+ early return when DB is missing so `get_fields()` isn't called on `conn=None`). |
| H24 | `www/util/sysinfo.sh:915-916` | Copy-paste: both `rx_hostnames` **and** `rx_addresses` read `${arr[128]}` → the sysinfo report's Receiver-addresses field always duplicates the hostnames value. | `${arr[129]}` for addresses. |

### 4.2 Availability / data-integrity

| # | Location | Finding | Fix |
|---|----------|---------|-----|
| H25 | `www/inc/sql.php:10-16` | `sqlConnect()` sets **no `PRAGMA busy_timeout`** and no WAL. worker (long-lived root `PDO`), FPM scripts, monitor daemons and manual `sqlite3 … vacuum` runs contend; under contention `execute()` fails → callers index `false`/`true` as arrays (PHP 8 warnings + silent logic corruption). Vacuums hold exclusive locks against live traffic. | Enable `busy_timeout=5000` + WAL at connect; surface errors (`ERRMODE_EXCEPTION` + try/catch) instead of `return false`. Also: `sqlQuery()` returns `true` for zero rows (`sql.php:156-158`) while dozens of callers do `$result[0]['value']` — return `array()`. |
| H26 | `www/inc/common.php:519-534` + `engine-cmd.php:19-27,46` | Port-bookkeeping races: concurrent `sed -i` rewrites of `/tmp/moode_portfile` can silently lose entries; the delete pattern `/4000/d` matches any line **containing** `4000` (e.g. `14000`); `socket_close()` skipped when `socket_connect` fails → leaked fd per failure. | Rewrite portfile atomically (read/filter/write-tmp/rename); anchor matches; always close. |
| H27 | `www/inc/common.php:615-630` (`waitWorker`) | `do { usleep(); open_ro; } while ($active != 0)` — loop runs **forever** if worker.php died mid-job; FPM child parked permanently. | Max-iteration bail-out + log. |
| H28 | `www/daemon/worker.php (main loop)` | Worker holds the PHP **session lock across the whole loop body**, including `sleep(45)` inside `chkClockRadio()`/`chkSleepTimer()` → UI long-polls stall up to ~45 s around those timers. | Release session around long waits; don't sleep while holding the lock. |
| H29 | `www/inc/mpd.php:338-353,330` | `openMpdSock()` retries = up to ~3 s (6×0.5 s) acceptable, but `readMpdResp()` sets **no stream timeout** (PHP default socket timeout applies); `getMpdSock()` on failure does `exit(0)` with no payload (blank UI), and `stopAutoShuffle()` continues calling `fputs()` on `false` → fatal. | `stream_set_timeout($sock, n)` after open; return structured errors. |
| H30 | `www/util/backup_manager.py:203-209` | On restore, `KeyError` path is reported but `os.path.isfile('/tmp/cfg_rcucache.sql')` still tests a **stale leftover from a previous restore** and pipes it into sqlite as root. | Unique temp names / delete after use. |
| H31 | `www/util/automount.sh:39,50,53` | Disk labels (USB-device-controlled) contain regex/sed metacharacters: unquoted `$(basename "$2")` in grep splits words (check skipped); `sed -i "/$label]/,/guest/ d"` errors on `(`/`,`-labels → Samba share entries never cleaned. | Quote expansions; block-copy with awk on exact `[name]` instead of regex deletion. |
| H32 | `www/daemon/rotenc.py:146-150,120-135,168-170` | Volume params fetched positionally from an **unordered** `param OR param` query (`fetchone()` twice) — row order swap snaps volume to the clamp; `int(None)` crash if a param is missing; MPD `connect()` unguarded → first failure kills the service (no systemd restart). | Map rows by `param` name; timeout on connect; `Restart=on-failure`. |

---

## 5. Medium Findings

### PHP core (`www/inc`)

| # | Location | Finding | Fix |
|---|----------|---------|-----|
| M1 | `www/inc/common.php:215-227` (`chkSQL`) | False positives: a `"` in any value aborts the request (`exit(1)`) — in worker context silently kills the current job; additionally the SQL_CMDS loop sets `$valid = true` re-enabling a string the char check already rejected. | Don't reset `$valid`; relax/remove `"` check given escaping is applied via `escapeString` in `sqlUpdate`. |
| M2 | `www/inc/common.php:244-265` (`chkXSS`) + `www/header.php:164,20,214` + `inc/common.php:441-490` | XSS detector only **logs** and never blocks; `HTTP_REFERER`-derived back-links are stored in session without `isset()`/validation and echoed unescaped (`href`), as are `browsertitle`, `bklp-config.php:168,174` upload filenames. | Block (or at minimum reject) detected payloads; `isset`-guard referer; validate local-path; `htmlspecialchars()` all echo. |
| M3 | `www/inc/autocfg.php:916-958, 943-964, 35-92` | "Unused settings" detector is dead/inverted (`unset($availableConfigs[$configName])` deletes by value-as-key; `empty()` check inverted); `$script` logged before assignment; nested function definitions redeclare fatal on second call; `catch (Exception)` misses PHP 8 `TypeError` from `parse_ini_file()->false`. | Track used keys in a map; invert checks; `catch (Throwable)`; hoist handlers to array-of-function-expressions. |
| M4 | `www/inc/mpd.php:23,107-238` (`updMpdConf`) | Params with empty `value` (SELECT has `value!=''`) leave all downstream variables undefined → malformed `mpd.conf` directives (`close_on_pause ""`, `buffer_time ""`, …) — masked by `E_ERROR` reporting. | Initialize all defaults before the loop. |
| M5 | `www/inc/mpd.php:825-826` | `$current['bitrate'] == '';` — comparison where assignment intended, station bitrate lost. | `=`. |
| M6 | `www/inc/mpd.php:856` & `queue.php:25` | `stripos(dirname($x), '.cue', -4)` throws PHP 8 `ValueError` for short dirnames (e.g. `.`) → fatal in `enhanceMetadata()`/`getPlayqueue()` for any song at MPD root. | Compute length-safe suffix check / `pathinfo(...,PATHINFO_EXTENSION)`. |
| M7 | `www/inc/music-library.php:697` | `ltrim($file, LIBSEARCH_BASE)` strips a **character set**, not the prefix — saved-search names starting with `v/a/r/l/o/c/…` get mangled. | `substr($file, strlen(LIBSEARCH_BASE))`. |
| M8 | `www/inc/music-library.php:493, cache write 306-310` | UTF8-rep path uses `count($lib) == 1` (sibling uses `<= 1`) → "Nothing found" placeholder skipped for empty libraries; library JSON writes are **non-atomic** → parallel readers can see truncated JSON. | `<= 1`; tmp-file + `rename()`. |
| M9 | `www/inc/music-library.php:72-118,143` | `$cmd` undefined when the filter value isn't in the switch → `fputs(null)` churn. | Initialize and skip empty. |
| M10 | `www/inc/renderer.php:127` (`stopAirPlay`) | Unanchored `pkill -f -9 cat` kills unrelated `cat`-containing processes (pattern `[c]at` is used correctly at L152). | Anchor the pattern. |
| M11 | `www/inc/alsa.php:39-43` (`getAlsaMixerName`, I2S branch) | if/else both assign the same constant — parsing dead; intent (mirror the IEC958 parse) lost. | Parse `$result[0]` in the else. |
| M12 | `www/inc/alsa.php:124,137` | `file_get_contents('/proc/asound/cardX/id')` on missing cards → warning every loop (masked) and works by accident. | `file_exists()` guard. |
| M13 | `www/inc/cdsp.php:36-44` | Declared `$cardNum` never used; constructor writes `$this->device = $cardNum` (PHP 8.2+ dynamic-property deprecation). | `$this->cardNum = $cardNum`. |
| M14 | `www/inc/network.php:167` | Hotspot `.nmconnection` parsed via `cat … 2>&1` without existence check → stderr text becomes the SSID. | `file_exists()` guard. |
| M15 | `www/inc/queue.php:121` (+ `findInQueue` and other raw-tag senders) | `$tag`/`$search` interpolated raw into MPD commands — filenames containing `"` desync the MPD protocol ("escapeDblQuotes()" exists and is inconsistently used). | Use `escapeDblQuotes()` everywhere. |
| M16 | `www/inc/radio-browser.php:183-190` + `worker.php:4013-4015` | Logo images (~100 KB) pushed through `$_SESSION['w_queueargs']` delimited by literal `~~~` — a favicon containing that byte sequence corrupts the job payload; success reported even when `submitJob()` returns false. | Length-prefix the blob; handle `false`. |
| M17 | `www/inc/session.php:97,139` | `get_status` debug-log spam (each call = a `cfg_system` query via `debugLog()`); `purgeSessionFiles` indexes `[0]['value']` without a row check. | Gate debug; null-check row. |

### Engines / daemons

| # | Location | Finding | Fix |
|---|----------|---------|-----|
| M18 | `www/engine-mpd.php:44,62` | `$_GET['state']` used without isset (undefined-key on PHP 8); `$resp` is read on the state-transition path where it was never assigned (works only by accident since `null != 'Socket timed out'`). | `$state = $_GET['state'] ?? null` ; assign `$resp = … ? sendIdle() : null`. |
| M19 | `www/daemon/mountmon.php` + `bkp`/`trx-config.php:134` | `multiroom_tx_query_timeout` POST key vs DB param `tx_query_timeout` → comparison always against undefined key;اقة redundant-update logic never triggers. | Match the param name. |
| M20 | `www/snd-config.php:360-361` | `phpSession('write','alsaequal',…)` **before** `submitJob('alsaequal', $_SESSION['alsaequal'] . ',' . $_POST…)` — "old,new" args are actually "new,new" (latent 2-arg contract break with worker/eqctl). | Capture old value first. |
| M21 | `www/daemon/worker.php:2955` (`create_saved_search`) | `chmod 0777 "$file"` on an undefined `$file` → saved-search JSON created with worker's umask, potentially unreadable by www-data. | Assign the path first. |
| M22 | `www/daemon/worker.php:4020` | `$job` undefined in the `set_rblogo_image` error case. | `$job = $_SESSION['w_queue']`. |
| M23 | `www/daemon/worker.php:125-129` | After auto-`reboot` on FPGA header-missing, startup keeps initializing on a dying system. | `exit;` after reboot. |
| M24 | `www/daemon/watchdog.sh:22,205 vs 100` | Inconsistent shairport pgrep patterns (`-f "LC_ALL=C …"` never matches because env assignments aren't in cmdline) → pre-check is dead code; retry-sleep burns 1 s/iteration. | Use `pgrep -x shairport-sync` consistently. |
| M25 | `www/daemon/mpdmon.php:28,48` | `filesize(MPD_LOG) - 1024` unchecked → negative `fseek` if log missing/tiny; fixed 1-KB trim can double-log across rotation race. | Clamp to ≥ 0; re-verify size. |
| M26 | `www/daemon/touchmon.php:48-57` | `$lastMTime` initialized only in the xinput-restart branch → bogus "touch detected" on first tick; `filemtime` warns if log isn't created yet. | Init unconditionally + existence guard. |

### Python / utils

| # | Location | Finding | Fix |
|---|----------|---------|-----|
| M27 | `www/util/radiocover_plus.py:966-971,447-452,494,99` | Blocking `flock` (no `LOCK_NB`) makes concurrent invocations pile up instead of skip; unreachable `archive.org` branch after an unconditional `return`; `resultCount != '0'` compares int to string (never fires); log file `chmod 0666`. | `LOCK_NB`; de-duplicate code; numeric compare; 0664 owner root. |
| M28 | `www/util/station_manager.py:425-427,489, 124-134,346-350, 562-570` | SQL built by concatenation with a **MySQL-style** escape (`\"` is not a SQLite escape) and an unescaped `name` in `WHERE`; missing-file `return_code=6/3` paths don't return (falls through to `ZipFile(missing)`); price-difference report Copy/paste guards both branches with `additional_bu_fields`. | Parameterized SQL; early returns; fix the report condition. |
| M29 | `www/util/cdsp_volume_update.py:51,71,190` | `yaml.load(Loader=yaml.Loader)` (unsafe loader → RCE if state file replaceable); `get_config()` can return `None, None` → `pow(10, None/20)`, `abs(None)` crash. | `yaml.safe_load`; per-field fallback (`or 60 / or 0`). |
| M30 | `www/util/plexamp_status.py:28` | `requests.get(url)` with no timeout in a poller → blocks indefinitely. | `timeout=3`. |
| M31 | `var/local/www/commandw/spotevent.sh:63,134-139` | `PLAYSTATE` initialised `Pause` and never set `Resume` in `track_changed` (the Qobuz twin *does*) → UI shows paused during Spotify playback changes. | Set `Resume` in `track_changed`. |
| M32 | `var/local/www/commandw/qbzevent.sh,spotevent.sh` | `while IFS== read; export $key=$value` over `jq -r` output — a metadata value containing a newline becomes an extra env var; values with `=` truncated. | NUL-delimited jq output / base64 values. |
| M33 | `www/daemon/gpio_buttons.py:24,37` / `btmeta.py:129` / `bt_pairing_agent.py:178,189-198` | Various unguarded: `int(sys.argv[1])`/`int(row['value'])` crash daemon on config typo; non-numeric AVRCP `Duration` kills DBus handler; agent unlinks/rebinds `/tmp/moode-btagent.sock` unconditionally (second instance steals the endpoint; pre-created file kills bind). | Defaults + try/except; refuse duplicates via lock; null-guard. |
| M34 | `www/util/aplmeta.py:92,102,269-271` | `RATE_TABLE[parts[n]]` KeyError for unmapped rates (e.g. 88.2k) crashes the consumer loop; "no cover" branch never publishes the cached JSON → stale metadata forever after cover-less sessions. | `get(rate, fallback)`; publish in both branches. |
| M35 | `www/util/system-updater.sh:46-52` + `plugin-updater.sh:43-49` | `unzip` exit status never checked → truncated zip still `chmod 0755`'d and its `install.sh` executed as root. | `|| { echo; exit 1; }`. |
| M36 | `www/util/watchdog.sh:189` | Remote `curl` with no `--max-time` blocks the loop ~2 min when the display host is down. | `--connect-timeout 2 --max-time 4`. |
| M37 | Various | Positional `readarray` indexing over unordered `param IN (...)` result sets (`vol.sh`, `rotvol.sh`, qbzevent/spotevent/spspre/spspost/slpower) — a query-plan change swaps every consumer's meaning; sqlite UPDATE in `$( )` used as fire-and-forget (errors silently dropped). | `ORDER BY param` (or map by name); surface errors. |

### Config UI (`www/*-config.php`) — beyond listed earlier

| # | Location | Finding | Fix |
|---|----------|---------|-----|
| M38 | `www/net-config.php:49-117` | `$pwd/$psk` uninitialized for unexpected `security` values; SSID store via raw SQL concat where `sqlUpdate()` escaping exists. | Initialize defaults; route the store through `sqlUpdate`.
| M39 | `www/sqe-config.php:20` | Double escaping: `sqlUpdate(..., SQLite3::escapeString($value))` while `sqlUpdate()` itself already escapes → values containing `'` persisted corrupted (`''`). | Pass raw value. |
| M40 | `www/bkp-config.php:130,240` | unchecked POST key `restore_camilladsp_with_replace`; `$msg == 'Restart required'` branch is dead. | isset-guard; drop dead branch. |
| M41 | `www/lib-config.php` (save paths) | `foreach ($mounts …)` before the `$mounts === true` early-return check. | Move check up. |
| M42 | All POST handlers in `*-config.php` | **No CSRF tokens** anywhere (session-cookie-only mutations, same-origin-only because of the refer logic). Global systematic gap. | Per-session token validated per POST. |
| M43 | `www/audioinfo.php:118,156,161-163,304-312` | `$mpdStatus` from the non-renderer branch referenced in the renderer-active branch; `$_resample_modes` covers a narrow key set (null lookups for unknown modes). | Initialize; shield lookup. |
| M44 | `www/per-config.php:272-277` | Toggling "LCD update" also writes `extmeta` — cross-effect between unrelated settings (likely copy-paste). | Confirm/remove. |
| M45 | `www/trx-config.php:134` | Wrong-comparison: `$_POST['multiroom_tx_query_timeout'] != $cfgMultiroom['multiroom_tx_query_timeout']` — the real column is `tx_query_timeout` (undefined key → write always "changed"). | Correct key. |
| M46 | `www/util/c/eqctl.php` (viaGuild) | reports the wrong message; duplicate root-uid check; session left open at `exit()`. | Fix message; single check; close session. |

### JS

| # | Location | Finding | Fix |
|---|----------|---------|-----|
| M47 | `www/js/playerlib.js:5364-5369` | `data[i][key] = '' ? A : B` — assignment as condition: the check always false-y, the cover slot **and** the real hash in `data` destroyed each show. | `data[i][key] == ''`. |
| M48 | `www/js/playerlib.js:1696-1697` | `RADIO.json[file]['home_page']` unguarded — streams absent from `cfg_radio` (Radio Browser prunes) throw, abort `renderUI` for the now-playing panel (sibling check exists at line 1871). | `typeof(RADIO.json[…]) !== 'undefined'` guard. |
| M49 | `www/js/playerlib.js:2600-2615` | "There are no playlists" branch references `element` declared inside the other branch → TypeError, message never rendered. | Hoist `element`. |
| M50 | `www/js/playerlib.js:2406-2409` (`renderRadioView`) | Second `var countryDiv` overwrites the region branch → region sorting loses metadata. | Merge conditions. |
| M51 | `www/js/playerlib.js:2455,2463` | `encodeURIComponent(imgUrl)` encodes `http://…` wholesale (external logos get broken relative paths); station names in `data-path` unescaped. | Only encode local thumbs; escape names. |
| M52 | `www/js/playerlib.js:1109` | `SESSION.json['volmute'] == '1';` — dead statement (intended assignment). | `=`. |
| M53 | `www/js/playerlib.js:3485` | `bgImgChange = false;` — implicit global; the real flag is `UI.bgImgChange` → preferences reset doesn't clear the actual flag. | `UI.bgImgChange`. |
| M54 | `www/js/scripts-panels.js:712-719` | `this` unbound inside the queued `setTimeout` → clicked queue row never gets the active highlight. | Capture `var self = this`. |
| M55 | `www/js/scripts-panels.js:1302-1303` | `UI.playlsitPos = -1;` typo — real `UI.playlistPos` keeps its stale value and is persisted after refresh. | Fix typo. |
| M56 | `www/js/scripts-panels.js:754,779` | Playlist/favorites names unencoded in `command/playlist.php?name=…` → names with `&`, `%`, `#` corrupt the request. | `encodeURIComponent`. |
| M57 | `www/js/scripts-panels.js:1170,1342,1713,1745` + `radio-browser.js:185` | `new RegExp(filter, 'i')` on raw user input — typing `(`/`[`/`+` in any list filter throws and the keyboard eats silently. | Escape metacharacters (or `String.includes`). |
| M58 | `www/js/scripts-library.js:1139,1245` | Random album: `(array[0] / 65535) * length` can equal `length` (off-by-one ~1/65536) → undefined deref. | `/ 65536` or modulo wrap. |
| M59 | `www/js/scripts-library.js:885` | Selector missing its leading dot (`lib-encoded-at-hires-badge-tagview` treated as a tag). | Add `.`. |
| M60 | `www/js/scripts-library.js:1907` | Dead check: `.album-view-button` doesn't exist (real class is `.album-view-btn`). | Fix selector. |
| M61 | `www/js/scripts-configs.js:125-128` | `location.assign('http://' + host …)` — **forces http**, downgrading HTTPS sessions (eqp/eqg paths). | Preserve `location.protocol` / relative URL. |
| M62 | `www/js/radio-browser.js:76` | `src="' + logo.replace(/&/g,'&amp;')'"` — only `&` escaped; `"`/`>` in favicon break the attribute (sibling fields use `rbEscapeHtml`). | Use `rbEscapeHtml(logo)`. |
| M63 | `www/js/radio-browser.js:361-374` | Duplicate `var target/observer` + `observe(target)` on possibly-null `querySelector` → initialization aborts when a span is missing. | Rename; null-guard. |
| M64 | `www/js/notify.js:90,167,224-229` + `osk.js:333-345` | Unguarded `SESSION.json['raspbianver'].split(' ')[1]`; implicit-global `showCloser/showSticker`; `osk` derefs `parentElement` without null check. | Guards + `var`. |

### Templates / misc

| # | Location | Finding | Fix |
|---|----------|---------|-----|
| M65 ✔ | `www/templates/snd-config.html:186` | `<div $_feat_multiroom">` — missing `class=` attribute (broken quote) → the Multirow "Configure" row is **always visible**, even when the feature is disabled. | `<div class="$_feat_multiroom">`. |
| M66 ✔ | `www/templates/lib-nas-config.html:52` | `<div id="edit-server" $_edit_server_hide">` — same class-attribute defect (block no longer hideable, malformed quote). | `<div class="$_edit_server_hide">`. |
| M67 | `www/templates/apl-config.html:199,211-217` | Copy-paste: active-state-end help link/heading uses `info-run-this-before-entering-active-state` → duplicate id makes the second help toggle the **first** text. | Rename to `after-exiting`. |
| M68 | `www/templates/chp-config.html:202` | Duplicate `id` on input (`boss2-dop-volume` + `subwvol`) — currently inside a comment block; fragile. | Remove stray duplicate. |
| M69 | `www/js/playerlib.js:3320,3324` + others (see §5 table in the JS report) | JS references dead DOM ids: `#info-clockradio-playname`, `#multiroom-receiver-volume`, `#delete-playlist-item-newpos`, `#delete-playqueue-item-newpos`, `#btn-downgrade-chromium-submit`, `#downgrade-chromium-modal`, `#one-touch-action-li`, `#import-export-msg` — feature remnants (features removed in indextpl refactor commits). | Prune dead handlers or restore ids. |
| M70 | `www/header.php:41` / `response400.html:7-13` | Stray `<` typo; `</head>` after `</body>` (invalid ordering). | Correct. |
| M71 | `www/inc/Zend/Media/Id3v2.php:212` | `ltrim($filename, '/var/lib/mpd/music/')` — charlist misuse mangles names. | `str_replace(MPD_MUSICROOT, '', …)`. |
| M72 | `www/inc/Zend/Io/Reader.php:454`, `Writer.php:287` | `private final function` — deprecation warning emitted at every Zend load (cover-art/tag operations). | Drop `final`. |
| M73 | `www/util/thumb-gen.php` main loop / `libstats.php:66-68` | Last-iteration `strtok` returns `false` (undefined-key [1] per run); `$tags['Album'/'AlbumArtist']` accessed without pre-seed → warnings. | `!== false` handling; `?? ''`. |
| M74 | `etc/php/8.4/*.sed.ini` | Deprecated PHP 8.4 directives (`opcache.fast_shutdown`, `session.sid_length`, `[Interbase]` stubs). | Prune. |

---

## 6. Low Findings (summary)

**Dead code / cosmetics (prune or fix):**
- `www/inc/mpd.php:63-74` unused locals; `mpd.php:1065` `md5(file_get_contents($path, 1024))` passes 1024 as `$use_include_path` (whole file loaded).
- `www/inc/cdsp.php:109` unused local; comment references `$this->$CAMILLA_CONFIG_DIR`.
- `www/inc/music-source.php:450,665` lowercase helper calls (PHP resolves them but inconsistent).
- `www/inc/autop.php:762,845` comment vs. `mediainfo.tpl` index mismatch (compression at [5], documented [4]); stray leading space in DSD string.
- Worker/daemon leftovers: `worker.php:*` lcd `$file` (M21), dup `$error` paths, `peppy-gain.php:45` `rtrim($v, 'dB')` strips the *d/B character set* (works today, wrong idiom — use `str_ends_with`/substr).
- `sysinfo.sh:335` prints six-channel mode under "Mixdown" (`$apl_mixdown` parsed at 623 is intended); `:968` `playlist_pos==${arr[165]}` double-`=` typo.
- `sysinfo.sh:511` / `sysutil.sh:7` / `lcd_updater.py:13` / `backup_manager.py` derive the web user with `ls /home/` — every `/home/<name>` path breaks or mis-targets when a second home dir or blank line exists.
- `www/util/start-peppy.sh:14,16` unquoted `$TYPE` in `[ ]`; missing cd error checks.
- `www/util/gen-cert.sh:9,37-38` `cat >> `/tmp/master cert config → duplicate sections on re-run; key never `chmod 600`; no error checks.
- `www/util/resizefs.sh` parted values used unrevalidated in arithmetic; fdisk result unchecked before writing the resize-once script.
- `www/gulpfile.js:198-209,589` `app/scss` paths don't exist; `$.newer()` compares against build cache not `DEPLOY_LOCATION` (stale incremental deploy behavior); `package.json:22-26` `appmain`/`appconfig` reference `xscripts-*.min.js` files that no longer exist.
- php lint artifact: `www/inc/usb.php`-style self-require oddities (`inc/alsa.php` self-require harmless), `inc/network.php:214-223` plaintext `/tmp/passphrase` window (fchmod 0600).
- Home-page/<head> leftovers: `www/inc/common.php:660-663` assumes `$lines[1]` of config.txt exists; `www/inc/common.php` `chkVariables()` fixed 3-level depth (deeper arrays TypeError).

**Stale/deprecated build config:** PHP FPM `.sed` sockets/values (also C13), systemctl stubs referencing removed features (chromium downgrade), nginx/nginx PHP-version const duplication (keep single source).

**Renderer/reporting quirks:** `upnp_albumart.py`, `itunescover.py` (no try/except around network covers; arg timeout validation); `camillaplot_pipeline.py` argv/with-block; `moode_selectactivecdspconfig.py` argv/IndexError guard; `rotenc.py` systemd unit without `Restart=`; `bluealsa-aplay@.service` without restart despite kill logic; manufacturers suppressed.

---

## 7. Verified Clean

- **Compile clean:** all 296 non-problematic PHP files (`php -l`), **all** Python files (3.12), all shell scripts (`bash -n`), all non-vendor JS (`node --check`).
- **No legacy PHP in vendored code beyond the 2 files in C1/C2** (grep-verified: no `each()`, `create_function()`, `get_magic_quotes`, old `implode()` order, `utf8_encode`, `strftime`).
- **Files read and judged clean (no action needed):** `www/inc/radio.php` (proper `escapeshellarg()` usage — the pattern other call sites should copy), `sqlUpdate/sqlDelete` escaping strategy, `engine-mpd.php` idle loop termination (readMpdResp honors timeouts), `touchmon`/`mpdmon` shell commands take no user input, `mpd-config.php` sox_multithreading inversion (0=Yes) is **intentional** and consistent with `sysinfo.sh`, `footer.min.php` includes are build artifacts (gulp-generpath etc.), and `dashboard.php`/`banner` one-off foot-noted in the notes above.

---

## 8. Remediation Plan

Ordered by risk; each phase ends with a regression-test gate.

### Phase 0 — Ship-stoppers (1–2 days, must-fix before release)
1. **C1/C2 Zend** — replace the six `$buffer{...}` accesses (`Mpeg/Object.php`); parenthesize the `VbriHeader.php` ternary and fix `$tocCount → $tocEntries`. Verify with `php -l` (must be clean) and by generating a thumbnail for an MP3 with a VBRI header.
2. **C3 genWpaPSK** — index `$result[3]`; unit-test by generating a PSK via `genWpaPSK('testssid','pass')` and correlating against direct `wpa_passphrase` output.
3. **C6 cdsp upload** — `basename()` + allowlist; regression test with `../../x.yml` as client filename (expect rejection, not a write).
4. **C9 engine-cmd timeouts** — `SO_RCVTIMEO`/`SO_SNDTIMEO` + clean exit path; soak-test 65 abandoned polls (FPM pool must not saturate; no watchdog FPM reload needed).
5. **C10 worker hardening** — early-exit/retry when `openMpdSock()` fails; `if (!$image)` guards in `set_ralogo_image`/`set_plcover_image`; add a systemd unit with `Restart=on-failure` for worker.php. Test: stop MPD and start worker (must not die); feed garbage base64 logo (must log + survive).
6. **C12/C13** — remove the NUL byte from `shellinabox.service`; sync the FPM pool socket name with the nginx config (or confirm the build tooling does).
7. **H1(H1/H2/H3) functional typos** — `audiout`→`audioout`, snd-config queueArgs, `mpd_httpd__local_audio` key.
8. **C11 shell-injection efficiently in one sweep:** harden `chkValue()` to reject `"`, `'`, `&`, `(`, `)`, newline + add an `escapeshellarg`-based helper, then convert the enumerated sinks (C4.1-C4.11, C8, `station_manager` os.system — convert to `subprocess.run([...])`; `backup_manager` sed → Python rewrite).

### Phase 1 — Data-integrity & correctness (week 1-2)
1. **C5 SQLi:** pre.s `sqlRead()` args through `SQLite3::escapeString()` (mirror sqlUpdate) and add `'` to `chkSQL()`; audit `sqlUpdate/sqlDelete` callers for raw content. ✔ verified with `command/cfg-table.php` `theme_name` injection test.
2. **C7 coverart.php traversal** — `realpath()` containment checks.
3. **C8 station_manager import containment** — reject `/`, `..`, `\0` in names; parameterized SQL (M28).
4. **H5–H12 logic fixes:** queue.php TimeMMSS ordering; cdsp configFile-save/pipeline unset; alsa `$result[0]`; worker `==`/`=` batch; address/Multicast dead statement; renderer-onoff boolean.
5. **H13 Zend Id3v2 path resolution** (`stream_resolve_include_path`); stop referencing `workerLog()` when `common.php` may be absent.
6. **H16 lcd-updater** — switch to directory-watch; regression test cover-update in the LCD flow.
7. **DB layer:** `sqlConnect()` `busy_timeout` + WAL + explicit `ERRMODE_EXCEPTION` with try/catch; change `sqlQuery()` zero-row return to `array()`; fix consumers (`grep -l "$result\[0\]"`), kill `$result['value']` row-indexing class (H8).
8. **H18/H19 JS engine resilience:** `var i` in `updateSavedSearchModal`; try/catch + `finally` reissue in `engineCmd()`.
9. **H20-/H21 XSS + library filters:** escape at sinks; fix `heading-key` mismatch and comparison tracing (albums like "Simon & Garfunkel" must resolve).

### Phase 2 — UX features and correctness (week 2-4)
1. **M-class batch** — normalize `===`, isset guards, initializations per file; especially `worker.php` (M19-M23), engine-mpd `$state`/`$resp` (M18), `sysinfo.sh` `[129]` (H24), template `class=` fixes (M65-67) and dead-selector cleanup (M69).
2. **Renderer + renderer state flows** — `paactive` polarity (H9), `renderer-onoff` validation (H15), `spotevent.sh` play state (M31).
3. **Idle-copy class fixes:** M5 (`==` vs `=`), M47 itemInfoModal condition, `disableVolKnob`, playlistPos typo (M55).
4. **Camilla/CDSP** — `getQuickConvolutionConfig` (H6), `setPlaybackDevice` keys (H7), `cdsp_volume_update.py` `yaml.safe_load` + None fallbacks (M29), selectactivecdspconfig guard.
5. **Radio covers** — radiocover_plus LOG_LEVEL (H22), flock `LOCK_NB`, unreachable branch; aplmeta robustness (M34).
6. **Availability patterns** — watchdog curl timeouts (M36), updater unzip checks (M35), busy-timeout side (already Phase 1), port-file atomic rewrite + exact-match sed (H26), `waitWorker` cap (H27), worker session lock release around sleeps (H28).

### Phase 3 — Hygiene & tooling (week 4+)
1. **CSRF tokens** (M42) on all POST handlers.
2. Prune dead code and dead DOM ids (M69), fix `gulpfile` stray paths + `package.json` stale entries, `header.php`/`response400.html` HTML hygiene (M70), `chkXSS` policy decision (M2), README-level note of the `alsa.php` self-require.
3. **CI gates:** add a lint job (`php -l` all; `python -m compileall`; `bash -n`; `node --check`) — this review's C1/C2 would have been caught immediately; add greps for `$buffer{`, `== '0';`, and `move_uploaded_file(..., . \$_FILES` patterns as guard rails.
4. Consider bumping the low-hanging PHP 8.4 compat items listed in M72/M74 at the same time as any future Zend refresh.

### Validation matrix (per phase)

- `php -l` zero exit across the tree; `python -m compileall` clean; `node --check` clean.
- Functional: hotspot PSK; Local-audio-with-HTTP stream; device change restart; Saved Search modal; queue rendering with `.cue` files, stops, and root-relative file paths; playlist rename with `&` characters; LCD cover update after title change; cover lookup for CAA/itunes/archive.org and missing-art; import of a station backup containing malicious names (must reject).
- Security probes: `coverart.php/../../../etc/passwd`; `cfg-table.php?theme_name=x'`; cdsp filename `../x`; bluetooth device name with `"`; NAS address `1.1.1.1;touch /tmp/pwn` (mountmon, expect validation error only).

---

## 9. Appendix — review artifacts

- Static checks run: `php -l 8.4.26` (2 failures, C1/C2), `python3 -m compileall` (clean), `bash -n` (clean), `node --check` (clean).
- Findings consolidated from per-area deep reviews of: `www/inc/*.php`, engines/daemons (`engine-*.php`, `daemon/worker.php` + monitors), `www/*.php` config UI + `www/util/*.php`, `www/js/*.js`, python+shell utils, templates/Zend/config files.
- Highest-severity class differences were cross-checked by the review author before publication: C3 (`wpa_passphrase` output indexing), C10 (worker false-socket path), C12 (od -c of the unit file), C13 (grep of pool/nginx configs), H1/H2/H3/H4, H6, H8 (`sqlQuery` shape), H16 (worker `rename()` vs inotify), H18 (strict-mode + `for (i`), M65/M66 (template `class`), radiocover_plus LOG_LEVEL, `station_manager` `except Error`.
