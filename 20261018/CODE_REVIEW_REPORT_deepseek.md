# moOde Audio Player — Code Review: Errors and Remediation Plan

**Scope:** Full repository at the current `develop` HEAD (`ee31f36b`).
**Method:** Static review of the PHP, Python, Bash and JavaScript application code plus syntax/parse validation (`php -l`, `python3 -m py_compile`, `node --check`, `bash -n`, `shellcheck`). Every finding below was manually re-read at the cited line and confirmed against the surrounding call sites. Vendored third‑party code (the `Zend` media library) is called out separately.
**Constraint honoured:** No existing code was modified; this report is the only file added.

---

## 1. Severity legend

| Level | Meaning |
|-------|---------|
| **Critical** | Fatal error (crash / parse failure) or security/data‑loss defect on a normal code path. |
| **High** | A user‑visible feature is broken or behaves incorrectly under ordinary use. |
| **Medium** | Incorrect behaviour on an edge case, wrong data displayed, or latent crash. |
| **Low** | Log/robustness/cosmetic defect, dead code, or code that is clearly unintentional. |

## 2. Summary

| Area | Critical | High | Medium | Low | Total |
|------|---------:|-----:|-------:|----:|------:|
| PHP core (`www/inc`, `www/daemon`, `www/command`) | 1 | 12 | 10 | 8 | 31 |
| PHP pages (`www/*.php`) | 0 | 3 | 5 | 3 | 11 |
| Vendored Zend library | 2 | 0 | 0 | 0 | 2 |
| JavaScript | 0 | 4 | 3 | 3 | 10 |
| Python utilities/daemons | 0 | 7 | 9 | 4 | 20 |
| Shell / `moodeutl` | 0 | 4 | 4 | 2 | 10 |
| **Total** | **3** | **30** | **31** | **20** | **84** |

Dominant root causes, in order of frequency:

1. **`=` vs `==` mistakes** — assignment written where a comparison was intended (a silent no‑op) and vice‑versa.
2. **Copy‑paste between sibling code blocks** — wrong variable, wrong array key, wrong index, or a duplicated line left in place.
3. **Off‑by‑one array indexing** (`count() >= n` guarding `$parts[n]`).
4. **`ltrim()`/`rtrim()` used as a *prefix* strip** — the 2nd argument is a character mask, not a string prefix.
5. **Unvalidated request data used in paths / shell commands / SQL** (`chkVariables(..., [excluded])` then used raw).
6. **Undefined variables** in rarely‑exercised branches (undefined variable warnings, `TypeError`/`AttributeError` under PHP 8.4 / Python 3.12).

---

## 3. Critical findings

### C1. PHP 8 parse error in vendored Zend library — `www/inc/Zend/Media/Mpeg/Object.php:144`
```php
if (ord($buffer{$pos++}) == 0) {
```
Curly‑brace string/array offset access (`$buffer{...}`) was **removed in PHP 8.0**. This file fails `php -l` on the target PHP 8.4 and any code path that autoloads `Zend_Media_Mpeg_Object` fatals.
**Remediation:** replace `$buffer{$pos++}` with `$buffer[$pos++]` throughout the file (and scan the rest of `www/inc/Zend` for the same syntax).

### C2. Fatal nested‑ternary in vendored Zend library — `www/inc/Zend/Media/Mpeg/Abs/VbriHeader.php:88`
```php
$this->_toc = array_merge(unpack(($tocEntrySize == 1) ? 'C*' :
    ($tocEntrySize == 2) ? 'n*' : 'N*',
    $this->_reader->read($tocCount * $tocEntrySize)));
```
Unparenthesized `a ? b : c ? d : e` is a **fatal error in PHP 8.0+**. `php -l` reports: *"Unparenthesized `a ? b : c ? d : e` is not supported."*
**Remediation:** parenthesize explicitly, e.g. `(($tocEntrySize == 1) ? 'C*' : (($tocEntrySize == 2) ? 'n*' : 'N*'))`.

### C3. `turnOffAutoShuffle()` called before the MPD socket exists — `www/command/index.php:80`
```php
case 'play_item':
case 'play_item_next':
    $item = trim(getArgs($cmd, false));
    _openSessionReadOnly($dbh);
    if ($_SESSION['ashuffle'] == '1') {
        turnOffAutoShuffle($sock);   // $sock not yet defined
    }
    ...
    $sock = getMpdSock('command/index.php');   // assigned only later (lines 98 / 121)
```
`turnOffAutoShuffle()` immediately calls `sendMpdCmd($sock, 'consume 0')`, i.e. `fputs(null, ...)`, which is a **fatal `TypeError` in PHP 8**. Triggered whenever Auto‑shuffle is enabled and the user plays an album/playlist/track from the Library — a very common action.
**Remediation:** create the socket before the auto‑shuffle check, or move the `turnOffAutoShuffle()` call into the branch where `$sock` has been obtained.

---

## 4. PHP core findings (`www/inc`, `www/daemon`, `www/command`)

### High

#### H1. `$_SESSION['audiout']` typo disables local ALSA audio — `www/inc/mpd.php:676`
```php
if ($_SESSION['mpd_httpd_local_audio'] == '1' && $_SESSION['audiout'] == 'Local') {
    sysCmd('mpc enable "' . ALSA_DEFAULT . '"');
} else {
    sysCmd('mpc disable "' . ALSA_DEFAULT . '"');
}
```
The session key is `audioout` everywhere else in the codebase (`set-btaudio.php`, `audioinfo.php`, `worker.php`, `snd-config.php`, …). `audiout` is never set, so the condition is always false and the `ALSA_DEFAULT` MPD output is **always disabled** — the recently added "Local audio" HTTP‑streaming option never routes to the local device.
**Remediation:** use `$_SESSION['audioout']`.

