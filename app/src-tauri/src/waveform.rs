// waveform.rs — Compute a SoundCloud-style amplitude profile for a track.
//
// Uses ffmpeg to decode the file to raw mono 8 kHz f32le PCM on stdout, then
// buckets the samples into a fixed number of slots (`BUCKETS`). For each
// bucket we keep the peak absolute amplitude and scale to 0..=255 so the
// final cache row is small and easy to draw with a canvas.

use crate::error::AppError;
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncReadExt;

pub const BUCKETS: usize = 500;
const SAMPLE_RATE: u32 = 8_000;

/// Decode `path` with ffmpeg and return a 500-byte amplitude profile.
pub async fn compute(path: &Path) -> Result<Vec<u8>, AppError> {
    let ffmpeg = which::which("ffmpeg")
        .map_err(|_| AppError::Io("ffmpeg not found on PATH".into()))?;

    let path_str = path.to_string_lossy().to_string();
    let mut child = tokio::process::Command::new(&ffmpeg)
        .args([
            "-v", "error",
            "-i", &path_str,
            "-f", "f32le",
            "-ac", "1",
            "-ar", &SAMPLE_RATE.to_string(),
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Io(format!("Failed to spawn ffmpeg: {}", e)))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Io("Failed to capture ffmpeg stdout".into()))?;

    let mut raw: Vec<u8> = Vec::new();
    stdout
        .read_to_end(&mut raw)
        .await
        .map_err(|e| AppError::Io(format!("Read ffmpeg stdout: {}", e)))?;

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::Io(format!("Wait ffmpeg: {}", e)))?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut err).await;
        }
        return Err(AppError::Io(format!("ffmpeg exited {}: {}", status, err.trim())));
    }

    // Each sample is a 4-byte little-endian f32.
    let total_samples = raw.len() / 4;
    if total_samples == 0 {
        return Ok(vec![0u8; BUCKETS]);
    }

    // Iterate without allocating an intermediate Vec<f32>.
    let bucket_size = total_samples.div_ceil(BUCKETS).max(1);
    let mut peaks = vec![0f32; BUCKETS];
    let mut i = 0usize;
    while i + 4 <= raw.len() {
        let bytes = [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
        let sample = f32::from_le_bytes(bytes).abs();
        let idx = (i / 4 / bucket_size).min(BUCKETS - 1);
        if sample > peaks[idx] {
            peaks[idx] = sample;
        }
        i += 4;
    }

    // Find max for normalization (avoid divide-by-zero on silence).
    let max_peak = peaks.iter().cloned().fold(0f32, f32::max).max(0.001);
    let bytes: Vec<u8> = peaks
        .iter()
        .map(|p| ((p / max_peak) * 255.0).round().clamp(0.0, 255.0) as u8)
        .collect();
    Ok(bytes)
}
