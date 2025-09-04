#include <AudioToolbox/AudioToolbox.h>
#include <AudioUnit/AudioUnit.h>
#include <CoreAudio/CoreAudioTypes.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <stdio.h>
#include <stdatomic.h>

// Simple C helper that wraps VoiceProcessingIO (AEC) and exposes a tiny C API
// for Python to call via ctypes without RT callbacks crossing the boundary.

// Forward declarations for functions used before their definitions
int vpio_start_stream(double sample_rate, int channels, size_t ring_capacity_bytes);
void vpio_stop_stream(void);
int vpio_start_playback_thread(int slice_ms, int preroll_ms);
void vpio_stop_playback_thread(void);

static AudioUnit gAudioUnit = NULL;
static double gSampleRate = 16000.0;
static int gChannels = 1;
static const int kBytesPerSample = 2; // SInt16

typedef enum { MODE_IDLE = 0, MODE_RECORD = 1, MODE_PLAY = 2 } Mode;
static _Atomic Mode gMode = MODE_IDLE;
static int gTrace = 0; // enable verbose logs if VPIO_TRACE is set

// Capture buffer
static unsigned char *gCapture = NULL;
static size_t gCaptureSize = 0;
static size_t gCaptureCap = 0;
// Streaming capture ring
static unsigned char *gCapRing = NULL;
static size_t gCapCap = 0;
static _Atomic size_t gCapW = 0; // write counter (bytes)
static _Atomic size_t gCapR = 0; // read counter (bytes)

// Playback buffer
static unsigned char *gPlay = NULL;
static size_t gPlayLen = 0;
static volatile size_t gPlayOff = 0;
// Streaming playback ring
static unsigned char *gPlayRing = NULL;
static size_t gPlayCap = 0;
static _Atomic size_t gPlayW = 0;
static _Atomic size_t gPlayR = 0;
static _Atomic size_t gUnderflowEvents = 0; // count render underflow events
// Track render pull sizes to size headroom
static _Atomic size_t gRenderLastBytes = 0;
static _Atomic size_t gRenderMaxBytes = 0;

// Staging ring for incoming 10ms frames; helper thread slices to ~5ms
static unsigned char *gInRing = NULL; // staging ring for 10ms frames
static size_t gInCap = 0;
static _Atomic size_t gInW = 0;
static _Atomic size_t gInR = 0;
static pthread_mutex_t gInLock;      // protects resizing and read/write to gInRing
static int gInLockInit = 0;

// Playback thread control
static pthread_t gPlayThread;
static _Atomic int gPlayThreadRun = 0;
static int gSliceMs = 5;        // pacing slice in ms
static int gPrerollMs = 40;     // preroll before steady pacing
static int gHeadroomMs = 10;    // target minimum headroom during steady state
static int gDidPreroll = 0;
// Render guard multiplier for sizing target against max observed pull
static double gRenderGuardMult = 1.5; // tighter than previous 2.0 for lower latency

// Note: we no longer implement any burst logic or drop policy.

// Ensure staging ring has at least `add` free bytes; if not, grow it.
static int ensure_inring_space(size_t add) {
  // Lock is held by caller
  size_t inW = atomic_load_explicit(&gInW, memory_order_acquire);
  size_t inR = atomic_load_explicit(&gInR, memory_order_acquire);
  size_t used = inW - inR;
  size_t freeBytes = (gInCap > used) ? (gInCap - used) : 0;
  if (add <= freeBytes) return 1;
  // Grow: new capacity at least used+add, plus slack (double or +50%).
  size_t need = used + add;
  size_t newCap = gInCap ? (gInCap * 2) : need;
  if (newCap < need) newCap = need;
  if (newCap < (size_t)(need + need / 2)) newCap = need + need / 2;
  unsigned char* p = (unsigned char*)malloc(newCap);
  if (!p) return 0;
  // Copy existing data in order into new buffer at offset 0
  if (used > 0 && gInRing && gInCap) {
    size_t ridx = inR % gInCap;
    size_t first = gInCap - ridx; if (first > used) first = used;
    memcpy(p, gInRing + ridx, first);
    if (used > first) memcpy(p + first, gInRing, used - first);
  }
  // Swap and reset indices
  if (gInRing) free(gInRing);
  gInRing = p;
  gInCap = newCap;
  atomic_store_explicit(&gInR, 0, memory_order_release);
  atomic_store_explicit(&gInW, used, memory_order_release);
  if (gTrace) fprintf(stderr, "[VPIO-PLAY] inRing grown to %zu bytes (used=%zu)\n", gInCap, used);
  return 1;
}

static size_t bytes_per_ms(void) {
  size_t bps = (size_t)(gSampleRate * (kBytesPerSample * gChannels));
  // Divide by 1000 safely (integer math; for 16k this is exact: 32 bytes/ms)
  return bps / 1000;
}

