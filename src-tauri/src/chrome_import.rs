// Sign-ins for the web widget's browser (macOS; elsewhere chrome_import_stub.rs): importing the cookies of chosen
// sites from a Chrome profile, and signing out of every site.
//
// The web widget's native views share one persistent website data store
// (native_view.rs, PROFILE_ID), so a sign-in made inside ccanvas already
// sticks across widgets and relaunches. This adds two things to that store,
// both only ever on an explicit action in Settings:
//   • Import: the user picks a Chrome profile and the sites to bring over
//     (nothing is chosen for them); their cookies are decrypted here and
//     written straight into that store.
//   • Sign out of all sites: everything in that store is removed.
//
// Threat model. A cookie is a sign-in: whoever holds it is the user on that
// site. So:
//   • Cookie values only exist in this process's memory, for the length of
//     one import, and then in WebKit's own store for the native views. They
//     never reach the frontend (commands return domains and counts only),
//     localStorage, logs, error messages, the canvas file, the Node server
//     or the preview proxy, and they are only ever sent over the network by
//     the native view, to their own site.
//   • They go into the native views' own data store, never the default store
//     the app's UI runs in (on macOS before 14, where WebKit has no separate
//     stores, the import refuses), and never the preview proxy, which serves
//     every proxied page from one origin and must stay cookie-less.
//   • Chrome's cookies are encrypted with a key kept in the login Keychain
//     ("Chrome Safe Storage"). It is asked for only when importing, through
//     macOS's own prompt, which the user approves or declines; it is never
//     stored, and it and everything derived from it are zeroed as soon as the
//     cookies are decrypted.
//   • Chrome holds its database open, so a copy is read, from a folder only
//     this user can open, which is deleted straight after (even on failure).
//   • A profile is only ever one Chrome lists in its own Local State, so no
//     path from the frontend reaches the disk. A cookie in a format this
//     doesn't know (anything but "v10") is skipped and counted, never guessed
//     at; if the Keychain says no, the import stops.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use zeroize::Zeroize;

#[derive(Serialize)]
pub struct ChromeProfile {
    /// Chrome's folder name for it ("Default", "Profile 1")
    dir: String,
    /// the name the user gave it in Chrome
    name: String,
}

#[derive(Serialize, PartialEq, Debug)]
pub struct CookieSite {
    domain: String,
    cookies: usize,
}

#[derive(Serialize)]
pub struct ImportReport {
    imported: usize,
    /// in a format this can't read, or refused by WebKit
    skipped: usize,
}

/// One cookie, decrypted. Its value is zeroed on drop.
struct Cookie {
    host: String,
    name: String,
    value: String,
    path: String,
    /// seconds since 1970; None for a session cookie
    expires: Option<f64>,
    secure: bool,
    http_only: bool,
    /// Chrome's: -1 unspecified, 0 none, 1 lax, 2 strict
    same_site: i32,
}

impl Drop for Cookie {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

// ---------- Chrome's files ----------

fn chrome_root() -> Option<PathBuf> {
    // development builds only: a throwaway Chrome-shaped folder to test
    // against, never the user's own (compiled out of release builds)
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("CCANVAS_TEST_CHROME_ROOT") {
        return Some(PathBuf::from(root));
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/Google/Chrome"))
}

/// Chrome's profiles, by its Local State (the only source of a profile name).
fn profiles_in(root: &Path) -> Result<Vec<ChromeProfile>, String> {
    let text = std::fs::read_to_string(root.join("Local State"))
        .map_err(|_| "Chrome isn't installed for this user (no Local State).".to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| "Couldn't read Chrome's Local State.".to_string())?;
    let mut out: Vec<ChromeProfile> = json
        .pointer("/profile/info_cache")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(dir, info)| ChromeProfile {
                    dir: dir.clone(),
                    name: info
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or(dir)
                        .to_string(),
                })
                .filter(|p| cookies_db(root, &p.dir).is_some())
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|p| p.name.to_lowercase());
    Ok(out)
}

fn cookies_db(root: &Path, dir: &str) -> Option<PathBuf> {
    ["Cookies", "Network/Cookies"]
        .iter()
        .map(|f| root.join(dir).join(f))
        .find(|p| p.is_file())
}

