import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { 
  MediaMetadata, 
  DomainAssessmentStatus, 
  DetectorExecutionStatus,
  DetectorReport 
} from '../../types';

const execFileAsync = promisify(execFile);

export class AudioProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioProcessingError';
  }
}

export interface AudioAnalysisResult {
  hasVoiceover: boolean;
  voiceoverRatio: number; // 0 to 1
  silenceRatio: number;
  hasMusicDetected: boolean | null; // null when unassessed, unavailable, or insufficient evidence
  meanVolumeDb?: number;
  isAudible?: boolean;
  advertiserSpeechFlags: Array<{ word: string; timestamp: number; category: string }>;
  segments: Array<{ start: number; end: number; type: 'voice' | 'music' | 'silence' | 'mixed' }>;
  transcriptSummary: string;
  repeatedAudioSegments?: Array<{ 
    start: number; 
    end: number; 
    matchWithTimestamp: number; 
    similarity: number; 
  }>;
  speechAnalysisStatus?: DomainAssessmentStatus | DetectorExecutionStatus;
  musicAnalysisStatus?: DomainAssessmentStatus | DetectorExecutionStatus;
  speechDetectionStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  transcriptionStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  repeatedAudioStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  transcriptSegments?: Array<{
    start: number;
    end: number;
    text: string;
    confidence?: number;
  }>;
  detectors?: Record<string, DetectorReport>;
}

export interface LocalTranscriptionResult {
  status: DetectorExecutionStatus;
  transcriptText?: string;
  segments?: Array<{ start: number; end: number; text: string; confidence?: number }>;
  failureReason?: string;
  limitations: string;
  executionDurationMs: number;
}

/**
 * Adapter for optional local Speech-to-Text transcription.
 * Gracefully checks dependency availability (e.g. WHISPER_PATH or LOCAL_STT_PATH).
 * Never fabricates transcripts when local model/executable is unconfigured or absent.
 */
