import React, { useEffect, useRef } from "react"

import { usePipecatClientMediaTrack } from "@pipecat-ai/client-react"

import { getSharedAudioContext } from "@/stores/audio"

type ParticipantType = Parameters<typeof usePipecatClientMediaTrack>[1]

interface Props {
  backgroundColor?: string
  barColor?: string
  peakLineColor?: string
  peakLineSpeed?: number
  peakLineThickness?: number
  peakOffset?: number
  peakFadeSpeed?: number
  barCount?: number
  barGap?: number
  barLineCap?: "round" | "square"
  barMaxHeight?: number
  barOrigin?: "top" | "bottom" | "center"
  barWidth?: number
  participantType: ParticipantType
  className?: string
  isThinking?: boolean
  thinkingSpeed?: number
  thinkingWaveWidth?: number
  thinkingMaxHeight?: number
  disablePeakLines?: boolean
}

export const ShipOSDVisualizer: React.FC<Props> = React.memo(
  ({
    backgroundColor = "transparent",
    barColor = "black",
    peakLineColor = "red",
    peakLineSpeed = 0.2,
    peakLineThickness = 2,
    peakOffset = 0,
    barCount = 5,
    barGap = 12,
    barLineCap = "round",
    barMaxHeight = 120,
    barOrigin = "center",
    barWidth = 30,
    participantType,
    className,
    peakFadeSpeed = 0.02,
    isThinking = false,
    thinkingSpeed = 2,
    thinkingWaveWidth = 1,
    thinkingMaxHeight,
    disablePeakLines = false,
  }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const resolvedBarColorRef = useRef<string>("black")
    const resolvedPeakLineColorRef = useRef<string>("red") // New ref for peak line color

    // Resolve the color only when barColor changes
    useEffect(() => {
      function resolveColor(color: string) {
        if (!color) return "black"
        if (color.startsWith("--")) {
          return (
            getComputedStyle(document.documentElement).getPropertyValue(color).trim() || "black"
          )
        }
        return color
      }
      resolvedBarColorRef.current = resolveColor(barColor)
      resolvedPeakLineColorRef.current = resolveColor(peakLineColor)
    }, [barColor, peakLineColor])

    const track: MediaStreamTrack | null = usePipecatClientMediaTrack("audio", participantType)

    useEffect(() => {
      if (!canvasRef.current) return

      const canvasWidth = barCount * barWidth + (barCount - 1) * barGap
      const canvasHeight = barMaxHeight

      const canvas = canvasRef.current

      const scaleFactor = 2

      // Make canvas fill the width and height of its container
      const resizeCanvas = () => {
        canvas.width = canvasWidth * scaleFactor
        canvas.height = canvasHeight * scaleFactor

        canvas.style.width = `${canvasWidth}px`
        canvas.style.height = `${canvasHeight}px`

        canvasCtx.lineCap = barLineCap
        canvasCtx.scale(scaleFactor, scaleFactor)
      }

      const canvasCtx = canvas.getContext("2d")!
      resizeCanvas()

      // Create frequency bands based on barCount
      const bands = Array.from({ length: barCount }, (_, i) => {
        // Use improved logarithmic scale for better frequency distribution
        const minFreq = barCount > 20 ? 200 : 80 // Adjust min frequency based on bar count
        const maxFreq = 10000 // Cover most important audio frequencies

        // Use Mel scale inspired approach for more perceptually uniform distribution
        // This helps with a large number of bars by placing fewer in the very low range
        // https://en.wikipedia.org/wiki/Mel_scale
        const melMin = 2595 * Math.log10(1 + minFreq / 700)
        const melMax = 2595 * Math.log10(1 + maxFreq / 700)
        const melStep = (melMax - melMin) / barCount

        const melValue = melMin + i * melStep
        const startFreq = 700 * (Math.pow(10, melValue / 2595) - 1)
        const endFreq = 700 * (Math.pow(10, (melValue + melStep) / 2595) - 1)

        return {
          startFreq,
          endFreq,
          smoothValue: 0,
          peakValue: 0,
          peakOpacity: 0,
        }
      })

      // Audio context setup — uses shared singleton (avoids competing audio clocks)
      let audioContext: AudioContext | null = null
      let source: MediaStreamAudioSourceNode | null = null
      let analyser: AnalyserNode | null = null
      let frequencyData: Uint8Array<ArrayBuffer> | null = null

      // Pre-computed bin index ranges per band (avoids per-frame slice/reduce)
      let bandBins: { start: number; end: number }[] | null = null

      if (!isThinking && track) {
        audioContext = getSharedAudioContext()
        source = audioContext.createMediaStreamSource(new MediaStream([track]))
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        frequencyData = new Uint8Array(analyser.frequencyBinCount)

        // Pre-compute frequency bin indices
        const nyquist = audioContext.sampleRate / 2
        const binCount = analyser.frequencyBinCount
        bandBins = bands.map((band) => ({
          start: Math.round((band.startFreq / nyquist) * (binCount - 1)),
          end: Math.round((band.endFreq / nyquist) * (binCount - 1)),
        }))
      }

      canvasCtx.lineCap = barLineCap

      let animationFrameId: number

      function drawSpectrum() {
        // Clear and fill background
        canvasCtx.clearRect(0, 0, canvas.width / scaleFactor, canvas.height / scaleFactor)
        canvasCtx.fillStyle = backgroundColor
        canvasCtx.fillRect(0, 0, canvas.width / scaleFactor, canvas.height / scaleFactor)

        const totalBarsWidth = bands.length * barWidth + (bands.length - 1) * barGap
        const startX = (canvas.width / scaleFactor - totalBarsWidth) / 2
        const adjustedCircleRadius = barWidth / 2
        const resolvedBarColor = resolvedBarColorRef.current
        const cvHeight = canvas.height / scaleFactor

        if (isThinking) {
          // Thinking mode: Mexican wave animation
          const time = performance.now() / 1000
          // Phase offset per bar to create wave effect
          // Smaller thinkingWaveWidth = larger offset = tighter/more condensed wave
          const phaseOffset = (Math.PI * 2) / barCount / thinkingWaveWidth

          // Use thinkingMaxHeight if provided, otherwise fall back to barMaxHeight
          const effectiveMaxHeight = thinkingMaxHeight ?? barMaxHeight

          bands.forEach((_, i) => {
            const x = startX + i * (barWidth + barGap)
            // Create wave using sine, offset by bar index
            const waveValue = Math.sin(time * thinkingSpeed - i * phaseOffset)
            // Normalize to 0-1 range and apply to max height
            const normalizedWave = (waveValue + 1) / 2
            const barHeight = normalizedWave * effectiveMaxHeight

            let yTop, yBottom

            switch (barOrigin) {
              case "top":
                yTop = adjustedCircleRadius
                yBottom = Math.min(
                  adjustedCircleRadius + barHeight,
                  cvHeight - adjustedCircleRadius
                )
                break
              case "bottom":
                yBottom = cvHeight - adjustedCircleRadius
                yTop = Math.max(yBottom - barHeight, adjustedCircleRadius)
                break
              case "center":
              default:
                yTop = Math.max(cvHeight / 2 - barHeight / 2, adjustedCircleRadius)
                yBottom = Math.min(cvHeight / 2 + barHeight / 2, cvHeight - adjustedCircleRadius)
                break
            }

            // Draw bar (no peak lines in thinking mode)
            if (barHeight > 0) {
              canvasCtx.beginPath()
              canvasCtx.moveTo(x + barWidth / 2, yTop)
              canvasCtx.lineTo(x + barWidth / 2, yBottom)
              canvasCtx.lineWidth = barWidth
              canvasCtx.strokeStyle = resolvedBarColor
              canvasCtx.stroke()
            } else {
              drawInactiveCircle(adjustedCircleRadius, resolvedBarColor, x, yTop)
            }
          })
        } else {
          // Audio-reactive mode
          if (analyser && frequencyData) {
            analyser.getByteFrequencyData(frequencyData)
          }

          let isActive = false

          bands.forEach((band, i) => {
            let bandValue = 0
            if (frequencyData && bandBins) {
              const { start, end } = bandBins[i]
              const count = end - start
              if (count > 0) {
                let sum = 0
                for (let j = start; j < end; j++) {
                  sum += frequencyData[j]
                }
                bandValue = sum / count
              }
            }

            const smoothingFactor = 0.2
            const fadeEpsilon = 0.5

            if (bandValue < 1) {
              band.smoothValue = Math.max(band.smoothValue - smoothingFactor * 5, 0)
            } else {
              band.smoothValue = band.smoothValue + (bandValue - band.smoothValue) * smoothingFactor
              isActive = true
            }

            // Update peak value - moves up with the bar but returns more slowly
            if (band.smoothValue > band.peakValue) {
              band.peakValue = band.smoothValue
              band.peakOpacity = 1
            } else {
              // Peak returns to the top of the bar more slowly
              const peakSmoothingFactor = peakLineSpeed
              band.peakValue = Math.max(band.peakValue - peakSmoothingFactor * 5, band.smoothValue)
              // Begin fading once the bar is effectively zeroed
              if (band.smoothValue <= fadeEpsilon) {
                band.peakOpacity = Math.max(0, band.peakOpacity - peakFadeSpeed)
              }
            }

            const x = startX + i * (barWidth + barGap)
            // Calculate bar height with a maximum cap
            const minHeight = 0
            const barHeight = Math.max(
              minHeight,
              Math.min((band.smoothValue / 255) * barMaxHeight, barMaxHeight)
            )

            let yTop, yBottom

            switch (barOrigin) {
              case "top":
                yTop = adjustedCircleRadius
                yBottom = Math.min(
                  adjustedCircleRadius + barHeight,
                  cvHeight - adjustedCircleRadius
                )
                break
              case "bottom":
                yBottom = cvHeight - adjustedCircleRadius
                yTop = Math.max(yBottom - barHeight, adjustedCircleRadius)
                break
              case "center":
              default:
                yTop = Math.max(cvHeight / 2 - barHeight / 2, adjustedCircleRadius)
                yBottom = Math.min(cvHeight / 2 + barHeight / 2, cvHeight - adjustedCircleRadius)
                break
            }

            if (band.smoothValue > 0) {
              canvasCtx.beginPath()
              canvasCtx.moveTo(x + barWidth / 2, yTop)
              canvasCtx.lineTo(x + barWidth / 2, yBottom)
              canvasCtx.lineWidth = barWidth
              canvasCtx.strokeStyle = resolvedBarColor
              canvasCtx.stroke()
            } else {
              drawInactiveCircle(adjustedCircleRadius, resolvedBarColor, x, yTop)
            }

            // Draw the peak line (2px line at the top) - always draw when it exists
            if (!disablePeakLines && (band.peakValue > 0 || (peakOffset > 0 && band.peakOpacity > 0))) {
              const peakHeight = Math.max(
                minHeight,
                Math.min((band.peakValue / 255) * barMaxHeight, barMaxHeight)
              )

              // Compute raw peak position by origin
              let peakY
              switch (barOrigin) {
                case "top":
                  peakY = adjustedCircleRadius + peakHeight
                  break
                case "bottom":
                  peakY = cvHeight - adjustedCircleRadius - peakHeight
                  break
                case "center":
                default:
                  peakY = cvHeight / 2 - peakHeight / 2
                  break
              }

              // Visual tip offset due to lineCap (round/square extend by barWidth/2)
              const capExtension =
                barLineCap === "round" || barLineCap === "square" ? barWidth / 2 : 0

              // Bar visual tip Y coordinate to clamp/offset against
              const barTipY = ((): number => {
                switch (barOrigin) {
                  case "top":
                    return yBottom + capExtension // bar grows downward
                  case "bottom":
                    return yTop - capExtension // bar grows upward
                  case "center":
                  default:
                    return yTop - capExtension // use upper tip as cap
                }
              })()

              // Enforce a constant offset from the bar tip in the outward direction
              if (barOrigin === "top") {
                const desiredY = barTipY + peakOffset // outward is increasing y
                peakY = Math.max(peakY, desiredY)
              } else {
                const desiredY = barTipY - peakOffset // outward is decreasing y
                peakY = Math.min(peakY, desiredY)
              }

              // Draw the peak line, matching bar width exactly
              const previousLineCap = canvasCtx.lineCap
              const previousAlpha = canvasCtx.globalAlpha
              canvasCtx.lineCap = "butt"
              canvasCtx.globalAlpha = band.peakOpacity
              canvasCtx.beginPath()
              canvasCtx.moveTo(x, peakY)
              canvasCtx.lineTo(x + barWidth, peakY)
              canvasCtx.lineWidth = peakLineThickness
              canvasCtx.strokeStyle = resolvedPeakLineColorRef.current
              canvasCtx.stroke()
              canvasCtx.lineCap = previousLineCap
              canvasCtx.globalAlpha = previousAlpha
            }
          })

          if (!isActive) {
            drawInactiveCircles(adjustedCircleRadius, resolvedBarColor)
          }
        }

        animationFrameId = requestAnimationFrame(drawSpectrum)
      }

      function drawInactiveCircle(circleRadius: number, color: string, x: number, y: number) {
        switch (barLineCap) {
          case "square":
            canvasCtx.fillStyle = color
            canvasCtx.fillRect(
              x + barWidth / 2 - circleRadius,
              y - circleRadius,
              circleRadius * 2,
              circleRadius * 2
            )
            break
          case "round":
          default:
            canvasCtx.beginPath()
            canvasCtx.arc(x + barWidth / 2, y, circleRadius, 0, 2 * Math.PI)
            canvasCtx.fillStyle = color
            canvasCtx.fill()
            canvasCtx.closePath()
            break
        }
      }

      function drawInactiveCircles(circleRadius: number, color: string) {
        const totalBarsWidth = bands.length * barWidth + (bands.length - 1) * barGap
        const startX = (canvas.width / scaleFactor - totalBarsWidth) / 2
        const cvHeight = canvas.height / scaleFactor

        let y
        switch (barOrigin) {
          case "top":
            y = circleRadius
            break
          case "bottom":
            y = cvHeight - circleRadius
            break
          case "center":
          default:
            y = cvHeight / 2
            break
        }

        bands.forEach((_, i) => {
          const x = startX + i * (barWidth + barGap)
          drawInactiveCircle(circleRadius, color, x, y)
        })
      }

      drawSpectrum()

      // Handle resizing
      window.addEventListener("resize", resizeCanvas)

      return () => {
        cancelAnimationFrame(animationFrameId)
        if (source) {
          source.disconnect()
        }
        window.removeEventListener("resize", resizeCanvas)
      }
    }, [
      backgroundColor,
      barCount,
      barGap,
      barLineCap,
      barMaxHeight,
      barOrigin,
      barWidth,
      track,
      barColor,
      peakLineSpeed,
      peakLineThickness,
      peakOffset,
      peakFadeSpeed,
      isThinking,
      thinkingSpeed,
      thinkingWaveWidth,
      thinkingMaxHeight,
      disablePeakLines,
    ])

    return (
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
        }}
        className={className}
      />
    )
  }
)

ShipOSDVisualizer.displayName = "ShipOSDVisualizer"