/// The cookie database of a profile Chrome lists (never a path from outside).
fn profile_db(root: &Path, dir: &str) -> Result<PathBuf, String> {
    if !profiles_in(root)?.iter().any(|p| p.dir == dir) {
        return Err("That Chrome profile isn't there any more.".into());
    }
    cookies_db(root, dir).ok_or_else(|| "That Chrome profile has no cookies.".into())
}

/// A private copy of a cookie database (Chrome keeps the original locked),
/// deleted on drop.
struct Copy {
    dir: PathBuf,
    db: PathBuf,
}

impl Copy {
    fn of(db: &Path) -> Result<Self, String> {
        use std::os::unix::fs::DirBuilderExt;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("ccanvas-cookies-{}-{nanos}", std::process::id()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|_| "Couldn't make a private folder to read Chrome's cookies.".to_string())?;
        let copy = Copy {
            db: dir.join("Cookies"),
            dir,
        };
        std::fs::copy(db, &copy.db)
            .map_err(|_| "Couldn't read Chrome's cookie database.".to_string())?;
        // its journal, if Chrome has one open, so the copy is complete
        for ext in ["-wal", "-journal", "-shm"] {
            let side = PathBuf::from(format!("{}{ext}", db.display()));
            if side.is_file() {
                let _ = std::fs::copy(&side, format!("{}{ext}", copy.db.display()));
            }
        }
        Ok(copy)
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const SEP: char = '\u{1f}';
const ROW: char = '\u{1e}';

/// Run one query on a copied database with macOS's own sqlite3, fields and
/// rows split by control characters. The output is zeroed by the caller.
fn query(db: &Path, sql: &str) -> Result<String, String> {
    let out = Command::new("/usr/bin/sqlite3")
        .args([
            "-readonly",
            "-batch",
            "-noheader",
            "-separator",
            "\u{1f}",
            "-newline",
            "\u{1e}",
        ])
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|_| "Couldn't run sqlite3 to read Chrome's cookies.".to_string())?;
    if !out.status.success() {
        return Err("Chrome's cookie database is in a format this can't read.".into());
    }
    String::from_utf8(out.stdout)
        .map_err(|_| "Chrome's cookie database didn't read as text.".into())
}

/// Microseconds since 1601 (Chrome's clock), now.
fn chrome_now() -> i64 {
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    (unix + 11_644_473_600) * 1_000_000
}

/// The site a cookie's host belongs to, for the checklist: `.mail.google.com`
/// → `google.com`, `www.bbc.co.uk` → `bbc.co.uk`.
fn site_of(host: &str) -> String {
    let h = host.trim_start_matches('.').to_ascii_lowercase();
    if h.parse::<std::net::IpAddr>().is_ok() {
        return h;
    }
    let labels: Vec<&str> = h.split('.').filter(|l| !l.is_empty()).collect();
    let n = labels.len();
    if n <= 2 {
        return labels.join(".");
    }
    // a country's second level (`co.uk`, `com.au`) keeps one more label
    let second = labels[n - 2];
    let take = if labels[n - 1].len() == 2
        && [
            "co", "com", "net", "org", "gov", "edu", "ac", "ne", "or", "go",
        ]
        .contains(&second)
    {
        3
    } else {
        2
    };
    labels[n - take..].join(".")
}

/// The sites with live cookies in a copied database, with how many each.
fn sites_in(db: &Path) -> Result<Vec<CookieSite>, String> {
    let mut out = query(
        db,
        &format!(
            "SELECT host_key, COUNT(*) FROM cookies WHERE expires_utc = 0 OR expires_utc > {} GROUP BY host_key",
            chrome_now()
        ),
    )?;
    let mut by_site: std::collections::BTreeMap<String, usize> = Default::default();
    for row in out.split(ROW) {
        let mut f = row.split(SEP);
        let (Some(host), Some(n)) = (f.next(), f.next()) else {
            continue;
        };
        *by_site.entry(site_of(host)).or_default() += n.trim().parse::<usize>().unwrap_or(0);
    }
    out.zeroize();
    Ok(by_site
        .into_iter()
        .filter(|(d, n)| !d.is_empty() && *n > 0)
        .map(|(domain, cookies)| CookieSite { domain, cookies })
        .collect())
}

/// The chosen sites' cookies, decrypted with `password` (Chrome Safe
/// Storage). Returns them and how many were skipped.
fn read_cookies(
    db: &Path,
    sites: &[String],
    password: &[u8],
) -> Result<(Vec<Cookie>, usize), String> {
    // from schema version 24 each value starts with a hash of its host
    let mut version = query(db, "SELECT value FROM meta WHERE key = 'version'")?;
    let schema: u32 = version.trim_end_matches(ROW).trim().parse().unwrap_or(0);
    version.zeroize();
    let mut out = query(
        db,
        &format!(
            "SELECT host_key, name, path, hex(encrypted_value), value, expires_utc, is_secure, is_httponly, samesite \
             FROM cookies WHERE expires_utc = 0 OR expires_utc > {}",
            chrome_now()
        ),
    )?;
    let mut key = derive_key(password);
    let mut cookies = Vec::new();
    let mut skipped = 0;
    for row in out.split(ROW) {
        let f: Vec<&str> = row.split(SEP).collect();
        if f.len() != 9 || !sites.iter().any(|s| *s == site_of(f[0])) {
            continue;
        }
        let value = if f[3].is_empty() {
            Some(f[4].to_string())
        } else {
            let mut enc = hex(f[3]);
            let v = enc.as_deref().and_then(|e| decrypt(&key, e, f[0], schema));
            if let Some(e) = enc.as_mut() {
                e.zeroize();
            }
            v
        };
        let Some(value) = value else {
            skipped += 1;
            continue;
        };
        let expires_utc: i64 = f[5].parse().unwrap_or(0);
        cookies.push(Cookie {
            host: f[0].to_string(),
            name: f[1].to_string(),
            value,
            path: if f[2].is_empty() {
                "/".into()
            } else {
                f[2].to_string()
            },
            expires: (expires_utc > 0).then(|| expires_utc as f64 / 1e6 - 11_644_473_600.0),
            secure: f[6] == "1",
            http_only: f[7] == "1",
            same_site: f[8].parse().unwrap_or(-1),
        });
    }
    key.zeroize();
    out.zeroize();
    Ok((cookies, skipped))
}

fn hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

// ---------- Chrome's encryption (macOS): CommonCrypto, part of the OS ----------

#[allow(non_snake_case)]
extern "C" {
    fn CCKeyDerivationPBKDF(
        algorithm: u32,
        password: *const u8,
        passwordLen: usize,
        salt: *const u8,
        saltLen: usize,
        prf: u32,
        rounds: u32,
        derivedKey: *mut u8,
        derivedKeyLen: usize,
    ) -> i32;
    fn CCCrypt(
        op: u32,
        alg: u32,
        options: u32,
        key: *const u8,
        keyLength: usize,
        iv: *const u8,
        dataIn: *const u8,
        dataInLength: usize,
        dataOut: *mut u8,
        dataOutAvailable: usize,
        dataOutMoved: *mut usize,
    ) -> i32;
    fn CC_SHA256(data: *const u8, len: u32, md: *mut u8) -> *mut u8;
}

const IV: [u8; 16] = [b' '; 16];

/// Chrome's key from the Safe Storage password: PBKDF2-HMAC-SHA1, "saltysalt",
/// 1003 rounds, 16 bytes.
fn derive_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    // kCCPBKDF2 = 2, kCCPRFHmacAlgSHA1 = 1
    unsafe {
        CCKeyDerivationPBKDF(
            2,
            password.as_ptr(),
            password.len(),
            b"saltysalt".as_ptr(),
            9,
            1,
            1003,
            key.as_mut_ptr(),
            16,
        );
    }
    key
}