static size_t write_play_ring(const unsigned char* src, size_t len) {
  if (!gPlayRing || gPlayCap == 0 || len == 0) return 0;
  size_t playW = atomic_load_explicit(&gPlayW, memory_order_acquire);
  size_t playR = atomic_load_explicit(&gPlayR, memory_order_acquire);
  size_t freeBytes = (gPlayCap > (playW - playR)) ? (gPlayCap - (playW - playR)) : 0;
  size_t n = (len < freeBytes) ? len : freeBytes;
  if (n == 0) return 0;
  size_t widx = playW % gPlayCap;
  size_t first = gPlayCap - widx; if (first > n) first = n;
  memcpy(gPlayRing + widx, src, first);
  if (n > first) memcpy(gPlayRing, src + first, n - first);
  atomic_store_explicit(&gPlayW, playW + n, memory_order_release);
  return n;
}

static size_t copy_from_staging_to_play(size_t nbytes) {
  if (!gInRing || gInCap == 0 || nbytes == 0) return 0;
  pthread_mutex_lock(&gInLock);
  size_t inW = atomic_load_explicit(&gInW, memory_order_acquire);
  size_t inR = atomic_load_explicit(&gInR, memory_order_acquire);
  size_t avail_in = inW - inR;
  size_t playW = atomic_load_explicit(&gPlayW, memory_order_acquire);
  size_t playR = atomic_load_explicit(&gPlayR, memory_order_acquire);
  size_t free_play = (gPlayCap > (playW - playR)) ? (gPlayCap - (playW - playR)) : 0;
  size_t n = nbytes;
  if (n > avail_in) n = avail_in;
  if (n > free_play) n = free_play;
  if (n == 0) { pthread_mutex_unlock(&gInLock); return 0; }
  size_t ridx = inR % gInCap;
  size_t first = gInCap - ridx; if (first > n) first = n;
  size_t wrote = 0;
  wrote += write_play_ring(gInRing + ridx, first);
  if (n > first) wrote += write_play_ring(gInRing, n - first);
  // Advance read by the amount we actually committed to play
  atomic_store_explicit(&gInR, inR + wrote, memory_order_release);
  pthread_mutex_unlock(&gInLock);
  return wrote;
}

static void* playback_thread_fn(void* arg) {
#if defined(__APPLE__)
  pthread_setname_np("vpio-play");
#endif
  const size_t b_per_ms = bytes_per_ms();
  const size_t slice_bytes = b_per_ms * (size_t)gSliceMs;
  gDidPreroll = 0;
  unsigned long _vpio_iter = 0; // for periodic logs
  while (atomic_load_explicit(&gPlayThreadRun, memory_order_acquire)) {
    // If nothing in play ring, consider this a new segment: re-preroll
    size_t _pw = atomic_load_explicit(&gPlayW, memory_order_acquire);
    size_t _pr = atomic_load_explicit(&gPlayR, memory_order_acquire);
    if ((_pw - _pr) == 0) {
      if (gDidPreroll && gTrace) fprintf(stderr, "[VPIO-PLAY] drained; re-preroll\n");
      gDidPreroll = 0;
    }

    if (!gDidPreroll) {
      size_t need = (size_t)gPrerollMs * b_per_ms;
      size_t have = (atomic_load_explicit(&gPlayW, memory_order_acquire) - atomic_load_explicit(&gPlayR, memory_order_acquire));
      if (have < need) {
        size_t to_pull = need - have;
        size_t got = copy_from_staging_to_play(to_pull);
        if (gTrace) {
          size_t inLevel = (gInW - gInR);
          size_t playLevel = (gPlayW - gPlayR);
          fprintf(stderr, "[VPIO-PLAY] preroll need=%zu wrote=%zu in=%zu play=%zu\n", to_pull, got, inLevel, playLevel);
        }
        if (got == 0) {
          // Wait for more input
          usleep((useconds_t)(gSliceMs * 1000));
        }
        continue; // loop until preroll satisfied
      }
      gDidPreroll = 1;
      if (gTrace) fprintf(stderr, "[VPIO-PLAY] preroll satisfied at %d ms\n", gPrerollMs);
      continue;
    }

    // Maintain continuous headroom; top up to a target level
    size_t level = (atomic_load_explicit(&gPlayW, memory_order_acquire) - atomic_load_explicit(&gPlayR, memory_order_acquire));
    size_t head_bytes = (size_t)gHeadroomMs * b_per_ms;
    size_t render_guard = (size_t)((double)gRenderMaxBytes * gRenderGuardMult); // cushion for occasional larger pulls
    size_t target = head_bytes;
    if (render_guard > target) target = render_guard;
    // keep at least one extra slice beyond the target
    size_t desired = target + slice_bytes;
    if (level < desired) {
      size_t need = desired - level;
      size_t got = copy_from_staging_to_play(need);
      if (gTrace) {
        size_t inLevel = (atomic_load_explicit(&gInW, memory_order_acquire) - atomic_load_explicit(&gInR, memory_order_acquire));
        size_t playLevel = (atomic_load_explicit(&gPlayW, memory_order_acquire) - atomic_load_explicit(&gPlayR, memory_order_acquire));
        fprintf(stderr, "[VPIO-PLAY] topup need=%zu wrote=%zu in=%zu play=%zu\n", need, got, inLevel, playLevel);
      }
      if (got == 0) {
        // No input yet; small wait
        usleep((useconds_t)(gSliceMs * 1000));
      }
    }

    // Steady pacing: optional small feed
    size_t _w = copy_from_staging_to_play(slice_bytes);
    if (gTrace) {
      _vpio_iter++;
      unsigned long period = (unsigned long)(200 / (gSliceMs > 0 ? gSliceMs : 5));
      if (period == 0) period = 40;
      if ((_vpio_iter % period) == 0) {
        size_t inLevel = (atomic_load_explicit(&gInW, memory_order_acquire) - atomic_load_explicit(&gInR, memory_order_acquire));
        size_t _wcur = atomic_load_explicit(&gPlayW, memory_order_acquire);
        size_t _rcur = atomic_load_explicit(&gPlayR, memory_order_acquire);
        size_t playLevel = (_wcur - _rcur);
        size_t freePlay = (gPlayCap > playLevel) ? (gPlayCap - playLevel) : 0;
        size_t rlast = atomic_load_explicit(&gRenderLastBytes, memory_order_acquire);
        size_t rmax = atomic_load_explicit(&gRenderMaxBytes, memory_order_acquire);
        fprintf(stderr, "[VPIO-PLAY] steady wrote=%zu in=%zu play=%zu free=%zu rlast=%zu rmax=%zu\n", _w, inLevel, playLevel, freePlay, rlast, rmax);
      }
    }
    // Normal pace sleep
    usleep((useconds_t)(gSliceMs * 1000));
  }
  return NULL;
}

