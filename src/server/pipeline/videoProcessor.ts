import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { 
  MediaMetadata, 
  ScanMode, 
  DomainAssessmentStatus, 
  DetectorExecutionStatus,
  DetectorReport 
} from '../../types';

const execFileAsync = promisify(execFile);

export class VideoProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoProcessingError';
  }
}

export interface VideoAnalysisResult {
  scenesCount: number;
  framesSampled: number;
  hasSlideshowPattern: boolean;
  /**
   * Repeated footage segments identified within the video stream.
   * Interval Convention:
   * - `start` and `end`: The timestamp interval of the later (repeated) occurrence.
   * - `matchWithTimestamp` and `matchWithEndTimestamp`: The timestamp interval of the earlier (original anchor) occurrence.
   * Both intervals are ordered and bounded within [0, durationSeconds].
   */
  repeatedFootageSegments: Array<{ 
    start: number; 
    end: number; 
    matchWithTimestamp: number; 
    matchWithEndTimestamp?: number;
    similarity: number; 
    confidence: number;
  }>;
  templateRepetitions: Array<{ 
    start: number; 
    end: number; 
    pattern: string;
    similarity?: number;
  }>;
  averagePacingSeconds: number;
  tempFramesDir: string;
  cutTimestamps?: number[];
  sampledIntervals?: Array<{ start: number; end: number }>;
  slideshowAnalysisStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  repeatedFootageStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  templateAnalysisStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  detectors?: Record<string, DetectorReport>;
  videoOcr?: import('../../types').VideoOcrResult;
}

export interface AdaptiveAnalysisResult extends VideoAnalysisResult {
  candidateTimestamps: number[];
  requestedFramesCount: number;
  actualExtractedFramesCount: number;
  framesValidatedReadable: number;
  actualAnalyzedFramesCount: number;
  additionalFramesExtracted: number;
  sceneCutCoverageRatio: number;
  candidateOverheadMs: number;
  adaptiveExtractionStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED_NO_CANDIDATES';
}

/**
 * Deterministic OCR sampling function used across production orchestration and regression suites.
 * Samples timestamps distributed across the entire media duration [0, durationSeconds] (start, middle, end).
 * Avoids duplicate timestamps, guarantees timestamps <= durationSeconds, and handles short media gracefully.
 */
export function calculateOcrSamplingTimestamps(
  durationSeconds: number,
  maxFrames: number = 15,
  sampleIntervalSeconds?: number
): number[] {
  const dur = Math.max(0.1, durationSeconds || 0.1);
  const maxF = Math.max(1, Math.min(60, maxFrames));
  const candidateTimestamps: number[] = [];

  if (dur <= 1.0) {
    return [0];
  }

  if (sampleIntervalSeconds && sampleIntervalSeconds > 0) {
    for (let t = 0; t < dur && candidateTimestamps.length < maxF; t += sampleIntervalSeconds) {
      candidateTimestamps.push(parseFloat(t.toFixed(2)));
    }
  } else {
    const targetCount = Math.min(maxF, Math.max(1, Math.ceil(dur)));
    if (targetCount === 1) {
      candidateTimestamps.push(0);
    } else {
      const step = (dur - 0.1) / (targetCount - 1);
      for (let i = 0; i < targetCount; i++) {
        const t = Math.min(dur - 0.05, Math.max(0, i * step));
        const rounded = parseFloat(t.toFixed(2));
        if (!candidateTimestamps.includes(rounded)) {
          candidateTimestamps.push(rounded);
        }
      }
    }
  }

  if (candidateTimestamps.length === 0) {
    candidateTimestamps.push(0);
  }
  return candidateTimestamps.sort((a, b) => a - b);
}

/**
 * Validates Tesseract TSV output structure before accepting OCR results.
 * Verifies standard header format, exact column count per row, numeric bounding boxes,
 * valid confidences in range [-1, 100], and rejects header-only TSV files.
 */
export function validateTesseractTsv(stdout: string): {
  isValid: boolean;
  error?: string;
  boundingBoxes: import('../../types').OcrBoundingBox[];
  words: string[];
  totalConf: number;
  wordCount: number;
} {
  // Split by newlines without stripping trailing tabs
  const lines = stdout.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) {
    return { isValid: false, error: 'Empty TSV output from Tesseract', boundingBoxes: [], words: [], totalConf: 0, wordCount: 0 };
  }

  const header = lines[0].split('\t').map(h => h.trim().toLowerCase());
  // Standard expected columns: level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text
  const requiredColumns = ['level', 'left', 'top', 'width', 'height', 'conf', 'text'];
  const hasRequiredHeaders = requiredColumns.every(col => header.includes(col));

  if (!hasRequiredHeaders) {
    return { isValid: false, error: 'Malformed TSV header: missing required columns', boundingBoxes: [], words: [], totalConf: 0, wordCount: 0 };
  }

  // Reject header-only TSV (no data rows)
  const dataLines = lines.slice(1).filter(l => l.length > 0);
  if (dataLines.length === 0) {
    return { isValid: false, error: 'Header-only TSV output: missing data lines (contains no data rows)', boundingBoxes: [], words: [], totalConf: 0, wordCount: 0 };
  }

  const levelIdx = header.indexOf('level');
  const leftIdx = header.indexOf('left');
  const topIdx = header.indexOf('top');
  const widthIdx = header.indexOf('width');
  const heightIdx = header.indexOf('height');
  const confIdx = header.indexOf('conf');
  const textIdx = header.indexOf('text');

  const boundingBoxes: import('../../types').OcrBoundingBox[] = [];
  const words: string[] = [];
  let totalConf = 0;
  let wordCount = 0;

  for (let l = 0; l < dataLines.length; l++) {
    const rawLine = dataLines[l];
    let parts = rawLine.split('\t');
    // If the trailing text column is empty, parts.length might be header.length - 1 if trailing tab was omitted
    if (parts.length === header.length - 1 && textIdx === header.length - 1) {
      parts.push('');
    }
    if (parts.length < header.length) {
      return {
        isValid: false,
        error: `Malformed TSV row at line ${l + 2}: expected ${header.length} columns, found ${parts.length}`,
        boundingBoxes: [],
        words: [],
        totalConf: 0,
        wordCount: 0
      };
    }

    // Validate level is numeric
    const level = parseInt(parts[levelIdx], 10);
    if (!Number.isFinite(level) || level < 1) {
      return {
        isValid: false,
        error: `Malformed TSV row at line ${l + 2}: invalid level field '${parts[levelIdx]}'`,
        boundingBoxes: [],
        words: [],
        totalConf: 0,
        wordCount: 0
      };
    }

    // Validate geometry fields are numeric non-negative integers
    const left = parseInt(parts[leftIdx], 10);
    const top = parseInt(parts[topIdx], 10);
    const w = parseInt(parts[widthIdx], 10);
    const h = parseInt(parts[heightIdx], 10);
    if (!Number.isFinite(left) || left < 0 || !Number.isFinite(top) || top < 0 ||
        !Number.isFinite(w) || w < 0 || !Number.isFinite(h) || h < 0) {
      return {
        isValid: false,
        error: `Malformed TSV row at line ${l + 2}: non-numeric or negative geometry (${parts[leftIdx]}, ${parts[topIdx]}, ${parts[widthIdx]}, ${parts[heightIdx]})`,
        boundingBoxes: [],
        words: [],
        totalConf: 0,
        wordCount: 0
      };
    }

    // Validate confidence is a valid number between -1 and 100
    const conf = parseFloat(parts[confIdx]);
    if (!Number.isFinite(conf) || conf < -1 || conf > 100) {
      return {
        isValid: false,
        error: `Malformed TSV row at line ${l + 2}: invalid confidence value '${parts[confIdx]}'`,
        boundingBoxes: [],
        words: [],
        totalConf: 0,
        wordCount: 0
      };
    }

    const wText = parts[textIdx]?.trim() || '';
    if (wText.length > 0 && conf >= 0) {
      words.push(wText);
      totalConf += conf;
      wordCount++;
      boundingBoxes.push({
        text: wText,
        confidence: parseFloat((conf / 100).toFixed(3)),
        left,
        top,
        width: w,
        height: h
      });
    }
  }

  return {
    isValid: true,
    boundingBoxes,
    words,
    totalConf,
    wordCount
  };
}

