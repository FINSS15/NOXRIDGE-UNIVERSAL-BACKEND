import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { AppError } from '../utils/errors.js';

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

const atempoChain = (value) => {
  const filters = [];
  let remaining = value;
  while (remaining > 2) { filters.push('atempo=2'); remaining /= 2; }
  while (remaining < 0.5) { filters.push('atempo=0.5'); remaining /= 0.5; }
  filters.push(`atempo=${remaining.toFixed(5)}`);
  return filters;
};

export const transformAudio = async ({ buffer, speed, pitch, volume }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError('Audio source file is empty.', 400, 'AUDIO_FILE_REQUIRED');
  }
  if (!ffmpegPath) {
    throw new AppError('Audio processing is unavailable on this server.', 503, 'AUDIO_PROCESSOR_UNAVAILABLE');
  }
  const pitchFactor = 2 ** (pitch / 12);
  const tempo = speed / pitchFactor;
  const filters = [
    `asetrate=44100*${pitchFactor.toFixed(6)}`,
    'aresample=44100',
    ...atempoChain(tempo),
    `volume=${volume.toFixed(3)}`
  ].join(',');

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-af', filters,
      '-ar', '44100', '-ac', '2',
      '-codec:a', 'libmp3lame', '-b:a', '192k',
      '-f', 'mp3', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const chunks = [];
    let total = 0;
    let stderr = '';
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AppError('Audio processing timed out.', 504, 'AUDIO_PROCESSING_TIMEOUT'));
    }, 120000);

    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new AppError('Processed audio exceeds Roblox 20 MB upload limit.', 413, 'AUDIO_OUTPUT_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.on('error', () => finish(new AppError('Could not start the audio processor.', 503, 'AUDIO_PROCESSOR_FAILED')));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new AppError('Audio could not be decoded or processed. Use a valid audio file.', 400, 'AUDIO_PROCESSING_FAILED'));
        return;
      }
      const output = Buffer.concat(chunks);
      if (!output.length) {
        finish(new AppError('Audio processor returned an empty file.', 400, 'AUDIO_PROCESSING_EMPTY'));
        return;
      }
      finish(null, output);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buffer);
  });
};