/// AES-128-CBC with PKCS#7 padding (`decrypt`: false encrypts, for tests).
fn aes_cbc(decrypt: bool, key: &[u8; 16], data: &[u8]) -> Option<Vec<u8>> {
    let mut out = vec![0u8; data.len() + 16];
    let mut moved = 0usize;
    // kCCDecrypt = 1 / kCCEncrypt = 0, kCCAlgorithmAES = 0, kCCOptionPKCS7Padding = 1
    let status = unsafe {
        CCCrypt(
            decrypt as u32,
            0,
            1,
            key.as_ptr(),
            16,
            IV.as_ptr(),
            data.as_ptr(),
            data.len(),
            out.as_mut_ptr(),
            out.len(),
            &mut moved,
        )
    };
    if status != 0 {
        out.zeroize();
        return None;
    }
    out.truncate(moved);
    Some(out)
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut md = [0u8; 32];
    unsafe {
        CC_SHA256(data.as_ptr(), data.len() as u32, md.as_mut_ptr());
    }
    md
}

/// One cookie's value: "v10" then AES-128-CBC; from schema 24 the plain text
/// starts with SHA-256 of the host, which must match. Anything else: None.
fn decrypt(key: &[u8; 16], data: &[u8], host: &str, schema: u32) -> Option<String> {
    let body = data.strip_prefix(b"v10")?;
    let mut plain = aes_cbc(true, key, body)?;
    if schema >= 24 {
        if plain.len() < 32 || plain[..32] != sha256(host.as_bytes()) {
            plain.zeroize();
            return None;
        }
        plain.drain(..32);
    }
    match String::from_utf8(plain) {
        Ok(s) => Some(s),
        Err(e) => {
            e.into_bytes().zeroize();
            None
        }
    }
}