export class SpeechTranscriptionAdapter {
  public async transcribe(videoPath: string, durationSeconds: number): Promise<LocalTranscriptionResult> {
    const startTime = Date.now();
    const sttPath = process.env.WHISPER_PATH || process.env.LOCAL_STT_PATH;

    if (!sttPath) {
      return {
        status: 'NOT_ASSESSED',
        limitations: 'Local speech-to-text executable (WHISPER_PATH or LOCAL_STT_PATH) not configured. Speech detection is acoustic-only without automated transcription.',
        executionDurationMs: 0
      };
    }

    if (!fs.existsSync(sttPath)) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        failureReason: `Configured STT executable not found at ${sttPath}`,
        limitations: 'STT path was configured but executable is missing on disk.',
        executionDurationMs: Date.now() - startTime
      };
    }

    try {
      // Execute local STT binary safely without shell expansion
      const { stdout } = await execFileAsync(sttPath, [videoPath, '--output_format', 'json'], { timeout: 60000 });
      const elapsed = Date.now() - startTime;
      const rawOutput = (stdout || '').trim();

      if (!rawOutput) {
        return {
          status: 'NO_SIGNAL_DETECTED',
          transcriptText: '',
          segments: [],
          limitations: 'STT executable completed with empty output; no speech detected.',
          executionDurationMs: elapsed
        };
      }

      let parsed: any = null;
      let isJson = false;

      // Check if output looks like JSON
      if (rawOutput.startsWith('{') || rawOutput.startsWith('[')) {
        try {
          parsed = JSON.parse(rawOutput);
          isJson = true;
        } catch {
          // Output attempted JSON formatting but is malformed
          return {
            status: 'ANALYSIS_UNAVAILABLE',
            failureReason: 'Malformed JSON output from STT executable',
            limitations: 'STT executable produced invalid JSON structure that could not be parsed.',
            executionDurationMs: elapsed
          };
        }
      }

      if (!isJson) {
        // Plain text transcript output without timestamps
        // CRITICAL: NEVER fabricate a full-duration segment [0, durationSeconds] from plain text
        return {
          status: rawOutput.length > 0 ? 'DETECTED' : 'NO_SIGNAL_DETECTED',
          transcriptText: rawOutput,
          segments: [], // Segments MUST remain empty when timestamps are absent
          limitations: 'Plain text transcript returned without segment timestamps; segment-level timestamps are unavailable and were not fabricated.',
          executionDurationMs: elapsed
        };
      }

      // Process and validate JSON segments
      const rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
      const validSegments: Array<{ start: number; end: number; text: string; confidence?: number }> = [];
      let rejectedTimestampsCount = 0;

      for (const s of rawSegments) {
        const start = typeof s?.start === 'number' ? s.start : parseFloat(s?.start);
        const end = typeof s?.end === 'number' ? s.end : parseFloat(s?.end);
        const text = String(s?.text || '').trim();

        // Validate finite, non-negative, ordered (start < end), and within media duration
        if (
          !Number.isFinite(start) || 
          !Number.isFinite(end) || 
          start < 0 || 
          end <= start || 
          start >= durationSeconds + 0.1
        ) {
          rejectedTimestampsCount++;
          continue;
        }

        const clampedEnd = Math.min(parseFloat(end.toFixed(2)), durationSeconds);
        const clampedStart = parseFloat(start.toFixed(2));

        if (clampedStart < clampedEnd) {
          validSegments.push({
            start: clampedStart,
            end: clampedEnd,
            text,
            confidence: typeof s?.confidence === 'number' && Number.isFinite(s.confidence) ? s.confidence : undefined
          });
        }
      }

      const transcriptText = typeof parsed.text === 'string' 
        ? parsed.text.trim() 
        : validSegments.map(s => s.text).join(' ');

      let limitationNotes = 'Transcribed via local STT executable; automated transcripts may contain phonetic inaccuracies.';
      if (rejectedTimestampsCount > 0) {
        limitationNotes += ` Note: ${rejectedTimestampsCount} invalid or out-of-order segment timestamp(s) were rejected.`;
      }

      let status: DetectorExecutionStatus;
      if (validSegments.length > 0 || transcriptText.length > 0) {
        status = 'DETECTED';
      } else if (rawSegments.length > 0 && validSegments.length === 0) {
        status = 'INSUFFICIENT_EVIDENCE';
        limitationNotes += ' All reported segment timestamps were invalid or out of bounds.';
      } else {
        status = 'NO_SIGNAL_DETECTED';
      }

      return {
        status,
        transcriptText,
        segments: validSegments,
        limitations: limitationNotes,
        executionDurationMs: elapsed
      };
    } catch (err: any) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        failureReason: `Local STT process execution failed: ${err?.message || err}`,
        limitations: 'Speech transcription failed during local execution.',
        executionDurationMs: Date.now() - startTime
      };
    }
  }
}

export interface LocalMusicClassificationResult {
  status: DetectorExecutionStatus;
  hasMusic: boolean | null;
  confidence?: number;
  segments?: Array<{ start: number; end: number; confidence?: number }>;
  failureReason?: string;
  limitations: string;
  executionDurationMs: number;
}

/**
 * Adapter for optional local Music Classification.
 * Checks dependency availability (MUSIC_CLASSIFIER_PATH).
 * Never assumes unassessed audio is music-free; distinguishes NOT_ASSESSED,
 * ANALYSIS_UNAVAILABLE, INSUFFICIENT_EVIDENCE, DETECTED, and NO_SIGNAL_DETECTED.
 */