static OSStatus render_cb(void *inRefCon,
                          AudioUnitRenderActionFlags *ioActionFlags,
                          const AudioTimeStamp *inTimeStamp,
                          UInt32 inBusNumber,
                          UInt32 inNumberFrames,
                          AudioBufferList *ioData) {
  if (!ioData || ioData->mNumberBuffers < 1) return noErr;
  AudioBuffer *buf = &ioData->mBuffers[0];
  UInt32 bytesNeeded = inNumberFrames * (UInt32)(kBytesPerSample * gChannels);
  if (!buf->mData) return noErr;
  atomic_store_explicit(&gRenderLastBytes, bytesNeeded, memory_order_release);
  size_t _rmax = atomic_load_explicit(&gRenderMaxBytes, memory_order_acquire);
  if (bytesNeeded > _rmax) atomic_store_explicit(&gRenderMaxBytes, bytesNeeded, memory_order_release);
  // Periodically decay the max to avoid a single spike inflating headroom forever.
  {
    static unsigned decay_counter = 0;
    if ((++decay_counter % 100) == 0) {
      size_t cur = atomic_load_explicit(&gRenderMaxBytes, memory_order_acquire);
      if (cur > 0) {
        size_t decayed = cur - (cur / 50); // ~2% decay
        if (decayed < bytesNeeded) decayed = bytesNeeded;
        atomic_store_explicit(&gRenderMaxBytes, decayed, memory_order_release);
      }
    }
  }

  if (atomic_load_explicit(&gMode, memory_order_acquire) == MODE_PLAY && gPlay && gPlayOff < gPlayLen) {
    size_t remaining = gPlayLen - gPlayOff;
    size_t toCopy = bytesNeeded < remaining ? bytesNeeded : remaining;
    memcpy(buf->mData, gPlay + gPlayOff, toCopy);
    gPlayOff += toCopy;
    if (toCopy < bytesNeeded) {
      memset((unsigned char *)buf->mData + toCopy, 0, bytesNeeded - toCopy);
    }
    buf->mDataByteSize = bytesNeeded;
  } else {
    // Streaming playback ring
    size_t avail = atomic_load_explicit(&gPlayW, memory_order_acquire) - atomic_load_explicit(&gPlayR, memory_order_acquire);
    size_t toCopy = (avail < bytesNeeded) ? avail : bytesNeeded;
    if (toCopy > 0 && gPlayRing && gPlayCap) {
      size_t playR = atomic_load_explicit(&gPlayR, memory_order_acquire);
      size_t ridx = playR % gPlayCap;
      size_t first = gPlayCap - ridx;
      if (first > toCopy) first = toCopy;
      memcpy(buf->mData, gPlayRing + ridx, first);
      if (toCopy > first) memcpy((unsigned char*)buf->mData + first, gPlayRing, toCopy - first);
      atomic_store_explicit(&gPlayR, playR + toCopy, memory_order_release);
    }
    if (toCopy < bytesNeeded) memset((unsigned char*)buf->mData + toCopy, 0, bytesNeeded - toCopy);
    buf->mDataByteSize = bytesNeeded;
    if (toCopy < bytesNeeded) {
      atomic_fetch_add_explicit(&gUnderflowEvents, 1, memory_order_relaxed);
    }
  }
  return noErr;
}

