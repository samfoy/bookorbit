import { onScopeDispose, ref, shallowRef } from 'vue'

import { isValidIsbn, normalizeIsbn } from '../lib/isbn'

/**
 * Camera barcode scanning for ISBN entry.
 *
 * Design notes:
 * - The `barcode-detector` polyfill is LAZY-LOADED on first `start()`, never at
 *   module scope. It carries a WASM payload, and most sessions never open the
 *   scanner, so importing it eagerly would tax every page load.
 * - It uses the NATIVE `BarcodeDetector` where available (Android Chrome) and
 *   falls back to its ZXing/WASM implementation elsewhere. iOS Safari has no
 *   native support, which is precisely the case that matters for shelving books.
 * - Every decode is checksum-validated locally BEFORE it is surfaced, so a
 *   misread never reaches the network. Barcode scanners routinely emit a wrong
 *   digit under poor lighting, and an ISBN checksum catches the vast majority.
 * - The stream stays open after a hit so a stack of books can be scanned in one
 *   pass; the caller decides when to stop.
 *
 * Requires a secure context (HTTPS or localhost) for camera access.
 */

/** ISBN barcodes are EAN-13; the others cover older or non-standard stock. */
const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a'] as const

/** Ignore a repeat of the same code within this window (one book, many frames). */
const DUPLICATE_SUPPRESSION_MS = 2500

/** Gap between detection passes. Fast enough to feel instant, cheap on battery. */
const SCAN_INTERVAL_MS = 300

export type ScannerStatus = 'idle' | 'starting' | 'scanning' | 'error' | 'unsupported'

type DetectedBarcode = { rawValue: string }
type DetectorLike = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> }

export function useBarcodeScanner(options: { onIsbn: (isbn13: string) => void }) {
  const status = ref<ScannerStatus>('idle')
  const error = ref<string | null>(null)
  /** Raised when a decode is well-formed but fails its checksum, so the UI can
   *  say "hold steadier" rather than silently ignoring the scan. */
  const lastRejected = ref<string | null>(null)

  const videoEl = shallowRef<HTMLVideoElement | null>(null)
  let stream: MediaStream | null = null
  let detector: DetectorLike | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let canvas: HTMLCanvasElement | null = null
  const recent = new Map<string, number>()

  function isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  }

  async function loadDetector(): Promise<DetectorLike> {
    // Prefer a native implementation when the browser ships one.
    const native = (globalThis as { BarcodeDetector?: new (o: unknown) => DetectorLike }).BarcodeDetector
    if (native) return new native({ formats: [...BARCODE_FORMATS] })
    const mod = await import('barcode-detector/ponyfill')
    return new mod.BarcodeDetector({ formats: [...BARCODE_FORMATS] })
  }

  function handleRaw(raw: string) {
    const normalized = normalizeIsbn(raw)
    if (!normalized) return

    const now = Date.now()
    const seenAt = recent.get(normalized)
    if (seenAt !== undefined && now - seenAt < DUPLICATE_SUPPRESSION_MS) return
    recent.set(normalized, now)

    // Checksum gate: never let a misread reach the network.
    if (!isValidIsbn(normalized)) {
      lastRejected.value = normalized
      return
    }
    lastRejected.value = null
    options.onIsbn(normalized)
  }

  async function tick() {
    const video = videoEl.value
    if (!video || !detector || video.readyState < 2) return
    if (!canvas) canvas = document.createElement('canvas')
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, width, height)
    try {
      const results = await detector.detect(canvas)
      for (const r of results) handleRaw(r.rawValue)
    } catch {
      // A single failed frame is normal (motion blur, partial barcode). Keep going.
    }
  }

  async function start(): Promise<void> {
    if (status.value === 'scanning' || status.value === 'starting') return
    if (!isSupported()) {
      status.value = 'unsupported'
      error.value = 'Camera access is not available in this browser.'
      return
    }
    status.value = 'starting'
    error.value = null
    try {
      detector = await loadDetector()
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      const video = videoEl.value
      if (video) {
        video.srcObject = stream
        await video.play().catch(() => undefined)
      }
      timer = setInterval(() => void tick(), SCAN_INTERVAL_MS)
      status.value = 'scanning'
    } catch (err) {
      status.value = 'error'
      const name = (err as { name?: string } | null)?.name
      error.value =
        name === 'NotAllowedError'
          ? 'Camera permission was denied. Enter the ISBN by hand instead.'
          : name === 'NotFoundError'
            ? 'No camera found on this device.'
            : 'Could not start the camera.'
      stop()
    }
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    const video = videoEl.value
    if (video) video.srcObject = null
    recent.clear()
    if (status.value === 'scanning' || status.value === 'starting') status.value = 'idle'
  }

  // Release the camera if the component unmounts while scanning; a live stream
  // keeps the device's camera indicator on and drains battery.
  onScopeDispose(stop)

  return { status, error, lastRejected, videoEl, start, stop, isSupported }
}
