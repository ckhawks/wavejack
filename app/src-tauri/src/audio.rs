// audio.rs — Native audio playback so output originates from the wavejack
// process PID (instead of WebView2's audio child process). This makes the
// app's audio audible to per-window screenshare/capture tools like Discord.
//
// Pipeline:
//   file --(symphonia via rodio)--> f32 PCM --(TapSource tee)--> rodio Player
//                                                |
//                                                v
//                                          mono ring buffer
//                                                |
//                                                v   (60Hz background task)
//                                          rustfft -> log-bucketed bins
//                                                |
//                                                v
//                                      emit "audio://spectrum"
//
// Progress + ended events are emitted from the same background task using
// rodio's Player::get_pos() (monotonic playback time, freezes while paused).

use rodio::source::Source;
use rodio::stream::{DeviceSinkBuilder, MixerDeviceSink};
use rodio::{ChannelCount, Decoder, Player, SampleRate};
use rustfft::{num_complex::Complex32, FftPlanner};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::Cursor;
use std::num::NonZero;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Number of mono samples kept in the FFT ring buffer. 8192 @ 44.1kHz ≈ 186ms.
const FFT_RING_CAPACITY: usize = 8192;
/// FFT input window. 1024 = 86Hz bin spacing at 44.1kHz, ~12ms latency.
const FFT_WINDOW: usize = 1024;
/// Number of log-spaced bands the frontend renders. Matches SpectrogramBar.
const SPECTRUM_BANDS: usize = 48;

#[derive(Default)]
struct PlayerState {
    player: Option<Player>,
    /// Output device sink — holds the cpal stream alive. Dropping it stops
    /// audio entirely, so we keep one for the lifetime of a track.
    _device_sink: Option<MixerDeviceSink>,
    duration_secs: f64,
    /// Path of the currently-loaded track. Used to fire a single
    /// `audio://ended` event per natural completion.
    current_path: Option<String>,
    /// True between `audio_load` returning and the track ending naturally.
    /// Cleared on stop/load to suppress the ended event after explicit stop.
    expecting_end: bool,
    volume: f32,
}

#[derive(Clone)]
pub struct AudioPlayer {
    state: Arc<Mutex<PlayerState>>,
    fft_ring: Arc<Mutex<VecDeque<f32>>>,
    /// Source sample rate of the currently-loaded track. The FFT bucketer
    /// doesn't actually need this yet, but it's plumbed through so a future
    /// frequency-axis label can read it without re-querying the decoder.
    sample_rate: Arc<Mutex<u32>>,
}

impl AudioPlayer {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(PlayerState {
                volume: 1.0,
                ..Default::default()
            })),
            fft_ring: Arc::new(Mutex::new(VecDeque::with_capacity(FFT_RING_CAPACITY))),
            sample_rate: Arc::new(Mutex::new(44_100)),
        }
    }

    /// Spawn the background FFT + progress emitter. Call once at app startup.
    pub fn spawn_emitter(&self, app: AppHandle) {
        let state = self.state.clone();
        let ring = self.fft_ring.clone();
        let sample_rate = self.sample_rate.clone();
        std::thread::spawn(move || run_emitter_loop(app, state, ring, sample_rate));
    }
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    #[serde(rename = "currentTime")]
    current_time: f64,
    duration: f64,
}

#[derive(Serialize, Clone)]
struct SpectrumPayload {
    bins: Vec<f32>,
}