static int append_capture(const void *src, size_t len) {
  if (!len) return 0;
  if (gCaptureSize + len > gCaptureCap) {
    size_t newCap = gCaptureCap ? gCaptureCap * 2 : (len * 2);
    if (newCap < gCaptureSize + len) newCap = gCaptureSize + len;
    void *p = realloc(gCapture, newCap);
    if (!p) return -1;
    gCapture = (unsigned char *)p;
    gCaptureCap = newCap;
  }
  memcpy(gCapture + gCaptureSize, src, len);
  gCaptureSize += len;
  return 0;
}

// Reusable input scratch buffer to avoid per-callback malloc/free
static unsigned char* gInputScratch = NULL;
static size_t gInputScratchCap = 0;

static OSStatus input_cb(void *inRefCon,
                         AudioUnitRenderActionFlags *ioActionFlags,
                         const AudioTimeStamp *inTimeStamp,
                         UInt32 inBusNumber,
                         UInt32 inNumberFrames,
                         AudioBufferList *ioData) {
  if (atomic_load_explicit(&gMode, memory_order_acquire) != MODE_RECORD) return noErr;

  UInt32 byteCount = inNumberFrames * (UInt32)(kBytesPerSample * gChannels);
  AudioBuffer buffer;
  buffer.mNumberChannels = (UInt32)gChannels;
  buffer.mDataByteSize = byteCount;
  if (gInputScratchCap < byteCount) {
    unsigned char* p = (unsigned char*)realloc(gInputScratch, byteCount);
    if (!p) return noErr; // drop frame on allocation failure
    gInputScratch = p;
    gInputScratchCap = byteCount;
  }
  buffer.mData = gInputScratch;
  AudioBufferList bl;
  bl.mNumberBuffers = 1;
  bl.mBuffers[0] = buffer;

  OSStatus st = AudioUnitRender(gAudioUnit, ioActionFlags, inTimeStamp, 1,
                                inNumberFrames, &bl);
  if (st == noErr) {
    // Append to streaming capture ring
    if (gCapRing && gCapCap) {
      size_t capW = atomic_load_explicit(&gCapW, memory_order_acquire);
      size_t capR = atomic_load_explicit(&gCapR, memory_order_acquire);
      size_t freeBytes = (gCapCap > (capW - capR)) ? (gCapCap - (capW - capR)) : 0;
      if (byteCount > freeBytes) {
        size_t need = byteCount - freeBytes;
        atomic_store_explicit(&gCapR, capR + need, memory_order_release); // drop oldest
        capR += need;
      }
      size_t widx = capW % gCapCap;
      size_t first = gCapCap - widx;
      if (first > byteCount) first = byteCount;
      memcpy(gCapRing + widx, buffer.mData, first);
      if (byteCount > first) memcpy(gCapRing, (unsigned char*)buffer.mData + first, byteCount - first);
      atomic_store_explicit(&gCapW, capW + byteCount, memory_order_release);
    }
    // Also keep simple capture for legacy API
    append_capture(buffer.mData, byteCount);
  }
  return st;
}

static UInt32 fourcc(const char s[4]) {
  return ((UInt32)s[0] << 24) | ((UInt32)s[1] << 16) | ((UInt32)s[2] << 8) |
         (UInt32)s[3];
}

