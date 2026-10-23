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
   * Validates that a candidate proxy file is an actual valid, readable media file
   * containing a playable video stream, using ffprobe.
   * Never relies on existence or non-zero size alone.
   */
  public async isValidMediaProxy(filePath: string): Promise<boolean> {
    if (!fs.existsSync(filePath)) return false;
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === 0) return false;

      const args = [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_type,width,height',
        '-print_format', 'json',
        filePath
      ];

      const { stdout } = await execFileAsync('ffprobe', args, { timeout: 10000 });
      const parsed = JSON.parse(stdout);
      const stream = parsed.streams?.[0];
      return stream?.codec_type === 'video' && Number(stream.width) > 0 && Number(stream.height) > 0;
    } catch (err: any) {
      console.warn('[ProxyGenerator] Proxy media validation failed for %s:', path.basename(filePath), err?.message || err);
      return false;
    }
  }

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

    // Fix B: Validate cached proxy media using ffprobe, not merely non-zero file size
    if (fs.existsSync(proxyPath)) {
      const isValidCached = await this.isValidMediaProxy(proxyPath);
      if (isValidCached) {
        return proxyPath;
      }
      // Cached proxy is invalid, corrupt, or empty: safely remove and regenerate
      if (proxyPath !== inputPath && fs.existsSync(proxyPath)) {
        try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
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

      // Verify that the generated file exists and is valid readable video media
      const isValidGenerated = await this.isValidMediaProxy(proxyPath);
      if (!isValidGenerated) {
        if (proxyPath !== inputPath && fs.existsSync(proxyPath)) {
          try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
        }
        throw new ProxyGenerationError(
          `Failed to generate required 1080p proxy for high-resolution (${metadata.resolutionLabel}) video: generated output is invalid or corrupted.`
        );
      }

      return proxyPath;
    } catch (err: any) {
      // Safe cleanup of partial or corrupt proxy, never touching original input
      if (proxyPath !== inputPath && fs.existsSync(proxyPath)) {
        try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
      }
      if (err instanceof ProxyGenerationError) throw err;

      // Fix A: Log full technical diagnostic to server logs without leaking internal paths or commands to user
      console.error(
        '[ProxyGenerator] FFmpeg conversion failed for %s (%s):',
        path.basename(inputPath),
        metadata.resolutionLabel,
        err?.message || err
      );

      const isTimeout = err?.killed || err?.signal === 'SIGTERM';
      const detail = isTimeout 
        ? 'conversion timed out after 60 seconds.'
        : 'conversion process failed.';

      throw new ProxyGenerationError(
        `Failed to generate required 1080p proxy for high-resolution (${metadata.resolutionLabel}) video: ${detail}`
      );
    }
  }
}

export const proxyGenerator = new ProxyGenerator();