fn run_emitter_loop(
    app: AppHandle,
    state: Arc<Mutex<PlayerState>>,
    ring: Arc<Mutex<VecDeque<f32>>>,
    sample_rate: Arc<Mutex<u32>>,
) {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_WINDOW);
    let mut scratch = vec![Complex32::default(); FFT_WINDOW];
    let interval = Duration::from_millis(16);
    // Hann window precomputed once.
    let window: Vec<f32> = (0..FFT_WINDOW)
        .map(|i| {
            let x = (i as f32) / (FFT_WINDOW as f32 - 1.0);
            0.5 - 0.5 * (2.0 * std::f32::consts::PI * x).cos()
        })
        .collect();

    loop {
        std::thread::sleep(interval);

        let (current_time, duration, ended_path) = {
            let mut s = state.lock().unwrap();
            let duration = s.duration_secs;
            let pos = s
                .player
                .as_ref()
                .map(|p| p.get_pos().as_secs_f64())
                .unwrap_or(0.0);
            let current_time = if duration > 0.0 { pos.min(duration) } else { pos };
            let ended = s.player.as_ref().map(|p| p.empty()).unwrap_or(false)
                && s.expecting_end
                && s.current_path.is_some();
            let ended_path = if ended {
                s.expecting_end = false;
                s.current_path.clone()
            } else {
                None
            };
            (current_time, duration, ended_path)
        };

        let _ = app.emit(
            "audio://progress",
            ProgressPayload {
                current_time,
                duration,
            },
        );

        if let Some(path) = ended_path {
            let _ = app.emit("audio://ended", path);
        }

        let samples: Option<Vec<f32>> = {
            let r = ring.lock().unwrap();
            if r.len() >= FFT_WINDOW {
                let start = r.len() - FFT_WINDOW;
                Some(r.iter().skip(start).copied().collect())
            } else {
                None
            }
        };

        if let Some(samples) = samples {
            for (i, s) in samples.iter().enumerate() {
                scratch[i] = Complex32::new(s * window[i], 0.0);
            }
            fft.process(&mut scratch);
            let half = FFT_WINDOW / 2;
            let mut mags = Vec::with_capacity(half);
            for c in scratch.iter().take(half).skip(1) {
                mags.push((c.re * c.re + c.im * c.im).sqrt());
            }
            let bins = log_bucket(&mags, SPECTRUM_BANDS, *sample_rate.lock().unwrap());
            let _ = app.emit("audio://spectrum", SpectrumPayload { bins });
        } else {
            let _ = app.emit(
                "audio://spectrum",
                SpectrumPayload {
                    bins: vec![0.0; SPECTRUM_BANDS],
                },
            );
        }
    }
}

/// Log-bucket FFT magnitudes into `bands` perceptually-spaced bins, normalized
/// to roughly 0..1. The compression curve is eyeballed to match the look of
/// the old AnalyserNode (Uint8 dB scale).
fn log_bucket(mags: &[f32], bands: usize, _sample_rate: u32) -> Vec<f32> {
    if mags.is_empty() {
        return vec![0.0; bands];
    }
    let min_bin: f32 = 1.0;
    let max_bin = mags.len() as f32;
    let log_min = min_bin.ln();
    let log_max = max_bin.ln();
    let mut out = Vec::with_capacity(bands);
    let mut prev: f32 = min_bin;
    for i in 0..bands {
        let next = (log_min + ((i + 1) as f32 / bands as f32) * (log_max - log_min)).exp();
        let lo = prev.floor() as usize;
        let hi = (mags.len()).min((lo + 1).max(next.ceil() as usize));
        let mut peak = 0.0f32;
        for &m in &mags[lo..hi] {
            if m > peak {
                peak = m;
            }
        }
        let v = (peak / 8.0).ln_1p() / 5.0;
        out.push(v.clamp(0.0, 1.0));
        prev = next;
    }
    out
}

// ============================================================================
// TapSource — wraps a rodio Source<Item = f32> and copies a downmixed-mono
// version of each output frame into the FFT ring buffer.
// ============================================================================

struct TapSource<S: Source> {
    inner: S,
    ring: Arc<Mutex<VecDeque<f32>>>,
    channels: u16,
    /// Accumulator for the current frame's channels — emit one mono sample
    /// per `channels` worth of input.
    frame_sum: f32,
    frame_count: u16,
}

impl<S: Source> TapSource<S> {
    fn new(inner: S, ring: Arc<Mutex<VecDeque<f32>>>) -> Self {
        let channels = inner.channels().get();
        Self {
            inner,
            ring,
            channels,
            frame_sum: 0.0,
            frame_count: 0,
        }
    }
}

impl<S: Source> Iterator for TapSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let s = self.inner.next()?;
        self.frame_sum += s;
        self.frame_count += 1;
        if self.frame_count >= self.channels {
            let mono = self.frame_sum / self.channels as f32;
            self.frame_sum = 0.0;
            self.frame_count = 0;
            // try_lock so we never block the audio thread on the FFT consumer.
            if let Ok(mut r) = self.ring.try_lock() {
                if r.len() >= FFT_RING_CAPACITY {
                    r.pop_front();
                }
                r.push_back(mono);
            }
        }
        Some(s)
    }
}