/// Chrome Safe Storage's password, through macOS's own Keychain prompt.
fn keychain_password() -> Result<Vec<u8>, String> {
    // development builds only: the test folder's made-up key, so a test never
    // touches the Keychain (compiled out of release builds)
    #[cfg(debug_assertions)]
    if std::env::var_os("CCANVAS_TEST_CHROME_ROOT").is_some() {
        return std::env::var("CCANVAS_TEST_CHROME_KEY")
            .map(String::into_bytes)
            .map_err(|_| "No test key.".to_string());
    }
    let out = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-w",
            "-s",
            "Chrome Safe Storage",
            "-a",
            "Chrome",
        ])
        .output()
        .map_err(|_| "Couldn't ask the Keychain for Chrome's key.".to_string())?;
    let mut pw = out.stdout;
    if !out.status.success() || pw.is_empty() {
        pw.zeroize();
        return Err("The Keychain didn't hand over Chrome's key (the prompt was declined, or Chrome has none).".into());
    }
    while pw.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
        pw.pop();
    }
    Ok(pw)
}

// ---------- the native views' data store ----------

/// Write the cookies into the web views' store, on the main thread; waits
/// for WebKit to confirm each. Returns how many it took.
fn store_cookies(app: &tauri::AppHandle, cookies: Vec<Cookie>) -> Result<usize, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    let total = cookies.len();
    if total == 0 {
        return Ok(0);
    }
    let (tx, rx) = mpsc::channel::<usize>();
    app.run_on_main_thread(move || {
        use objc2::runtime::AnyObject;
        use objc2::MainThreadMarker;
        use objc2_foundation::{
            NSDate, NSDictionary, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieExpires,
            NSHTTPCookieName, NSHTTPCookiePath, NSHTTPCookieSameSiteLax,
            NSHTTPCookieSameSitePolicy, NSHTTPCookieSameSiteStrict, NSHTTPCookieSecure,
            NSHTTPCookieValue, NSString, NSUUID,
        };
        use objc2_web_kit::WKWebsiteDataStore;
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(0);
            return;
        };
        let store = unsafe {
            WKWebsiteDataStore::dataStoreForIdentifier(
                &NSUUID::from_bytes(crate::native_view::PROFILE_ID),
                mtm,
            )
        };
        let jar = unsafe { store.httpCookieStore() };
        let made: Vec<_> = cookies
            .iter()
            .filter_map(|c| unsafe {
                let name = NSString::from_str(&c.name);
                let value = NSString::from_str(&c.value);
                let domain = NSString::from_str(&c.host);
                let path = NSString::from_str(&c.path);
                let yes = NSString::from_str("TRUE");
                let http_only_key = NSString::from_str("HttpOnly");
                let mut keys: Vec<&NSString> = vec![
                    NSHTTPCookieName,
                    NSHTTPCookieValue,
                    NSHTTPCookieDomain,
                    NSHTTPCookiePath,
                ];
                let mut objs: Vec<&AnyObject> = vec![&name, &value, &domain, &path];
                let expires = c.expires.map(NSDate::dateWithTimeIntervalSince1970);
                if let Some(e) = expires.as_ref() {
                    keys.push(NSHTTPCookieExpires);
                    objs.push(e);
                }
                if c.secure {
                    keys.push(NSHTTPCookieSecure);
                    objs.push(&yes);
                }
                if c.http_only {
                    keys.push(&http_only_key);
                    objs.push(&yes);
                }
                match c.same_site {
                    1 => {
                        keys.push(NSHTTPCookieSameSitePolicy);
                        objs.push(NSHTTPCookieSameSiteLax);
                    }
                    2 => {
                        keys.push(NSHTTPCookieSameSitePolicy);
                        objs.push(NSHTTPCookieSameSiteStrict);
                    }
                    _ => {}
                }
                let props = NSDictionary::<NSString, AnyObject>::from_slices(&keys, &objs);
                NSHTTPCookie::cookieWithProperties(&props)
            })
            .collect();
        drop(cookies);
        let left = Arc::new(AtomicUsize::new(made.len()));
        if made.is_empty() {
            let _ = tx.send(0);
            return;
        }
        let n = made.len();
        for cookie in &made {
            let left = left.clone();
            let tx = tx.clone();
            let done = block2::RcBlock::new(move || {
                if left.fetch_sub(1, Ordering::SeqCst) == 1 {
                    let _ = tx.send(n);
                }
            });
            unsafe { jar.setCookie_completionHandler(cookie, Some(&done)) };
        }
    })
    .map_err(|_| "Couldn't reach the browser's cookie store.".to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(60))
        .map_err(|_| "The browser's cookie store didn't answer.".to_string())
}

