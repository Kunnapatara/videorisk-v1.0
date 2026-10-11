import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { MediaMetadata } from '../../types';

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
  hasMusicDetected: boolean;
  meanVolumeDb?: number;
  isAudible?: boolean;
  advertiserSpeechFlags: Array<{ word: string; timestamp: number; category: string }>;
  segments: Array<{ start: number; end: number; type: 'voice' | 'music' | 'silence' | 'mixed' }>;
  transcriptSummary: string;
}

export class AudioProcessor {
  /**
   * Processes audio stream using ffmpeg silencedetect and volume statistics
   * Uses execFile directly without shell
   */
  public async analyzeAudio(videoPath: string, metadataOrDuration: MediaMetadata | number): Promise<AudioAnalysisResult> {
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
        hasMusicDetected: false,
        meanVolumeDb: undefined,
        isAudible: false,
        advertiserSpeechFlags: [],
        segments: [{ start: 0, end: durationSeconds, type: 'silence' }],
        transcriptSummary: 'No audio stream detected in container.'
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

      // Distinguish measurable acoustic activity from verified speech:
      // Volume and silence filters measure sound energy, NOT speech or narrator identity.
      // Therefore, speech presence remains unverified by acoustic filters alone.
      const hasVoiceover = false;
      const voiceoverRatio = 0;
      const hasMusicDetected = false;

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

      return {
        hasVoiceover,
        voiceoverRatio,
        silenceRatio: parseFloat(silenceRatio.toFixed(2)),
        hasMusicDetected,
        meanVolumeDb: meanVol,
        isAudible,
        advertiserSpeechFlags: [],
        segments,
        transcriptSummary: isAudible 
          ? `Audio stream inspected. Acoustic energy present across ${Math.round(activeRatio * 100)}% of the timeline (mean volume ${meanVol} dB). Speech and voice narration are unverified without transcript analysis.`
          : 'Low volume or quiet audio track.'
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