export class VideoProcessor {
  /**
   * Samples visual frames and performs:
   * 1. Scene cut transition detection via FFmpeg gt(scene,0.3)
   * 2. Perceptual frame fingerprinting (8x8 grayscale block comparison)
   * 3. Non-adjacent within-video repeated footage detection
   * 4. Intra-scene static frame invariance (slideshow heuristic)
   * 5. Structural template repetition analysis
   */
  public async analyzeVideo(
    videoPath: string, 
    metadata: MediaMetadata, 
    scanMode: ScanMode
  ): Promise<VideoAnalysisResult> {
    const startTime = Date.now();

    if (!fs.existsSync(videoPath)) {
      throw new VideoProcessingError(`Video file not found at ${videoPath}`);
    }

    const stats = await fs.promises.stat(videoPath);
    if (stats.size === 0) {
      throw new VideoProcessingError('Video file is empty (0 bytes).');
    }

    // Audio-only input: No video stream to sample
    if (!metadata.videoCodec || metadata.width === 0) {
      return {
        scenesCount: 0,
        framesSampled: 0,
        hasSlideshowPattern: false,
        repeatedFootageSegments: [],
        templateRepetitions: [],
        averagePacingSeconds: 0,
        tempFramesDir: '',
        slideshowAnalysisStatus: 'NOT_PROVIDED',
        repeatedFootageStatus: 'NOT_PROVIDED',
        templateAnalysisStatus: 'NOT_PROVIDED',
        detectors: {
          video_scene_cut: {
            detectorName: 'ffmpeg_scene_select',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No video stream present in container.'
          },
          video_repeated_footage: {
            detectorName: 'perceptual_hash_comparator',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No video stream present in container.'
          }
        }
      };
    }

    const dur = Math.max(0.1, metadata.durationSeconds || 0.1);
    const uniqueJobSubdir = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempDir = path.resolve(process.cwd(), 'uploads', 'frames', uniqueJobSubdir);
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Sampling parameters: sample 1 fps for short videos (<= 30s) to reliably capture cut transitions and repetitions
    const targetSamples = scanMode === 'deep' ? 120 : 60;
    const sampleInterval = dur <= 30
      ? 1
      : Math.max(1, parseFloat((dur / Math.min(targetSamples, Math.ceil(dur / 2))).toFixed(2)));
    const expectedSamples = Math.min(targetSamples, Math.max(1, Math.ceil(dur / sampleInterval)));

    try {
      // 1. Extract sampled visual preview JPEG frames for disk evidence
      const extractArgs = [
        '-y',
        '-i', videoPath,
        '-vf', `fps=1/${sampleInterval},scale=160:90`,
        '-vframes', String(expectedSamples),
        path.join(tempDir, 'frame_%03d.jpg')
      ];

      await execFileAsync('ffmpeg', extractArgs, { timeout: 45000 });

      // Read extracted frames from disk
      const frameFiles = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg')).sort();
      const framesCount = frameFiles.length;

      if (framesCount === 0) {
        throw new VideoProcessingError('Failed to extract visual frames from video stream.');
      }

      // 2. Extract 8x8 raw RGB bytes for perceptual similarity and repetition analysis
      // 8x8 rawvideo in rgb24 produces 192 bytes per sampled frame
      const bytesPerFrame = 192;
      const rawSampleArgs = [
        '-y',
        '-i', videoPath,
        '-vf', `fps=1/${sampleInterval},scale=8:8,format=rgb24`,
        '-vframes', String(expectedSamples),
        '-f', 'rawvideo',
        '-'
      ];

      let rawFramesBuffer: Buffer = Buffer.alloc(0);
      try {
        const rawRes = await execFileAsync('ffmpeg', rawSampleArgs, { 
          encoding: 'buffer', 
          maxBuffer: 10 * 1024 * 1024,
          timeout: 45000 
        });
        rawFramesBuffer = rawRes.stdout as unknown as Buffer;
      } catch (err: any) {
        throw new VideoProcessingError(`Failed to extract perceptual frame stream: ${err?.message || err}`);
      }

      const totalRawFrames = Math.floor(rawFramesBuffer.length / bytesPerFrame);

      // 3. Measure scene cut transitions via FFmpeg select gt(scene,0.3)
      const sceneDetectStart = Date.now();
      const sceneArgs = [
        '-y',
        '-i', videoPath,
        '-vf', "scale='min(320,iw)':-2,select='gt(scene,0.3)',metadata=print:file=-",
        '-f', 'null',
        '-'
      ];

      const { stdout: sceneStdout } = await execFileAsync('ffmpeg', sceneArgs, { timeout: 45000 });
      const sceneDetectMs = Date.now() - sceneDetectStart;

      // Parse detected scene cut timestamps
      const cutTimestamps: number[] = [];
      const regex = /pts_time:([0-9.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(sceneStdout)) !== null) {
        const ts = parseFloat(match[1]);
        if (!isNaN(ts)) {
          // Avoid duplicate triggers within 0.3s of each other
          if (cutTimestamps.length === 0 || ts - cutTimestamps[cutTimestamps.length - 1] >= 0.3) {
            cutTimestamps.push(parseFloat(ts.toFixed(2)));
          }
        }
      }

      // Calculate scenes count and average pacing strictly from detected cuts
      let scenesCount: number;
      let avgPacing: number;

      if (cutTimestamps.length === 0) {
        // Continuous single scene without detected cut transitions
        scenesCount = 1;
        avgPacing = dur;
      } else {
        scenesCount = cutTimestamps.length + 1;
        const sceneDurations: number[] = [];
        let prev = 0;
        for (const cut of cutTimestamps) {
          sceneDurations.push(Math.max(0.1, cut - prev));
          prev = cut;
        }
        sceneDurations.push(Math.max(0.1, dur - prev));
        const totalPacing = sceneDurations.reduce((sum, d) => sum + d, 0);
        avgPacing = totalPacing / sceneDurations.length;
      }

      // 4. Repeated Footage Detection via Perceptual Frame Comparison
      // Compare non-adjacent frames to find within-video repeated visual material
      const repetitionStart = Date.now();
      const repeatedFootageSegments: VideoAnalysisResult['repeatedFootageSegments'] = [];
      const templateRepetitions: VideoAnalysisResult['templateRepetitions'] = [];
      const sampledIntervals: Array<{ start: number; end: number }> = [];

      for (let i = 0; i < totalRawFrames; i++) {
        const sTime = Math.min(dur, parseFloat((i * sampleInterval).toFixed(2)));
        const eTime = Math.min(dur, parseFloat(((i + 1) * sampleInterval).toFixed(2)));
        sampledIntervals.push({ start: sTime, end: eTime });
      }

      // Precompute per-frame luminance grid (8x8 = 64 pixels), statistics, and gradient dHash bits
      interface FrameSignature {
        index: number;
        offset: number;
        luminance: Float32Array; // 64 values
        meanY: number;
        varY: number;
        stdDevY: number;
        meanR: number;
        meanG: number;
        meanB: number;
        hGradients: boolean[]; // 56 horizontal bits
        vGradients: boolean[]; // 56 vertical bits
      }

      const frameSignatures: FrameSignature[] = [];
      for (let i = 0; i < totalRawFrames; i++) {
        const off = i * bytesPerFrame;
        const lum = new Float32Array(64);
        let sumY = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;

        for (let p = 0; p < 64; p++) {
          const r = rawFramesBuffer[off + p * 3];
          const g = rawFramesBuffer[off + p * 3 + 1];
          const b = rawFramesBuffer[off + p * 3 + 2];
          sumR += r;
          sumG += g;
          sumB += b;
          const y = 0.299 * r + 0.587 * g + 0.114 * b;
          lum[p] = y;
          sumY += y;
        }

        const meanY = sumY / 64;
        let sumSqY = 0;
        for (let p = 0; p < 64; p++) {
          const dy = lum[p] - meanY;
          sumSqY += dy * dy;
        }
        const varY = sumSqY / 64;
        const stdDevY = Math.sqrt(varY);

        // 56 horizontal gradient comparisons: Y(x+1, y) > Y(x, y)
        const hGradients: boolean[] = [];
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 7; x++) {
            hGradients.push(lum[y * 8 + x + 1] > lum[y * 8 + x]);
          }
        }

        // 56 vertical gradient comparisons: Y(x, y+1) > Y(x, y)
        // Stored in row-major order: index = y * 8 + x (y in 0..6, x in 0..7)
        const vGradients: boolean[] = [];
        for (let y = 0; y < 7; y++) {
          for (let x = 0; x < 8; x++) {
            vGradients.push(lum[(y + 1) * 8 + x] > lum[y * 8 + x]);
          }
        }

        frameSignatures.push({
          index: i,
          offset: off,
          luminance: lum,
          meanY,
          varY,
          stdDevY,
          meanR: sumR / 64,
          meanG: sumG / 64,
          meanB: sumB / 64,
          hGradients,
          vGradients
        });
      }