/// The web views have a store of their own only from macOS 14; before that
/// they would share the app's, so nothing is imported there.
fn own_store_available() -> bool {
    objc2::available!(macos = 14.0)
}

// ---------- commands ----------

#[tauri::command]
pub fn chrome_profiles() -> Result<Vec<ChromeProfile>, String> {
    profiles_in(&chrome_root().ok_or("No home folder.")?)
}

/// The sites a profile has cookies for (no values), for the checklist.
#[tauri::command]
pub async fn chrome_cookie_sites(profile: String) -> Result<Vec<CookieSite>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = chrome_root().ok_or("No home folder.")?;
        let copy = Copy::of(&profile_db(&root, &profile)?)?;
        sites_in(&copy.db)
    })
    .await
    .map_err(|_| "The cookie reader stopped.".to_string())?
}

/// Import the cookies of `sites` (domains from `chrome_cookie_sites`) from a
/// Chrome profile into the web views' store. Asks macOS for Chrome's key.
#[tauri::command]
pub async fn chrome_import(
    app: tauri::AppHandle,
    profile: String,
    sites: Vec<String>,
) -> Result<ImportReport, String> {
    {
        if !own_store_available() {
            return Err("Importing sign-ins needs macOS 14 or later (before that the browser view shares the app's storage).".into());
        }
        if sites.is_empty() || sites.len() > 1000 {
            return Err("Choose the sites to import.".into());
        }
        let (cookies, skipped) = tauri::async_runtime::spawn_blocking(move || {
            let root = chrome_root().ok_or("No home folder.")?;
            let copy = Copy::of(&profile_db(&root, &profile)?)?;
            // only the sites this profile has: nothing else can be asked for
            let known: Vec<String> = sites_in(&copy.db)?.into_iter().map(|s| s.domain).collect();
            let chosen: Vec<String> = sites.into_iter().filter(|s| known.contains(s)).collect();
            if chosen.is_empty() {
                return Ok((Vec::new(), 0));
            }
            let mut pw = keychain_password()?;
            let read = read_cookies(&copy.db, &chosen, &pw);
            pw.zeroize();
            read
        })
        .await
        .map_err(|_| "The cookie reader stopped.".to_string())??;
        let total = cookies.len();
        let stored = store_cookies(&app, cookies)?;
        Ok(ImportReport {
            imported: stored,
            skipped: skipped + (total - stored),
        })
    }
}

