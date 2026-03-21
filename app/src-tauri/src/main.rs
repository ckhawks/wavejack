// main.rs — Desktop entry point.
// This file is intentionally minimal — all the real logic lives in lib.rs.
// The #![cfg_attr] line hides the console window on Windows in release builds.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    wavejack_lib::run()
}