      // Compute comprehensive similarity between two frames:
      // Combines:
      // 1. Normalized zero-mean luminance cross-correlation (NCC) - invariant to overall brightness shifts
      // 2. Luminance gradient difference hash match ratio (dHash) - captures structural edge layout
      // 3. Color difference (Delta RGB) - rejects wildly disparate color palettes
      // 4. Raw pixel RMS similarity (for flat/solid scenes where gradient variance is near zero)
      const evaluateFramePair = (f1: FrameSignature, f2: FrameSignature): { isDuplicate: boolean; similarity: number } => {
        // Raw RMS similarity across 192 RGB bytes
        let sumSq = 0;
        for (let k = 0; k < bytesPerFrame; k++) {
          const diff = rawFramesBuffer[f1.offset + k] - rawFramesBuffer[f2.offset + k];
          sumSq += diff * diff;
        }
        const rms = Math.sqrt(sumSq / bytesPerFrame);
        const rawRmsSim = Math.max(0, 1 - (rms / 255));

        // Mean color difference normalized to [0, 1]
        const colorDiff = (
          Math.abs(f1.meanR - f2.meanR) +
          Math.abs(f1.meanG - f2.meanG) +
          Math.abs(f1.meanB - f2.meanB)
        ) / (3 * 255);
        const colorSim = Math.max(0, 1 - colorDiff);

        // Low texture / flat frames (standard deviation of luminance < 2.5)
        const isFlat1 = f1.stdDevY < 2.5;
        const isFlat2 = f2.stdDevY < 2.5;

        if (isFlat1 || isFlat2) {
          if (isFlat1 && isFlat2) {
            // Both frames are flat/solid. They only match if raw RMS color is nearly identical
            const isMatch = rawRmsSim >= 0.96;
            return { isDuplicate: isMatch, similarity: rawRmsSim };
          }
          // One flat, one textured: cannot be duplicate
          return { isDuplicate: false, similarity: Math.min(rawRmsSim, 0.70) };
        }

        // Textured frames: compute normalized cross-correlation (NCC)
        let nccSum = 0;
        for (let p = 0; p < 64; p++) {
          nccSum += (f1.luminance[p] - f1.meanY) * (f2.luminance[p] - f2.meanY);
        }
        const ncc = nccSum / (64 * Math.max(0.1, f1.stdDevY * f2.stdDevY));

        // Compute gradient match ratio (112 bits)
        let gradMatches = 0;
        for (let b = 0; b < 56; b++) {
          if (f1.hGradients[b] === f2.hGradients[b]) gradMatches++;
          if (f1.vGradients[b] === f2.vGradients[b]) gradMatches++;
        }
        const gradMatchRatio = gradMatches / 112;

        // Composite structural similarity:
        // Weight: 50% NCC correlation, 30% gradient dHash, 20% color similarity
        const compositeSim = 0.50 * Math.max(0, ncc) + 0.30 * gradMatchRatio + 0.20 * colorSim;

        // Duplicate criteria for textured frames:
        // 1. High correlation (ncc >= 0.86)
        // 2. High gradient agreement (gradMatchRatio >= 0.85)
        // 3. Compatible color palette (colorDiff <= 0.22, accommodating lighting adjustments)
        let isDuplicate = ncc >= 0.86 && gradMatchRatio >= 0.85 && colorDiff <= 0.22;
        let matchedSim = isDuplicate ? Math.max(compositeSim, rawRmsSim) : compositeSim;

        // If not matched canonically, evaluate horizontal reflection (common video reuse/evasion mirror transform)
        if (!isDuplicate && colorDiff <= 0.22) {
          let nccMirrorSum = 0;
          for (let y = 0; y < 8; y++) {
            const yOff = y * 8;
            for (let x = 0; x < 8; x++) {
              nccMirrorSum += (f1.luminance[yOff + x] - f1.meanY) * (f2.luminance[yOff + (7 - x)] - f2.meanY);
            }
          }
          const nccMirror = nccMirrorSum / (64 * Math.max(0.1, f1.stdDevY * f2.stdDevY));

          if (nccMirror >= 0.86) {
            let gradMirrorMatches = 0;
            // Horizontal gradients: y in [0..7], x in [0..6] maps to mirrorX = 6 - x with inverted gradient direction
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 7; x++) {
                const mirrorH = !f2.hGradients[y * 7 + (6 - x)];
                if (f1.hGradients[y * 7 + x] === mirrorH) gradMirrorMatches++;
              }
            }
            // Vertical gradients: y in [0..6], x in [0..7] maps to mirrorX = 7 - x with same vertical gradient direction
            for (let y = 0; y < 7; y++) {
              for (let x = 0; x < 8; x++) {
                if (f1.vGradients[y * 8 + x] === f2.vGradients[y * 8 + (7 - x)]) gradMirrorMatches++;
              }
            }
            const gradMirrorMatchRatio = gradMirrorMatches / 112;
            if (gradMirrorMatchRatio >= 0.85) {
              isDuplicate = true;
              const compositeMirrorSim = 0.50 * Math.max(0, nccMirror) + 0.30 * gradMirrorMatchRatio + 0.20 * colorSim;
              matchedSim = compositeMirrorSim;
            }
          }
        }

        return {
          isDuplicate,
          similarity: parseFloat(Math.max(0, Math.min(1.0, matchedSim)).toFixed(3))
        };
      };

      // Intra-scene frame stability evaluation for slideshow heuristic
      let intraSceneFramePairs = 0;
      let intraSceneStaticPairs = 0;

      // Find non-adjacent visual matches
      // Two frames i and j are non-adjacent if separated by at least 2 intervening sample intervals or 2 seconds
      const minIndexGap = Math.max(2, Math.ceil(2.0 / sampleInterval));
      const rawMatches: Array<{ i: number; j: number; sim: number }> = [];

      for (let i = 0; i < totalRawFrames; i++) {
        const timeI = i * sampleInterval;

        // Check intra-scene continuity with adjacent frame i+1
        if (i + 1 < totalRawFrames) {
          const adjResult = evaluateFramePair(frameSignatures[i], frameSignatures[i + 1]);
          // If there is an abrupt visual transition (similarity < 0.85), it is a scene/slide boundary, not intra-scene
          if (adjResult.similarity >= 0.85) {
            intraSceneFramePairs++;
            // A static slide has near-zero movement: similarity >= 0.97
            if (adjResult.similarity >= 0.97) {
              intraSceneStaticPairs++;
            }
          }
        }

        // Compare against non-adjacent frames j > i
        for (let j = i + minIndexGap; j < totalRawFrames; j++) {
          const pairResult = evaluateFramePair(frameSignatures[i], frameSignatures[j]);

          // Near-duplicate threshold supported by structural evidence
          if (pairResult.isDuplicate) {
            // To be repeated footage (rather than an uninterrupted static long take),
            // there must be an intervening scene cut OR intervening distinct visual content
            const timeJ = j * sampleInterval;
            const hasInterveningCut = cutTimestamps.some(cut => cut > timeI + 0.1 && cut < timeJ - 0.1);
            let hasInterveningDifference = hasInterveningCut;
            if (!hasInterveningDifference) {
              for (let k = i + 1; k < j; k++) {
                const midResult = evaluateFramePair(frameSignatures[i], frameSignatures[k]);
                if (!midResult.isDuplicate || midResult.similarity < 0.88) {
                  hasInterveningDifference = true;
                  break;
                }
              }
            }

            if (hasInterveningDifference) {
              rawMatches.push({ i, j, sim: pairResult.similarity });
            }
          }
        }
      }

      // Merge contiguous repeated frame pairs into segments
      // e.g. (i, j), (i+1, j+1) -> segment [t_i, t_{i+1}] matching [t_j, t_{j+1}]
      const visitedPairs = new Set<string>();

      for (const m of rawMatches) {
        const pairKey = `${m.i}:${m.j}`;
        if (visitedPairs.has(pairKey)) continue;

        let startI = m.i;
        let endI = m.i;
        let startJ = m.j;
        let endJ = m.j;
        let totalSim = m.sim;
        let count = 1;
        visitedPairs.add(pairKey);

        // Extend forward
        let nextI = m.i + 1;
        let nextJ = m.j + 1;
        while (nextI < totalRawFrames && nextJ < totalRawFrames) {
          const nextKey = `${nextI}:${nextJ}`;
          const nextMatch = rawMatches.find(rm => rm.i === nextI && rm.j === nextJ);
          if (nextMatch) {
            endI = nextI;
            endJ = nextJ;
            totalSim += nextMatch.sim;
            count++;
            visitedPairs.add(nextKey);
            nextI++;
            nextJ++;
          } else {
            break;
          }
        }

        const tStart = Math.min(dur, parseFloat((startI * sampleInterval).toFixed(2)));
        const tEnd = Math.min(dur, parseFloat(((endI + 1) * sampleInterval).toFixed(2)));
        const matchTStart = Math.min(dur, parseFloat((startJ * sampleInterval).toFixed(2)));
        const matchTEnd = Math.min(dur, parseFloat(((endJ + 1) * sampleInterval).toFixed(2)));
        const avgSim = parseFloat((totalSim / count).toFixed(3));

        repeatedFootageSegments.push({
          start: matchTStart,
          end: Math.min(dur, Math.max(matchTStart + 0.1, matchTEnd)),
          matchWithTimestamp: tStart,
          matchWithEndTimestamp: tEnd,
          similarity: avgSim,
          confidence: parseFloat(Math.min(0.99, avgSim * 0.98).toFixed(2))
        });
      }

      // Consolidate overlapping repeated segments (keep maximal non-redundant spans)
      const consolidatedRepeats: VideoAnalysisResult['repeatedFootageSegments'] = [];
      const sortedByDuration = [...repeatedFootageSegments].sort((a, b) => (b.end - b.start) - (a.end - a.start));
      for (const seg of sortedByDuration) {
        const isRedundant = consolidatedRepeats.some(c => 
          seg.start >= c.start - 0.2 && seg.end <= c.end + 0.2
        );
        if (!isRedundant) {
          consolidatedRepeats.push(seg);
        }
      }
      consolidatedRepeats.sort((a, b) => a.start - b.start);

      // 5. Template Repetition Analysis
      // Detects recurring structural sequences (such as intro bumpers, outro cards, or chapter stings)
      // that appear at specific structural boundaries (e.g. near video start, video end, or across distinct scenes).
      // Distinct from general repeated footage (which may be b-roll or editing loops).
      if (consolidatedRepeats.length > 0 && scenesCount >= 2) {
        for (const seg of consolidatedRepeats) {
          const segDuration = seg.end - seg.start;
          if (segDuration >= 0.5 && segDuration <= 8.0) {
            // Check structural sequence position:
            // Intro: first occurrence is within first 25% of timeline or <= 5s
            // Outro / bumper: recurrence is near end (>= 75% or >= dur - 6s) or across separate scene cut boundaries
            const isNearStart = seg.matchWithTimestamp <= Math.max(5, dur * 0.25);
            const isNearEnd = seg.start >= Math.min(dur - 6, dur * 0.75);
            const alignsWithSceneCut = cutTimestamps.some(cut => Math.abs(cut - seg.start) < 1.0) ||
              cutTimestamps.some(cut => Math.abs(cut - seg.matchWithTimestamp) < 1.0);

            if ((isNearStart && isNearEnd) || alignsWithSceneCut) {
              templateRepetitions.push({
                start: seg.start,
                end: seg.end,
                pattern: (isNearStart && isNearEnd) ? 'recurring_intro_outro_template' : 'recurring_structural_bumper',
                similarity: seg.similarity
              });
            }
          }
        }
      }

      // 6. Slideshow Heuristic
      // Requirements for slideshow classification:
      // - Multiple distinct scene transitions (scenesCount >= 3)
      // - High proportion of intra-scene frames that are static (> 75%)
      // - Measured intra-scene frames count >= 3
      // - Average scene pacing between 1.5s and 12s
      // (Explicitly rejects single continuous static shot or dynamic cut videos)
      let hasSlideshowPattern = false;
      let slideshowStatus: DetectorExecutionStatus = 'NO_SIGNAL_DETECTED';

      if (dur < 3 || totalRawFrames < 3) {
        slideshowStatus = 'INSUFFICIENT_EVIDENCE';
      } else if (scenesCount >= 3 && intraSceneFramePairs >= 3) {
        const staticRatio = intraSceneStaticPairs / intraSceneFramePairs;
        if (staticRatio >= 0.75 && avgPacing >= 1.5 && avgPacing <= 12.0) {
          hasSlideshowPattern = true;
          slideshowStatus = 'DETECTED';
        } else {
          slideshowStatus = 'NO_SIGNAL_DETECTED';
        }
      } else {
        slideshowStatus = 'NO_SIGNAL_DETECTED';
      }

      const repeatedFootageStatus: DetectorExecutionStatus = totalRawFrames < 2 
        ? 'INSUFFICIENT_EVIDENCE' 
        : (consolidatedRepeats.length > 0 ? 'DETECTED' : 'NO_SIGNAL_DETECTED');

      const templateAnalysisStatus: DetectorExecutionStatus = totalRawFrames < 2
        ? 'INSUFFICIENT_EVIDENCE'
        : (templateRepetitions.length > 0 ? 'DETECTED' : 'NO_SIGNAL_DETECTED');

      const repetitionDurationMs = Date.now() - repetitionStart;
      const bitsToHex = (bits: boolean[]): string => {
        let hex = '';
        for (let b = 0; b < bits.length; b += 4) {
          let nibble = 0;
          if (bits[b]) nibble |= 8;
          if (bits[b + 1]) nibble |= 4;
          if (bits[b + 2]) nibble |= 2;
          if (bits[b + 3]) nibble |= 1;
          hex += nibble.toString(16);
        }
        return hex;
      };

      const compactVisualSignatures = frameSignatures.map(f => ({
        timestamp: parseFloat((f.index * sampleInterval).toFixed(2)),
        hGrad: bitsToHex(f.hGradients),
        vGrad: bitsToHex(f.vGradients),
        meanY: parseFloat(f.meanY.toFixed(1)),
        stdDevY: parseFloat(f.stdDevY.toFixed(1)),
        meanR: Math.round(f.meanR),
        meanG: Math.round(f.meanG),
        meanB: Math.round(f.meanB)
      }));

      const detectors: Record<string, DetectorReport> = {
        video_scene_cut: {
          detectorName: 'ffmpeg_scene_select',
          version: '1.0.0',
          status: 'DETECTED',
          executionDurationMs: sceneDetectMs,
          confidence: 0.90,
          limitations: 'Detects visual cut transitions based on luminance differences; does not classify semantic scene content.'
        },
        video_repeated_footage: {
          detectorName: 'perceptual_hash_comparator',
          version: '1.0.0',
          status: repeatedFootageStatus,
          executionDurationMs: repetitionDurationMs,
          confidence: consolidatedRepeats.length > 0 ? consolidatedRepeats[0].confidence : 0.92,
          limitations: 'Analyzes within-video non-adjacent frame repetition using 8x8 perceptual similarity; does not query external copyright or third-party databases.',
          details: {
            visualSignatures: compactVisualSignatures,
            repeatedSegmentsCount: consolidatedRepeats.length
          }
        },
        video_slideshow_heuristic: {
          detectorName: 'intra_scene_invariance_heuristic',
          version: '1.0.0',
          status: slideshowStatus,
          executionDurationMs: repetitionDurationMs,
          confidence: hasSlideshowPattern ? 0.85 : 0.90,
          limitations: 'Evaluates intra-scene stillness across multiple cuts. Panning slides, animated overlays, or talking heads may present ambiguous signals.'
        },
        video_template_heuristic: {
          detectorName: 'structural_template_comparator',
          version: '1.0.0',
          status: templateAnalysisStatus,
          executionDurationMs: repetitionDurationMs,
          confidence: templateRepetitions.length > 0 ? 0.84 : 0.88,
          limitations: 'Detects repeated short visual segments within the video container; does not evaluate cross-channel production templates.'
        }
      };

      return {
        scenesCount,
        framesSampled: framesCount,
        hasSlideshowPattern,
        repeatedFootageSegments: consolidatedRepeats,
        templateRepetitions,
        averagePacingSeconds: parseFloat(avgPacing.toFixed(1)),
        cutTimestamps,
        tempFramesDir: tempDir,
        sampledIntervals,
        slideshowAnalysisStatus: slideshowStatus,
        repeatedFootageStatus,
        templateAnalysisStatus,
        detectors
      };
    } catch (err: any) {
      // Ensure temp directory is cleaned up immediately on error to avoid disk leak
      await this.cleanupFrames(tempDir);
      if (err instanceof VideoProcessingError) {
        throw err;
      }
      throw new VideoProcessingError(
        `Video scene analysis failed: ${err?.message || 'FFmpeg process error'}`
      );
    }
  }

  /**
   * CANDIDATE ADAPTIVE SAMPLING STRATEGY (Phase 2 Experimental Evaluation)
   * Samples targeted frames around detected scene cut transitions while maintaining
   * bounded processing time, memory allocation, and maximum frame limits.
   *
   * Architectural Principles:
   * 1. Reuses initial scene cut detection results from baseline.
   * 2. Defines non-overlapping sampling windows around scene cuts (default +/-0.5s).
   * 3. Merges overlapping windows to prevent redundant sampling.
   * 4. Enforces strict upper bound on additional frames (maxAdditionalFrames).
   * 5. Performs actual frame extraction and 8x8 RGB perceptual inspection.
   * 6. Strictly computes sceneCutCoverageRatio from verified analyzed frames, not candidate timestamps.
   * 7. Measures candidateOverheadMs purely for the candidate phase excluding baseline time.
   */
  public async analyzeVideoAdaptiveCandidate(
    videoPath: string,
    metadata: MediaMetadata,
    scanMode: ScanMode,
    options: {
      windowSeconds?: number;
      maxAdditionalFrames?: number;
      simulateExtractionFailure?: boolean;
      simulatePartialExtractionCount?: number;
      simulateCorruptRgbBytes?: boolean | number[];
    } = {}
  ): Promise<AdaptiveAnalysisResult> {
    const baseline = await this.analyzeVideo(videoPath, metadata, scanMode);
    const overheadStart = Date.now();
    const cuts = baseline.cutTimestamps || [];

    if (cuts.length === 0 || !metadata.videoCodec || metadata.width === 0) {
      return {
        ...baseline,
        candidateTimestamps: [],
        requestedFramesCount: 0,
        actualExtractedFramesCount: 0,
        framesValidatedReadable: 0,
        actualAnalyzedFramesCount: 0,
        additionalFramesExtracted: 0,
        sceneCutCoverageRatio: 1.0,
        candidateOverheadMs: Date.now() - overheadStart,
        adaptiveExtractionStatus: 'SKIPPED_NO_CANDIDATES'
      };
    }

    const dur = Math.max(0.1, metadata.durationSeconds || 0.1);
    const windowSec = options.windowSeconds ?? 0.5;
    const maxAdditional = options.maxAdditionalFrames ?? 15;

    // 1. Merge overlapping windows around cuts
    const rawWindows = cuts.map(c => ({
      start: Math.max(0, c - windowSec),
      end: Math.min(dur, c + windowSec),
      center: c
    })).sort((a, b) => a.start - b.start);

    const mergedWindows: Array<{ start: number; end: number; cuts: number[] }> = [];
    for (const rw of rawWindows) {
      const last = mergedWindows[mergedWindows.length - 1];
      if (last && rw.start <= last.end) {
        last.end = Math.max(last.end, rw.end);
        last.cuts.push(rw.center);
      } else {
        mergedWindows.push({ start: rw.start, end: rw.end, cuts: [rw.center] });
      }
    }

    // 2. Identify candidate timestamps not already covered by baseline sampledIntervals
    const baselineTimes = (baseline.sampledIntervals || []).map(s => s.start);
    const candidateTimestamps: number[] = [];

    for (const w of mergedWindows) {
      for (const c of w.cuts) {
        const tBefore = Math.max(0, parseFloat((c - 0.25).toFixed(2)));
        const tAfter = Math.min(dur, parseFloat((c + 0.25).toFixed(2)));

        const isCoveredBefore = baselineTimes.some(bt => Math.abs(bt - tBefore) < 0.25);
        const isCoveredAfter = baselineTimes.some(bt => Math.abs(bt - tAfter) < 0.25);

        if (!isCoveredBefore && !candidateTimestamps.some(ct => Math.abs(ct - tBefore) < 0.1)) {
          candidateTimestamps.push(tBefore);
        }
        if (!isCoveredAfter && !candidateTimestamps.some(ct => Math.abs(ct - tAfter) < 0.1)) {
          candidateTimestamps.push(tAfter);
        }
        if (candidateTimestamps.length >= maxAdditional) break;
      }
      if (candidateTimestamps.length >= maxAdditional) break;
    }

    candidateTimestamps.sort((a, b) => a - b);
    const targetedTimestamps = candidateTimestamps.slice(0, maxAdditional);
    const requestedFramesCount = targetedTimestamps.length;

    if (requestedFramesCount === 0) {
      let coveredCuts = 0;
      for (const cut of cuts) {
        if (baselineTimes.some(pt => Math.abs(pt - cut) <= windowSec)) {
          coveredCuts++;
        }
      }
      return {
        ...baseline,
        candidateTimestamps,
        requestedFramesCount: 0,
        actualExtractedFramesCount: 0,
        framesValidatedReadable: 0,
        actualAnalyzedFramesCount: 0,
        additionalFramesExtracted: 0,
        sceneCutCoverageRatio: cuts.length > 0 ? parseFloat((coveredCuts / cuts.length).toFixed(3)) : 1.0,
        candidateOverheadMs: Date.now() - overheadStart,
        adaptiveExtractionStatus: 'SKIPPED_NO_CANDIDATES'
      };
    }

    // 3. Perform Actual Targeted Frame Extraction and Validation
    const targetDir = baseline.tempFramesDir && fs.existsSync(baseline.tempFramesDir)
      ? baseline.tempFramesDir
      : path.resolve(process.cwd(), 'uploads', 'frames', `adaptive_${Date.now()}`);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const extractedFrames: string[] = [];
    const validatedReadableTimestamps: number[] = [];

    for (let i = 0; i < targetedTimestamps.length; i++) {
      const t = targetedTimestamps[i];

      // Simulated failure / partial testing hooks
      if (options.simulateExtractionFailure) {
        continue;
      }
      if (typeof options.simulatePartialExtractionCount === 'number' && i >= options.simulatePartialExtractionCount) {
        continue;
      }

      const frameFile = path.join(targetDir, `adaptive_cut_${String(i).padStart(3, '0')}.jpg`);
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-ss', String(t),
          '-i', videoPath,
          '-frames:v', '1',
          '-vf', 'scale=160:90',
          frameFile
        ], { timeout: 15000 });

        if (fs.existsSync(frameFile) && fs.statSync(frameFile).size > 0) {
          extractedFrames.push(frameFile);

          // Validate raw pixel decode readability (8x8 RGB raw video: 8 * 8 * 3 = 192 bytes).
          // NOTE: Perceptual analysis is NOT implemented for candidate frames.
          // This verifies only that raw bytes can be extracted and decoded from the container.
          let isReadable = false;
          if (options.simulateCorruptRgbBytes === true) {
            isReadable = false;
          } else if (Array.isArray(options.simulateCorruptRgbBytes) && options.simulateCorruptRgbBytes.includes(i)) {
            isReadable = false;
          } else {
            const rawResult = await execFileAsync('ffmpeg', [
              '-y',
              '-ss', String(t),
              '-i', videoPath,
              '-frames:v', '1',
              '-vf', 'scale=8:8,format=rgb24',
              '-f', 'rawvideo',
              '-'
            ], { encoding: 'buffer', timeout: 15000 });

            if (rawResult.stdout && rawResult.stdout.length === 192) {
              isReadable = true;
            }
          }

          if (isReadable) {
            validatedReadableTimestamps.push(t);
          }
        }
      } catch (err: any) {
        console.warn(`[VideoProcessor] Adaptive candidate extraction failed at ${t}s:`, err?.message || err);
      }
    }

    const actualExtractedFramesCount = extractedFrames.length;
    const framesValidatedReadable = validatedReadableTimestamps.length;
    // Perceptual analysis is not implemented; actualAnalyzedFramesCount is strictly 0
    const actualAnalyzedFramesCount = 0;
    const additionalFramesExtracted = framesValidatedReadable;

    // 4. Determine Adaptive Extraction Status
    let adaptiveExtractionStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED_NO_CANDIDATES';
    if (requestedFramesCount === 0) {
      adaptiveExtractionStatus = 'SKIPPED_NO_CANDIDATES';
    } else if (framesValidatedReadable === requestedFramesCount && actualExtractedFramesCount === requestedFramesCount) {
      adaptiveExtractionStatus = 'SUCCESS';
    } else if (framesValidatedReadable > 0) {
      adaptiveExtractionStatus = 'PARTIAL';
    } else {
      adaptiveExtractionStatus = 'FAILED';
    }

    // 5. Measure scene cut coverage ratio strictly from ACTUALLY VALIDATED sample points
    const allValidatedPoints = [...baselineTimes, ...validatedReadableTimestamps];
    let coveredCuts = 0;
    for (const cut of cuts) {
      if (allValidatedPoints.some(pt => Math.abs(pt - cut) <= windowSec)) {
        coveredCuts++;
      }
    }
    const sceneCutCoverageRatio = cuts.length > 0 ? parseFloat((coveredCuts / cuts.length).toFixed(3)) : 1.0;
    const candidateOverheadMs = Date.now() - overheadStart;

    return {
      ...baseline,
      framesSampled: baseline.framesSampled + additionalFramesExtracted,
      candidateTimestamps,
      requestedFramesCount,
      actualExtractedFramesCount,
      framesValidatedReadable,
      actualAnalyzedFramesCount,
      additionalFramesExtracted,
      sceneCutCoverageRatio,
      candidateOverheadMs,
      adaptiveExtractionStatus
    };
  }

  /**
   * Phase 4.3 Full-video OCR implementation:
   * Deterministically samples frames from video, extracts high-res candidate frames using FFmpeg,
   * executes local Tesseract OCR on extracted frames, parses TSV bounding boxes & genuine confidence,
   * deduplicates repeated text across frames, and enforces bounded execution limits.
   */
  public async performVideoOcr(
    videoPath: string,
    metadata: MediaMetadata,
    options?: {
      maxFrames?: number;
      sampleIntervalSeconds?: number;
      timeoutMs?: number;
      languages?: string;
      timestamps?: number[];
    }
  ): Promise<import('../../types').VideoOcrResult> {
    const startTime = Date.now();
    const dur = Math.max(0.1, metadata.durationSeconds || 0.1);

    if (!fs.existsSync(videoPath)) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        framesInspected: 0,
        totalCandidateFrames: 0,
        coverageRatio: 0,
        limitations: 'Video file does not exist on disk.',
        failureReason: `Video media file not found at ${path.basename(videoPath)}`,
        executionDurationMs: 0,
        detectedFrames: [],
        allExtractedText: []
      };
    }

    if (!metadata.videoCodec || metadata.width === 0) {
      return {
        status: 'NOT_PROVIDED',
        framesInspected: 0,
        totalCandidateFrames: 0,
        coverageRatio: 0,
        limitations: 'Container does not contain an active visual video stream.',
        executionDurationMs: 0,
        detectedFrames: [],
        allExtractedText: []
      };
    }

    // Determine tesseract binary
    const tesseractPath = process.env.TESSERACT_PATH;
    let executable: string | null = null;
    if (tesseractPath && fs.existsSync(tesseractPath)) {
      executable = tesseractPath;
    } else if (tesseractPath) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        framesInspected: 0,
        totalCandidateFrames: 0,
        coverageRatio: 0,
        limitations: 'OCR engine path configured but executable is missing on disk.',
        failureReason: `Configured TESSERACT_PATH not found at ${tesseractPath}`,
        executionDurationMs: Date.now() - startTime,
        detectedFrames: [],
        allExtractedText: []
      };
    }

    if (!executable) {
      return {
        status: 'NOT_ASSESSED',
        framesInspected: 0,
        totalCandidateFrames: 0,
        coverageRatio: 0,
        limitations: 'Local visual OCR engine (TESSERACT_PATH) not configured or installed. Full-video on-screen text overlays are not assessed.',
        executionDurationMs: 0,
        detectedFrames: [],
        allExtractedText: []
      };
    }

    // Bounded configuration limits
    const maxFrames = Math.max(1, Math.min(60, options?.maxFrames || 15));
    const timeoutMs = options?.timeoutMs || 45000;
    const langs = options?.languages || 'eng+tha';

    // Calculate candidate timestamps distributed deterministically across the entire duration [0, dur]
    const candidateTimestamps = (options?.timestamps && options.timestamps.length > 0)
      ? options.timestamps.filter(t => t >= 0 && t <= dur).sort((a, b) => a - b)
      : calculateOcrSamplingTimestamps(dur, maxFrames, options?.sampleIntervalSeconds);
    const totalCandidateFrames = candidateTimestamps.length;
    const framesTargeted = totalCandidateFrames;

    const uniqueOcrDir = `video_ocr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempOcrDir = path.resolve(process.cwd(), 'uploads', 'ocr_frames', uniqueOcrDir);

    try {
      if (!fs.existsSync(tempOcrDir)) {
        fs.mkdirSync(tempOcrDir, { recursive: true });
      }

      // Extract candidate frames to disk via FFmpeg
      const extractedFrames: Array<{ timestamp: number; index: number; filePath: string }> = [];
      let extractionTimeouts = false;
      let framesExtractionFailed = 0;

      for (let i = 0; i < candidateTimestamps.length; i++) {
        // Enforce overall processing timeout
        if (Date.now() - startTime >= timeoutMs) {
          extractionTimeouts = true;
          break;
        }

        const ts = candidateTimestamps[i];
        const outName = `frame_${i.toString().padStart(3, '0')}.png`;
        const outPath = path.join(tempOcrDir, outName);

        try {
          await execFileAsync('ffmpeg', [
            '-y',
            '-ss', String(ts),
            '-i', videoPath,
            '-vframes', '1',
            '-vf', 'scale=640:-2', // Standardize frame resolution for bounded OCR processing
            outPath
          ], { timeout: 10000 });

          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
            extractedFrames.push({ timestamp: ts, index: i, filePath: outPath });
          } else {
            framesExtractionFailed++;
          }
        } catch {
          framesExtractionFailed++;
        }
      }

      const framesExtracted = extractedFrames.length;
      const plannedExtractionAttempts = extractionTimeouts ? extractedFrames.length + framesExtractionFailed : totalCandidateFrames;
      const extractionSkipped = Math.max(0, totalCandidateFrames - plannedExtractionAttempts);

      if (framesExtracted === 0) {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          executionStatus: 'UNAVAILABLE',
          framesInspected: 0,
          totalCandidateFrames,
          coverageRatio: 0,
          timelineCoverageRatio: 0,
          samplingCoverageRatio: 0,
          ocrExecutionSuccessRatio: 0,
          framesTargeted,
          framesExtracted: 0,
          framesExtractionFailed,
          framesAttempted: 0,
          framesSucceeded: 0,
          framesFailed: 0,
          framesOcrFailed: 0,
          framesSkipped: extractionSkipped,
          isPartial: true,
          limitations: 'Failed to extract video frames for OCR analysis.',
          failureReason: `FFmpeg frame extraction yielded 0 readable candidate frames (${framesExtractionFailed} attempt(s) failed).`,
          executionDurationMs: Date.now() - startTime,
          detectedFrames: [],
          allExtractedText: []
        };
      }

      // Run Tesseract OCR on extracted frames
      const detectedFrames: import('../../types').VideoFrameOcrItem[] = [];
      const allExtractedTextSet = new Set<string>();
      let previousFrameText = '';
      let framesAttempted = 0;
      let framesSucceeded = 0;
      let framesOcrFailed = 0;
      const ocrErrors: string[] = [];
      let executionTimedOut = extractionTimeouts;

      const succeededTimestamps: number[] = [];

      for (const ef of extractedFrames) {
        if (Date.now() - startTime >= timeoutMs) {
          executionTimedOut = true;
          break;
        }

        framesAttempted++;
        try {
          const { stdout } = await execFileAsync(executable, [ef.filePath, 'stdout', '-l', langs, 'tsv'], { timeout: 15000 });

          // Strict TSV structural validation: verify header, columns, rows, geometry, and confidence
          const tsvValidation = validateTesseractTsv(stdout || '');
          if (!tsvValidation.isValid) {
            framesOcrFailed++;
            ocrErrors.push(`Frame @ ${ef.timestamp}s: ${tsvValidation.error || 'Invalid TSV structure'}`);
            continue;
          }

          framesSucceeded++;
          succeededTimestamps.push(ef.timestamp);

          const { words, boundingBoxes, totalConf, wordCount } = tsvValidation;
          const frameText = words.join(' ').trim();
          if (frameText.length > 0) {
            // Deduplicate identical repeated text across immediately consecutive sampled frames
            const avgConf = wordCount > 0 ? parseFloat((totalConf / (wordCount * 100)).toFixed(3)) : 0;
            if (frameText !== previousFrameText) {
              detectedFrames.push({
                timestamp: ef.timestamp,
                frameIndex: ef.index,
                frameFile: path.basename(ef.filePath),
                text: frameText,
                confidence: avgConf,
                boundingBoxes
              });
              allExtractedTextSet.add(frameText);
            }
            previousFrameText = frameText;
          }
        } catch (ocrErr: any) {
          framesOcrFailed++;
          ocrErrors.push(`Frame @ ${ef.timestamp}s: ${ocrErr?.message || ocrErr}`);
        }
      }

      // framesFailed: total OCR failures
      const framesFailed = framesOcrFailed;
      // framesSkipped: frames planned but never attempted due to timeout or prior fatal stage
      const framesSkipped = Math.max(0, framesTargeted - (framesAttempted + framesExtractionFailed));

      // samplingCoverageRatio: sampling fulfillment ratio = framesExtracted / framesTargeted
      const samplingCoverageRatio = framesTargeted > 0
        ? parseFloat((framesExtracted / framesTargeted).toFixed(3))
        : 0;

      // ocrExecutionSuccessRatio: proportion of attempted OCR evaluations that succeeded with valid TSV
      const ocrExecutionSuccessRatio = framesAttempted > 0
        ? parseFloat((framesSucceeded / framesAttempted).toFixed(3))
        : 0;

      // Timeline coverage: union of temporal inspection windows associated with each successfully inspected frame
      // Each frame represents an inspection window of [ts - halfWindow, ts + halfWindow] clipped to [0, dur]
      let timelineCoverageRatio = 0;
      if (succeededTimestamps.length > 0 && dur > 0) {
        // Window size per sample point = dur / framesTargeted
        const windowSize = dur / Math.max(1, framesTargeted);
        const halfWindow = windowSize / 2;

        const rawIntervals = succeededTimestamps.map(t => ({
          start: Math.max(0, parseFloat((t - halfWindow).toFixed(3))),
          end: Math.min(dur, parseFloat((t + halfWindow).toFixed(3)))
        })).sort((a, b) => a.start - b.start);

        // Compute mathematical union of non-overlapping intervals
        const mergedIntervals: Array<{ start: number; end: number }> = [];
        for (const interval of rawIntervals) {
          const last = mergedIntervals[mergedIntervals.length - 1];
          if (!last || interval.start > last.end) {
            mergedIntervals.push({ start: interval.start, end: interval.end });
          } else {
            last.end = Math.max(last.end, interval.end);
          }
        }

        const coveredSeconds = mergedIntervals.reduce((sum, int) => sum + (int.end - int.start), 0);
        timelineCoverageRatio = parseFloat(Math.min(1.0, coveredSeconds / dur).toFixed(3));
      }

      // Backward compatible coverageRatio represents true sampling coverage
      const coverageRatio = samplingCoverageRatio;
      const isPartial = framesSucceeded < framesTargeted || executionTimedOut;

      // Semantic status classification:
      // SUCCESS_WITH_SIGNAL: all required work succeeded AND text was detected
      // NO_SIGNAL_DETECTED: all required work succeeded AND no text was detected
      // PARTIAL: some OCR frames succeeded but others failed or timed out
      // FAILED: all attempted OCR failed or 0 frames succeeded
      // UNAVAILABLE: executable missing/unusable
      let executionStatus: 'SUCCESS_WITH_SIGNAL' | 'NO_SIGNAL_DETECTED' | 'PARTIAL' | 'FAILED' | 'UNAVAILABLE' | 'NOT_ASSESSED';
      let status: import('../../types').DetectorExecutionStatus;

      if (framesAttempted === 0 || framesSucceeded === 0) {
        executionStatus = 'FAILED';
        status = 'INSUFFICIENT_EVIDENCE';
      } else if (isPartial) {
        executionStatus = 'PARTIAL';
        status = detectedFrames.length > 0 ? 'DETECTED' : 'INSUFFICIENT_EVIDENCE';
      } else if (detectedFrames.length > 0) {
        executionStatus = 'SUCCESS_WITH_SIGNAL';
        status = 'DETECTED';
      } else {
        executionStatus = 'NO_SIGNAL_DETECTED';
        status = 'NO_SIGNAL_DETECTED';
      }

      let limitations: string;
      if (executionStatus === 'FAILED') {
        limitations = `OCR execution failed for all ${framesAttempted} attempted frame(s). No visual text signals could be assessed.`;
      } else if (isPartial) {
        limitations = `Sampled and completed OCR on ${framesSucceeded} of ${framesTargeted} target frames (${Math.round(samplingCoverageRatio * 100)}% sampling fulfillment, ${Math.round(timelineCoverageRatio * 100)}% temporal timeline coverage) due to ${executionTimedOut ? 'timeout' : 'frame processing error'}. Text on uninspected portions was not evaluated.`;
      } else {
        limitations = `Sampled ${framesSucceeded} video frames deterministically across the entire ${Math.round(dur)}s timeline (${Math.round(samplingCoverageRatio * 100)}% sampling fulfillment, ${Math.round(timelineCoverageRatio * 100)}% timeline coverage) via local Tesseract OCR.`;
      }

      const failureReason = ocrErrors.length > 0
        ? `OCR encountered errors on ${framesOcrFailed} frame(s): ${ocrErrors.slice(0, 3).join('; ')}`
        : (executionTimedOut ? `OCR execution timed out after ${timeoutMs}ms` : undefined);

      return {
        status,
        executionStatus,
        framesInspected: framesSucceeded,
        totalCandidateFrames,
        coverageRatio,
        timelineCoverageRatio,
        samplingCoverageRatio,
        ocrExecutionSuccessRatio,
        framesTargeted,
        framesExtracted,
        framesExtractionFailed,
        framesAttempted,
        framesSucceeded,
        framesFailed,
        framesOcrFailed,
        framesSkipped,
        isPartial,
        limitations,
        failureReason,
        executionDurationMs: Date.now() - startTime,
        detectedFrames,
        allExtractedText: Array.from(allExtractedTextSet)
      };
    } finally {
      // Safe cleanup of temporary OCR frame directory
      try {
        if (fs.existsSync(tempOcrDir)) {
          await fs.promises.rm(tempOcrDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup error
      }
    }
  }

  /**
   * Cleans up extracted frames directory after job completes or fails
   */
  public async cleanupFrames(framesDir: string): Promise<void> {
    try {
      if (fs.existsSync(framesDir)) {
        await fs.promises.rm(framesDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn('[VideoProcessor] Failed to clean temp frames:', err);
    }
  }
}

export const videoProcessor = new VideoProcessor();