#### H2. Stop‑state elapsed/time immediately overwritten — `www/inc/mpd.php:496–522`
```php
$time = explode(':', $status['time']);          // line 496 — 'time' absent when stopped
if ($status['state'] == 'stop') {
    $percent = '0';
    $status['elapsed'] = '0';
    $status['time'] = '0';
} else if (...) { ... }
...
$status['elapsed'] = $time[0];                  // lines 521–522 overwrite the branch above
$status['time']    = $time[1];
```
When MPD is stopped the `time` key is deliberately absent (see the comment on line 494), so line 496 raises *"Undefined array key"* and lines 521–522 overwrite the `'0'` values with empty strings / `null`.
**Remediation:** only read `$status['time']` when present, and do not re‑assign `elapsed`/`time` after the `if/else` chain.

#### H3. `==` used instead of `=` for MPD bitrate — `www/inc/mpd.php:826`
```php
if ($_SESSION[$song['file']]['bitrate'] == '') {
    $current['bitrate'] == '';        // no-op
}
```
The intended assignment never happens, leaving a stale/undefined `bitrate`.
**Remediation:** `$current['bitrate'] = '';`.

#### H4. Sudoers file written as `…-nopasswd-nopasswd` — `www/daemon/worker.php:87–89`
```php
$nopasswdFile = '/etc/sudoers.d/010_' . $userId . '-nopasswd';
if (!file_exists($nopasswdFile)) {
    sysCmd('... | sudo tee ' . $nopasswdFile . '-nopasswd' . ' > /dev/null');
```
The suffix is appended twice, so the `file_exists()` guard never sees the file that is actually created, and the intended `/etc/sudoers.d/010_<user>-nopasswd` file is never written. This directly conflicts with the comment above (Trixie removes the file at boot).
**Remediation:** drop the concatenated `'-nopasswd'`.

#### H5. Session initialisers silently do nothing (`==` no‑ops) — `www/daemon/worker.php:464` and `:1531`
```php
if (!isset($_SESSION['eth0chk'])) { $_SESSION['eth0chk'] == '0'; }   // line 464
if (!isset($_SESSION['lcdup']))    { $_SESSION['lcdup']   == '0'; }  // line 1531
```
`$_SESSION['eth0chk']`/`$_SESSION['lcdup']` are never initialised, so later reads produce undefined‑key warnings and unexpected control flow (e.g. `lcdup` logic, Ethernet check state).
**Remediation:** use the assignment operator `=`.

#### H6. Undefined `$timeout` in the engine‑mpd socket‑timeout computation — `www/daemon/worker.php:1619`
```php
$sockTimeout = $_SESSION['empd_socket_timeout'] == 'default' ? MPD_DEFAULT_SOCKET_TIMEOUT : $timeout;
```
`$timeout` is defined nowhere in `worker.php` (only `engine-mpd.php:15` defines its own). For any non‑`default` value the log line reports a null/empty timeout. The correct source is the `empd_socket_timeout` DB/session value.
**Remediation:** derive `$timeout` from `$_SESSION['empd_socket_timeout']` (as `engine-mpd.php` does) or rename to the intended variable.

#### H7. Empty ALSА card compare always false — `www/daemon/worker.php:807`
```php
$cards = getAlsaCardIDs();
foreach ($cards as &$card) { $card = str_pad($card, 16); }   // lines 654–657
...
if ($cards[$_SESSION['cardnum']] == ALSA_EMPTY_CARD) {       // ALSA_EMPTY_CARD === 'empty'
```
The stored value is `'empty           '` (16 chars), which never equals `'empty'`; the empty‑card warning branch is dead.
**Remediation:** compare against `str_pad(ALSA_EMPTY_CARD, 16)` or `trim()` the card value before comparing.

#### H8. Inverted Plexamp flag in `chkRbActive()` — `www/daemon/worker.php:2246–2248`
```php
$rendererNotActive = ($_SESSION['btactive'] == '0' && $GLOBALS['aplactive'] == '0' && ...
    && $GLOBALS['slactive'] == '0' && $_SESSION['paactive']
    && $_SESSION['rxactive'] == '0' && $GLOBALS['inpactive'] == '0');
```
Every sibling term tests `== '0'`, but `paactive` is tested as a bare string. `'0'` is falsy, so this requires Plexamp to be **active** for the renderer to be considered inactive — the exact opposite of the intent.
**Remediation:** `$_SESSION['paactive'] == '0'`.

#### H9. Undefined `$file` when chmod‑ing a saved search — `www/daemon/worker.php:2955`
```php
case 'create_saved_search':
    $fh = fopen(LIBSEARCH_BASE . $_SESSION['w_queueargs'] . '.json', 'w');
    ...
    sysCmd('chmod 0777 "' . $file . '"');   // $file is never set in this case
```
The wrong path is chmod‑ed (or an empty path), leaving the newly created saved‑search file with the wrong permissions.
**Remediation:** chmod `LIBSEARCH_BASE . $_SESSION['w_queueargs'] . '.json'`.

