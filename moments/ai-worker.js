/* Moments: on-device "search by meaning" worker.
 * Runs MobileCLIP-S0 with Transformers.js. Photos never leave the phone:
 * only the model files are downloaded (from Hugging Face, once, then cached). */
import {
  env, AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, RawImage,
} from './vendor/transformers.min.js';

const MODEL = 'Xenova/mobileclip_s0';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;
env.backends.onnx.wasm.numThreads = 1; // GitHub Pages isn't cross-origin isolated

let ready = null, tokenizer, processor, textModel, visionModel;

function normalise(arr) {
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
  return out;
}

function load() {
  if (ready) return ready;
  const progress = (p) => {
    if (p && p.status === 'progress' && p.total) self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  };
  ready = (async () => {
    const opts = { progress_callback: progress, device: 'wasm' };
    tokenizer = await AutoTokenizer.from_pretrained(MODEL, opts);
    processor = await AutoProcessor.from_pretrained(MODEL, opts);
    textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL, { ...opts, dtype: 'q8' });
    try { visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { ...opts, dtype: 'q8' }); }
    catch (_) { visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { ...opts, dtype: 'fp32' }); }
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') { await load(); self.postMessage({ id, type: 'ready' }); return; }
    await load();
    if (type === 'image') {
      const image = await RawImage.fromBlob(e.data.blob);
      const inputs = await processor(image);
      const { image_embeds } = await visionModel(inputs);
      self.postMessage({ id, type: 'embedding', vec: normalise(image_embeds.data) });
    } else if (type === 'text') {
      const inputs = tokenizer([e.data.text], { padding: 'max_length', truncation: true });
      const { text_embeds } = await textModel(inputs);
      self.postMessage({ id, type: 'embedding', vec: normalise(text_embeds.data) });
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