int vpio_init(double sample_rate, int channels) {
  if (gAudioUnit) return 0;
  gSampleRate = sample_rate;
  // Force mono for VoiceProcessingIO
  gChannels = 1;
  // Check env for tracing
  const char* tr = getenv("VPIO_TRACE");
  if (tr && tr[0] != '\0' && tr[0] != '0') gTrace = 1;
  // Optional render guard multiplier (e.g., 1.25..2.0)
  {
    const char* rg = getenv("VPIO_RENDER_GUARD_MULT");
    if (rg && rg[0] != '\0') {
      double v = atof(rg);
      if (v < 1.0) v = 1.0;
      if (v > 4.0) v = 4.0;
      gRenderGuardMult = v;
    }
  }
  // Optional tunables for burst top-up behavior
  // No burst or overflow policy configuration: staging grows dynamically.

  AudioComponentDescription desc;
  desc.componentType = fourcc("auou");
  desc.componentSubType = fourcc("vpio");
  desc.componentManufacturer = fourcc("appl");
  desc.componentFlags = 0;
  desc.componentFlagsMask = 0;

  AudioComponent comp = AudioComponentFindNext(NULL, &desc);
  if (!comp) return -1;
  OSStatus st = AudioComponentInstanceNew(comp, &gAudioUnit);
  if (st != noErr) return (int)st;

  UInt32 one = 1;
  st = AudioUnitSetProperty(gAudioUnit, kAudioOutputUnitProperty_EnableIO,
                            kAudioUnitScope_Input, 1, &one, sizeof(one));
  if (st != noErr) return (int)st;
  st = AudioUnitSetProperty(gAudioUnit, kAudioOutputUnitProperty_EnableIO,
                            kAudioUnitScope_Output, 0, &one, sizeof(one));
  if (st != noErr) return (int)st;

  // Ensure voice processing (AEC/NS/HPF) is enabled (i.e., bypass disabled)
  {
    UInt32 bypass = 0; // 0 = enable processing, 1 = bypass
    OSStatus st2 = AudioUnitSetProperty(gAudioUnit,
                                        kAUVoiceIOProperty_BypassVoiceProcessing,
                                        kAudioUnitScope_Global,
                                        0,
                                        &bypass,
                                        sizeof(bypass));
    if (st2 != noErr && gTrace) {
      fprintf(stderr, "[VPIO] Warning: failed to set BypassVoiceProcessing (st=%d)\n", (int)st2);
    }
  }

  AudioStreamBasicDescription asbd;
  memset(&asbd, 0, sizeof(asbd));
  asbd.mSampleRate = gSampleRate;
  asbd.mFormatID = kAudioFormatLinearPCM;
  asbd.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
  asbd.mBytesPerPacket = (UInt32)(kBytesPerSample * gChannels);
  asbd.mFramesPerPacket = 1;
  asbd.mBytesPerFrame = (UInt32)(kBytesPerSample * gChannels);
  asbd.mChannelsPerFrame = (UInt32)gChannels;
  asbd.mBitsPerChannel = (UInt32)(kBytesPerSample * 8);

  st = AudioUnitSetProperty(gAudioUnit, kAudioUnitProperty_StreamFormat,
                            kAudioUnitScope_Output, 1, &asbd, sizeof(asbd));
  if (st != noErr) return (int)st;
  st = AudioUnitSetProperty(gAudioUnit, kAudioUnitProperty_StreamFormat,
                            kAudioUnitScope_Input, 0, &asbd, sizeof(asbd));
  if (st != noErr) return (int)st;

  AURenderCallbackStruct rcb;
  rcb.inputProc = render_cb;
  rcb.inputProcRefCon = NULL;
  st = AudioUnitSetProperty(gAudioUnit, kAudioUnitProperty_SetRenderCallback,
                            kAudioUnitScope_Input, 0, &rcb, sizeof(rcb));
  if (st != noErr) return (int)st;

  AURenderCallbackStruct icb;
  icb.inputProc = input_cb;
  icb.inputProcRefCon = NULL;
  st = AudioUnitSetProperty(gAudioUnit,
                            kAudioOutputUnitProperty_SetInputCallback,
                            kAudioUnitScope_Global, 0, &icb, sizeof(icb));
  if (st != noErr) return (int)st;

  // Pre-initialize: set a tight MaximumFramesPerSlice (~10ms) so CoreAudio
  // honors smaller render pulls from the start.
  {
    UInt32 maxFrames = (UInt32)((gSampleRate / 1000.0) * 10.0); // ~10ms
    if (maxFrames < 80) maxFrames = 80; // at least ~5ms at 16k
    OSStatus pst = AudioUnitSetProperty(gAudioUnit,
                         kAudioUnitProperty_MaximumFramesPerSlice,
                         kAudioUnitScope_Global,
                         0,
                         &maxFrames,
                         sizeof(maxFrames));
    if (pst != noErr && gTrace) fprintf(stderr, "[VPIO] pre-init MaxFramesPerSlice set failed (st=%d)\n", (int)pst);
  }

  st = AudioUnitInitialize(gAudioUnit);
  // Tighter maximum frames per slice to reduce large render pulls (target ~10ms)
  {
    UInt32 maxFrames = (UInt32)((gSampleRate / 1000.0) * 10.0); // ~10ms
    if (maxFrames < 80) maxFrames = 80; // at least ~5ms at 16k
    OSStatus pst = AudioUnitSetProperty(gAudioUnit,
                         kAudioUnitProperty_MaximumFramesPerSlice,
                         kAudioUnitScope_Global,
                         0,
                         &maxFrames,
                         sizeof(maxFrames));
    if (pst != noErr && gTrace) fprintf(stderr, "[VPIO] post-init MaxFramesPerSlice set failed (st=%d)\n", (int)pst);
  }
  if (st != noErr) { if (gTrace) fprintf(stderr, "[VPIO] AudioUnitInitialize failed (st=%d)\n", (int)st); return (int)st; }
  st = AudioOutputUnitStart(gAudioUnit);
  if (st != noErr) { if (gTrace) fprintf(stderr, "[VPIO] AudioOutputUnitStart failed (st=%d)\n", (int)st); return (int)st; }
  atomic_store_explicit(&gMode, MODE_IDLE, memory_order_release);
  return 0;
}