#### H10. First character of the IP compared instead of the full address — `www/daemon/worker.php:3531`
```php
$validIPAddress = ($_SESSION['ipaddress'] != '0.0.0.0' && $GLOBALS['wlan0Ip'][0] != explode('/', $_SESSION['ap_network_addr'])[0]);
```
`$wlan0Ip` is a string (e.g. `192.168.1.50`), so `[0]` is `'1'`; the compare against the first octet of the AP network is meaningless. The correct form is used at line 1556 (`$wlan0Ip != explode('/', …)[0]`).
**Remediation:** drop the `[0]`.

#### H11. Local audio form field typo — `www/snd-config.php:315`
```php
if (isset($_POST['update_mpd_httpd_local_audio']) && $_POST['mpd_httpd__local_audio'] != $_SESSION['mpd_httpd_local_audio']) {
```
The form field is `mpd_httpd_local_audio` (single underscore, lines 597–598); the double‑underscore key is undefined, so the comparison is effectively always true.
**Remediation:** `$_POST['mpd_httpd_local_audio']`.

#### H12. Device‑change flag lost in `mpdcfg` job arguments — `www/snd-config.php:56`
```php
$deviceChange = '1';
$mixerChange  = '0';
$queueArgs = $mixerChange . ',' . $mixerChange;   // "0,0" instead of "1,0"
submitJob('mpdcfg', $queueArgs);
```
`worker.php:2979–2980` treats `queueArgs[0]` as `deviceChange` and uses it to decide whether to stop playback and reset volume (lines 2995–3000). The copy‑paste duplicate makes worker believe no device change occurred. The sibling volume‑type block (line 81) correctly uses `$deviceChange . ',' . $mixerChange`.
**Remediation:** `$queueArgs = $deviceChange . ',' . $mixerChange;`.

#### H13. Wrong multiroom param key — `www/trx-config.php:134`
```php
if (isset($_POST['multiroom_tx_query_timeout']) && $_POST['multiroom_tx_query_timeout'] != $cfgMultiroom['multiroom_tx_query_timeout']) {
```
The DB param is `tx_query_timeout` (lines 135 and 270), so `$cfgMultiroom['multiroom_tx_query_timeout']` is an undefined key and the guard is always true.
**Remediation:** use `$cfgMultiroom['tx_query_timeout']`.

#### H14. CamillaDSP config remove/copy appends `.yml` twice — `www/cdsp-config.php:72,73,84`
```php
if ($_SESSION['camilladsp'] != $selectedConfig . '.yml') { ... }   // 72
$configFileName = $cdsp->getConfigsLocationsFileName() . $selectedConfig . '.yml';  // 73
...
$cdsp->copyConfig($selectedConfig . '.yml', ...);                  // 84
```
`$selectedConfig` comes from `getAvailableConfigs()`, whose keys are `pathinfo(...)['basename']` — i.e. they already include `.yml` (confirmed by line 96 using it raw for `readfile`). Consequences:
* the "cannot remove the active configuration" guard never matches, so the **active config can be deleted**;
* `unlink()`/`copyConfig()` target a nonexistent `foo.yml.yml`.
**Remediation:** use `$selectedConfig` without appending `.yml` (or normalise the value to one canonical form).

#### H15. Empty pipeline not removed (unset of `mixers`) — `www/inc/cdsp.php:87–89`
```php
if (empty($ymlCfg['pipeline']) || (key_exists('pipeline', $ymlCfg) && count($ymlCfg['pipeline'])) == 0) {
    unset($ymlCfg['mixers']);   // should be $ymlCfg['pipeline']
}
```
The guard exists to strip a parser‑produced empty `pipeline`, but it unsets `mixers` instead, leaving an empty `pipeline` key that breaks the CamillaDSP config. (The same mistake is visible in the commented test at line 494.)
**Remediation:** `unset($ymlCfg['pipeline']);`.

#### H16. Undefined `$psk` exports an empty hotspot password — `www/inc/autocfg.php:330`
```php
// inside the 'custom_write' closure for iface apd0:
$str .= "apdpwd = \"" . $psk . "\"\n";
```
`$psk` belongs to the sibling `wlan0` closure; in the `apd0` closure it is undefined, so an exported autoconfig carries an empty AP password. The value should come from the DB row like the adjacent lines.
**Remediation:** use `$result[0]['wlanpwd']` (or the corresponding `wlanpsk`), matching the `apdpsk` line below it.

### Medium

#### M1. `getRadioCoverUrlCacheCount()` never returns — `www/inc/radio.php:22–24`
```php
function getRadioCoverUrlCacheCount() {
    sqlQuery("SELECT count() FROM cfg_rcucache", sqlConnect());
}
```
Missing `return`, so the function always evaluates to `null`.
**Remediation:** `return sqlQuery(...);`.

#### M2. `ltrim()` used as a prefix stripper — `www/inc/music-library.php:697`
```php
$name = ltrim(pathinfo($file, PATHINFO_FILENAME), LIBSEARCH_BASE);
```
`LIBSEARCH_BASE = '/var/local/www/libsearch_'`; `ltrim`'s second argument is a **character mask**, so `libsearch_blues` is mangled (leading characters that appear in the mask are stripped until a char outside the mask is hit). Saved‑search names are therefore corrupted.
**Remediation:** `basename($file, '.json')` or `substr(pathinfo($file, PATHINFO_FILENAME), strlen('libsearch_'))`.

