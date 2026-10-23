import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { MediaMetadata } from '../../types';

const execFileAsync = promisify(execFile);

export class ProxyGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyGenerationError';
  }
}

export class ProxyGenerator {
  /**
   * Generates a 1080p proxy file for 4K / UHD footage to control compute costs.
   * If proxy generation fails or times out, fails closed to prevent overloading
   * downstream analyzers with raw high-resolution media.
   * Uses execFile directly without shell.
   */
  public async generateProxyIfNeeded(inputPath: string, metadata: MediaMetadata): Promise<string> {
    if (!metadata.isProxyUsed) {
      return inputPath;
    }

    const outputDir = path.resolve(process.cwd(), 'uploads', 'proxies');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const proxyPath = path.join(outputDir, `proxy_${path.basename(inputPath, path.extname(inputPath))}.mp4`);

    if (fs.existsSync(proxyPath)) {
      try {
        const stats = fs.statSync(proxyPath);
        if (stats.size > 0) {
          return proxyPath;
        }
        if (proxyPath !== inputPath) {
          fs.unlinkSync(proxyPath);
        }
      } catch {
        // ignore and regenerate
      }
    }

    try {
      const args = [
        '-y',
        '-i', inputPath,
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        proxyPath
      ];

      await execFileAsync('ffmpeg', args, { timeout: 60000 });

      if (!fs.existsSync(proxyPath) || fs.statSync(proxyPath).size === 0) {
        if (proxyPath !== inputPath && fs.existsSync(proxyPath)) {
          try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
        }
        throw new ProxyGenerationError('Generated proxy video file is missing or empty.');
      }

      return proxyPath;
    } catch (err: any) {
      if (proxyPath !== inputPath && fs.existsSync(proxyPath)) {
        try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
      }
      if (err instanceof ProxyGenerationError) throw err;
      const isTimeout = err?.killed || err?.signal === 'SIGTERM';
      const detail = isTimeout 
        ? 'Processing timed out after 60 seconds'
        : (err?.message ? `FFmpeg error: ${err.message}` : 'FFmpeg process error');
      throw new ProxyGenerationError(
        `Failed to generate required 1080p proxy for high-resolution (${metadata.resolutionLabel}) video: ${detail}`
      );
    }
  }
}

export const proxyGenerator = new ProxyGenerator();