int vpio_start_stream(double sample_rate, int channels, size_t ring_capacity_bytes) {
  int rc = vpio_init(sample_rate, channels);
  if (rc != 0) return rc;
  // Allocate rings
  if (ring_capacity_bytes < (size_t)(sample_rate * channels * kBytesPerSample)) {
    ring_capacity_bytes = (size_t)(sample_rate * channels * kBytesPerSample);
  }
  gCapRing = (unsigned char*)malloc(ring_capacity_bytes);
  gCapCap = ring_capacity_bytes;
  if (!gCapRing) { vpio_stop_stream(); return -1; }
  atomic_store_explicit(&gCapW, 0, memory_order_release);
  atomic_store_explicit(&gCapR, 0, memory_order_release);

  gPlayRing = (unsigned char*)malloc(ring_capacity_bytes);
  gPlayCap = ring_capacity_bytes;
  if (!gPlayRing) { vpio_stop_stream(); return -1; }
  atomic_store_explicit(&gPlayW, 0, memory_order_release);
  atomic_store_explicit(&gPlayR, 0, memory_order_release);
  // staging ring for input frames (10ms)
  gInRing = (unsigned char*)malloc(ring_capacity_bytes);
  gInCap = ring_capacity_bytes;
  if (!gInRing) { vpio_stop_stream(); return -1; }
  atomic_store_explicit(&gInW, 0, memory_order_release);
  atomic_store_explicit(&gInR, 0, memory_order_release);
  if (!gInLockInit) { pthread_mutex_init(&gInLock, NULL); gInLockInit = 1; }
  // Always be in record mode for streaming (AEC engaged)
  atomic_store_explicit(&gMode, MODE_RECORD, memory_order_release);
  return 0;
}

void vpio_stop_stream(void) {
  // Stop playback thread if running
  if (atomic_load_explicit(&gPlayThreadRun, memory_order_acquire)) {
    vpio_stop_playback_thread();
  }
  atomic_store_explicit(&gMode, MODE_IDLE, memory_order_release);
  if (gCapRing) { free(gCapRing); gCapRing = NULL; }
  gCapCap = 0; atomic_store_explicit(&gCapW, 0, memory_order_release); atomic_store_explicit(&gCapR, 0, memory_order_release);
  if (gPlayRing) { free(gPlayRing); gPlayRing = NULL; }
  gPlayCap = 0; atomic_store_explicit(&gPlayW, 0, memory_order_release); atomic_store_explicit(&gPlayR, 0, memory_order_release);
  if (gInRing) { free(gInRing); gInRing = NULL; }
  gInCap = 0; atomic_store_explicit(&gInW, 0, memory_order_release); atomic_store_explicit(&gInR, 0, memory_order_release);
  if (gInLockInit) { pthread_mutex_destroy(&gInLock); gInLockInit = 0; }
}

size_t vpio_read_capture(void* dst, size_t maxlen) {
  if (!gCapRing || gCapCap == 0 || maxlen == 0) return 0;
  size_t avail = atomic_load_explicit(&gCapW, memory_order_acquire) - atomic_load_explicit(&gCapR, memory_order_acquire);
  size_t n = (avail < maxlen) ? avail : maxlen;
  if (n == 0) return 0;
  size_t capR = atomic_load_explicit(&gCapR, memory_order_acquire);
  size_t ridx = capR % gCapCap;
  size_t first = gCapCap - ridx; if (first > n) first = n;
  memcpy(dst, gCapRing + ridx, first);
  if (n > first) memcpy((unsigned char*)dst + first, gCapRing, n - first);
  atomic_store_explicit(&gCapR, capR + n, memory_order_release);
  return n;
}

size_t vpio_write_playback(const void* src, size_t len) {
  if (!gPlayRing || gPlayCap == 0 || len == 0) return 0;
  // Make room if needed
  size_t playW = atomic_load_explicit(&gPlayW, memory_order_acquire);
  size_t playR = atomic_load_explicit(&gPlayR, memory_order_acquire);
  size_t freeBytes = (gPlayCap > (playW - playR)) ? (gPlayCap - (playW - playR)) : 0;
  if (len > freeBytes) {
    size_t need = len - freeBytes;
    // drop oldest
    atomic_store_explicit(&gPlayR, playR + need, memory_order_release);
    playR += need;
  }
  playW = atomic_load_explicit(&gPlayW, memory_order_acquire);
  size_t widx = playW % gPlayCap;
  size_t first = gPlayCap - widx; if (first > len) first = len;
  memcpy(gPlayRing + widx, src, first);
  if (len > first) memcpy(gPlayRing, (const unsigned char*)src + first, len - first);
  atomic_store_explicit(&gPlayW, playW + len, memory_order_release);
  return len;
}