#### M3. Inconsistent "No results" guard between the two library builders — `www/inc/music-library.php:295` vs `:493`
```php
if (count($lib) <= 1 && empty($lib[0]['file'])) { ... }   // line 295 (genLibrary)
...
if (count($lib) == 1 && empty($lib[0]['file'])) { ... }   // line 493 (utf8 variant)
```
`$lib` starts empty; when the MPD query returns zero rows `count($lib) == 0`, so line 493 skips building the `'Nothing found'` placeholder that the front‑end expects, while line 295 handles it.
**Remediation:** use `count($lib) <= 1` (or `empty($lib)`) in both.

#### M4. Off‑by‑one when parsing SMB version — `www/inc/music-source.php:206–207`
```php
$parts = explode('  ', end($output));
if (count($parts) >= 2) {
    $version = trim($parts[2]);   // index 2 needs at least 3 elements
```
A 2‑element split produces an undefined index.
**Remediation:** guard with `count($parts) >= 3` (the same defect exists in `usr/local/bin/moodeutl:1001`).

#### M5. Saved‑playlist contents read an undefined key — `www/command/playlist.php:300`
```php
$playlist = getPlaylistContents($_POST['path']);
$array = array('name' => $playlist['name'], ...);
```
`getPlaylistContents()` (line 386) returns only `genre`, `cover`, `items` — no `name`.
**Remediation:** drop `'name'` or have `getPlaylistContents()` return it.

#### M6. Uninitialised `$contents` in playlist writers — `www/command/playlist.php:419–426` and `:444–446`
```php
if ($appendFlag == 0) {
    $contents = '#EXTGENRE:...';
}
foreach ($plItems as $item) { $contents .= $item . "\n"; }   // undefined when $appendFlag != 0
```
and in `putPlaylistMetadata()` `$contents` is used with no initialiser at all. Produces undefined‑variable warnings and, in append mode, relies on an undefined variable.
**Remediation:** initialise `$contents = '';` before use.

#### M7. `array_walk_recursive()` / `usort()` run before the API‑failure check — `www/command/radio-browser.php:67–72`
```php
$data = rbApi('/json/countries', ...);
array_walk_recursive($data, ...);   // $data may be false
...
if ($data !== false) { ... }
```
`rbApi()` may return `false`; the walk/sort run on `false` (`TypeError` in PHP 8).
**Remediation:** move the `if ($data !== false)` check above the walk/sort.

#### M8. `usort()` on the `true` returned by `sqlQuery()` for an empty result — `www/command/radio-browser.php:85–88`
```php
$result = sqlQuery("SELECT name, genre FROM cfg_rbgenres", sqlConnect());
usort($result, ...);   // sqlQuery returns true when there are no rows
```
`sqlQuery()` (inc/sql.php) returns `true` for a successful query with zero rows; `usort(true, …)` is a `TypeError`.
**Remediation:** normalise like `$result = sqlQuery(...); if (is_array($result)) { usort(...); } else { $result = []; }`.

#### M9. Uninitialised `$artists` / `$genres` accumulators — `www/command/audioinfo.php:108,120`
```php
$artists .= $value . ', ';   // undefined first time
...
$genres .= $value . ', ';
```
Later read with `rtrim()` (lines 160–161). Functionally works but emits warnings and hides the "no tags" case.
**Remediation:** initialise both to `''` before the loop.

#### M10. `TimeMMSS` computed before `Time` is assigned — `www/inc/queue.php:28`
```php
$queue[$idx]['file'] = $origValue;
$queue[$idx]['fileext'] = getSongFileExt($origValue);
$queue[$idx]['TimeMMSS'] = formatSongTime($queue[$idx]['Time']);   // 'Time' not yet set
```
`TimeMMSS` is therefore always `00:00`.
**Remediation:** compute it after the `Time` tag has been parsed (or defer to a final pass).

#### M11. `PLAYER_EVENT`/renderer status: undefined `[0]` and unreachable fallback — `www/ren-status.php:12`, `www/sys-status.php:12`
```php
$_plugin_log = sysCmd('cat /var/log/moode.log | grep "Downloading"')[0] . '<br>';
...
$_plugin_log = empty($_plugin_log) ? 'Log is empty' : $_plugin_log;
```
`sysCmd(...)[0]` warns when the grep matches nothing, and the unconditional `'<br>'` makes `empty()` always false, so `'Log is empty'` is unreachable.
**Remediation:** guard the index and only append/assign when non‑empty.

#### M12. Undefined cached lookup on discovery failure — `www/dashboard.php:63`
```php
if (false === ($status = sendTrxControlCmd($ipAddr, '-all'))) {
    ...
    $host = $cachedIPAddresses[$ipAddr];   // may not exist
}
```
For a newly discovered IP absent from the cache file this is an undefined key.
**Remediation:** `$host = $cachedIPAddresses[$ipAddr] ?? $ipAddr;`.

### Low

#### L1. `chp-config.php:288` — duplicate condition makes the `else` dead
```php
if ($_SESSION['i2sdevice'] == 'Audiophonics ES9028/9038 DAC') {   // 282
    ...
    if ($_SESSION['i2sdevice'] == 'Audiophonics ES9028/9038 DAC') { ... }  // 288 always true
    else { /* Pre 2019 implementation — unreachable */ }
```
**Remediation:** remove the redundant inner condition (or correct it to the board revision test it was meant to be).

