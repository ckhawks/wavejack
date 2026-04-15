import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../stores/playerStore";

const HEIGHT = 28;
const BANDS = 48;

// Module-level singleton — MediaElementSource captures the audio element's
// output exclusively, so we MUST re-connect it through the AnalyserNode to
// the AudioContext destination, and the context MUST be resumed inside a
// user-gesture callback for any sound to come out.
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
const attached = new WeakSet<HTMLAudioElement>();

/** Synchronous setup — must be called inside a user-gesture handler so that
 * resume() is treated as gesture-initiated. Returns the analyser immediately. */
function getOrCreateAnalyser(audio: HTMLAudioElement): AnalyserNode | null {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new Ctx();
    }
    // Kick resume synchronously; don't await (preserves gesture activation).
    if (audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
    }
    if (!attached.has(audio)) {
      const source = audioCtx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      attached.add(audio);
    }
    return analyser;
  } catch (e) {
    console.error("Spectrogram analyser setup failed:", e);
    return null;
  }
}

/** Bucket linear FFT bins into BANDS log-spaced bands so bass/mid/treble feel
 * balanced (linear bins overweight high frequencies). Returns 0..=1 per band. */
function bucketLogBands(freqData: Uint8Array, bands: number): number[] {
  const bins = freqData.length;
  const out = new Array<number>(bands);
  const minF = 1; // skip DC
  const maxF = bins;
  const logMin = Math.log(minF);
  const logMax = Math.log(maxF);
  let prev = minF;
  for (let i = 0; i < bands; i++) {
    const next = Math.exp(logMin + ((i + 1) / bands) * (logMax - logMin));
    const lo = Math.floor(prev);
    const hi = Math.min(bins, Math.max(lo + 1, Math.ceil(next)));
    let peak = 0;
    for (let j = lo; j < hi; j++) {
      if (freqData[j] > peak) peak = freqData[j];
    }
    out[i] = peak / 255;
    prev = next;
  }
  return out;
}

export function SpectrogramBar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!currentTrack) return;
    const audio = document.querySelector("audio");
    if (!audio) return;
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(HEIGHT * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let node: AnalyserNode | null = null;
    let freqData: Uint8Array | null = null;

    const drawIdle = () => {
      ctx.clearRect(0, 0, width, HEIGHT);
    };

    const draw = () => {
      if (!node || !freqData) return;
      node.getByteFrequencyData(freqData as Uint8Array<ArrayBuffer>);
      const bands = bucketLogBands(freqData, BANDS);

      ctx.clearRect(0, 0, width, HEIGHT);
      const gap = 1;
      const barW = Math.max(1, (width - (BANDS - 1) * gap) / BANDS);
      for (let i = 0; i < BANDS; i++) {
        const v = bands[i];
        const h = Math.max(1, v * HEIGHT);
        const x = i * (barW + gap);
        const y = HEIGHT - h;
        const hue = 280 - (i / BANDS) * 200;
        ctx.fillStyle = `hsl(${hue}, 70%, ${30 + v * 40}%)`;
        ctx.fillRect(x, y, barW, h);
      }
      raf = requestAnimationFrame(draw);
    };

    // Defer Web Audio attachment until the audio element actually plays —
    // browsers reroute the output through the AudioContext, which must be
    // running (which requires a user gesture). Hooking the `play` event
    // guarantees we're in a user-gesture context.
    const onPlay = () => {
      node = getOrCreateAnalyser(audio);
      if (!node) return;
      if (audioCtx && audioCtx.state === "suspended") {
        void audioCtx.resume();
      }
      if (!freqData) freqData = new Uint8Array(new ArrayBuffer(node.frequencyBinCount));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("playing", onPlay);
    // If we mount mid-play (track switch with autoplay), kick off immediately
    if (!audio.paused) onPlay();
    else drawIdle();

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("playing", onPlay);
      cancelAnimationFrame(raf);
    };
    // Re-run only when the audio element identity could change (currentTrack
    // appears/disappears) or the canvas resizes — NOT on filePath/isPlaying,
    // which would tear down listeners around the play event and miss it on
    // subsequent tracks.
  }, [currentTrack ? "yes" : "no", width]);

  if (!currentTrack) return null;

  return (
    <div
      ref={containerRef}
      className="border-t border-[#222] bg-[#0a0a0a] px-4"
      style={{ height: HEIGHT }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: HEIGHT, display: "block" }} />
    </div>
  );
}