export class MusicClassificationAdapter {
  public async classify(videoPath: string, durationSeconds: number): Promise<LocalMusicClassificationResult> {
    const startTime = Date.now();
    const classifierPath = process.env.MUSIC_CLASSIFIER_PATH;

    if (!classifierPath) {
      return {
        status: 'NOT_ASSESSED',
        hasMusic: null,
        limitations: 'Music detection and classification model (MUSIC_CLASSIFIER_PATH) not configured in local environment; music presence is unverified.',
        executionDurationMs: 0
      };
    }

    if (!fs.existsSync(classifierPath)) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        hasMusic: null,
        failureReason: `Configured music classifier executable not found at ${classifierPath}`,
        limitations: 'Music classifier path was configured but executable is missing on disk.',
        executionDurationMs: Date.now() - startTime
      };
    }

    try {
      const { stdout } = await execFileAsync(classifierPath, [videoPath, '--format', 'json'], { timeout: 60000 });
      const elapsed = Date.now() - startTime;
      const rawOutput = (stdout || '').trim();

      if (!rawOutput) {
        return {
          status: 'NO_SIGNAL_DETECTED',
          hasMusic: false,
          segments: [],
          limitations: 'Music classifier completed with empty output; no musical signals detected.',
          executionDurationMs: elapsed
        };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(rawOutput);
      } catch {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          hasMusic: null,
          failureReason: 'Malformed JSON output from music classifier executable',
          limitations: 'Music classifier returned non-JSON output.',
          executionDurationMs: elapsed
        };
      }

      const hasMusic = Boolean(parsed.hasMusic);
      const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.85;

      const segments = Array.isArray(parsed.segments)
        ? parsed.segments
            .filter((s: any) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end > s.start && s.start < durationSeconds)
            .map((s: any) => ({
              start: parseFloat(s.start.toFixed(2)),
              end: Math.min(durationSeconds, parseFloat(s.end.toFixed(2))),
              confidence: s.confidence
            }))
        : [];

      return {
        status: hasMusic ? 'DETECTED' : 'NO_SIGNAL_DETECTED',
        hasMusic,
        confidence,
        segments,
        limitations: 'Classified via local music classifier model. Does not query external copyright registries or YouTube Content ID.',
        executionDurationMs: elapsed
      };
    } catch (err: any) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        hasMusic: null,
        failureReason: `Local music classifier process execution failed: ${err?.message || err}`,
        limitations: 'Music classification failed during execution.',
        executionDurationMs: Date.now() - startTime
      };
    }
  }
}

/**
 * Radix-2 Cooley-Tukey In-Place Fast Fourier Transform for spectral audio analysis.
 */
function computeFFT(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 0, j = 0; i < n; i++) {
    if (j > i) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let s = 2; s <= n; s <<= 1) {
    const half = s >> 1;
    const wStep = -2 * Math.PI / s;
    for (let i = 0; i < n; i += s) {
      for (let j = 0; j < half; j++) {
        const theta = j * wStep;
        const c = Math.cos(theta), sn = Math.sin(theta);
        const vR = real[i + j + half] * c - imag[i + j + half] * sn;
        const vI = real[i + j + half] * sn + imag[i + j + half] * c;
        real[i + j + half] = real[i + j] - vR;
        imag[i + j + half] = imag[i + j] - vI;
        real[i + j] += vR;
        imag[i + j] += vI;
      }
    }
  }
}

/**
 * 16 logarithmically/perceptually-spaced frequency subbands from 0 to 4000 Hz for 8kHz audio.
 */
const SPECTRAL_BANDS_8KHZ: Array<[number, number]> = [
  [0, 200], [200, 400], [400, 600], [600, 800],
  [800, 1000], [1000, 1250], [1250, 1500], [1500, 1750],
  [1750, 2000], [2000, 2300], [2300, 2600], [2600, 2900],
  [2900, 3200], [3200, 3500], [3500, 3800], [3800, 4000]
];

/**
 * Computes a normalized 16-band spectral energy profile for a window of 8000Hz PCM samples.
 */