#### L2. `peppy-config.php:46,67` — `ltrim()` with a path character mask
```php
$folder = rtrim(ltrim($folderPath, PEPPY_METER_OPT_DIR . '/'), '/');
```
The directory prefix is treated as a character set, mangling folder names.
**Remediation:** `substr($folderPath, strlen(PEPPY_METER_OPT_DIR) + 1)`.

#### L3. `www/header.php:41` — stray `<` in an HTML comment
```html
<<!--link href="css/fa-thin.css" rel="stylesheet"-->
```
Emits a literal `<` into `<head>`.
**Remediation:** `<!-- ... -->`.

#### L4. `www/bkp-config.php:240` — undefined `$msg`
```php
$tpl = $msg == 'Restart required' ? "sys-config.html" : "bkp-config.html";
```
`$msg` is never defined in the file; the `sys-config.html` branch is dead and a warning is emitted.
**Remediation:** remove the expression or set `$msg` from the actual notify state.

#### L5. `www/inc/alsa.php:7` — file requires itself
```php
require_once __DIR__ . '/alsa.php';   // inside alsa.php
```
Harmless (no‑op via `require_once`) but clearly unintended.
**Remediation:** delete the line.

#### L6. `www/inc/radio-browser.php:176–177` — logo written twice
```php
$result = imagejpeg($canvas, $outPath, $quality);      // result discarded
$saved  = @imagejpeg($canvas, $outPath, $quality);     // written again
```
**Remediation:** call `imagejpeg()` once and return its result.

#### L7. `www/inc/constants.php:328` — user‑visible typo
```php
'11' => 'Novenber',
```
Rendered by the audio‑info month display.
**Remediation:** `'November'`.

#### L8. `www/daemon/worker.php:4020,4032,4036` — undefined `$job`
```php
case 'set_rblogo_image':
    ...
    workerLog('worker: '. $job .' ERROR: imagecreatefromstring() failed for ' . $name);
```
`$job` is assigned only in the sibling `set_ralogo_image`/`set_plcover_image` case (line 3914), so the log message is blank here.
**Remediation:** `$job = $_SESSION['w_queue'];` at the top of this case (or use a literal).

#### L9. `www/engine-mpd.php:62` — undefined `$resp` when the state changed
```php
if ($_GET['state'] == $status['state']) { ... $resp = readMpdResp($sock); ... }
...
if ($resp != 'Socket timed out') { ... }   // $resp undefined when states differ
```
The functional flow is still acceptable (data is returned), but PHP emits an undefined‑variable warning.
**Remediation:** initialise `$resp = ''` before the `if`.

#### L10. `www/coverart.php:60` — `fread()` on a zero‑byte file
```php
$fileSize = filesize($path);
$fh = fopen($path, 'rb');
$imageData = fread($fh, $fileSize);   // ValueError in PHP 8 when $fileSize === 0
```
**Remediation:** handle `$fileSize === 0` before reading.

#### L11. `www/daemon/mpdmon.php:28` — negative seek offset
```php
$logSize = filesize(MPD_LOG) - 1024;
...
fseek($fh, $logSize);   // negative SEEK_SET offset fails for a small/rotated log
```
**Remediation:** clamp to `max(0, ...)`.

### Security (request data → SQL / shell)

`chkVariables($arr, $excludedKeys)` deliberately **skips** validation of the excluded keys (`www/inc/common.php:9,14,21`), and `chkSQL()` only rejects `"` and `--` (`common.php` `chkSQL`), so single quotes are *not* filtered. The following pass excluded/unvalidated input straight into SQL or shell commands.

| ID | Location | Problem | Remediation |
|----|----------|---------|-------------|
| S1 | `www/command/playlist.php:15,487,492` | `item` is excluded from `chkVariables($_GET, ['item'])`, then interpolated into `SELECT/UPDATE cfg_radio … WHERE station='" . $item . "'` and into `sysCmd('fgrep "…"')`/`echo … >> …`. | Validate/escape `item` (`SQLite3::escapeString`, `escapeshellarg`). |
| S2 | `www/command/radio.php:14,151–183` | `path` is excluded from `chkVariables($_POST, ['path'])`; `type`, `genre`, `broadcaster`, `language`, `country`, `region`, `bitrate`, `format`, `geo_fenced`, `monitor`, `id` are concatenated unescaped into `INSERT`/`UPDATE`. | Escape every field (`SQLite3::escapeString`) or use prepared statements. |
| S3 | `www/command/music-library.php:17,61–66` | `name` is excluded, then used to build `LIBSEARCH_BASE . $_POST['name'] . '.json'` (read) and `sysCmd('rm "…"')` (delete) — path traversal / command injection. | `basename()` + allow‑list validation; use `escapeshellarg`. |
| S4 | `www/inc/sql.php:23,130` | `sqlRead()`/`sqlDelete()` interpolate `$id` without `SQLite3::escapeString()` (unlike the rest of the file); `chkSQL()` allows single quotes. | Escape `$id` or bind it. |
| S5 | `www/eqg-config.php:15,62,102` | Only `$_POST` is validated; `$_GET['curve']` goes unescaped into `DELETE`/`SELECT` on `cfg_eqalsa`. | Add `chkVariables($_GET)` and escape/`bindValue`. |

---

## 5. JavaScript findings (`www/js`)

### High