void vpio_flush_playback(void) {
  // Drop all pending playback in streaming ring immediately
  size_t playW = atomic_load_explicit(&gPlayW, memory_order_acquire);
  atomic_store_explicit(&gPlayR, playW, memory_order_release);
}

void vpio_flush_input(void) {
  // Drop all pending data in staging ring immediately
  pthread_mutex_lock(&gInLock);
  size_t inW = atomic_load_explicit(&gInW, memory_order_acquire);
  atomic_store_explicit(&gInR, inW, memory_order_release);
  pthread_mutex_unlock(&gInLock);
}

size_t vpio_get_underflow_count(void) {
  return atomic_load_explicit(&gUnderflowEvents, memory_order_acquire);
}

void vpio_reset_underflow_count(void) {
  atomic_store_explicit(&gUnderflowEvents, 0, memory_order_release);
}

int vpio_record(double seconds) {
  if (!gAudioUnit) return -1;
  atomic_store_explicit(&gMode, MODE_RECORD, memory_order_release);
  gCaptureSize = 0;
  double elapsed = 0.0;
  while (elapsed < seconds) {
    usleep(10 * 1000); // 10ms
    elapsed += 0.01;
  }
  atomic_store_explicit(&gMode, MODE_IDLE, memory_order_release);
  return 0;
}

size_t vpio_get_capture_size(void) { return gCaptureSize; }

size_t vpio_copy_capture(void *dst, size_t maxlen) {
  size_t n = (gCaptureSize < maxlen) ? gCaptureSize : maxlen;
  if (n && dst) memcpy(dst, gCapture, n);
  return n;
}

size_t vpio_reset_capture(void) {
  gCaptureSize = 0;
  return 0;
}

int vpio_play(const void *data, size_t len) {
  if (!gAudioUnit) return -1;
  if (gPlay) {
    free(gPlay);
    gPlay = NULL;
    gPlayLen = 0;
    gPlayOff = 0;
  }
  gPlay = (unsigned char *)malloc(len);
  if (!gPlay) return -1;
  memcpy(gPlay, data, len);
  gPlayLen = len;
  gPlayOff = 0;
  atomic_store_explicit(&gMode, MODE_PLAY, memory_order_release);

  // Wait until played (approx)
  size_t bytesPerSec = (size_t)(gSampleRate * (kBytesPerSample * gChannels));
  double secs = (double)len / (double)bytesPerSec;
  double elapsed = 0.0;
  while (elapsed < secs && gPlayOff < gPlayLen) {
    usleep(10 * 1000);
    elapsed += 0.01;
  }
  atomic_store_explicit(&gMode, MODE_IDLE, memory_order_release);
  return 0;
}

void vpio_shutdown(void) {
  if (gAudioUnit) {
    AudioOutputUnitStop(gAudioUnit);
    AudioUnitUninitialize(gAudioUnit);
    AudioComponentInstanceDispose(gAudioUnit);
    gAudioUnit = NULL;
  }
  // Free streaming rings
  if (gCapRing) { free(gCapRing); gCapRing = NULL; }
  gCapCap = 0; gCapW = gCapR = 0;
  if (gPlayRing) { free(gPlayRing); gPlayRing = NULL; }
  gPlayCap = 0; gPlayW = gPlayR = 0;
  if (gInRing) { free(gInRing); gInRing = NULL; }
  gInCap = 0; gInW = gInR = 0;
  if (gInLockInit) { pthread_mutex_destroy(&gInLock); gInLockInit = 0; }
  if (gInputScratch) { free(gInputScratch); gInputScratch = NULL; gInputScratchCap = 0; }
  if (gCapture) {
    free(gCapture);
    gCapture = NULL;
    gCaptureSize = gCaptureCap = 0;
  }
  if (gPlay) {
    free(gPlay);
    gPlay = NULL;
    gPlayLen = 0;
    gPlayOff = 0;
  }
}

// Debug helpers
int vpio_get_bypass(unsigned int* bypass) {
  if (!gAudioUnit || !bypass) return -1;
  UInt32 val = 0, sz = sizeof(val);
  OSStatus st = AudioUnitGetProperty(gAudioUnit,
                                     kAUVoiceIOProperty_BypassVoiceProcessing,
                                     kAudioUnitScope_Global,
                                     0,
                                     &val,
                                     &sz);
  if (st != noErr) return (int)st;
  *bypass = (unsigned int)val;
  return 0;
}