function extractSubbandSpectralProfile(pcmBuffer: Buffer, startByte: number, lengthBytes: number): Float64Array {
  const profile = new Float64Array(SPECTRAL_BANDS_8KHZ.length);
  const totalSamples = Math.floor(lengthBytes / 2);
  const winSize = 512;
  const numWins = Math.floor(totalSamples / winSize);
  if (numWins <= 0) return profile;

  const binWidth = 8000 / winSize;
  const real = new Float64Array(winSize);
  const imag = new Float64Array(winSize);

  for (let w = 0; w < numWins; w++) {
    const winOffset = startByte + w * winSize * 2;
    for (let i = 0; i < winSize; i++) {
      // Periodic Hann window
      const h = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winSize - 1)));
      real[i] = pcmBuffer.readInt16LE(winOffset + i * 2) * h;
      imag[i] = 0;
    }
    computeFFT(real, imag);
    for (let b = 0; b < SPECTRAL_BANDS_8KHZ.length; b++) {
      const [fLow, fHigh] = SPECTRAL_BANDS_8KHZ[b];
      const startBin = Math.max(1, Math.floor(fLow / binWidth));
      const endBin = Math.min(winSize / 2 - 1, Math.ceil(fHigh / binWidth));
      for (let k = startBin; k <= endBin; k++) {
        profile[b] += (real[k] * real[k] + imag[k] * imag[k]);
      }
    }
  }

  let sumSq = 0;
  for (let b = 0; b < profile.length; b++) sumSq += profile[b] * profile[b];
  const norm = Math.sqrt(sumSq) || 1;
  for (let b = 0; b < profile.length; b++) profile[b] /= norm;
  return profile;
}

export class AudioProcessor {
  private transcriptionAdapter = new SpeechTranscriptionAdapter();
  private musicAdapter = new MusicClassificationAdapter();