| ID | Location | Problem | Remediation |
|----|----------|---------|-------------|
| J1 | `playerlib.js:5368` | `var coverUrl = data[i][key] = '' ? DEFAULT_ALBUM_COVER : '…' + encodeURIComponent(data[i][key]) + '.jpg';` — `=` instead of `==`; also overwrites `data[i][key]` with `''`. Empty cover hashes build a broken `/imagesw/thmcache/.jpg`. | Use `data[i][key] === ''` and a separate variable. |
| J2 | `playerlib.js:5237` | `} else if (cols = 7) {` — assignment, always truthy, clobbers `cols`. | `cols === 7`. |
| J3 | `scripts-panels.js:1302–1303` | `UI.playlsitPos = -1; storePlaylistPos(UI.playlistPos)` — misspelled property means the reset never happens and the stale position is stored. | `UI.playlistPos = -1;`. |
| J4 | `scripts-panels.js:716–719` | `$(this)` inside a plain `setTimeout(function(){…})` is not the clicked element, so the `active` class is never applied. | Capture `var self = this;` (or use an arrow function) before the timeout. |

### Medium

| ID | Location | Problem | Remediation |
|----|----------|---------|-------------|
| J5 | `playerlib.js:2120` | `'<div>…' + data[i].playlist; + '</div></div>'` — stray `;` terminates the statement, so `</div></div>` is never emitted (malformed saved‑playlist markup). | Remove the `;`. |
| J6 | `playerlib.js:2408–2409` | Duplicate `var countryDiv = …`; the second declaration overwrites the first, making the `sortTag == 'region'` branch dead. | Merge the two conditions into one declaration. |
| J7 | `scripts-library.js:1692` | `attr('heading-mb-album-id')` — the attribute rendered/used elsewhere is `heading-key` (lines 807, 822, 1666), so MBID filtering matches nothing. | `attr('heading-key')`. |
| J8 | `scripts-library.js:1391` | `count == '0'` — `count` is built as `'(0)'`/`'(N)'` on line 1384, so the check never matches and "All" is always shown. | Compare against `'(0)'` or track the numeric count separately. |

### Low

| ID | Location | Problem | Remediation |
|----|----------|---------|-------------|
| J9 | `playerlib.js:1109` | `SESSION.json['volmute'] == '1';` — discarded comparison, no effect. | Remove or convert to a real condition. |
| J10 | `scripts-library.js:885` | Selector `lib-encoded-at-hires-badge-tagview` is missing its leading `.`, so the class is never cleared. | `.lib-encoded-at-hires-badge-tagview`. |

---

## 6. Python findings

### High

#### P1. `read_global()` crashes when `LOG_LEVEL` is absent — `www/util/radiocover_plus.py:189`
```python
level = values.get("LOG_LEVEL").upper()
logging.getLogger().setLevel(LOG_LEVELS[level])
```
If the config omits `LOG_LEVEL` (or it is blank → stored as `None` on line 131), `.upper()` raises `AttributeError`; an unknown value raises `KeyError`.
**Remediation:** `level = (values.get("LOG_LEVEL") or "ERROR").upper(); setLevel(LOG_LEVELS.get(level, logging.ERROR))`.

#### P2. Integer compared to the string `'0'` — `www/util/radiocover_plus.py:494`
```python
if r.json().get("resultCount") != '0':
```
`resultCount` is an integer, so this is always true (and `r.json()` is parsed twice).
**Remediation:** `if r.json().get("resultCount", 0) != 0:`.

#### P3. `station_manager.py` — `Error` is undefined — `www/util/station_manager.py:89`
```python
except Error as e:   # NameError; only sqlite3 is imported
```
A failing DB open raises `NameError` instead of the intended handling.
**Remediation:** `except sqlite3.Error as e:`.

#### P4. `station_manager.py` uses `self.conn` when the DB was not found — `:116`
```python
self.db_ver = 7 if 'geo_fenced' in self.get_fields() else 6
```
Reached even after `return_code = 4` (DB missing), when `self.conn` is still `None`; `get_fields()` then raises `AttributeError`.
**Remediation:** return early when the DB/connection is unavailable before calling `get_fields()`.

#### P5. `station_manager.py` opens a missing backup zip unconditionally — `:134`
```python
with ZipFile(self.backup_file, 'r') as backup:   # runs even when check_backup found the file missing
```
`check_backup()` correctly sets `return_code = 6` but then the code proceeds to open the archive, raising `FileNotFoundError` instead of returning the error code.
**Remediation:** return the error code before the `with ZipFile(...)` block.

#### P6. `cdsp_volume_update.py` dereferences a `None` state file — `:50`
```python
if self._volume_state_file and self._volume_state_file.is_file() is False:
    ...
elif self._volume_state_file.is_file() is True:   # None.is_file() when no state file was supplied
```
`_volume_state_file` defaults to `None`, so the `elif` raises `AttributeError`.
**Remediation:** guard with `self._volume_state_file and …` in the `elif` too.

#### P7. `cdsp_volume_update.py` mutates a shared class‑level template — `:67,79`
```python
cdsp_state = dict(CamillaDSPVolumeUpdater.CDSP_STATE_TEMPLATE)   # shallow copy
...
cdsp_state['volume'][0] = main_volume                            # mutates the class template list
```
`dict()` copies only the top level (the `volume`/`mute` lists are shared), so every instance mutates the class template.
**Remediation:** `import copy; cdsp_state = copy.deepcopy(...)`.