impl<S: Source> Source for TapSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // Forward the seek to the wrapped decoder — the default Source impl
        // returns NotSupported, which would silently drop every seek. Reset the
        // frame accumulator and flush the FFT ring so the spectrogram doesn't
        // paint pre-seek audio after the jump.
        self.inner.try_seek(pos)?;
        self.frame_sum = 0.0;
        self.frame_count = 0;
        if let Ok(mut r) = self.ring.try_lock() {
            r.clear();
        }
        Ok(())
    }
}

// ============================================================================
// Public commands — invoked from the frontend via Tauri.
// ============================================================================

#[derive(Serialize)]
pub struct LoadResult {
    pub duration: f64,
}

#[tauri::command]
pub fn audio_load(
    path: String,
    player: tauri::State<'_, AudioPlayer>,
) -> Result<LoadResult, String> {
    // Read the whole (compressed) file into memory and decode from there so we
    // never keep an OS handle on the track. Holding the file open blocks the
    // user from editing/renaming the currently-playing track's tags — on
    // Windows the tag write hangs on our open read handle. A compressed song is
    // only a few MB, so buffering it is cheap.
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {}", path, e))?;
    let decoder = Decoder::new(Cursor::new(bytes)).map_err(|e| format!("decode: {}", e))?;
    let total_duration = decoder
        .total_duration()
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let sample_rate: NonZero<u32> = decoder.sample_rate();

    {
        let mut r = player.fft_ring.lock().unwrap();
        r.clear();
    }
    *player.sample_rate.lock().unwrap() = sample_rate.get();

    let tapped = TapSource::new(decoder, player.fft_ring.clone());

    let mut state = player.state.lock().unwrap();
    // Build the device sink fresh on each load. Holding it across loads would
    // be fine, but rebuilding lets us recover if the user changed the OS
    // default audio device since the last track.
    let device_sink = DeviceSinkBuilder::open_default_sink()
        .map_err(|e| format!("open output stream: {}", e))?;
    let new_player = Player::connect_new(device_sink.mixer());
    new_player.set_volume(state.volume);
    new_player.append(tapped);

    state.player = Some(new_player);
    state._device_sink = Some(device_sink);
    state.duration_secs = total_duration;
    state.current_path = Some(path);
    state.expecting_end = true;

    Ok(LoadResult {
        duration: total_duration,
    })
}

#[tauri::command]
pub fn audio_play(player: tauri::State<'_, AudioPlayer>) -> Result<(), String> {
    let state = player.state.lock().unwrap();
    if let Some(p) = state.player.as_ref() {
        p.play();
    }
    Ok(())
}

#[tauri::command]
pub fn audio_pause(player: tauri::State<'_, AudioPlayer>) -> Result<(), String> {
    let state = player.state.lock().unwrap();
    if let Some(p) = state.player.as_ref() {
        p.pause();
    }
    Ok(())
}

#[tauri::command]
pub fn audio_stop(player: tauri::State<'_, AudioPlayer>) -> Result<(), String> {
    let mut state = player.state.lock().unwrap();
    state.expecting_end = false;
    if let Some(p) = state.player.take() {
        p.stop();
    }
    state._device_sink = None;
    state.current_path = None;
    state.duration_secs = 0.0;
    Ok(())
}

#[tauri::command]
pub fn audio_seek(secs: f64, player: tauri::State<'_, AudioPlayer>) -> Result<(), String> {
    let state = player.state.lock().unwrap();
    if let Some(p) = state.player.as_ref() {
        let secs = secs.max(0.0);
        p.try_seek(Duration::from_secs_f64(secs))
            .map_err(|e| format!("seek: {:?}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn audio_set_volume(volume: f32, player: tauri::State<'_, AudioPlayer>) -> Result<(), String> {
    let v = volume.clamp(0.0, 1.0);
    let mut state = player.state.lock().unwrap();
    state.volume = v;
    if let Some(p) = state.player.as_ref() {
        p.set_volume(v);
    }
    Ok(())
}
