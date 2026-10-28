/**
 * Tiny Windows launcher for the packaged mmo-chip app.
 *
 * On this project's target machines Chromium's sandbox initialization can
 * crash Electron before main.js runs (access violation, silent exit). The
 * official escape hatch is the ELECTRON_DISABLE_SANDBOX environment variable,
 * which must be set before the Electron binary starts — a .cmd wrapper would
 * flash a console window and shortcuts cannot carry env vars, so this
 * launcher sets the variable and spawns the real app exe.
 *
 * afterPack renames Electron's mmo-chip.exe to mmo-chip-app.exe and places
 * this launcher as mmo-chip.exe, so double-clicking "mmo-chip" just works.
 * Arguments are passed through unchanged; the exit code is propagated.
 */
use std::process::Command;

fn main() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => std::process::exit(2),
    };
    let dir = match exe.parent() {
        Some(d) => d.to_path_buf(),
        None => std::process::exit(2),
    };
    let app = dir.join("mmo-chip-app.exe");
    if !app.exists() {
        let _ = std::fs::write(dir.join("launcher-error.txt"), format!("missing {}", app.display()));
        std::process::exit(2);
    }

    std::env::set_var("ELECTRON_DISABLE_SANDBOX", "1");
    let mut cmd = Command::new(&app);
    cmd.args(std::env::args_os().skip(1));
    match cmd.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            let _ = std::fs::write(dir.join("launcher-error.txt"), format!("{error}"));
            std::process::exit(1);
        }
    }
}