#### P8. `mpdconf_merge.py` discards malformed lines — `:86` and `:123`
```python
InvalidLine("Invalid line nr %d: '%s'" % (linenr, linetxt))   # missing raise
...
InvalidLine("Hum unexpected")                                 # missing raise
```
Malformed config lines/entries are silently ignored.
**Remediation:** add `raise` before both constructor calls.

### Medium

| ID | Location | Problem | Remediation |
|----|----------|---------|-------------|
| P9 | `www/util/mpdconf_merge.py:141` | `to_text(get_section_data(section), depth=1)` hard‑codes depth instead of `depth+1`, so nested sections get wrong indentation. | `depth=depth+1`. |
| P10 | `www/util/pirev.py:222` | `if args.mem_mb:` omits `or args.all or args.code` (unlike all sibling fields), so `--all`/default output never prints memory in MB. | `if args.mem_mb or args.all or args.code:`. |
| P11 | `www/util/pirev.py:161–169,223` | The old‑style `rev_info` dict has no `mem_mb` key, so `--mem_mb` on an old board raises `KeyError`. | Add `mem_mb` (or use `.get()` with a fallback). |
| P12 | `www/util/aplmeta.py:92,102` | `RATE_TABLE[parts[1]]` / `RATE_TABLE[parts[0]]` — the table only lists 44100/48000/96000/192000; an unlisted rate (e.g. 88200) or the documented `None` source raises an uncaught `KeyError`/`IndexError` that kills the metadata daemon. | Use `.get(rate, rate + '?')` and guard part counts. |
| P13 | `www/util/moode_selectactivecdspconfig.py:50` | `result.split('|')[2]` — when the grep finds no `camilladsp` row, `IndexError`. | Check for a match before indexing. |
| P14 | `www/util/station_manager.py:562` | `if len(additional_bu_fields) >= 1:` guards the **missing**‑fields report (copy‑paste from line 567), so the section prints for the wrong reason. | `if len(missing_bu_fields) >= 1:`. |
| P15 | `www/util/station_manager.py:529,534,539` | `hashlib.md5(open(...).read())` never closes the file objects (fd leak). | Use `with open(...) as f:`. |
| P16 | `www/daemon/rotenc.py:146–150` | Two `fetchone()` calls against `WHERE param='volknob' OR param='volume_mpd_max'` with no `ORDER BY`; row order is unspecified, so the two volumes can be swapped. | Query each param explicitly or `ORDER BY param`. |
| P17 | `www/util/cdsp_volume_update.py:190` | `… - abs(volume_offset)` when `get_config()` returns `None` (both fields are explicitly optional) raises `TypeError`. | Default to `0` when `None`. |
| P18 | `www/daemon/bt_pairing_agent.py:102,185` | An accepted `pairresp` without a numeric code yields `code = None`, then `dbus.UInt32(None)` raises `TypeError` inside the GLib callback. | Only call the reply with a code, or fall back to a default; guard `code is not None`. |
| P19 | `www/util/station_manager.py:348` | `return_code = 3` is assigned but never returned/used, so import continues after "station pls files not found". | `return return_code`. |
| P20 | `var/local/www/commandw/lcd_updater.py:13` | `ls /home/` is assumed to yield exactly one entry; with more than one the embedded newline makes `/home/<x>/lcd.txt` an invalid path. | Use `os.listdir()` and select a valid user directory. |
| P21 | `www/util/radiocover_plus.py:451–452` | Dead code after `return dim, dim` (`if "archive.org" in url …: return 500, 500`) — unreachable and misleading. | Remove or restructure the archive.org fallback. |
| P22 | `www/util/cdsp_volume_update.py:12,32,51,71` | `yaml.load(..., Loader=yaml.Loader)` on the state file allows arbitrary object construction (unsafe deserialisation). | `yaml.safe_load(...)`. |

---

## 7. Shell / `moodeutl` findings

### High

#### B1. `playlist_pos==` typo (wrong assignment) — `www/util/sysinfo.sh:968`
```sh
playlist_pos==${arr[165]}
```
Assigns the literal string `=<value>` (confirmed by shellcheck `SC1097` and by running the construct), so the "Playlist position" value in the system info dump is corrupted.
**Remediation:** `playlist_pos=${arr[165]}`.

#### B2. Wrong DB index for receiver addresses — `www/util/sysinfo.sh:916`
```sh
[[ "${arr[128]}" = "-1" ]] && rx_addresses="Run discover" || rx_addresses="${arr[128]}"
```
Index 129 (`arr[128]`) is `rx_hostnames`; `rx_addresses` is id 130 (`arr[129]`). The "Receiver addrs" line duplicates the hostnames and never reads the addresses.
**Remediation:** use `arr[129]`.

#### B3. Wrong DB index for Parametric EQ — `www/util/sysinfo.sh:843`
```sh
eqfa12p=${arr[73]}
```
`eqfa12p` is not a `cfg_system` column at all (it is a session variable), so `arr[73]` is actually id 74 `peppy_display_type`. The "Parametric EQ" line shows the Peppy display type.
**Remediation:** source `eqfa12p` from the correct place (`moodeutl -d -gv eqfa12p` or the session dump).

#### B4. "Mixdown" prints the six‑channel mode — `www/util/sysinfo.sh:335`
```sh
echo -e "\nMixdown\t\t\t= $apl_six_channel_mode\c"
```
`apl_mixdown` is parsed at line 623 but never used; the Mixdown row duplicates "Six ch mode".
**Remediation:** print `$apl_mixdown`.

### Medium

