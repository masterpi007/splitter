import { useState, useRef } from 'react';
import { processReceipt } from '../api/client';
import { ReceiptOCRResult } from '../types';

interface ReceiptCaptureProps {
  onProcessed: (result: ReceiptOCRResult) => void;
  onError?: (error: string) => void;
  disabled?: boolean;
}

// Phone cameras produce 5-10MB photos. The OCR endpoint converts every byte
// into a JS number for the AI binding, so oversized uploads burn seconds of
// server CPU for no accuracy gain — receipt text reads fine at ~1280px.
const MAX_DIMENSION = 1280;

async function downscaleImage(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = MAX_DIMENSION / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1 && file.type === 'image/jpeg') return file;

    const width = Math.round(bitmap.width * Math.min(scale, 1));
    const height = Math.round(bitmap.height * Math.min(scale, 1));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.8),
    );
    if (!blob) return file;
    return new File([blob], 'receipt.jpg', { type: 'image/jpeg' });
  } catch {
    // HEIC or other formats the browser can't decode — send as-is.
    return file;
  }
}

export function ReceiptCapture({ onProcessed, onError, disabled }: ReceiptCaptureProps) {
  const [processing, setProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setProcessing(true);

    try {
      const result = await processReceipt(await downscaleImage(file));
      onProcessed(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process receipt';
      onError?.(message);
    } finally {
      setProcessing(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
    e.target.value = '';
  };

  if (processing) {
    return (
      <div className="flex items-center justify-center gap-2 py-3 px-4 bg-gray-700 rounded-lg">
        <svg className="animate-spin h-5 w-5 text-cyan-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span className="text-sm text-gray-300">Scanning receipt...</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        capture="environment"
        onChange={handleFileChange}
        className="hidden"
        disabled={disabled}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        onChange={handleFileChange}
        className="hidden"
        disabled={disabled}
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => cameraInputRef.current?.click()}
          disabled={disabled}
          className="flex-1 flex items-center justify-center gap-2 bg-gray-700 text-gray-300 py-3 px-4 rounded-lg hover:bg-gray-600 disabled:opacity-50"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4 5a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-1.586a1 1 0 01-.707-.293l-1.121-1.121A2 2 0 0011.172 3H8.828a2 2 0 00-1.414.586L6.293 4.707A1 1 0 015.586 5H4zm6 9a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
          Take Photo
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="flex-1 flex items-center justify-center gap-2 bg-gray-700 text-gray-300 py-3 px-4 rounded-lg hover:bg-gray-600 disabled:opacity-50"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
          </svg>
          Upload
        </button>
      </div>
    </div>
  );
}
