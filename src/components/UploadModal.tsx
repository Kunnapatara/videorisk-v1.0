import React, { useState, useRef } from 'react';
import { 
  UploadCloud, 
  Film, 
  Play, 
  Image as ImageIcon, 
  Tag, 
  AlertCircle, 
  CheckCircle, 
  Info, 
  Zap, 
  Tv, 
  X,
  FileText
} from 'lucide-react';
import { ScanMode, UserAccount } from '../types';
import { authFetch } from '../utils/api';

interface UploadModalProps {
  user: UserAccount | null;
  onScanCreated: (scanId: string) => void;
  onCancel: () => void;
  parentScanId?: string; // If doing a re-scan
  onGoToChannelProfile?: () => void;
}

export const UploadModal: React.FC<UploadModalProps> = ({ 
  user, 
  onScanCreated, 
  onCancel,
  parentScanId,
  onGoToChannelProfile
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [videoTitle, setVideoTitle] = useState('');
  const [videoDescription, setVideoDescription] = useState('');
  const [videoTags, setVideoTags] = useState('');
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);
  
  const [scanMode, setScanMode] = useState<ScanMode>('standard');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Client-side quick file metadata inspect
  const [clientMeta, setClientMeta] = useState<{
    durationSeconds: number;
    width: number;
    height: number;
    sizeMb: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (selectedFile: File) => {
    setFile(selectedFile);
    setUploadError(null);
    if (!videoTitle) {
      setVideoTitle(selectedFile.name.replace(/\.[^/.]+$/, ''));
    }

    const videoElem = document.createElement('video');
    videoElem.preload = 'metadata';
    videoElem.src = URL.createObjectURL(selectedFile);
    videoElem.onloadedmetadata = () => {
      setClientMeta({
        durationSeconds: Math.round(videoElem.duration || 60),
        width: videoElem.videoWidth || 1920,
        height: videoElem.videoHeight || 1080,
        sizeMb: parseFloat((selectedFile.size / (1024 * 1024)).toFixed(2))
      });
      URL.revokeObjectURL(videoElem.src);
    };
    videoElem.onerror = () => {
      setClientMeta({
        durationSeconds: 120,
        width: 1920,
        height: 1080,
        sizeMb: parseFloat((selectedFile.size / (1024 * 1024)).toFixed(2))
      });
    };
  };

  const handleThumbnailChange = (selectedImage: File) => {
    setThumbnailFile(selectedImage);
    const previewUrl = URL.createObjectURL(selectedImage);
    setThumbnailPreview(previewUrl);
  };

  const removeThumbnail = () => {
    if (thumbnailPreview) {
      URL.revokeObjectURL(thumbnailPreview);
    }
    setThumbnailFile(null);
    setThumbnailPreview(null);
  };

  const calculateRequiredCredits = () => {
    const mins = clientMeta ? Math.max(1, Math.ceil(clientMeta.durationSeconds / 60)) : 2;
    return scanMode === 'deep' ? mins * 2 : mins;
  };

  const handleStartRealScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      setUploadError('Please sign in or register to analyze videos. All scan data is strictly private to your account.');
      return;
    }
    if (!file) {
      setUploadError('Please select or drag a video file.');
      return;
    }

    setIsUploading(true);
    setUploadError(null);

    try {
      // 1. Upload Video
      const formData = new FormData();
      formData.append('video', file);

      const uploadRes = await authFetch('/api/uploads', {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        const errData = await uploadRes.json();
        throw new Error(errData.error || 'Failed to upload video.');
      }

      const uploadData = await uploadRes.json();

      // 2. Upload Thumbnail if provided
      let uploadedThumbPath: string | undefined;
      let uploadedThumbFilename: string | undefined;

      if (thumbnailFile) {
        const thumbFormData = new FormData();
        thumbFormData.append('thumbnail', thumbnailFile);

        const thumbRes = await authFetch('/api/uploads/thumbnail', {
          method: 'POST',
          body: thumbFormData,
        });

        if (thumbRes.ok) {
          const thumbData = await thumbRes.json();
          uploadedThumbPath = thumbData.filePath;
          uploadedThumbFilename = thumbData.filename;
        } else {
          console.warn('Thumbnail upload had non-critical issue; proceeding with video-only scan.');
        }
      }

      // Parse tags
      const parsedTags = videoTags
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      // 3. Create Scan
      const scanRes = await authFetch('/api/scans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPath: uploadData.filePath,
          videoFilename: uploadData.filename,
          videoTitle: videoTitle || uploadData.filename,
          videoDescription,
          videoTags: parsedTags.length > 0 ? parsedTags : undefined,
          thumbnailPath: uploadedThumbPath,
          thumbnailFilename: uploadedThumbFilename,
          scanMode,
          parentScanId,
          isRescan: !!parentScanId,
        }),
      });

      if (!scanRes.ok) {
        const errData = await scanRes.json();
        throw new Error(errData.error || 'Failed to start scan.');
      }

      const scanJob = await scanRes.json();
      onScanCreated(scanJob.id);
    } catch (err: any) {
      setUploadError(err.message || 'Error occurred while processing video.');
      setIsUploading(false);
    }
  };

  const handleStartDemoScan = async (demoType: 'problematic' | 'revised') => {
    if (!user) {
      setUploadError('Please sign in or register to analyze videos. All scan data is strictly private to your account.');
      return;
    }
    setIsUploading(true);
    setUploadError(null);

    try {
      const scanRes = await authFetch('/api/scans/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          demoType,
          scanMode,
          videoTitle: videoTitle || undefined,
          videoDescription: videoDescription || undefined,
          hasThumbnail: !!thumbnailFile,
          parentScanId: demoType === 'revised' ? parentScanId : undefined
        }),
      });

      if (!scanRes.ok) {
        throw new Error('Failed to start demo scan.');
      }

      const scanJob = await scanRes.json();
      onScanCreated(scanJob.id);
    } catch (err: any) {
      setUploadError(err.message || 'Failed to launch demo scan.');
      setIsUploading(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl border border-stone-200 overflow-hidden max-w-4xl mx-auto text-stone-900">
      {/* Header */}
      <div className="px-6 py-5 bg-stone-900 text-white flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase font-extrabold text-rose-500 tracking-wider">
              {parentScanId ? 'Verification Cut' : 'Pre-Publish Package'}
            </span>
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white mt-0.5">
            {parentScanId ? 'Re-Scan Revised Video' : 'Publishing Package Risk Assessment'}
          </h2>
          <p className="text-xs text-stone-400 mt-0.5">
            {parentScanId 
              ? 'Upload your updated cut to verify resolved signals and compare risk reduction.' 
              : 'Inspect your video, title, description, and thumbnail before you publish.'}
          </p>
        </div>
        <button 
          onClick={onCancel}
          className="text-stone-400 hover:text-white p-1 rounded-lg hover:bg-stone-800 transition-colors"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <form onSubmit={handleStartRealScan} className="p-6 sm:p-8 space-y-6">
        {uploadError && (
          <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-900 text-xs flex items-start gap-3">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-rose-600" />
            <div>
              <p className="font-bold text-sm">Unable to process video</p>
              <p className="mt-0.5">{uploadError}</p>
            </div>
          </div>
        )}

        {/* 1. Video Dropzone (Required) */}
        <div>
          <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-2">
            1. Video Media File <span className="text-rose-600">*</span>
          </label>
          <div 
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              if (e.dataTransfer.files?.[0]) {
                handleFileChange(e.dataTransfer.files[0]);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
              isDragOver ? 'border-rose-500 bg-rose-50/50' : 'border-stone-300 hover:border-stone-400 bg-stone-50/60 hover:bg-stone-50'
            }`}
          >
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={(e) => e.target.files?.[0] && handleFileChange(e.target.files[0])}
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/avi"
              className="hidden" 
            />

            <UploadCloud className="w-10 h-10 mx-auto text-stone-400 mb-2" />
            {file ? (
              <div>
                <p className="font-bold text-sm text-stone-900">{file.name}</p>
                <p className="text-xs text-stone-500 mt-1">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB · Ready to inspect · Click to change file
                </p>
              </div>
            ) : (
              <div>
                <p className="font-semibold text-stone-800 text-sm">
                  Drag and drop your video file here, or <span className="text-rose-600 underline">browse files</span>
                </p>
                <p className="text-xs text-stone-500 mt-1">
                  Supports MP4, MOV, WebM, MKV · Up to 4K resolution (1080p proxy decode)
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Client Metadata Preview */}
        {clientMeta && (
          <div className="bg-stone-50 rounded-xl p-3.5 border border-stone-200 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-stone-500 block text-[11px]">Duration</span>
              <span className="font-bold text-stone-900">
                {Math.floor(clientMeta.durationSeconds / 60)}m {clientMeta.durationSeconds % 60}s
              </span>
            </div>
            <div>
              <span className="text-stone-500 block text-[11px]">Resolution</span>
              <span className="font-bold text-stone-900">
                {clientMeta.width}x{clientMeta.height}
              </span>
            </div>
            <div>
              <span className="text-stone-500 block text-[11px]">File Size</span>
              <span className="font-bold text-stone-900">{clientMeta.sizeMb} MB</span>
            </div>
            <div>
              <span className="text-stone-500 block text-[11px]">Credits Required</span>
              <span className="font-extrabold text-rose-600 font-mono">{calculateRequiredCredits()} mins</span>
            </div>
          </div>
        )}

        {/* 2. Publishing Metadata: Title, Description, Tags (Optional) */}
        <div className="space-y-4 pt-2 border-t border-stone-100">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
              2. Publishing Metadata (Optional)
            </label>
            <span className="text-[11px] text-stone-400">
              Video-only scan is supported if metadata is not ready
            </span>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs font-semibold text-stone-700">Planned Video Title</span>
              <span className="text-[10px] text-stone-400">{videoTitle.length}/100</span>
            </div>
            <input 
              type="text"
              maxLength={100}
              value={videoTitle}
              onChange={(e) => setVideoTitle(e.target.value)}
              placeholder="e.g. How I Actually Built a Business in 30 Days"
              className="w-full px-3.5 py-2.5 border border-stone-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
            />
            <span className="text-[10px] text-stone-400 mt-0.5 block">
              Evaluated for deceptive claims, sensitive terms, and video coherence.
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Planned Description
              </label>
              <textarea 
                rows={3}
                value={videoDescription}
                onChange={(e) => setVideoDescription(e.target.value)}
                placeholder="Paste video summary, timestamps, links, or disclosure statements..."
                className="w-full px-3.5 py-2.5 border border-stone-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Tags or Keywords (comma separated)
              </label>
              <textarea 
                rows={3}
                value={videoTags}
                onChange={(e) => setVideoTags(e.target.value)}
                placeholder="e.g. business, startups, case study, tutorial, tech"
                className="w-full px-3.5 py-2.5 border border-stone-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
              />
            </div>
          </div>
        </div>

        {/* 3. Thumbnail Asset Upload (Optional) */}
        <div className="pt-2 border-t border-stone-100 space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
              3. Thumbnail Image (Optional)
            </label>
            <span className="text-[11px] text-stone-400">16:9 ratio (1280x720) recommended</span>
          </div>

          {thumbnailPreview ? (
            <div className="flex items-center gap-4 p-3 bg-stone-50 rounded-xl border border-stone-200">
              <img 
                src={thumbnailPreview} 
                alt="Thumbnail preview" 
                className="w-28 h-16 object-cover rounded-lg border border-stone-300 shadow-2xs" 
              />
              <div className="flex-1 min-w-0 text-xs">
                <p className="font-bold text-stone-900 truncate">{thumbnailFile?.name}</p>
                <p className="text-stone-500 text-[11px]">
                  {((thumbnailFile?.size || 0) / (1024 * 1024)).toFixed(2)} MB · Ready for aspect & visual checks
                </p>
              </div>
              <button
                type="button"
                onClick={removeThumbnail}
                className="text-stone-500 hover:text-rose-600 text-xs px-2.5 py-1.5 rounded-lg border border-stone-200 hover:border-rose-200 bg-white"
              >
                Remove
              </button>
            </div>
          ) : (
            <div 
              onClick={() => thumbnailInputRef.current?.click()}
              className="border border-dashed border-stone-300 hover:border-stone-400 rounded-xl p-4 text-center cursor-pointer bg-stone-50/50 hover:bg-stone-50 transition-colors"
            >
              <input 
                type="file" 
                ref={thumbnailInputRef} 
                onChange={(e) => e.target.files?.[0] && handleThumbnailChange(e.target.files[0])}
                accept="image/jpeg,image/png,image/webp"
                className="hidden" 
              />
              <div className="flex items-center justify-center gap-2 text-xs text-stone-600">
                <ImageIcon className="w-4 h-4 text-stone-400" />
                <span>Upload thumbnail image (JPEG, PNG, WebP) to inspect framing and policy compliance</span>
              </div>
            </div>
          )}
        </div>

        {/* 4. Analysis Level & Mode */}
        <div className="pt-2 border-t border-stone-100 space-y-2">
          <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider">
            4. Inspection Depth
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div 
              onClick={() => setScanMode('standard')}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                scanMode === 'standard' 
                  ? 'border-rose-600 bg-rose-50/40 ring-1 ring-rose-500' 
                  : 'border-stone-200 hover:border-stone-300 bg-white'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-sm text-stone-900">Standard Scan</span>
                <span className="text-xs text-rose-600 font-bold">1 credit / min</span>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Fast media inspection, audio silencedetect, scene cuts, metadata coherence, and full policy mapping.
              </p>
            </div>

            <div 
              onClick={() => setScanMode('deep')}
              className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                scanMode === 'deep' 
                  ? 'border-rose-600 bg-rose-50/40 ring-1 ring-rose-500' 
                  : 'border-stone-200 hover:border-stone-300 bg-white'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-sm text-stone-900">Deep Scan</span>
                <span className="text-xs text-rose-600 font-bold">2 credits / min</span>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Granular perceptual frame hashing, heavier cross-segment comparison, and intensive pattern audit.
              </p>
            </div>
          </div>
        </div>

        {/* Submit Action Bar */}
        <div className="pt-4 border-t border-stone-200 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-xs text-stone-600 flex items-center gap-1.5">
            <span>Available credits:</span>
            <strong className="text-emerald-700 font-mono text-sm font-bold">
              {user?.creditsRemaining ?? 0} mins
            </strong>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 sm:flex-initial px-4 py-2.5 border border-stone-300 hover:bg-stone-50 text-stone-700 text-xs font-semibold rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isUploading || !file}
              className={`flex-1 sm:flex-initial px-6 py-2.5 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-2 transition-all shadow-sm ${
                isUploading || !file ? 'bg-rose-300 cursor-not-allowed' : 'bg-rose-600 hover:bg-rose-500 active:scale-98'
              }`}
            >
              {isUploading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Processing Media Pipeline...</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Start Pre-Publish Risk Analysis</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Interactive Quick Demo Scans for Immediate Verification */}
        <div className="pt-4 border-t border-stone-100 bg-stone-50 -mx-6 sm:-mx-8 -mb-6 sm:-mb-8 p-6 sm:p-8 space-y-3">
          <div className="flex items-center gap-1.5 text-xs text-stone-700">
            <Zap className="w-4 h-4 text-amber-500" />
            <span className="font-bold">Instant Sandbox Playground:</span>
            <span>Test the pre-publish intelligence engine with creator sample profiles:</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <button
              type="button"
              disabled={isUploading}
              onClick={() => handleStartDemoScan('problematic')}
              className="p-3 bg-white border border-stone-200 hover:border-rose-400 rounded-xl text-left transition-colors shadow-2xs group"
            >
              <div className="font-bold text-stone-900 group-hover:text-rose-600 flex items-center justify-between">
                <span>Sample A: Raw Montage Clip</span>
                <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.2 rounded font-semibold">Reused Signals</span>
              </div>
              <p className="text-[11px] text-stone-500 mt-1">
                Simulates video with third-party clips, low creator voiceover, and static slideshow patterns.
              </p>
            </button>

            <button
              type="button"
              disabled={isUploading}
              onClick={() => handleStartDemoScan('revised')}
              className="p-3 bg-white border border-stone-200 hover:border-emerald-400 rounded-xl text-left transition-colors shadow-2xs group"
            >
              <div className="font-bold text-stone-900 group-hover:text-emerald-600 flex items-center justify-between">
                <span>Sample B: Clean Commentary Cut</span>
                <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.2 rounded font-semibold">Transformative</span>
              </div>
              <p className="text-[11px] text-stone-500 mt-1">
                Simulates revised cut with voice commentary, narrative framing, and corrected metadata.
              </p>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