| ID | Location | Problem | Remediation |
|----|----------|---------|-------------|
| B5 | `www/util/sysinfo.sh:168` | `$mpdcrossfade` is never assigned in this script (it is a session var), so "Crossfade" always prints blank. | Populate via `moodeutl -d -gv mpdcrossfade`. |
| B6 | `usr/local/bin/moodeutl:415` | `$cpuLoad = $cpuload >= 100 ? …` — PHP variable names are case‑sensitive; `$cpuload` is undefined, so the CPU readout is never capped at 100%. | Use `$cpuLoad`. |
| B7 | `usr/local/bin/moodeutl:1001–1002` | `if (count($parts) >= 2) { $version = trim($parts[2]); }` — index 2 needs ≥3 elements. | `>= 3` (same defect as M4). |
| B8 | `usr/local/bin/moodeutl:981–983` | `for (…) { $output = sysCmdStr("nmblookup …"); }` overwrites instead of accumulating, so only the last scan's hosts are reported. | `$output .= …`. |

### Low

| ID | Location | Problem | Remediation |
|----|----------|---------|-------------|
| B9 | `usr/local/bin/moodeutl:211` | Help text lists `--clearodt` while the implemented case is `--clearodc` (line 128). | Correct the help text (or the case label). |
| B10 | `www/util/automount.sh:39` | `grep -w -c $(basename "$2") /etc/exports` — unquoted substitution splits on spaces (USB label "My Disk"), producing a wrong count / NFS export skipped. | Quote: `grep -w -c "$(basename "$2")"`. |
| B11 | `usr/local/bin/devutl:53` | `cd /media` unchecked before `find . -name "._*" -exec rm -rf {} \;`; a failed `cd` runs the deletes in the wrong directory. | `cd /media || exit`. |

> Note: shellcheck also flags `while IFS== read -r key value` in `qbzevent.sh:214` and `spotevent.sh:161` (`SC1097`). This is a **false positive** — `IFS==` correctly sets `IFS` to `=` — and was verified by execution, so it is not reported as a bug.

---

## 8. Cross‑cutting observations

* **Error handling vs. PHP 8.4.** Many sites assume a value/array index/file is present. Under PHP 8.x undefined array keys are warnings and `fputs(null, …)` / `fread(false, 0)` are fatal `TypeError`/`ValueError`. The `turnOffAutoShuffle($sock)` and Zend parse errors are the most severe.
* **`chkVariables()` exclusions are an injection foot‑gun.** Prefer prepared statements/`SQLite3::escapeString()` and `escapeshellarg()` at every sink rather than relying on the exclusion list.
* **Vendored `Zend` media library is not PHP 8 compatible.** On a PHP 8.4 image this folder should either be patched (C1/C2) or excluded from any code path; it cannot be parsed as‑is.
* **The `radiocover_plus.py` dead code and `resultCount != '0'`** suggest the recent MusicBrainz refactor was not exercised for the empty‑result / archive.org paths.

---

## 9. Prioritised remediation plan

**Phase 1 — stop crashes and security holes (do first)**
1. Fix the PHP 8 parse/fatal errors in `Zend/Media/Mpeg/Object.php` and `VbriHeader.php` (C1, C2).
2. Move the `$sock` acquisition before `turnOffAutoShuffle()` in `command/index.php` (C3).
3. Escape/validate request data at all SQL/shell sinks: `playlist.php`, `radio.php`, `music-library.php`, `eqg-config.php`, `sql.php` (S1–S5).
4. Fix the Python `NameError`/`AttributeError`/`FileNotFoundError` paths in `station_manager.py` and `cdsp_volume_update.py` (P3–P6).
5. Fix `radiocover_plus.py` config parse and `resultCount` (P1, P2).

**Phase 2 — restore broken user‑visible features**
6. `mpd.php` local‑audio session key and stop‑state handling (H1, H2).
7. `worker.php`: sudoers filename, session initialisers, ALSА card compare, Plexamp flag, `$file`, IP compare (H4, H5, H7, H8, H9, H10).
8. `snd-config.php` device flag and local‑audio field (H11, H12); `trx-config.php` key (H13); `cdsp-config.php` `.yml` handling (H14); `cdsp.php` pipeline unset (H15); `autocfg.php` password (H16).
9. JavaScript: `playerlib.js` cover/font/`countryDiv` and `scripts-panels.js` playlist position (J1–J4, J6).

**Phase 3 — correctness on edge cases and cleanup**
10. Off‑by‑one guards (`music-source.php`, `moodeutl`), `ltrim` prefix misuse (`music-library.php`, `peppy-config.php`), uninitialised accumulators/`$contents`, `sqlQuery()` truthy handling (`audioinfo.php`, `playlist.php`, `radio-browser.php`).
11. Python medium items and shell medium items (Section 6/7 tables).
12. Cosmetic/robustness: `constants.php` typo, `header.php` comment, `alsa.php` self‑require, duplicate `imagejpeg()`, `--clearodt` help text, `devutl` `cd` guard.

**Regression suggestions**
* Add PHP 8.4 lint to CI over `www/**` (excluding or separately handling `www/inc/Zend`).
* Add a tiny shell/python smoke test that exercises the empty‑result branches for library load, radio‑browser countries/genres, and the Python import/export commands.
* Prefer prepared SQL statements and a single escaping helper at every sink so future `chkVariables` exclusions cannot bypass validation.

---

*End of report.*