  /**
   * Processes audio stream using:
   * 1. FFmpeg silencedetect & volumedetect
   * 2. Acoustic energy modulation & Zero-Crossing Rate (ZCR) signal analysis
   * 3. Within-video non-adjacent repeated audio segment detection
   * 4. Optional local speech-to-text adapter
   */
  public async analyzeAudio(videoPath: string, metadataOrDuration: MediaMetadata | number): Promise<AudioAnalysisResult> {
    const startTime = Date.now();

    if (!fs.existsSync(videoPath)) {
      throw new AudioProcessingError(`Audio/video file not found at ${videoPath}`);
    }

    const durationSeconds = typeof metadataOrDuration === 'number'
      ? metadataOrDuration
      : metadataOrDuration.durationSeconds;
    const hasAudio = typeof metadataOrDuration === 'number'
      ? true
      : metadataOrDuration.hasAudio;

    if (!hasAudio) {
      return {
        hasVoiceover: false,
        voiceoverRatio: 0,
        silenceRatio: 1,
        hasMusicDetected: null,
        meanVolumeDb: undefined,
        isAudible: false,
        advertiserSpeechFlags: [],
        segments: [{ start: 0, end: durationSeconds, type: 'silence' }],
        transcriptSummary: 'No audio stream detected in container.',
        speechAnalysisStatus: 'NOT_PROVIDED',
        musicAnalysisStatus: 'NOT_PROVIDED',
        speechDetectionStatus: 'NOT_PROVIDED',
        transcriptionStatus: 'NOT_PROVIDED',
        repeatedAudioStatus: 'NOT_PROVIDED',
        detectors: {
          audio_silence_volume: {
            detectorName: 'ffmpeg_silence_and_volume',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No audio stream detected in container.'
          },
          audio_speech_activity: {
            detectorName: 'acoustic_energy_modulation',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No audio stream detected in container.'
          },
          audio_music_detection: {
            detectorName: 'music_classification_analyzer',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No audio stream detected in container.'
          },
          audio_repeated_segments: {
            detectorName: 'subband_spectral_audio_fingerprint',
            version: '1.1.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No audio stream detected in container.'
          }
        }
      };
    }

    try {
      const args = [
        '-i', videoPath,
        '-af', 'silencedetect=noise=-30dB:d=1.5,volumedetect',
        '-f', 'null',
        '-'
      ];

      // ffmpeg writes filter output and telemetry to stderr
      let output = '';
      try {
        const { stdout, stderr } = await execFileAsync('ffmpeg', args, { timeout: 30000 });
        output = (stdout || '') + (stderr || '');
      } catch (procErr: any) {
        // Fail closed: Never treat partial output from a failed FFmpeg process as a successful measurement
        throw new AudioProcessingError(`FFmpeg audio analysis failed: ${procErr?.message || procErr}`);
      }

      const dur = durationSeconds;
      if (!Number.isFinite(dur) || dur <= 0) {
        throw new AudioProcessingError(`FFmpeg audio analysis failed: invalid or non-finite duration (${dur})`);
      }

      // Look for volume level indicators - fail closed if missing or malformed
      const meanVolumeMatch = output.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
      if (!meanVolumeMatch) {
        throw new AudioProcessingError('FFmpeg audio analysis failed: missing mean_volume measurement in output');
      }

      const meanVol = parseFloat(meanVolumeMatch[1]);
      if (!Number.isFinite(meanVol)) {
        throw new AudioProcessingError(`FFmpeg audio analysis failed: malformed non-finite mean_volume measurement (${meanVolumeMatch[1]})`);
      }

      // Parse silencedetect events
      const silenceMatches = [...output.matchAll(/silence_start: ([\d.]+)|silence_end: ([\d.]+)/g)];
      let totalSilenceDuration = 0;
      let lastStart: number | null = null;
      const segments: AudioAnalysisResult['segments'] = [];

      for (const m of silenceMatches) {
        if (m[0].startsWith('silence_start')) {
          const val = parseFloat(m[1]);
          if (Number.isFinite(val)) {
            lastStart = val;
          }
        } else if (m[0].startsWith('silence_end') && lastStart !== null) {
          const end = parseFloat(m[2]);
          if (Number.isFinite(end) && end >= lastStart) {
            totalSilenceDuration += (end - lastStart);
            segments.push({ start: Math.round(lastStart), end: Math.round(end), type: 'silence' });
          }
          lastStart = null;
        }
      }

      if (!Number.isFinite(totalSilenceDuration)) {
        throw new AudioProcessingError('FFmpeg audio analysis failed: malformed silence duration calculation');
      }

      const silenceRatio = Math.min(1, totalSilenceDuration / dur);
      const activeRatio = Math.max(0, 1 - silenceRatio);
      const isAudible = meanVol > -50;

      // Extract raw PCM audio chunk samples for acoustic signal processing & repetition detection
      // 8000Hz mono 16-bit PCM: 16,000 bytes per second
      let pcmBuffer: Buffer = Buffer.alloc(0);
      try {
        const pcmRes = await execFileAsync('ffmpeg', [
          '-y',
          '-i', videoPath,
          '-vn',
          '-ac', '1',
          '-ar', '8000',
          '-f', 's16le',
          '-'
        ], { encoding: 'buffer', maxBuffer: 15 * 1024 * 1024, timeout: 30000 });
        pcmBuffer = pcmRes.stdout as unknown as Buffer;
      } catch {
        // Non-fatal for PCM sampling, fall back gracefully
      }

      const bytesPerSec = 16000;
      const totalAudioSeconds = Math.floor(pcmBuffer.length / bytesPerSec);
      
      // Calculate 1-second acoustic chunk signatures: RMS energy, Zero-Crossing Rate, and 16-band spectral profile
      interface AudioChunkSignature {
        sec: number;
        rms: number;
        zcr: number;
        spectralProfile: Float64Array;
      }

      const chunkSignatures: AudioChunkSignature[] = [];
      for (let sec = 0; sec < totalAudioSeconds; sec++) {
        const startOffset = sec * bytesPerSec;
        let sumSq = 0;
        let zcr = 0;
        let prevVal = pcmBuffer.readInt16LE(startOffset);

        for (let i = 1; i < 8000; i++) {
          const val = pcmBuffer.readInt16LE(startOffset + i * 2);
          sumSq += val * val;
          if ((val >= 0 && prevVal < 0) || (val < 0 && prevVal >= 0)) {
            zcr++;
          }
          prevVal = val;
        }

        const rms = Math.sqrt(sumSq / 8000);
        const spectralProfile = extractSubbandSpectralProfile(pcmBuffer, startOffset, bytesPerSec);
        chunkSignatures.push({ sec, rms, zcr, spectralProfile });
      }

      // 1. Acoustic Speech Modulation Detection
      // Speech has high temporal modulation in energy envelope and significant ZCR variability between phonemes
      let speechDetectionStatus: DetectorExecutionStatus = 'NO_SIGNAL_DETECTED';
      if (!isAudible || totalAudioSeconds < 1) {
        speechDetectionStatus = isAudible ? 'INSUFFICIENT_EVIDENCE' : 'NO_SIGNAL_DETECTED';
      } else {
        const rmsValues = chunkSignatures.map(c => c.rms).filter(r => r > 100);
        if (rmsValues.length >= 2) {
          const meanRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
          const varianceRms = rmsValues.reduce((a, b) => a + Math.pow(b - meanRms, 2), 0) / rmsValues.length;
          const stdDevRms = Math.sqrt(varianceRms);
          const coeffVariation = stdDevRms / Math.max(1, meanRms);

          // Natural speech exhibits syllabic modulation with coefficient of variation > 0.25
          // Synthetic single tones or flat hums exhibit coefficient of variation < 0.08
          if (coeffVariation >= 0.25) {
            speechDetectionStatus = 'DETECTED';
          } else {
            speechDetectionStatus = 'NO_SIGNAL_DETECTED';
          }
        }
      }

      // 2. Within-Video Repeated Audio Detection
      // Identifies non-adjacent audio segments with matching acoustic signatures and 16-band spectral profiles
      const repeatedAudioSegments: AudioAnalysisResult['repeatedAudioSegments'] = [];
      const minAudioGap = 2; // at least 2 seconds separation

      for (let i = 0; i < chunkSignatures.length; i++) {
        const c1 = chunkSignatures[i];
        if (c1.rms < 150) continue; // Skip near-silent intervals

        for (let j = i + minAudioGap; j < chunkSignatures.length; j++) {
          const c2 = chunkSignatures[j];
          if (c2.rms < 150) continue;

          // Acoustic & spectral correlation between 1-second chunks:
          let spectralSim = 0;
          for (let b = 0; b < 16; b++) {
            spectralSim += c1.spectralProfile[b] * c2.spectralProfile[b];
          }

          const rmsDelta = Math.abs(c1.rms - c2.rms) / Math.max(c1.rms, c2.rms);
          const zcrDelta = Math.abs(c1.zcr - c2.zcr) / Math.max(1, Math.max(c1.zcr, c2.zcr));

          // Robust match criteria:
          // 1. Spectral subband correlation >= 0.88
          // 2. RMS energy amplitude delta <= 25%
          // 3. Zero-crossing rate delta <= 20%
          if (spectralSim >= 0.88 && rmsDelta <= 0.25 && zcrDelta <= 0.20) {
            const compositeSimilarity = parseFloat((0.60 * spectralSim + 0.25 * Math.max(0, 1 - rmsDelta) + 0.15 * Math.max(0, 1 - zcrDelta)).toFixed(3));
            const startSec = parseFloat(c1.sec.toFixed(2));
            const endSec = parseFloat(Math.min(c1.sec + 1, dur).toFixed(2));
            const matchTimestamp = parseFloat(c2.sec.toFixed(2));

            if (startSec < endSec && endSec <= dur && matchTimestamp <= dur) {
              repeatedAudioSegments.push({
                start: startSec,
                end: endSec,
                matchWithTimestamp: matchTimestamp,
                similarity: compositeSimilarity
              });
              break; // Record one match per source segment to avoid combinatorial explosion
            }
          }
        }
      }

      let repeatedAudioStatus: DetectorExecutionStatus = totalAudioSeconds < 2 
        ? 'INSUFFICIENT_EVIDENCE'
        : (repeatedAudioSegments.length > 0 ? 'DETECTED' : 'NO_SIGNAL_DETECTED');

      // 3. Optional Local Speech Transcription
      const sttResult = await this.transcriptionAdapter.transcribe(videoPath, dur);

      // 4. Optional Local Music Classification
      const musicResult = await this.musicAdapter.classify(videoPath, dur);

      // Active intervals contain acoustic energy (music, speech, sfx, or ambient)
      if (isAudible) {
        if (segments.length === 0) {
          segments.push({ start: 0, end: dur, type: 'mixed' });
        } else {
          // Fill gaps between silence as mixed acoustic activity
          let curr = 0;
          const activeSegments: AudioAnalysisResult['segments'] = [];
          for (const s of segments) {
            if (s.start > curr + 1) {
              activeSegments.push({ start: curr, end: s.start, type: 'mixed' });
            }
            curr = s.end;
          }
          if (curr < dur) {
            activeSegments.push({ start: curr, end: dur, type: 'mixed' });
          }
          segments.push(...activeSegments);
          segments.sort((a, b) => a.start - b.start);
        }
      }

      // Evidence integrity: Distinguish measurable acoustic activity from verified speech:
      // Volume and silence filters measure sound energy, NOT speech or narrator identity.
      const hasVoiceover = sttResult.status === 'DETECTED' && Boolean(sttResult.segments && sttResult.segments.length > 0);
      const voiceoverRatio = hasVoiceover
        ? Math.min(1, parseFloat(((sttResult.segments!.reduce((acc, s) => acc + (s.end - s.start), 0)) / dur).toFixed(2)))
        : 0;

      const totalMs = Date.now() - startTime;

      const detectors: Record<string, DetectorReport> = {
        audio_silence_volume: {
          detectorName: 'ffmpeg_silence_and_volume',
          version: '1.0.0',
          status: 'DETECTED',
          executionDurationMs: totalMs,
          confidence: 0.95,
          limitations: 'Measures decibel energy and silence boundaries; does not determine speech semantics or music copyright.'
        },
        audio_speech_activity: {
          detectorName: 'acoustic_energy_modulation',
          version: '1.0.0',
          status: speechDetectionStatus,
          executionDurationMs: totalMs,
          confidence: 0.85,
          limitations: 'Acoustic activity heuristic based on energy envelope modulation; does not produce verified speech semantics or textual transcripts.'
        },
        audio_transcription: {
          detectorName: 'local_speech_to_text_adapter',
          version: '1.0.0',
          status: sttResult.status,
          executionDurationMs: sttResult.executionDurationMs,
          limitations: sttResult.limitations,
          failureReason: sttResult.failureReason
        },
        audio_music_detection: {
          detectorName: 'music_classification_analyzer',
          version: '1.0.0',
          status: musicResult.status,
          executionDurationMs: musicResult.executionDurationMs,
          confidence: musicResult.confidence,
          limitations: musicResult.limitations,
          failureReason: musicResult.failureReason
        },
        audio_repeated_segments: {
          detectorName: 'subband_spectral_audio_fingerprint',
          version: '1.1.0',
          status: repeatedAudioStatus,
          executionDurationMs: totalMs,
          confidence: repeatedAudioSegments.length > 0 ? 0.90 : 0.92,
          limitations: 'Detects within-video acoustic repetition across non-adjacent segments using 16-band spectral energy correlation; does not match external copyrighted audio catalogs or YouTube Content ID.'
        }
      };

      return {
        hasVoiceover,
        voiceoverRatio,
        silenceRatio: parseFloat(silenceRatio.toFixed(2)),
        hasMusicDetected: musicResult.hasMusic,
        meanVolumeDb: meanVol,
        isAudible,
        advertiserSpeechFlags: [],
        segments,
        repeatedAudioSegments,
        transcriptSummary: isAudible 
          ? `Audio stream inspected. Acoustic energy present across ${Math.round(activeRatio * 100)}% of the timeline (mean volume ${meanVol} dB). ${sttResult.status === 'DETECTED' ? 'Speech transcription completed via local STT.' : 'Speech and voice narration are unverified without transcript analysis.'}`
          : 'Low volume or quiet audio track.',
        speechAnalysisStatus: sttResult.status,
        musicAnalysisStatus: musicResult.status,
        speechDetectionStatus,
        transcriptionStatus: sttResult.status,
        repeatedAudioStatus,
        transcriptSegments: sttResult.segments,
        detectors
      };
    } catch (err: any) {
      if (err instanceof AudioProcessingError) {
        throw err;
      }
      throw new AudioProcessingError(`Audio analysis failed: ${err?.message || 'FFmpeg process error'}`);
    }
  }
}

export const audioProcessor = new AudioProcessor();
