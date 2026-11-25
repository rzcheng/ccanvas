// Importing Chrome sign-ins is macOS-only for now (chrome_import.rs): Chrome
// encrypts cookies differently on each platform. These say so.

#[tauri::command]
pub fn chrome_profiles() -> Result<Vec<()>, String> {
    Err("Importing from Chrome is only on macOS for now.".into())
}

#[tauri::command]
pub async fn chrome_cookie_sites(profile: String) -> Result<Vec<()>, String> {
    let _ = profile;
    Err("Importing from Chrome is only on macOS for now.".into())
}

#[tauri::command]
pub async fn chrome_import(profile: String, sites: Vec<String>) -> Result<(), String> {
    let _ = (profile, sites);
    Err("Importing from Chrome is only on macOS for now.".into())
}

#[tauri::command]
pub async fn web_sign_out_all() -> Result<(), String> {
    Err("Only on macOS for now.".into())
}