/// Sign out of every site in the web views: remove all of their website
/// data (cookies, storage, caches).
#[tauri::command]
pub async fn web_sign_out_all(app: tauri::AppHandle) -> Result<(), String> {
    {
        if !own_store_available() {
            return Err("Needs macOS 14 or later.".into());
        }
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        app.run_on_main_thread(move || {
            use objc2::MainThreadMarker;
            use objc2_foundation::{NSDate, NSUUID};
            use objc2_web_kit::WKWebsiteDataStore;
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            unsafe {
                let store = WKWebsiteDataStore::dataStoreForIdentifier(
                    &NSUUID::from_bytes(crate::native_view::PROFILE_ID),
                    mtm,
                );
                let done = block2::RcBlock::new(move || {
                    let _ = tx.send(());
                });
                store.removeDataOfTypes_modifiedSince_completionHandler(
                    &WKWebsiteDataStore::allWebsiteDataTypes(mtm),
                    &NSDate::distantPast(),
                    &done,
                );
            }
        })
        .map_err(|_| "Couldn't reach the browser's data store.".to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .map_err(|_| "The browser's data store didn't answer.".to_string())?;
        crate::native_view::reload_all(&app);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_hosts_into_sites() {
        assert_eq!(site_of(".mail.google.com"), "google.com");
        assert_eq!(site_of("github.com"), "github.com");
        assert_eq!(site_of("www.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(site_of(".example.com.au"), "example.com.au");
        assert_eq!(site_of("localhost"), "localhost");
        assert_eq!(site_of("10.0.0.2"), "10.0.0.2");
    }

    #[test]
    fn decrypts_chrome_values() {
        // a made-up password, never the user's
        let key = derive_key(b"test-password");
        let enc = |host: &str, value: &str, schema: u32| {
            let mut plain = Vec::new();
            if schema >= 24 {
                plain.extend_from_slice(&sha256(host.as_bytes()));
            }
            plain.extend_from_slice(value.as_bytes());
            let mut out = b"v10".to_vec();
            out.extend(aes_cbc(false, &key, &plain).unwrap());
            out
        };
        assert_eq!(
            decrypt(&key, &enc(".a.test", "s3cret", 23), ".a.test", 23).as_deref(),
            Some("s3cret")
        );
        assert_eq!(
            decrypt(&key, &enc(".a.test", "s3cret", 24), ".a.test", 24).as_deref(),
            Some("s3cret")
        );
        // a hash for another host is refused, as is an unknown format or key
        assert_eq!(decrypt(&key, &enc(".a.test", "x", 24), ".b.test", 24), None);
        assert_eq!(decrypt(&key, b"v11whatever", ".a.test", 23), None);
        assert_eq!(
            decrypt(
                &derive_key(b"wrong"),
                &enc(".a.test", "s3cret", 23),
                ".a.test",
                23
            ),
            None
        );
    }

    /// A throwaway Chrome-shaped profile: Local State plus a Cookies database
    /// with test cookies, encrypted with a test password.
    fn fake_chrome(schema: u32) -> (tempdir::Dir, Vec<u8>) {
        let dir = tempdir::Dir::new();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Profile 1")).unwrap();
        std::fs::write(
            root.join("Local State"),
            r#"{"profile":{"info_cache":{"Profile 1":{"name":"Testing"},"Gone":{"name":"No cookies"}}}}"#,
        )
        .unwrap();
        let pw = b"test-password".to_vec();
        let key = derive_key(&pw);
        let enc = |host: &str, v: &str| {
            let mut plain = Vec::new();
            if schema >= 24 {
                plain.extend_from_slice(&sha256(host.as_bytes()));
            }
            plain.extend_from_slice(v.as_bytes());
            let mut out = b"v10".to_vec();
            out.extend(aes_cbc(false, &key, &plain).unwrap());
            out.iter().map(|b| format!("{b:02X}")).collect::<String>()
        };
        let future = chrome_now() + 3_600_000_000;
        let past = chrome_now() - 3_600_000_000;
        let sql = format!(
            "CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('version','{schema}');
             CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, path TEXT, encrypted_value BLOB,
               expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);
             INSERT INTO cookies VALUES('.github.test','sess','','/',X'{}',{future},1,1,1);
             INSERT INTO cookies VALUES('api.github.test','tok','','/v1',X'{}',0,1,0,-1);
             INSERT INTO cookies VALUES('.other.test','id','','/',X'{}',{future},0,0,2);
             INSERT INTO cookies VALUES('.old.test','gone','','/',X'{}',{past},0,0,0);
             INSERT INTO cookies VALUES('.weird.test','v11','','/',X'763131414141',{future},0,0,0);",
            enc(".github.test", "hello"),
            enc("api.github.test", "world"),
            enc(".other.test", "nope"),
            enc(".old.test", "old"),
        );
        let ok = Command::new("/usr/bin/sqlite3")
            .arg(root.join("Profile 1/Cookies"))
            .arg(sql)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        (dir, pw)
    }

    #[test]
    fn reads_a_throwaway_profile() {
        for schema in [23, 24] {
            let (dir, pw) = fake_chrome(schema);
            let root = dir.path();
            let profiles = profiles_in(root).unwrap();
            assert_eq!(profiles.len(), 1, "only profiles with cookies");
            assert_eq!(
                (profiles[0].dir.as_str(), profiles[0].name.as_str()),
                ("Profile 1", "Testing")
            );
            assert!(
                profile_db(root, "../../etc").is_err(),
                "only Chrome's own profiles"
            );

            let copy = Copy::of(&profile_db(root, "Profile 1").unwrap()).unwrap();
            let copy_dir = copy.dir.clone();
            let sites = sites_in(&copy.db).unwrap();
            assert_eq!(
                sites,
                vec![
                    CookieSite {
                        domain: "github.test".into(),
                        cookies: 2
                    },
                    CookieSite {
                        domain: "other.test".into(),
                        cookies: 1
                    },
                    CookieSite {
                        domain: "weird.test".into(),
                        cookies: 1
                    },
                ],
                "expired cookies left out"
            );
            let (cookies, skipped) =
                read_cookies(&copy.db, &["github.test".into(), "weird.test".into()], &pw).unwrap();
            assert_eq!(skipped, 1, "an unknown format is skipped, not guessed");
            let got: Vec<_> = cookies
                .iter()
                .map(|c| {
                    (
                        c.host.as_str(),
                        c.name.as_str(),
                        c.value.as_str(),
                        c.path.as_str(),
                        c.secure,
                        c.http_only,
                        c.same_site,
                        c.expires.is_some(),
                    )
                })
                .collect();
            assert_eq!(
                got,
                vec![
                    (".github.test", "sess", "hello", "/", true, true, 1, true),
                    (
                        "api.github.test",
                        "tok",
                        "world",
                        "/v1",
                        true,
                        false,
                        -1,
                        false
                    ),
                ]
            );
            drop(copy);
            assert!(!copy_dir.exists(), "the private copy is deleted");
        }
    }

    #[test]
    fn makes_webkit_cookies_with_their_flags() {
        use objc2::runtime::AnyObject;
        use objc2_foundation::{
            NSDictionary, NSHTTPCookie, NSHTTPCookieDomain, NSHTTPCookieName, NSHTTPCookiePath,
            NSHTTPCookieSameSiteLax, NSHTTPCookieSameSitePolicy, NSHTTPCookieSecure,
            NSHTTPCookieValue, NSString,
        };
        unsafe {
            let (name, value, domain, path) = (
                NSString::from_str("sess"),
                NSString::from_str("v"),
                NSString::from_str(".github.test"),
                NSString::from_str("/"),
            );
            let yes = NSString::from_str("TRUE");
            let http_only = NSString::from_str("HttpOnly");
            let keys: Vec<&NSString> = vec![
                NSHTTPCookieName,
                NSHTTPCookieValue,
                NSHTTPCookieDomain,
                NSHTTPCookiePath,
                NSHTTPCookieSecure,
                &http_only,
                NSHTTPCookieSameSitePolicy,
            ];
            let objs: Vec<&AnyObject> = vec![
                &name,
                &value,
                &domain,
                &path,
                &yes,
                &yes,
                NSHTTPCookieSameSiteLax,
            ];
            let c = NSHTTPCookie::cookieWithProperties(&NSDictionary::from_slices(&keys, &objs))
                .unwrap();
            assert!(c.isSecure());
            assert!(c.isHTTPOnly());
            assert_eq!(
                c.sameSitePolicy().map(|p| p.to_string()).as_deref(),
                Some("lax")
            );
            assert!(c.isSessionOnly());
        }
    }

    /// A scratch folder for one test, removed after.
    mod tempdir {
        pub struct Dir(std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let n = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let p = std::env::temp_dir()
                    .join(format!("ccanvas-test-chrome-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