double vpio_get_in_sample_rate(void) {
  if (!gAudioUnit) return 0.0;
  AudioStreamBasicDescription asbd; UInt32 sz = sizeof(asbd);
  OSStatus st = AudioUnitGetProperty(gAudioUnit,
                                     kAudioUnitProperty_StreamFormat,
                                     kAudioUnitScope_Output,
                                     1,
                                     &asbd,
                                     &sz);
  if (st != noErr) return 0.0;
  return asbd.mSampleRate;
}

double vpio_get_out_sample_rate(void) {
  if (!gAudioUnit) return 0.0;
  AudioStreamBasicDescription asbd; UInt32 sz = sizeof(asbd);
  OSStatus st = AudioUnitGetProperty(gAudioUnit,
                                     kAudioUnitProperty_StreamFormat,
                                     kAudioUnitScope_Input,
                                     0,
                                     &asbd,
                                     &sz);
  if (st != noErr) return 0.0;
  return asbd.mSampleRate;
}

size_t vpio_get_ring_levels(size_t* cap_level, size_t* play_level) {
  size_t cap = (atomic_load_explicit(&gCapW, memory_order_acquire) - atomic_load_explicit(&gCapR, memory_order_acquire));
  size_t play = (atomic_load_explicit(&gPlayW, memory_order_acquire) - atomic_load_explicit(&gPlayR, memory_order_acquire));
  if (cap_level) *cap_level = cap;
  if (play_level) *play_level = play;
  return cap + play;
}

// Debug: expose staging (input) ring level and capacity
size_t vpio_get_staging_level(void) {
  size_t inW = atomic_load_explicit(&gInW, memory_order_acquire);
  size_t inR = atomic_load_explicit(&gInR, memory_order_acquire);
  return inW - inR;
}

size_t vpio_get_staging_capacity(void) {
  return gInCap;
}

void vpio_debug_dump(void) {
  unsigned int bypass = 0xFFFFFFFF; int r = vpio_get_bypass(&bypass);
  double inSR = vpio_get_in_sample_rate();
  double outSR = vpio_get_out_sample_rate();
  size_t cap = (atomic_load_explicit(&gCapW, memory_order_acquire) - atomic_load_explicit(&gCapR, memory_order_acquire));
  size_t play = (atomic_load_explicit(&gPlayW, memory_order_acquire) - atomic_load_explicit(&gPlayR, memory_order_acquire));
  fprintf(stderr,
          "[VPIO] mode=%d bypass=%u (rc=%d) inSR=%.2f outSR=%.2f capRing=%zu/%zu playRing=%zu/%zu\n",
          (int)gMode, bypass, r, inSR, outSR, cap, gCapCap, play, gPlayCap);
}

// New APIs for 10ms input and C-paced 5ms playback
size_t vpio_write_frame_10ms(const void* data, size_t len) {
  if (!gInRing || gInCap == 0 || !data || len == 0) return 0;
  pthread_mutex_lock(&gInLock);
  // Ensure capacity; grow if needed
  if (!ensure_inring_space(len)) { pthread_mutex_unlock(&gInLock); return 0; }
  size_t inW = atomic_load_explicit(&gInW, memory_order_acquire);
  size_t widx = inW % gInCap;
  size_t first = gInCap - widx; if (first > len) first = len;
  memcpy(gInRing + widx, data, first);
  if (len > first) memcpy(gInRing, (const unsigned char*)data + first, len - first);
  atomic_store_explicit(&gInW, inW + len, memory_order_release);
  pthread_mutex_unlock(&gInLock);
  return len;
}

void vpio_set_target_headroom_ms(int ms) {
  if (ms < 0) ms = 0;
  gHeadroomMs = ms;
}

int vpio_start_playback_thread(int slice_ms, int preroll_ms) {
  if (slice_ms <= 0) slice_ms = 5;
  if (preroll_ms < 0) preroll_ms = 0;
  gSliceMs = slice_ms;
  gPrerollMs = preroll_ms;
  gDidPreroll = 0;
  if (atomic_load_explicit(&gPlayThreadRun, memory_order_acquire)) return 0; // already running
  atomic_store_explicit(&gPlayThreadRun, 1, memory_order_release);
  int rc = pthread_create(&gPlayThread, NULL, playback_thread_fn, NULL);
  if (rc != 0) {
    atomic_store_explicit(&gPlayThreadRun, 0, memory_order_release);
    return -1;
  }
  return 0;
}

void vpio_stop_playback_thread(void) {
  if (!atomic_load_explicit(&gPlayThreadRun, memory_order_acquire)) return;
  atomic_store_explicit(&gPlayThreadRun, 0, memory_order_release);
  // wake the thread if sleeping
  usleep(1000);
  pthread_join(gPlayThread, NULL);
  gDidPreroll = 0;
}
