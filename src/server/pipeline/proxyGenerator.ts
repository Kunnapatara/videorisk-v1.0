import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { MediaMetadata } from '../../types';

const execFileAsync = promisify(execFile);

export class ProxyGenerator {
  /**
   * Generates a 1080p proxy file for 4K / UHD footage to control compute costs
   * Uses execFile directly without shell
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
      return proxyPath;
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
      return proxyPath;
    } catch (err: any) {
      console.warn('[ProxyGenerator] Failed to create proxy, falling back to original:', err?.message || err);
      return inputPath;
    }
  }
}

export const proxyGenerator = new ProxyGenerator();
